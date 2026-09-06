import { randomUUID } from 'node:crypto';
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
  await pool.end();
  await database.container.stop();
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

  it('revalidates a lease after waiting for the agent capacity row', async () => {
    const lease = await repository.acquireLease(
      tenant, alias, 'capacity-wait-adapter', [], 250, { resume: true },
    );
    const epoch = acquiredEpoch(lease);
    await repository.publish(command());
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      `SELECT 1 FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenant, alias],
    );
    const claim = repository.claimDeliveries(
      tenant, alias, 'capacity-wait-adapter', epoch, 1, 30_000,
    );
    await new Promise((resolve) => setTimeout(resolve, 350));
    await blocker.query('COMMIT');
    blocker.release();

    await expect(claim).rejects.toMatchObject({ code: 'fenced' });
    expect((await pool.query<{ status: string }>(
      `SELECT status FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2`,
      [tenant, alias],
    )).rows).toEqual([{ status: 'pending' }]);
  });

  it('rejects an already in-flight delivery before invoking the runtime effect', async () => {
    const revision = await profileRevision();
    const expected = contract(revision);
    const lease = await repository.acquireLease(
      tenant, alias, 'context-busy-adapter', [], 30_000, { resume: true },
    );
    const epoch = acquiredEpoch(lease);
    await repository.publish(command());
    await repository.claimDeliveries(
      tenant, alias, 'context-busy-adapter', epoch, 1, 30_000,
    );
    const apply = vi.fn(async () => effect(revision, 'unexpected'));

    await expect(repository.reconcileAgentContextRuntime({
      tenantId: tenant,
      alias,
      expectedRevision: revision,
      expectedExpectation: expected,
      apply,
    })).rejects.toMatchObject({ code: 'conflict' });
    expect(apply).not.toHaveBeenCalled();
  });

  it('serializes a canonical profile writer behind the runtime effect', async () => {
    const revision = await profileRevision();
    const expected = contract(revision);
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
    const profiles = new AgentProfileRepository(pool);
    const current = await profiles.read(tenant, alias);
    const replacement = profiles.replace(
      { ...current, role_summary: 'A later desired profile' },
      revision,
      { tenant_id: tenant, alias: 'kant' },
    );
    const replacementState = await Promise.race([
      replacement.then(() => 'settled'),
      new Promise<'blocked'>((resolve) => setTimeout(() => { resolve('blocked'); }, 80)),
    ]);
    expect(replacementState).toBe('blocked');

    releaseEffect();
    await expect(reconcile).resolves.toEqual({ state: 'committed', value: 'committed' });
    await expect(replacement).resolves.toMatchObject({ revision: revision + 1 });
  });

  it('serializes a canonical expectation writer behind the runtime effect', async () => {
    const revision = await profileRevision();
    const expected = contract(revision);
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
    const later = contract(revision, 'd'.repeat(64));
    const replacement = repository.recordProfileRuntimeExpectation(tenant, alias, later);
    const replacementState = await Promise.race([
      replacement.then(() => 'settled'),
      new Promise<'blocked'>((resolve) => setTimeout(() => { resolve('blocked'); }, 80)),
    ]);
    expect(replacementState).toBe('blocked');

    releaseEffect();
    await expect(reconcile).resolves.toEqual({ state: 'committed', value: 'committed' });
    await replacement;
    const stored = await pool.query<{ documents: unknown }>(
      `SELECT documents FROM agent_profile_runtime_expectations
        WHERE tenant_id=$1 AND alias=$2`, [tenant, alias],
    );
    expect(stored.rows[0]?.documents).toEqual(later.documents);
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
