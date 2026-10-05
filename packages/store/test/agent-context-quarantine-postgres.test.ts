import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  CauceRepository, CONTEXT_WRITE_QUARANTINE_KIND, assertAgentContextAdmissionAllowed, persistAgentContextReconcileInTransaction,
  type ContextWriteDescriptor, type ContextWriterQuiescence, type DatabaseClient, type DatabasePool,
  type ReserveContextWriteInput,
} from '../src/index.js';
import { withTransaction } from '../src/db.js';
import { agentContextReconcileLockKey } from '../src/repository/agent-context-lock.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;
let started = false;
const tenant = 'Steven' as const;
const alias = 'argos';
const file = '/home/dev/.claude/CLAUDE.md';
const oldSha = 'a'.repeat(64);
const targetSha = 'b'.repeat(64);
const runtime = { runtimeGeneration: 'runtime-a', containerId: 'container-a', writerInstanceId: randomUUID() };
const expectation = { revision: 1, generation: 'runtime-a', documents: [{ name: 'CLAUDE.md', path: file, sha: oldSha }] };
function input(overrides: Partial<ReserveContextWriteInput> = {}): ReserveContextWriteInput {
  return { operationId: randomUUID(), token: randomUUID(), generation: randomUUID(), tenantId: tenant, alias,
    writer: runtime, expectedRevision: 1, expectedExpectation: expectation,
    documents: [{ name: 'CLAUDE.md', path: file, beforeSha: oldSha, targetSha }], ...overrides };
}
function proof(descriptor: ContextWriteDescriptor, measured = targetSha): ContextWriterQuiescence {
  return { operationId: descriptor.operationId, token: descriptor.token, generation: descriptor.generation,
    writer: descriptor.writer, state: 'quiescent', durability: 'post_fsync',
    documents: descriptor.documents.map((item) => ({ name: item.name, path: item.path, sha: measured })) };
}
async function activeCount(): Promise<number> {
  const result = await pool.query<{ total: string }>(`SELECT count(*)::text AS total FROM jobs WHERE kind=$1 AND status<>'done'`, [CONTEXT_WRITE_QUARANTINE_KIND]);
  return Number(result.rows[0]?.total);
}
async function admission(selectedAlias = alias): Promise<void> {
  await withTransaction(pool, async (client) => {
    await client.query(`SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))`, [agentContextReconcileLockKey(tenant, selectedAlias)]);
    await assertAgentContextAdmissionAllowed(client, tenant, selectedAlias);
  });
}
async function persistTarget(client: DatabaseClient, receipt: ContextWriterQuiescence): Promise<void> {
  await client.query(`UPDATE agent_profile_runtime_expectations SET documents=$3::jsonb WHERE tenant_id=$1 AND alias=$2`,
    [tenant, alias, JSON.stringify(receipt.documents.map((item) => ({ name: item.name, path: item.path, sha: item.sha })))]);
}
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase(); started = true;
  pool = database.pool; repository = new CauceRepository(pool);
  console.info('owned-quarantine-postgres', execFileSync('docker', ['inspect', '--format',
    '{{json .Id}} {{json .Mounts}} {{json .HostConfig.PortBindings}} {{json .Config.Labels}}', database.container.getId()], { encoding: 'utf8' }).trim());
}, 120_000);
beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
    VALUES('Steven','argos','claude','Argos',true,'ws-argos','dev','/home/dev','/tmp/argos');
    INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES('Steven','argos','Independent runtime reviewer');`);
  await repository.recordProfileRuntimeExpectation(tenant, alias, expectation);
});
afterAll(async () => {
  if (!started) return;
  const cid = database.container.getId();
  const cleanup = await Promise.allSettled([pool.end(), database.container.stop()]);
  const failures = cleanup.filter((item) => item.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'owned Postgres cleanup failed');
  const inspect = await import('node:child_process');
  const absent = inspect.spawnSync('docker', ['inspect', cid], { encoding: 'utf8' });
  if (absent.status !== 1 || !/no such (object|container)/iu.test(absent.stderr)) throw new Error('owned Postgres absence is unverified');
  console.info('owned-quarantine-postgres-absent', cid);
});
describe('durable context write reservation', () => {
  it('commits a durable running NULL-lease reservation before any dispatch and blocks only its alias', async () => {
    const descriptor = await repository.reserveContextWrite(input());
    const row = await pool.query<{ status: string; lease_until: unknown; claim_token: string }>(`SELECT status,lease_until,claim_token::text FROM jobs WHERE id=$1`, [descriptor.operationId]);
    expect(row.rows[0]).toEqual({ status: 'running', lease_until: null, claim_token: descriptor.token });
    expect(await repository.readContextWrite(tenant, alias, descriptor.operationId)).toEqual(descriptor);
    await expect(admission()).rejects.toThrow('fences admission');
    await admission('kant');
    expect(descriptor.dispatch).toBe('reserved');
  });
  it('serializes two reservations and rejects stale inputs without changing desired', async () => {
    const outcomes = await Promise.allSettled([repository.reserveContextWrite(input()), repository.reserveContextWrite(input())]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    expect(await activeCount()).toBe(1);
    await pool.query('DELETE FROM jobs WHERE kind=$1', [CONTEXT_WRITE_QUARANTINE_KIND]);
    let desiredCalled = false;
    await expect(repository.reserveContextWrite(input({ expectedRevision: 2, updateDesired: async () => { desiredCalled = true; } }))).rejects.toThrow('snapshot changed');
    expect(desiredCalled).toBe(false); expect(await activeCount()).toBe(0);
  });
  it('persists canonical reload journals and audit atomically inside resolution without nested transaction', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(input()));
    const next = { ...expectation, documents: [{ name: 'CLAUDE.md', path: file, sha: targetSha }] };
    const persist = async (client: DatabaseClient): Promise<void> => {
      await persistAgentContextReconcileInTransaction(client,
        { mode: 'reload', tenantId: tenant, alias, expectedRevision: 1, expectedExpectation: expectation,
          apply: async () => { throw new Error('physical apply must not run in TX2'); } }, expectation,
        { value: undefined, expectation: next,
          documentRevisions: [{ path: file, sha256: targetSha, bytes: 10, actorTenant: tenant, actorAlias: alias }],
          resultAudit: { tenantId: tenant, actorAlias: alias, traceId: randomUUID(), metadata: { operation: descriptor.operationId } } });
    };
    const before = (await pool.query('SELECT id FROM agent_document_revisions ORDER BY id')).rows;
    await expect(repository.resolveContextWrite(descriptor, async () => proof(descriptor), async (client) => {
      await persist(client); throw new Error('result commit failed');
    })).rejects.toThrow('result commit failed');
    expect((await pool.query('SELECT id FROM agent_document_revisions ORDER BY id')).rows).toEqual(before);
    expect((await pool.query<{ documents: unknown }>('SELECT documents FROM agent_profile_runtime_expectations')).rows[0]?.documents).toEqual(expectation.documents);
    await expect(admission()).rejects.toThrow();
    await expect(repository.resolveContextWrite(descriptor, async () => proof(descriptor), persist)).resolves.toBe('target');
    expect((await pool.query<{ documents: unknown }>('SELECT documents FROM agent_profile_runtime_expectations')).rows[0]?.documents).toEqual(next.documents);
    expect((await pool.query<{ metadata: unknown }>("SELECT metadata FROM audit_events WHERE action='agent_document.write'")).rows)
      .toEqual([{ metadata: { operation: descriptor.operationId } }]);
    await admission();
  });
  it('updates desired in the reservation transaction and preserves both snapshots', async () => {
    const descriptor = await repository.reserveContextWrite(input({ updateDesired: async (client) => {
      await client.query(`UPDATE agent_profiles SET revision=revision+1,role_summary='New desired' WHERE tenant_id=$1 AND alias=$2`, [tenant, alias]);
    } }));
    expect(descriptor.before.revision).toBe(1); expect(descriptor.after.revision).toBe(2);
    expect(descriptor.before.profileSha256).not.toBe(descriptor.after.profileSha256);
    await expect(admission()).rejects.toThrow();
  });
  it('rolls desired back if reservation insertion fails', async () => {
    const descriptor = await repository.reserveContextWrite(input());
    await pool.query(`UPDATE jobs SET status='done' WHERE id=$1`, [descriptor.operationId]);
    await expect(repository.reserveContextWrite(input({ operationId: descriptor.operationId, updateDesired: async (client) => {
      await client.query(`UPDATE agent_profiles SET role_summary='Changed desired' WHERE tenant_id=$1 AND alias=$2`, [tenant, alias]);
    } }))).rejects.toThrow();
    const revision = await pool.query<{ revision: string }>(`SELECT revision FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`, [tenant, alias]);
    expect(Number(revision.rows[0]?.revision)).toBe(1);
  });
  it('authorizes dispatch exactly once and never repairs an uncertain repeat', async () => {
    const descriptor = await repository.reserveContextWrite(input());
    const outcomes = await Promise.allSettled([repository.authorizeContextWriteDispatch(descriptor), repository.authorizeContextWriteDispatch(descriptor)]);
    expect(outcomes.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((item) => item.status === 'rejected')).toHaveLength(1);
    const committed = await repository.readContextWrite(tenant, alias, descriptor.operationId);
    expect(committed?.dispatch).toBe('authorized');
    if (committed === undefined) throw new Error('missing dispatch reservation');
    await expect(repository.authorizeContextWriteDispatch(committed)).rejects.toThrow('already authorized');
    await expect(admission()).rejects.toThrow();
  });
  it('rejects all-target bytes without exact server proof and retains quarantine', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(input()));
    for (const mutation of [
      { token: randomUUID() }, { generation: randomUUID() }, { writer: { ...runtime, writerInstanceId: randomUUID() } },
      { documents: [] }, { state: 'writing' }, { durability: 'hash-only' }, { durability: 'exact_process_dead' },
    ]) {
      let persisted = false;
      await expect(repository.resolveContextWrite(descriptor, async () => ({ ...proof(descriptor), ...mutation } as ContextWriterQuiescence), async () => { persisted = true; })).rejects.toThrow();
      expect(persisted).toBe(false); expect(await activeCount()).toBe(1);
    }
  });
  it('resolves only after same-client proof and atomic target persistence', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(input()));
    let proofBackend: number | undefined;
    await expect(repository.resolveContextWrite(descriptor, async (client) => {
      const row = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'); proofBackend = row.rows[0]?.pid;
      return proof(descriptor);
    }, async (client, receipt) => {
      const row = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid'); expect(row.rows[0]?.pid).toBe(proofBackend);
      await persistTarget(client, receipt);
    })).resolves.toBe('target');
    expect(await activeCount()).toBe(0); await admission();
    expect((await repository.readContextWrite(tenant, alias, descriptor.operationId))?.completion?.resolution).toBe('target');
    const row = await pool.query<{ documents: unknown }>('SELECT documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    expect(row.rows[0]?.documents).toEqual([{ name: 'CLAUDE.md', path: file, sha: targetSha }]);
  });
  it('keeps reservation when persistence, proof query, profile CAS or mixed bytes fail', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(input()));
    await expect(repository.resolveContextWrite(descriptor, async () => proof(descriptor), async (client, receipt) => {
      await persistTarget(client, receipt); throw new Error('journal failed');
    })).rejects.toThrow('journal failed');
    await expect(repository.resolveContextWrite(descriptor, async () => { throw new Error('writer query timeout'); }, persistTarget)).rejects.toThrow('timeout');
    await expect(repository.resolveContextWrite(descriptor, async () => proof(descriptor, 'c'.repeat(64)), persistTarget)).rejects.toThrow('mixed');
    await pool.query(`UPDATE agent_profiles SET role_summary='Changed desired' WHERE tenant_id=$1 AND alias=$2`, [tenant, alias]);
    let queried = false;
    await expect(repository.resolveContextWrite(descriptor, async () => { queried = true; return proof(descriptor); }, persistTarget)).rejects.toThrow('snapshot changed');
    expect(queried).toBe(false); expect(await activeCount()).toBe(1);
  });
  it('resolves all-old only with proof and does not persist target adoption', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(input()));
    let persisted = false;
    await expect(repository.resolveContextWrite(descriptor, async () => proof(descriptor, oldSha), async () => { persisted = true; })).resolves.toBe('old');
    expect(persisted).toBe(false); expect(await activeCount()).toBe(0);
  });
  it('retains any non-done status and malformed reservations block the whole tenant', async () => {
    const descriptor = await repository.reserveContextWrite(input());
    for (const status of ['queued', 'failed', 'dead']) {
      await pool.query(`UPDATE jobs SET status=$2 WHERE id=$1`, [descriptor.operationId, status]);
      await expect(admission()).rejects.toThrow('metadata is invalid');
      await expect(admission('kant')).rejects.toThrow('metadata is invalid');
      await expect(repository.authorizeContextWriteDispatch(descriptor)).rejects.toThrow('CAS failed');
    }
    await pool.query(`UPDATE jobs SET payload='{}'::jsonb WHERE id=$1`, [descriptor.operationId]);
    await expect(admission('kant')).rejects.toThrow('metadata is invalid');
  });
  it('creates the first desired profile atomically under a reservation and rejects a concurrent creator', async () => {
    await pool.query('DELETE FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    await pool.query('DELETE FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    const create = (): ReserveContextWriteInput => input({ expectedRevision: null, expectedExpectation: null, updateDesired: async (client) => {
      await client.query(`INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,'First desired')`, [tenant, alias]);
    } });
    const results = await Promise.allSettled([repository.reserveContextWrite(create()), repository.reserveContextWrite(create())]);
    const success = results.find((item) => item.status === 'fulfilled');
    if (success?.status !== 'fulfilled') throw new Error('no profile reservation committed');
    expect(results.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(success.value.before.revision).toBeNull(); expect(success.value.before.profileSha256).toBeNull();
    expect(success.value.after.revision).toBe(1);
    expect(await activeCount()).toBe(1);
    const profiles = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    expect(Number(profiles.rows[0]?.total)).toBe(1);
    await expect(admission()).rejects.toThrow();
  });
  it('supports document-only reservation without inventing a missing profile', async () => {
    await pool.query('DELETE FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    await pool.query('DELETE FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    const descriptor = await repository.reserveContextWrite(input({ expectedRevision: null, expectedExpectation: null }));
    expect(descriptor.before.revision).toBeNull(); expect(descriptor.after.revision).toBeNull();
    const profiles = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    expect(Number(profiles.rows[0]?.total)).toBe(0);
  });
  it('rolls first-profile creation back when reservation insertion fails', async () => {
    const descriptor = await repository.reserveContextWrite(input());
    await pool.query(`UPDATE jobs SET status='done' WHERE id=$1`, [descriptor.operationId]);
    await pool.query('DELETE FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    await pool.query('DELETE FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    await expect(repository.reserveContextWrite(input({ operationId: descriptor.operationId, expectedRevision: null, expectedExpectation: null,
      updateDesired: async (client) => { await client.query(`INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES($1,$2,'First desired')`, [tenant, alias]); } }))).rejects.toThrow();
    const profiles = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM agent_profiles WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
    expect(Number(profiles.rows[0]?.total)).toBe(0); expect(await activeCount()).toBe(0);
  });
  it('aborts a blocked proof query physically without resolving the reservation', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(input()));
    const controller = new AbortController();
    let entered!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    let backend = 0;
    const resolving = repository.resolveContextWrite(descriptor, async (client) => {
      backend = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
      entered(); await client.query('SELECT pg_sleep(30)'); return proof(descriptor);
    }, persistTarget, controller.signal).then(() => 'resolved', () => 'cancelled');
    await ready; controller.abort(new Error('owned request cancelled'));
    expect(await resolving).toBe('cancelled');
    const result = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM pg_stat_activity WHERE pid=$1', [backend]);
    expect(Number(result.rows[0]?.total)).toBe(0); expect(await activeCount()).toBe(1);
    await expect(admission()).rejects.toThrow();
  });
  it('rejects a leased delivery before updating desired or reserving', async () => {
    const lease = await repository.acquireLease(tenant, alias, 'quarantine-before-entry', [], 60_000);
    if (!lease.acquired || lease.epoch === undefined) throw new Error('owned lease not acquired');
    await repository.publish({ version: '3.0', request_id: randomUUID(), trace_id: randomUUID(), tenant_id: tenant,
      room_id: 'grp.steven', actor_alias: 'kant', recipients: [{ tenant_id: tenant, alias }], body: { text: 'owned fixture' },
      lane: 'interactive', priority: 0, idempotency_key: randomUUID() });
    const claimed = await repository.claimDeliveries(tenant, alias, 'quarantine-before-entry', lease.epoch, 1);
    expect(claimed).toHaveLength(1);
    let changed = false;
    await expect(repository.reserveContextWrite(input({ updateDesired: async () => { changed = true; } }))).rejects.toThrow('work in flight');
    expect(changed).toBe(false); expect(await activeCount()).toBe(0);
  });
  it('keeps admission behind reservation commit and then denies it', async () => {
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let backend = 0;
    const reservation = repository.reserveContextWrite(input({ updateDesired: async (client) => {
      backend = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
      entered(); await hold;
    } }));
    await ready;
    const laterAdmission = admission().then(() => 'allowed', () => 'fenced');
    try {
      const deadline = performance.now() + 2000;
      let blocked = false;
      while (!blocked && performance.now() < deadline) {
        const result = await pool.query<{ blocked: boolean }>(`SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked`, [backend]);
        blocked = result.rows[0]?.blocked === true;
        if (!blocked) await new Promise<void>((resolve) => { setImmediate(resolve); });
      }
      expect(blocked).toBe(true);
    } finally { release(); }
    await reservation;
    expect(await laterAdmission).toBe('fenced');
  });
  it('retains quarantine after the resolver backend dies while awaiting proof', async () => {
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(input()));
    let entered!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; });
    const hold = new Promise<void>((resolve) => { release = resolve; });
    let backend = 0;
    const resolving = repository.resolveContextWrite(descriptor, async (client) => {
      backend = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid ?? 0;
      entered(); await hold; return proof(descriptor);
    }, persistTarget).then(() => 'resolved', () => 'failed');
    await ready;
    try { await pool.query('SELECT pg_terminate_backend($1)', [backend]); }
    finally { release(); }
    expect(await resolving).toBe('failed');
    expect(await activeCount()).toBe(1);
    await expect(admission()).rejects.toThrow('fences admission');
    const alive = await pool.query<{ total: string }>('SELECT count(*)::text AS total FROM pg_stat_activity WHERE pid=$1', [backend]);
    expect(Number(alive.rows[0]?.total)).toBe(0);
  });
  it('rejects existing work and malformed input before any desired update', async () => {
    let changed = false;
    await expect(repository.reserveContextWrite(input({ documents: [], updateDesired: async () => { changed = true; } }))).rejects.toThrow('invalid');
    expect(changed).toBe(false); expect(await activeCount()).toBe(0);
    await pool.query(`UPDATE agents SET enabled=false WHERE tenant_id=$1 AND alias=$2`, [tenant, alias]);
    await expect(repository.reserveContextWrite(input())).rejects.toThrow('disabled');
    expect(await activeCount()).toBe(0);
  });
});
