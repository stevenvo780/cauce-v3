import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { emptyAgentProfile } from '@cauce/protocol';
import {
  AgentProfileRepository, CauceRepository, type ContextWriteDescriptor, type ContextWritePlan,
  type ContextWriteRecoveryInput, type ContextWriterRecoveryProof, type DatabasePool, type ReserveContextWriteInput,
} from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;
let profiles: AgentProfileRepository;
let started = false;
const tenant = 'Steven' as const;
const alias = 'argos';
const path = '/home/dev/.claude/CLAUDE.md';
const oldSha = 'a'.repeat(64);
const targetSha = 'b'.repeat(64);
const expectation = (sha: string) => ({ revision: 1, generation: 'runtime-a', documents: [{ name: 'CLAUDE.md', path, sha }] });
const actor = { tenant_id: tenant, alias };
const profile = { ...emptyAgentProfile(tenant, alias), role_summary: 'Recovery fixture profile' };

function plan(): Extract<ContextWritePlan, { operation: 'profile' }> {
  return {
    operation: 'profile', actor: { tenantId: tenant, alias },
    audit: { traceId: randomUUID(), attribution: { kind: 'operator', operatorId: 'fixture', attributed: true, reason: 'recovery test' } },
    journalDocuments: [{ name: 'CLAUDE.md', path, kind: 'agent_profile' }],
    expectationDocuments: [{ name: 'CLAUDE.md', path }], sourceReceipt: null,
  };
}

function reservation(overrides: Partial<ReserveContextWriteInput> = {}): ReserveContextWriteInput {
  return {
    operationId: randomUUID(), token: randomUUID(), generation: randomUUID(), tenantId: tenant, alias,
    writer: { runtimeGeneration: 'runtime-a', containerId: 'container-a', writerInstanceId: randomUUID() },
    expectedRevision: 1, expectedExpectation: expectation(oldSha), documents: [{ name: 'CLAUDE.md', path, beforeSha: oldSha, targetSha }],
    plan: plan(), ...overrides,
  };
}

function recoveryProof(
  descriptor: ContextWriteDescriptor,
  documents: readonly { readonly name: string; readonly path: string; readonly sha: string | null; readonly bytes: number }[] = [
    { name: 'CLAUDE.md', path, sha: targetSha, bytes: 17 },
  ],
) {
  return {
    operationId: descriptor.operationId, token: descriptor.token, generation: descriptor.generation,
    writer: descriptor.writer, state: 'quiescent' as const, durability: 'post_fsync' as const,
    documents,
  };
}

function recoveryInput(descriptor: ContextWriteDescriptor, overrides: Partial<ContextWriteRecoveryInput> = {}): ContextWriteRecoveryInput {
  return {
    tenantId: tenant, alias, operationId: descriptor.operationId, signal: new AbortController().signal,
    lockHumanAuthority: async () => undefined,
    assertTargetControl: async () => undefined,
    authenticatedReadback: async () => recoveryProof(descriptor),
    persistTarget: async (client, _selectedPlan, proof) => {
      await client.query(`UPDATE agent_profile_runtime_expectations SET documents=$3::jsonb
        WHERE tenant_id=$1 AND alias=$2`, [tenant, alias, JSON.stringify(proof.documents.map(({ name, path: documentPath, sha }) => ({ name, path: documentPath, sha })))]);
    },
    ...overrides,
  };
}

