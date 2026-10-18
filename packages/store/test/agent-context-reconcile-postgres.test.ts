import Fastify from 'fastify';
import { AgentContextWriteCoordinator } from '../../../services/gateway/src/console/agent-context-write-coordinator.js';
import { registerAgentContextReloadRoutes } from '../../../services/gateway/src/console/agent-context-reload.routes.js';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProfileRuntimeContract, PublishMessage } from '@cauce/protocol';
import { AgentProfileRepository, CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const tenant = 'Steven' as const;
const alias = 'argos';
const path = '/home/dev/.claude/CLAUDE.md';

function contract(revision: number, sha = 'a'.repeat(64)): ProfileRuntimeContract {
  return {
    revision,
    generation: 'runtime-generation-a',
    documents: [{ name: 'CLAUDE.md', path, sha }],
  };
}

function command(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `context-reconcile-${randomUUID()}`,
    tenant_id: tenant,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: tenant, alias }],
    body: { text: 'queued while context reconciliation is fenced' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
  };
}

function effect<Value>(revision: number, value: Value, bytes = 120) {
  const expectation = contract(revision, 'b'.repeat(64));
  const document = expectation.documents[0];
  if (document === undefined) throw new Error('test runtime contract has no document');
  return {
    value,
    expectation,
    documentRevisions: [{
      path,
      sha256: document.sha,
      bytes,
      actorTenant: tenant,
      actorAlias: 'kant',
    }],
    resultAudit: {
      tenantId: tenant,
      actorAlias: 'kant',
      traceId: `reconcile-result-${randomUUID()}`,
      metadata: { operation: 'context_reconcile', phase: 'result', revision },
    },
  };
}

function acquiredEpoch(
  lease: Awaited<ReturnType<CauceRepository['acquireLease']>>,
): number {
  if (!lease.acquired || lease.epoch === undefined) throw new Error('test lease was not acquired');
  return lease.epoch;
}

