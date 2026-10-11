import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { VERSIONED_CONTEXT_CAPABILITY, type Ack, type DeliveryEnvelope } from '@cauce/protocol';
import { CauceRepository, lockCompanyAuthority, type DatabasePool } from '../src/index.js';
import { ContextVersionStore } from '../src/context-version.js';
import { processContextOutbox } from '../src/context-version-worker.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let store: ContextVersionStore; let repository: CauceRepository;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool); repository = new CauceRepository(pool);
  await current.adminPool.query("UPDATE agents SET harness_id='codex' WHERE alias='director' AND tenant_id IN ('ContextAlpha','ContextBeta')");
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function target() { const value = fixtures[0]; if (!value) throw new Error('fixture absent'); return value; }
function source(client: import('../src/db.js').DatabaseClient) { const value = target(); return lockCompanyAuthority(client,
  { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
const files = [{ path: 'context/mission.md', content: 'Use the current scoped context.' }];
const write = (expected = 0) => store.write(source, target().tenant_id, target().alias, { expected_version: expected, source: 'ui', files });
async function claim(capabilities = [VERSIONED_CONTEXT_CAPABILITY]) {
  const value = target(); const instanceId = 'context-adapter';
  const lease = await repository.acquireLease(value.tenant_id, value.alias, instanceId, capabilities, 60_000, { resume: true });
  if (!lease.acquired || !lease.epoch) throw new Error('lease unavailable');
  await repository.publish({ version: '3.0', request_id: randomUUID(), trace_id: randomUUID(), tenant_id: value.tenant_id,
    room_id: 'context-room', actor_alias: 'owner', recipients: [{ tenant_id: value.tenant_id, alias: value.alias }],
    body: { type: 'command', text: 'Consume the current context.' }, lane: 'interactive', priority: 0, idempotency_key: randomUUID() });
  const [delivery] = await repository.claimDeliveries(value.tenant_id, value.alias, instanceId, lease.epoch, 1, 60_000);
  if (!delivery) throw new Error('claim unavailable');
  return { delivery, epoch: lease.epoch, instanceId };
}
function ack(claimed: { delivery: DeliveryEnvelope; epoch: number; instanceId: string }, result: Record<string, unknown>, status: Ack['status'] = 'done'): Ack {
  return { version: '3.0', event_id: randomUUID(), instance_id: claimed.instanceId, epoch: claimed.epoch,
    attempt: claimed.delivery.attempt, claim_token: claimed.delivery.claim_token, status, retryable: false,
    result: { output: { reply: 'Context consumed', messages: [], notify: [], status, retryable: false, artifacts: [] }, ...result } };
}
function proof(delivery: DeliveryEnvelope) {
  const context = delivery.versioned_context;
  if (!context) throw new Error('context absent');
  return { context_adoption: { version: context.version, digest: context.digest, input_sha256: 'a'.repeat(64) },
    harness_consumption_v1: { version: 1, harness_id: 'codex', native_session_id: 'context-session', native_turn_id: randomUUID(),
      input_sha256: 'a'.repeat(64), evidence_kind: 'canonical_final_response' } };
}
const send = (claimed: Awaited<ReturnType<typeof claim>>, result: Record<string, unknown>, status?: Ack['status']) =>
  repository.ackDelivery(claimed.delivery.delivery_id, target().tenant_id, target().alias, ack(claimed, result, status));

describe('versioned context adoption through the fenced delivery ACK', () => {
  it('negotiates exact context and accepts a consumed turn while the application worker awaits the ACK without holding target locks', async () => {
    await write(); const claimed = await claim();
    expect(claimed.delivery.versioned_context).toMatchObject({ company_id: 'context_alpha', tenant_id: 'ContextAlpha', alias: 'director', version: 1 });
    expect(claimed.delivery.versioned_context?.files).toEqual(expect.arrayContaining(files));
    const result = await processContextOutbox(pool, { git: { commit: async () => 'b'.repeat(40), push: async () => undefined }, runtime: {
      apply: async version => {
        expect((await send(claimed, proof(claimed.delivery))).applied).toBe(true);
        expect((await store.read(source, target().tenant_id, target().alias)).applied_version).toBe(1);
        return { version: version.version, digest: version.digest };
      },
    } });
    expect(result).toMatchObject({ state: 'synced', version: 1 });
    expect((await pool.query('SELECT apply_token,apply_lease_until FROM agent_context_outbox')).rows).toEqual([{ apply_token: null, apply_lease_until: null }]);
  });
  it('does not add context to an older consumer or accept a claimed version without matching consumption evidence', async () => {
    await write(); const legacy = await claim([]);
    expect(legacy.delivery.versioned_context).toBeUndefined();
    await send(legacy, {});
    const claimed = await claim(); const evidence = proof(claimed.delivery);
    await send(claimed, { ...evidence, context_adoption: { ...evidence.context_adoption, input_sha256: 'c'.repeat(64) } });
    expect((await store.read(source, target().tenant_id, target().alias)).applied_version).toBe(0);
  });
  it.each(['digest', 'harness', 'failed', 'late'] as const)('keeps applied unchanged for %s evidence', async kind => {
    await write(); const claimed = await claim(); const evidence = proof(claimed.delivery);
    if (kind === 'digest') evidence.context_adoption.digest = '0'.repeat(64);
    if (kind === 'harness') evidence.harness_consumption_v1.harness_id = 'claude';
    if (kind === 'late') {
      if (!current) throw new Error('database unavailable');
      await current.adminPool.query("UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1", [claimed.delivery.delivery_id]);
    }
    await send(claimed, evidence, kind === 'failed' ? 'failed' : 'done');
    expect((await store.read(source, target().tenant_id, target().alias)).applied_version).toBe(0);
  });
  it('fences duplicate applications with a durable lease and recovers an expired lease', async () => {
    await write(); const claimed = await claim(); let entered!: () => void; let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; }); const blocked = new Promise<void>(resolve => { release = resolve; });
    const git = { commit: async () => 'b'.repeat(40), push: async () => undefined };
    const pending = processContextOutbox(pool, { git, runtime: { apply: async version => { entered(); await blocked; return { version: version.version, digest: version.digest }; } } });
    await started;
    expect(await processContextOutbox(pool, { git, runtime: { apply: async () => { throw new Error('duplicate runtime'); } } })).toEqual({ state: 'idle' });
    if (!current) throw new Error('database unavailable');
    await current.adminPool.query("UPDATE agent_context_outbox SET apply_lease_until=now()-interval '1 second'");
    const recovered = await processContextOutbox(pool, { git, runtime: { apply: async version => { await send(claimed, proof(claimed.delivery)); return { version: version.version, digest: version.digest }; } } });
    expect(recovered).toMatchObject({ state: 'synced', version: 1 });
    release(); expect(await pending).toMatchObject({ state: 'pending', version: 1 });
    expect((await store.read(source, target().tenant_id, target().alias)).applied_version).toBe(1);
  });
});