async function expectStillRunning(operationId: string): Promise<void> {
  const result = await pool.query<{ status: string; lease_until: Date | null; payload: { completion: unknown } }>(
    'SELECT status,lease_until,payload FROM jobs WHERE id=$1', [operationId]);
  expect(result.rows[0]).toMatchObject({ status: 'running', lease_until: null, payload: { completion: null } });
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase(); started = true; pool = database.pool;
  repository = new CauceRepository(pool); profiles = new AgentProfileRepository(pool);
  console.info('owned-context-recovery-postgres', execFileSync('docker', ['inspect', '--format',
    '{{json .Id}} {{json .Mounts}} {{json .HostConfig.PortBindings}} {{json .Config.Labels}}', database.container.getId()], { encoding: 'utf8' }).trim());
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
    VALUES($1,$2,'claude','Argos',true,'ws-argos','dev','/home/dev','/tmp/argos')`, [tenant, alias]);
  await profiles.replace(profile, null, actor);
  await repository.recordProfileRuntimeExpectation(tenant, alias, expectation(oldSha));
});

afterAll(async () => {
  if (!started) return;
  const cid = database.container.getId();
  const cleanup = await Promise.allSettled([pool.end(), database.container.stop()]);
  const failures = cleanup.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'owned recovery Postgres cleanup failed');
  const absent = await import('node:child_process');
  const inspect = absent.spawnSync('docker', ['inspect', cid], { encoding: 'utf8' });
  if (inspect.status !== 1 || !/no such (object|container)/iu.test(inspect.stderr)) throw new Error('owned recovery Postgres absence is unverified');
  console.info('owned-context-recovery-postgres-absent', cid);
});

describe('versioned context-write recovery', () => {
  it('keeps v1 reservations recoverable only through the existing proof path, never auto-upgrading them', async () => {
    const { plan: discardedPlan, ...v1Request } = reservation();
    expect(discardedPlan).toBeDefined();
    const descriptor = await repository.reserveContextWrite(v1Request);
    await repository.authorizeContextWriteDispatch(descriptor);
    let callbacks = 0;
    await expect(repository.recoverContextWrite(recoveryInput(descriptor, {
      lockHumanAuthority: async () => { callbacks += 1; },
      authenticatedReadback: async () => { callbacks += 1; throw new Error('must not query v1 proof'); },
      persistTarget: async () => { callbacks += 1; },
    }))).rejects.toThrow('recovery plan is unavailable');
    expect(callbacks).toBe(1);
    expect((await repository.readContextWrite(tenant, alias, descriptor.operationId))?.version).toBe(1);
    await expectStillRunning(descriptor.operationId);
  });

  it('recovers a v2 target once using the same client for authority, target control, proof and persistence', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(reservation()));
    const order: string[] = [];
    const pids: number[] = [];
    let persistedPlan: ContextWritePlan | undefined;
    const result = await repository.recoverContextWrite(recoveryInput(descriptor, {
      lockHumanAuthority: async (client) => {
        order.push('authority'); pids.push(Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid));
        const before = await client.query<{ total: string }>(`SELECT count(*)::text AS total FROM pg_locks
          WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted`);
        expect(Number(before.rows[0]?.total)).toBe(0);
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('owned-human-authority',0))`);
        const held = await client.query<{ total: string }>(`SELECT count(*)::text AS total FROM pg_locks
          WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted`);
        expect(Number(held.rows[0]?.total)).toBe(1);
      },
      assertTargetControl: async (client, selected) => {
        order.push('control'); pids.push(Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid));
        const held = await client.query<{ total: string }>(`SELECT count(*)::text AS total FROM pg_locks
          WHERE pid=pg_backend_pid() AND locktype='advisory' AND granted`);
        expect(Number(held.rows[0]?.total)).toBe(2);
        expect(selected.version).toBe(2);
        expect(selected.operationId).toBe(descriptor.operationId);
      },
      authenticatedReadback: async (client) => {
        order.push('proof'); pids.push(Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid));
        return recoveryProof(descriptor);
      },
      persistTarget: async (client, selectedPlan, proof) => {
        order.push('persist'); pids.push(Number((await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid));
        persistedPlan = selectedPlan;
        await client.query(`UPDATE agent_profile_runtime_expectations SET documents=$3::jsonb
          WHERE tenant_id=$1 AND alias=$2`, [tenant, alias, JSON.stringify(proof.documents.map(({ name, path: documentPath, sha }) => ({ name, path: documentPath, sha })))]);
      },
    }));
    expect(result).toEqual({ operationId: descriptor.operationId, resolution: 'target' });
    expect(order).toEqual(['authority', 'control', 'proof', 'persist']);
    expect(new Set(pids).size).toBe(1);
    expect(descriptor.version).toBe(2);
    if (descriptor.version !== 2) throw new Error('reservation plan was not persisted');
    expect(persistedPlan).toEqual(descriptor.plan);
    expect((await repository.readContextWrite(tenant, alias, descriptor.operationId))?.completion?.resolution).toBe('target');
    expect((await pool.query<{ status: string; lease_until: Date | null }>('SELECT status,lease_until FROM jobs WHERE id=$1', [descriptor.operationId])).rows[0])
      .toEqual({ status: 'done', lease_until: null });
    expect((await pool.query<{ documents: unknown }>('SELECT documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0]?.documents)
      .toEqual([{ name: 'CLAUDE.md', path, sha: targetSha }]);
  });

  it('creates the first profile under a v2 reservation with a nullable before snapshot', async () => {
    await pool.query('DELETE FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    await pool.query('DELETE FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    const request = reservation({ expectedRevision: null, expectedExpectation: null, updateDesired: async (client) => {
      await profiles.replaceInTransaction(client, profile, null, actor);
      await client.query(`INSERT INTO agent_profile_runtime_expectations(tenant_id,alias,revision,generation,documents)
        VALUES($1,$2,1,'runtime-a',$3::jsonb)`, [tenant, alias, JSON.stringify([{ name: 'CLAUDE.md', path, sha: oldSha }])]);
    } });
    const descriptor = await repository.reserveContextWrite(request);
    expect(descriptor.version).toBe(2);
    expect(descriptor.before).toMatchObject({ revision: null, profileSha256: null });
    expect(descriptor.after.revision).toBe(1);
    const saved = await repository.readContextWrite(tenant, alias, descriptor.operationId);
    if (descriptor.version !== 2 || saved?.version !== 2) throw new Error('versioned plan was not persisted');
    expect(saved.plan).toEqual(descriptor.plan);
  });

  it('hides foreign operation scope and rejects reserved work before invoking recovery callbacks', async () => {
    const descriptor = await repository.reserveContextWrite(reservation());
    let authorityLocks = 0;
    let recoveryEffects = 0;
    const callbacksInput = recoveryInput(descriptor, {
      lockHumanAuthority: async () => { authorityLocks += 1; },
      assertTargetControl: async () => { recoveryEffects += 1; },
      authenticatedReadback: async () => { recoveryEffects += 1; throw new Error('no proof expected'); },
      persistTarget: async () => { recoveryEffects += 1; },
    });
    await expect(repository.recoverContextWrite({ ...callbacksInput, operationId: randomUUID() })).rejects.toThrow('not found');
    await expect(repository.recoverContextWrite({ ...callbacksInput, tenantId: 'Hegel' })).rejects.toThrow('not found');
    await expect(repository.recoverContextWrite(callbacksInput)).rejects.toThrow('recovery control fields are invalid');
    expect(authorityLocks).toBe(3);
    expect(recoveryEffects).toBe(0);
    await expectStillRunning(descriptor.operationId);
  });

  it('rejects mutated plans, claim tokens and lease controls before proof or persistence', async () => {
    const mutate = [
      async (operationId: string) => pool.query(`UPDATE jobs SET payload=jsonb_set(payload,'{plan,operation}','"document"') WHERE id=$1`, [operationId]),
      async (operationId: string) => pool.query('UPDATE jobs SET claim_token=$2 WHERE id=$1', [operationId, randomUUID()]),
      async (operationId: string) => pool.query("UPDATE jobs SET lease_until=clock_timestamp()+interval '1 minute' WHERE id=$1", [operationId]),
    ];
    for (const corrupt of mutate) {
      const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(reservation()));
      await corrupt(descriptor.operationId);
      let proofs = 0; let writes = 0;
      await expect(repository.recoverContextWrite(recoveryInput(descriptor, {
        authenticatedReadback: async () => { proofs += 1; return recoveryProof(descriptor); },
        persistTarget: async () => { writes += 1; },
      }))).rejects.toThrow();
      expect(proofs).toBe(0); expect(writes).toBe(0);
      const job = await pool.query<{ status: string; lease_until: Date | null }>('SELECT status,lease_until FROM jobs WHERE id=$1', [descriptor.operationId]);
      expect(job.rows[0]?.status).toBe('running');
      await pool.query('DELETE FROM jobs WHERE id=$1', [descriptor.operationId]);
    }
  });

  it('keeps quarantine on old, mixed, malformed byte and invalid-scope proofs', async () => {
    const secondPath = '/home/dev/.claude/CLAUDE.local.md';
    const selectedPlan = plan();
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(reservation({
      documents: [
        { name: 'CLAUDE.md', path, beforeSha: oldSha, targetSha },
        { name: 'CLAUDE.local.md', path: secondPath, beforeSha: oldSha, targetSha: 'c'.repeat(64) },
      ],
      plan: { ...selectedPlan,
        journalDocuments: [...selectedPlan.journalDocuments, { name: 'CLAUDE.local.md', path: secondPath, kind: 'agent_profile' }],
        expectationDocuments: [...selectedPlan.expectationDocuments, { name: 'CLAUDE.local.md', path: secondPath }],
      },
    })));
    const firstTarget = { name: 'CLAUDE.md', path, sha: targetSha, bytes: 17 };
    const secondTarget = { name: 'CLAUDE.local.md', path: secondPath, sha: 'c'.repeat(64), bytes: 23 };
    const allTarget = [firstTarget, secondTarget];
    const allOld = allTarget.map((document) => ({ ...document, sha: oldSha }));
    const invalidProofs: unknown[] = [
      { ...recoveryProof(descriptor, allTarget), operationId: randomUUID() },
      recoveryProof(descriptor, [{ ...firstTarget, bytes: -1 }, secondTarget]),
      recoveryProof(descriptor, [{ ...firstTarget, bytes: 1.5 }, secondTarget]),
      recoveryProof(descriptor, [{ ...firstTarget, path: `${path}.other` }, secondTarget]),
      { ...recoveryProof(descriptor, allTarget), writer: { ...descriptor.writer, writerInstanceId: randomUUID() } },
      { ...recoveryProof(descriptor, allTarget), state: 'writing' },
      { ...recoveryProof(descriptor, allTarget), durability: 'hash-only' },
      recoveryProof(descriptor, [firstTarget, { ...secondTarget, sha: oldSha }]),
    ];
    for (const malformed of invalidProofs) {
      await expect(repository.recoverContextWrite(recoveryInput(descriptor, {
        authenticatedReadback: async () => malformed as ContextWriterRecoveryProof,
      }))).rejects.toThrow();
      await expectStillRunning(descriptor.operationId);
    }
    let persistedOld = false;
    await expect(repository.recoverContextWrite(recoveryInput(descriptor, {
      authenticatedReadback: async () => recoveryProof(descriptor, allOld),
      persistTarget: async () => { persistedOld = true; },
    }))).resolves.toMatchObject({ resolution: 'old' });
    expect(persistedOld).toBe(false);
    expect((await repository.readContextWrite(tenant, alias, descriptor.operationId))?.completion?.resolution).toBe('old');
    expect((await pool.query<{ documents: unknown }>('SELECT documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0]?.documents)
      .toEqual([{ name: 'CLAUDE.md', path, sha: oldSha }]);
  });

  it('serializes concurrent recovery and revalidates completed history without re-reading or persisting', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(reservation()));
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let reads = 0; let writes = 0; let controls = 0;
    const first = repository.recoverContextWrite(recoveryInput(descriptor, {
      authenticatedReadback: async () => { reads += 1; entered(); await hold; return {
        ...recoveryProof(descriptor),
      }; },
      persistTarget: async (client, _plan, proof) => { writes += 1; await client.query('UPDATE agent_profile_runtime_expectations SET documents=$3::jsonb WHERE tenant_id=$1 AND alias=$2',
        [tenant, alias, JSON.stringify(proof.documents.map(({ name, path: documentPath, sha }) => ({ name, path: documentPath, sha })))]); },
    }));
    await ready;
    const second = repository.recoverContextWrite(recoveryInput(descriptor, {
      assertTargetControl: async () => { controls += 1; },
      authenticatedReadback: async () => { reads += 1; throw new Error('must not repeat proof'); },
      persistTarget: async () => { writes += 1; },
    }));
    release();
    await expect(Promise.all([first, second])).resolves.toEqual([
      { operationId: descriptor.operationId, resolution: 'target' }, { operationId: descriptor.operationId, resolution: 'target' },
    ]);
    expect(reads).toBe(1); expect(writes).toBe(1); expect(controls).toBe(1);
    await profiles.replace({ ...profile, role_summary: 'Newer desired revision' }, 1, actor);
    let historicalProofs = 0; let historicalWrites = 0; let historicalControls = 0;
    await expect(repository.recoverContextWrite(recoveryInput(descriptor, {
      assertTargetControl: async () => { historicalControls += 1; },
      authenticatedReadback: async () => { historicalProofs += 1; throw new Error('completed history must not re-read files'); },
      persistTarget: async () => { historicalWrites += 1; },
    }))).resolves.toMatchObject({ resolution: 'target' });
    expect(historicalControls).toBe(1); expect(historicalProofs).toBe(0); expect(historicalWrites).toBe(0);
  });

  it('aborts before proof or after readback without committing completion or target data', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(reservation()));
    for (const phase of ['authority', 'control', 'proof'] as const) {
      const controller = new AbortController(); let reads = 0; let writes = 0;
      const request = recoveryInput(descriptor, {
        signal: controller.signal,
        lockHumanAuthority: async () => { if (phase === 'authority') controller.abort(new Error('authority revoked')); },
        assertTargetControl: async () => { if (phase === 'control') controller.abort(new Error('authority revoked')); },
        authenticatedReadback: async () => { reads += 1; const value = recoveryProof(descriptor); if (phase === 'proof') controller.abort(new Error('request cancelled')); return value; },
        persistTarget: async () => { writes += 1; },
      });
      await expect(repository.recoverContextWrite(request)).rejects.toThrow();
      expect(reads).toBe(phase === 'control' || phase === 'authority' ? 0 : 1);
      expect(writes).toBe(0); await expectStillRunning(descriptor.operationId);
    }
  });
});