async function profileRevision(): Promise<number> {
  const result = await pool.query<{ revision: string | number }>(
    `SELECT revision FROM agent_profiles WHERE tenant_id=$1 AND alias=$2`, [tenant, alias],
  );
  return Number(result.rows[0]?.revision);
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  console.info('owned-postgres', execFileSync('docker', ['inspect', '--format',
    '{{json .Id}} {{json .Mounts}} {{json .HostConfig.PortBindings}} {{json .Config.Labels}}',
    database.container.getId()], { encoding: 'utf8' }).trim());
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,
      container_name,runtime_user,home_directory,state_directory
    ) VALUES
      ('Steven','kant','codex','Kant',true,'ws-kant','dev','/home/dev','/tmp/kant'),
      ('Steven','argos','claude','Argos',true,'ws-argos','dev','/home/dev','/tmp/argos');
    INSERT INTO agent_profiles(tenant_id,alias,role_summary)
      VALUES('Steven','argos','Independent runtime reviewer');
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
  `);
  await repository.recordProfileRuntimeExpectation(tenant, alias, contract(await profileRevision()));
});

afterAll(async () => {
  if (!databaseStarted) return;
  const cleanup = await Promise.allSettled([pool.end(), database.container.stop()]);
  const failures = cleanup.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'owned Postgres cleanup failed');
});

describe('agent context reconciliation fence', () => {
  it('preserves one wake and its heartbeat while runtime I/O fences a near-expiry claim', async () => {
    const revision = await profileRevision();
    const expected = contract(revision);
    const lease = await repository.acquireLease(
      tenant, alias, 'context-fence-adapter', [], 500, { resume: true },
    );
    expect(lease.acquired).toBe(true);
    const epoch = acquiredEpoch(lease);
    await repository.publish(command());

    let enterEffect!: () => void;
    const effectEntered = new Promise<void>((resolve) => { enterEffect = resolve; });
    let releaseEffect!: () => void;
    const mayFinish = new Promise<void>((resolve) => { releaseEffect = resolve; });
    const reconcile = repository.reconcileAgentContextRuntime({
      tenantId: tenant,
      alias,
      expectedRevision: revision,
      expectedExpectation: expected,
      apply: async () => {
        enterEffect();
        await mayFinish;
        return effect(revision, 'committed');
      },
    });
    await effectEntered;
    const claim = repository.claimDeliveries(
      tenant, alias, 'context-fence-adapter', epoch, 1, 30_000,
    );
    const claimState = await Promise.race([
      claim.then(() => 'settled'),
      new Promise<'blocked'>((resolve) => setTimeout(() => { resolve('blocked'); }, 80)),
    ]);
    expect(claimState).toBe('blocked');
    await expect(repository.heartbeat(
      tenant, alias, 'context-fence-adapter', epoch, 2_000,
    )).resolves.toEqual(expect.any(String));
    await new Promise((resolve) => setTimeout(resolve, 600));

    releaseEffect();
    await expect(reconcile).resolves.toEqual({ state: 'committed', value: 'committed' });
    await expect(claim).resolves.toHaveLength(1);
  });

  it('rejects a stale full expectation contract before invoking the runtime effect', async () => {
    const revision = await profileRevision();
    const stale = contract(revision);
    await repository.recordProfileRuntimeExpectation(
      tenant, alias, contract(revision, 'c'.repeat(64)),
    );
    const apply = vi.fn(async () => effect(revision, 'unexpected'));

    await expect(repository.reconcileAgentContextRuntime({
      tenantId: tenant,
      alias,
      expectedRevision: revision,
      expectedExpectation: stale,
      apply,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('rolls back all final metadata and reports unknown after a post-effect failure', async () => {
    const revision = await profileRevision();
    const expected = contract(revision);
    const documentsBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_document_revisions
        WHERE tenant_id=$1 AND alias=$2`, [tenant, alias],
    );
    const auditsBefore = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE action='agent_document.write' AND decision='allow'`,
    );
    const result = await repository.reconcileAgentContextRuntime({
      tenantId: tenant,
      alias,
      expectedRevision: revision,
      expectedExpectation: expected,
      apply: async () => effect(revision, 'not-committed', -1),
    });

    expect(result).toEqual({ state: 'effect_unknown' });
    const stored = await pool.query<{ documents: unknown }>(
      `SELECT documents FROM agent_profile_runtime_expectations
        WHERE tenant_id=$1 AND alias=$2`, [tenant, alias],
    );
    expect(stored.rows[0]?.documents).toEqual(expected.documents);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM agent_document_revisions
        WHERE tenant_id=$1 AND alias=$2`, [tenant, alias],
    )).rows).toEqual(documentsBefore.rows);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events
        WHERE action='agent_document.write' AND decision='allow'`,
    )).rows).toEqual(auditsBefore.rows);

    await expect(repository.reconcileAgentContextRuntime({
      tenantId: tenant,
      alias,
      expectedRevision: revision,
      expectedExpectation: expected,
      apply: async () => effect(revision, 'retried'),
    })).resolves.toEqual({ state: 'committed', value: 'retried' });
  });
});

async function replaceProfile(revision: number): Promise<void> {
  const profiles = new AgentProfileRepository(pool);
  await profiles.replace({ ...(await profiles.read(tenant, alias)), role_summary: 'New saved profile' },
    revision, { tenant_id: tenant, alias: 'kant' });
}

async function advisoryClaimWait(): Promise<void> {
  await vi.waitFor(async () => {
    const waiting = await pool.query<{ blocked: boolean }>(`
      SELECT EXISTS(SELECT 1 FROM pg_locks l WHERE l.locktype='advisory'
        AND NOT l.granted AND cardinality(pg_blocking_pids(l.pid))>0) AS blocked`);
    expect(waiting.rows[0]?.blocked).toBe(true);
  }, { timeout: 2_000, interval: 10 });
}

async function withRuntimeBytes(run: (file: string) => Promise<void>): Promise<void> {
  const scratch = await mkdtemp(join(tmpdir(), 'cauce-reload-'));
  const file = join(scratch, 'CLAUDE.md');
  try { await writeFile(file, 'before'); await run(file); }
  finally { await rm(scratch, { recursive: true, force: true }); }
}

describe('context reload claim exclusion and snapshot CAS', () => {

  it('holds a real claim until bytes, expectation, document journal and audit commit together', async () => {
    await withRuntimeBytes(async (file) => {
      const revision = await profileRevision();
      const docsBefore = (await pool.query<{ sha256: string }>('SELECT sha256 FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows;
      const auditBefore = (await pool.query("SELECT metadata FROM audit_events WHERE action='agent_document.write'")).rows;
      const lease = await repository.acquireLease(tenant, alias, 'during-reload', [], 30_000);
      await repository.publish(command());
      let entered = (): void => undefined;
      let finish = (): void => undefined;
      const atEffect = new Promise<void>((resolve) => { entered = resolve; });
      const barrier = new Promise<void>((resolve) => { finish = resolve; });
      const reload = repository.reconcileAgentContextRuntime({ mode: 'reload', tenantId: tenant, alias,
        expectedRevision: revision, expectedExpectation: contract(revision), apply: async () => {
          await writeFile(file, 'after'); entered(); await barrier;
          return effect(revision, 'committed');
        },
      });
      await atEffect;
      const claim = repository.claimDeliveries(tenant, alias, 'during-reload', acquiredEpoch(lease), 1, 30_000);
      try {
        await advisoryClaimWait();
        expect(await readFile(file, 'utf8')).toBe('after');
        expect((await pool.query<{ sha256: string }>('SELECT sha256 FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows).toEqual(docsBefore);
        await expect(repository.heartbeat(tenant, alias, 'during-reload', acquiredEpoch(lease), 30_000)).resolves.toEqual(expect.any(String));
      } finally { finish(); await Promise.allSettled([reload, claim]); }
      await expect(reload).resolves.toEqual({ state: 'committed', value: 'committed' });
      await expect(claim).resolves.toHaveLength(1);
      expect((await pool.query<{ sha256: string }>('SELECT sha256 FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows).toEqual([...docsBefore, { sha256: 'b'.repeat(64) }]);
      expect((await pool.query("SELECT metadata FROM audit_events WHERE action='agent_document.write'", [])).rows).toHaveLength(auditBefore.length + 1);
      expect((await pool.query<{ documents: unknown }>('SELECT documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0]?.documents).toEqual(contract(revision, 'b'.repeat(64)).documents);
    });
  });

  it('reloads a saved profile newer than its prior applied revision and generation', async () => {
    const previousRevision = await profileRevision();
    const previous = contract(previousRevision);
    await replaceProfile(previousRevision);
    const revision = await profileRevision();
    await expect(repository.reconcileAgentContextRuntime({ mode: 'reload', tenantId: tenant, alias,
      expectedRevision: revision, expectedExpectation: previous, apply: async () => effect(revision, 'applied'),
    })).resolves.toEqual({ state: 'committed', value: 'applied' });
  });

  it('keeps physical bytes unknown and rolls back all SQL after a post-write journal failure', async () => {
    await withRuntimeBytes(async (file) => {
      const revision = await profileRevision();
      const docsBefore = (await pool.query('SELECT 1 FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows;
      const auditBefore = (await pool.query("SELECT 1 FROM audit_events WHERE action='agent_document.write'")).rows;
      const result = await repository.reconcileAgentContextRuntime({ mode: 'reload', tenantId: tenant, alias,
        expectedRevision: revision, expectedExpectation: contract(revision), apply: async () => {
          await writeFile(file, 'after'); return effect(revision, 'not-committed', -1);
        },
      });
      expect(result).toEqual({ state: 'effect_unknown' });
      expect(await readFile(file, 'utf8')).toBe('after');
      expect((await pool.query<{ documents: unknown }>('SELECT documents FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0]?.documents).toEqual(contract(revision).documents);
      expect((await pool.query('SELECT 1 FROM agent_document_revisions WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows).toEqual(docsBefore);
      expect((await pool.query("SELECT 1 FROM audit_events WHERE action='agent_document.write'", [])).rows).toEqual(auditBefore);
    });
  });
});

describe('gateway reload with the canonical Store fence', () => {
  it('denies a real claim that arrives while preflight is preparing before changing bytes', async () => {
    await withRuntimeBytes(async (file) => {
      await pool.query('DELETE FROM agent_profile_runtime_expectations WHERE tenant_id=$1 AND alias=$2', [tenant, alias]);
      const lease = await repository.acquireLease(tenant, alias, 'gateway-late-claim', [], 30_000);
      await repository.publish(command());
      let prepared = (): void => undefined;
      let finish = (): void => undefined;
      const atPrepare = new Promise<void>((resolve) => { prepared = resolve; });
      const barrier = new Promise<void>((resolve) => { finish = resolve; });
      const unchanged = async () => ({
        profile: (await pool.query('SELECT to_jsonb(p) AS value FROM agent_profiles p WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows,
        profileJournal: (await pool.query('SELECT to_jsonb(j) AS value FROM agent_profile_revisions j WHERE tenant_id=$1 AND alias=$2 ORDER BY id', [tenant, alias])).rows,
        documents: (await pool.query('SELECT to_jsonb(d) AS value FROM agent_document_revisions d WHERE tenant_id=$1 AND alias=$2 ORDER BY id', [tenant, alias])).rows,
        expectation: (await pool.query('SELECT to_jsonb(e) AS value FROM agent_profile_runtime_expectations e WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows,
        audit: (await pool.query("SELECT to_jsonb(a) AS value FROM audit_events a WHERE tenant_id=$1 AND action IN ('agent_profile.write','agent_document.write') ORDER BY id", [tenant])).rows,
      });
      const before = await unchanged();
      const status = vi.fn(async (): Promise<never> => { throw new Error('Admission must precede writer status'); });
      const coordinator = new AgentContextWriteCoordinator(pool, {
        factsFor: async () => ({ source: 'measured', facts: { harness: 'claude', home: '/home/dev',
          generation: 'runtime-generation-a', containerId: 'own-runtime',
          writerInstanceId: randomUUID(), features: ['write_quiescence_v1'] } }),
        readGovernanceDocument: async () => { throw new Error('Admission must precede physical readback'); },
        listMemoryDirectory: async () => { throw new Error('This fixture has no memory directory'); },
        supportsDurableWrites: () => true, writeStatus: status,
      });
      const app = Fastify();
      const apply = vi.fn(async () => { await writeFile(file, 'after'); return []; });
      registerAgentContextReloadRoutes(app, {
        authorize: async () => ({ tenant_id: tenant, alias: 'kant' }),
        authorizeTarget: async () => ({ tenant_id: tenant, alias, enabled: true }),
        resolveOperator: () => ({ operator_id: 'own-fixture-operator', attributed: true }),
        readContext: (tenantId, targetAlias) => new AgentProfileRepository(pool).readContextWithPresence(tenantId, targetAlias),
        readRuntimeExpectation: async () => undefined,
        measureContext: async () => undefined,
        deliveryInFlight: async () => ({ count: 0, deliveries: [] }),
        coordinateWrite: (input) => coordinator.coordinate(input),
        recordAudit: async () => undefined,
        prepareRuntime: async () => {
          prepared(); await barrier;
          return { harness: 'claude', existentes: new Map(), materialize: (revision) => ({
            revision, harness: 'claude', documents: ['CLAUDE.md'], preview: [], apply,
            verification: { state: 'drifted', generation: 'runtime-generation-a', container_id: 'own-runtime',
              observed_at: new Date().toISOString(), documents: [{ name: 'CLAUDE.md', path,
                expected_sha: 'b'.repeat(64), observed_sha: null, expected_bytes: 5, observed_bytes: null, current: false }] },
          }) };
        },
      });
      const request = app.inject({ method: 'POST', url: `/v3/console/tenants/${tenant}/agents/${alias}/context/reload`,
        payload: { reason: 'reload the owned fixture context after a profile change' } });
      try {
        await atPrepare;
        expect(await repository.claimDeliveries(tenant, alias, 'gateway-late-claim', acquiredEpoch(lease), 1, 30_000)).toHaveLength(1);
        finish();
        const response = await request;
        expect(response.statusCode).toBe(409);
        expect(response.json<{ error: string }>()).toMatchObject({ error: 'conflict' });
        expect(apply).not.toHaveBeenCalled();
        expect(status).not.toHaveBeenCalled();
        expect(await readFile(file, 'utf8')).toBe('before');
        expect(await unchanged()).toEqual(before);
        expect((await pool.query("SELECT id FROM jobs WHERE tenant_id=$1 AND kind='system.context.write.quarantine.v1'", [tenant])).rows).toEqual([]);
      } finally { finish(); await Promise.allSettled([request]); await app.close(); }
    });
  });
});

describe('reload validation and reconciliation compatibility', () => {

  it('keeps strict reconciliation generation identity while reload alone can replace it', async () => {
    const revision = await profileRevision();
    const next = effect(revision, 'new generation');
    next.expectation.generation = 'next-generation';
    await expect(repository.reconcileAgentContextRuntime({ tenantId: tenant, alias,
      expectedRevision: revision, expectedExpectation: contract(revision), apply: async () => next,
    })).resolves.toEqual({ state: 'effect_unknown' });
    await expect(repository.reconcileAgentContextRuntime({ mode: 'reload', tenantId: tenant, alias,
      expectedRevision: revision, expectedExpectation: contract(revision), apply: async () => next,
    })).resolves.toEqual({ state: 'committed', value: 'new generation' });
  });
});
