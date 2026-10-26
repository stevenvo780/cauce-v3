import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { CONTEXT_ADOPTION_CAPABILITY, VERSIONED_CONTEXT_CAPABILITY, type DeliveryEnvelope } from '@cauce/protocol';
import { CauceRepository, ContextRuntimeUnsupportedError, lockCompanyAuthority, processContextOutbox, requestContextApplication,
  settleContextApplications, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { ContextVersionStore, readContextVersion } from '../../../packages/store/src/context-version.js';
import { seedSyntheticCompanyContexts } from '../../../packages/store/src/seed-dev-cli.js';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { DeliveryContextRuntimeSink } from './context-version-runtime.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let store: ContextVersionStore; let repository: CauceRepository;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool); repository = new CauceRepository(pool);
  await current.adminPool.query("UPDATE agents SET harness_id='codex' WHERE alias='director' AND tenant_id IN ('ContextAlpha','ContextBeta')");
});
afterEach(async () => { if (current) await settleContextApplications(current.pool); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const READY = [VERSIONED_CONTEXT_CAPABILITY, 'harness.codex'];
const git = { commit: async () => 'b'.repeat(40), push: async () => undefined };
function target(index = 0) { const value = fixtures[index]; if (!value) throw new Error('fixture absent'); return value; }
function source(index = 0) { const value = target(index); return (client: DatabaseClient) => lockCompanyAuthority(client,
  { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
async function context(index = 0, expected = 0) {
  await store.write(source(index), target(index).tenant_id, target(index).alias,
    { expected_version: expected, source: 'ui', files: [{ path: 'context/mission.md', content: `Read this context ${String(expected + 1)}.` }] });
  const client = await pool.connect();
  try { return await readContextVersion(client, target(index), expected + 1); } finally { client.release(); }
}
const retry = (index = 0) => store.retry(source(index), target(index).tenant_id, target(index).alias);
/** «Aplicar al agente», as the console route asks for it. */
const request = async (index = 0) => { await requestContextApplication(pool, await retry(index)); };
const applied = async (index = 0) => (await store.read(source(index), target(index).tenant_id, target(index).alias)).applied_version;
async function lease(index: number, capabilities: string[]) {
  const value = await repository.acquireLease(target(index).tenant_id, target(index).alias, `native-context-consumer-${String(index)}`, capabilities, 60_000);
  if (!value.acquired || !value.epoch) throw new Error('consumer lease unavailable');
  return value.epoch;
}
async function claim(index: number, epoch: number) {
  for (let retry = 0; retry < 100; retry++) {
    const [delivery] = await repository.claimDeliveries(target(index).tenant_id, target(index).alias, `native-context-consumer-${String(index)}`, epoch, 1, 60_000);
    if (delivery) return delivery;
    await new Promise<void>(resolve => { setTimeout(resolve, 10); });
  }
  throw new Error('context request was not delivered');
}
async function ack(index: number, epoch: number, delivery: DeliveryEnvelope, witnessed: boolean) {
  const context = delivery.versioned_context;
  if (!context) throw new Error('versioned context absent');
  await repository.ackDelivery(delivery.delivery_id, target(index).tenant_id, target(index).alias, {
    version: '3.0', event_id: randomUUID(), status: 'done', instance_id: `native-context-consumer-${String(index)}`, epoch,
    attempt: delivery.attempt, claim_token: delivery.claim_token, retryable: false,
    result: { output: { reply: 'Context consumed', messages: [], notify: [], status: 'done', retryable: false, artifacts: [] },
      ...(witnessed ? { context_adoption: { version: context.version, digest: context.digest, input_sha256: 'a'.repeat(64) },
        harness_consumption_v1: { version: 1, harness_id: 'codex', native_session_id: 'native-context-session', native_turn_id: randomUUID(),
          input_sha256: 'a'.repeat(64), evidence_kind: 'canonical_final_response' } } : {}) },
  });
}
async function naturalTurn(index: number, epoch: number) {
  await repository.publish({ version: '3.0', request_id: randomUUID(), trace_id: randomUUID(), tenant_id: target(index).tenant_id,
    room_id: 'context-room', actor_alias: 'owner', recipients: [{ tenant_id: target(index).tenant_id, alias: target(index).alias }],
    body: { type: 'command', text: 'Ordinary work.' }, lane: 'interactive', priority: 0, idempotency_key: randomUUID() });
  return claim(index, epoch);
}
async function turns(index = 0): Promise<number> {
  return (await pool.query<{ count: number }>(`SELECT count(*)::integer AS count FROM messages message JOIN deliveries delivery
    ON delivery.message_id=message.id WHERE message.auth_channel='context-broker' AND delivery.recipient_tenant=$1`,
  [target(index).tenant_id])).rows[0]?.count ?? 0;
}
async function outbox(index = 0) {
  const row = (await pool.query<{ apply_error: string | null; applied: boolean; leased: boolean; parked: boolean; retry_in: number | null }>(
    `SELECT apply_error,applied_at IS NOT NULL AS applied,apply_token IS NOT NULL AS leased,apply_retry_at>clock_timestamp() AS parked,
      CASE WHEN isfinite(apply_retry_at) THEN EXTRACT(EPOCH FROM apply_retry_at-clock_timestamp())::float8 END AS retry_in
    FROM agent_context_outbox WHERE tenant_id=$1 ORDER BY version DESC LIMIT 1`, [target(index).tenant_id])).rows[0];
  if (!row) throw new Error('context outbox absent');
  return row;
}

describe('real bus application sink waits for consumed and fenced ACK', () => {
  it('publishes from the company director, reuses an outstanding request and observes only exact context adoption', async () => {
    const version = await context();
    const lease = await repository.acquireLease(target().tenant_id, target().alias, 'native-context-consumer', READY, 60_000);
    if (!lease.acquired || !lease.epoch) throw new Error('consumer lease unavailable');
    const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    const applying = runtime.apply(version);
    let delivery;
    for (let retry = 0; retry < 100; retry++) {
      [delivery] = await repository.claimDeliveries(target().tenant_id, target().alias, 'native-context-consumer', lease.epoch, 1, 60_000);
      if (delivery) break;
      await new Promise<void>(resolve => { setTimeout(resolve, 10); });
    }
    if (!delivery) throw new Error('context request was not delivered');
    expect(delivery.actor_alias).toBe('director');
    expect(delivery.origin?.adapter).toBe('context-broker');
    expect(delivery.versioned_context).toMatchObject({ version: 1, digest: version.digest, company_id: 'context_alpha' });
    expect(await applied()).toBe(0);
    const repeated = runtime.apply(version);
    await repository.ackDelivery(delivery.delivery_id, target().tenant_id, target().alias, {
      version: '3.0', event_id: randomUUID(), status: 'done', instance_id: 'native-context-consumer', epoch: lease.epoch,
      attempt: delivery.attempt, claim_token: delivery.claim_token, retryable: false,
      result: { output: { reply: 'Context consumed', messages: [], notify: [], status: 'done', retryable: false, artifacts: [] },
        context_adoption: { version: 1, digest: version.digest, input_sha256: 'a'.repeat(64) },
        harness_consumption_v1: { version: 1, harness_id: 'codex', native_session_id: 'native-context-session', native_turn_id: 'native-context-turn',
          input_sha256: 'a'.repeat(64), evidence_kind: 'canonical_final_response' } },
    });
    expect(await applying).toEqual({ version: 1, digest: version.digest });
    expect(await repeated).toEqual({ version: 1, digest: version.digest });
    expect((await pool.query("SELECT count(*)::integer AS count FROM messages WHERE auth_channel='context-broker'")).rows).toEqual([{ count: 1 }]);
  });
  it('leaves the desired version pending when the agent does not provide a consumed turn', async () => {
    const version = await context();
    await expect(new DeliveryContextRuntimeSink(pool, 50).apply(version)).rejects.toThrow('consumed-turn evidence');
    expect(await applied()).toBe(0);
  });
  it('never borrows a director from another company when the target company lacks one', async () => {
    const version = await context();
    if (!current) throw new Error('database unavailable');
    await current.adminPool.query("DELETE FROM company_system_principals WHERE company_id='context_alpha' AND kind='director'");
    await expect(new DeliveryContextRuntimeSink(pool, 50).apply(version)).rejects.toThrow('director is unavailable');
    expect((await pool.query("SELECT count(*)::integer AS count FROM messages WHERE auth_channel='context-broker'")).rows).toEqual([{ count: 0 }]);
  });
});

describe('bounded application of versioned context to the live agent', () => {
  it('waits for the next natural turn and spends a dedicated turn only on an operator request', async () => {
    await context(); const epoch = await lease(0, READY); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'idle' });
    expect(await outbox()).toMatchObject({ apply_error: null, leased: false, parked: true });
    expect(await turns()).toBe(0);
    const natural = await naturalTurn(0, epoch);
    expect(natural.versioned_context).toMatchObject({ version: 1 });
    await ack(0, epoch, natural, true);
    expect(await applied()).toBe(1);

    await context(0, 1);
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 2 });
    expect(await turns()).toBe(0);
    await request();
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 2 });
    const dedicated = await claim(0, epoch);
    expect(dedicated.origin?.adapter).toBe('context-broker');
    await ack(0, epoch, dedicated, true);
    await settleContextApplications(pool);
    expect(await applied()).toBe(2);
    expect(await turns()).toBe(1);
  });
  it('retries a sync without spending a dedicated turn on the version left to the natural turn', async () => {
    await context(); await lease(0, READY); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    await retry();
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    await settleContextApplications(pool);
    expect(await turns()).toBe(0);
    expect(await outbox()).toMatchObject({ apply_error: null, leased: false, parked: true });
  });
  it('probes again a version left to the natural turn and shows why when the agent returns without the capability', async () => {
    await context(); await lease(0, READY); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    const parked = await outbox();
    expect(parked).toMatchObject({ apply_error: null, parked: true });
    expect(parked.retry_in).toBeGreaterThan(290); expect(parked.retry_in).toBeLessThanOrEqual(300);
    await pool.query("UPDATE connection_leases SET capabilities='[\"harness.codex\"]'::jsonb WHERE tenant_id=$1", [target().tenant_id]);
    await pool.query('UPDATE agent_context_outbox SET apply_retry_at=now() WHERE isfinite(apply_retry_at)');
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'error', version: 1, error: 'context_runtime_unsupported' });
    expect(await turns()).toBe(0);
    expect((await store.read(source(), target().tenant_id, target().alias)).application)
      .toEqual({ state: 'error', last_error: 'context_runtime_unsupported' });
  });
  it.each([
    ['that does not negotiate versioned context', ['harness.codex']],
    ['whose harness cannot witness its turn', [VERSIONED_CONTEXT_CAPABILITY, 'harness.hermes']],
    // The Praxis case: headless Muse and a pre-witness Grok adapter announce versioned context but never return a witness.
    ['whose runner does not accredit adoption (headless Muse)', [VERSIONED_CONTEXT_CAPABILITY, 'harness.muse']],
    ['whose release predates its witness (Grok)', [VERSIONED_CONTEXT_CAPABILITY, 'harness.grok']],
    ['whose release cannot read its V4 profile (OpenClaw)', [VERSIONED_CONTEXT_CAPABILITY, 'harness.openclaw']],
  ])('refuses an agent %s without publishing a turn and shows why', async (_case, capabilities) => {
    const version = await context(); await lease(0, capabilities); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    const refused = { state: 'error', version: 1, error: 'context_runtime_unsupported' };
    expect(await processContextOutbox(pool, { git, runtime })).toEqual(refused);
    await request();
    expect(await processContextOutbox(pool, { git, runtime })).toEqual(refused);
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'idle' });
    await expect(runtime.apply(version)).rejects.toBeInstanceOf(ContextRuntimeUnsupportedError);
    expect(await turns()).toBe(0);
    expect(await outbox()).toMatchObject({ apply_error: 'context_runtime_unsupported', leased: false, parked: true });
    expect((await store.read(source(), target().tenant_id, target().alias)).application)
      .toEqual({ state: 'error', last_error: 'context_runtime_unsupported' });
    expect((await pool.query("SELECT decision,metadata->>'error_code' AS code FROM audit_events WHERE action='context.apply'")).rows)
      .toEqual([{ decision: 'deny', code: 'context_runtime_unsupported' }, { decision: 'deny', code: 'context_runtime_unsupported' }]);
  });
  it('an adapter that accredits adoption at runtime gets the natural turn and adopts', async () => {
    await context(); const epoch = await lease(0, [VERSIONED_CONTEXT_CAPABILITY, CONTEXT_ADOPTION_CAPABILITY, 'harness.grok']);
    const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    expect(await outbox()).toMatchObject({ apply_error: null, parked: true });
    expect(await turns()).toBe(0);
    await ack(0, epoch, await naturalTurn(0, epoch), true);
    expect(await applied()).toBe(1);
  });
  it.each(['resume', 'takeover', 'reconnect'] as const)('reevaluates an unsupported version when a capable lease returns by %s', async mode => {
    await context(); await lease(0, ['harness.codex']); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    expect(await processContextOutbox(pool, { git, runtime })).toMatchObject({ error: 'context_runtime_unsupported' });
    expect(await outbox()).toMatchObject({ apply_error: 'context_runtime_unsupported', parked: true });
    if (mode === 'reconnect') await pool.query('UPDATE connection_leases SET lease_until=now()');
    const returned = await repository.acquireLease(target().tenant_id, target().alias, 'native-context-consumer-0', READY, 60_000,
      mode === 'resume' ? { resume: true } : mode === 'takeover' ? { takeover: true } : {});
    if (!returned.acquired || !returned.epoch) throw new Error('consumer lease unavailable');
    expect(await outbox()).toMatchObject({ apply_error: null, parked: false });
    expect((await store.read(source(), target().tenant_id, target().alias)).application).toEqual({ state: 'pending', last_error: null });
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    expect(await turns()).toBe(0);
    expect(await applied()).toBe(0);
    await ack(0, returned.epoch, await naturalTurn(0, returned.epoch), true);
    expect(await applied()).toBe(1);
  });
  it('recovers an already capable parked lease on its next fenced heartbeat', async () => {
    await context(); const epoch = await lease(0, READY);
    await pool.query("UPDATE agent_context_outbox SET apply_error='context_runtime_unsupported',apply_retry_at='infinity'");
    await repository.heartbeat(target().tenant_id, target().alias, 'native-context-consumer-0', epoch, 60_000);
    expect(await outbox()).toMatchObject({ apply_error: null, parked: false });
    expect(await applied()).toBe(0);
    expect(await turns()).toBe(0);
  });
  it('retains the refusal until both capabilities are announced and preserves other terminal failures', async () => {
    await context(); await lease(0, ['harness.codex']); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    await processContextOutbox(pool, { git, runtime });
    await repository.acquireLease(target().tenant_id, target().alias, 'native-context-consumer-0', [VERSIONED_CONTEXT_CAPABILITY], 60_000, { resume: true });
    expect(await outbox()).toMatchObject({ apply_error: 'context_runtime_unsupported', parked: true });
    await pool.query("UPDATE agent_context_outbox SET apply_error='context_runtime_attempts_exhausted'");
    await repository.acquireLease(target().tenant_id, target().alias, 'native-context-consumer-0', READY, 60_000, { resume: true });
    expect(await outbox()).toMatchObject({ apply_error: 'context_runtime_attempts_exhausted', parked: true });
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'idle' });
    expect(await turns()).toBe(0);
  });
  it('does not reopen a superseded refusal when the current version is already adopted', async () => {
    await context(); await lease(0, ['harness.codex']); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    await processContextOutbox(pool, { git, runtime });
    await context(0, 1);
    await pool.query("UPDATE agent_context_outbox SET apply_error='context_runtime_unsupported',apply_retry_at='infinity',applied_at=now() WHERE version=2");
    await repository.acquireLease(target().tenant_id, target().alias, 'native-context-consumer-0', READY, 60_000, { resume: true });
    expect((await pool.query('SELECT version::integer,apply_error FROM agent_context_outbox ORDER BY version')).rows).toEqual([
      { version: 1, apply_error: 'context_runtime_unsupported' }, { version: 2, apply_error: 'context_runtime_unsupported' }]);
  });
  it('requires successful lease fencing and never replaces a live application reservation', async () => {
    await context(); const epoch = await lease(0, ['harness.codex']); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    await processContextOutbox(pool, { git, runtime });
    expect((await repository.acquireLease(target().tenant_id, target().alias, 'other-consumer', READY, 60_000)).acquired).toBe(false);
    await expect(repository.heartbeat(target().tenant_id, target().alias, 'native-context-consumer-0', epoch + 1, 60_000)).rejects.toThrow('fencing');
    expect(await outbox()).toMatchObject({ apply_error: 'context_runtime_unsupported', parked: true });
    await pool.query("UPDATE agent_context_outbox SET apply_token=gen_random_uuid(),apply_lease_until=now()+interval '1 minute'");
    await repository.acquireLease(target().tenant_id, target().alias, 'native-context-consumer-0', READY, 60_000, { resume: true });
    expect(await outbox()).toMatchObject({ apply_error: 'context_runtime_unsupported', parked: true, leased: true });
    await pool.query('UPDATE agent_context_outbox SET apply_lease_until=now()');
    await repository.heartbeat(target().tenant_id, target().alias, 'native-context-consumer-0', epoch, 60_000);
    expect(await outbox()).toMatchObject({ apply_error: null, parked: false });
  });
  it('does not queue a dedicated turn for an offline agent on request', async () => {
    await context(); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    await request();
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'error', version: 1, error: 'context_runtime_offline' });
    expect(await turns()).toBe(0);
    expect(await outbox()).toMatchObject({ apply_error: 'context_runtime_offline', parked: true });
  });
  it('re-arms an offline refusal when the agent returns and leaves it to the natural turn', async () => {
    await context(); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    await request();
    expect(await processContextOutbox(pool, { git, runtime })).toMatchObject({ error: 'context_runtime_offline' });
    const epoch = await lease(0, READY);
    expect(await outbox()).toMatchObject({ apply_error: null, parked: false });
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    expect(await turns()).toBe(0);
    await ack(0, epoch, await naturalTurn(0, epoch), true);
    expect(await applied()).toBe(1);
  });
  it('an offline refusal answered by a lease without the capability becomes the honest unsupported refusal', async () => {
    await context(); const runtime = new DeliveryContextRuntimeSink(pool, 5_000);
    await request();
    expect(await processContextOutbox(pool, { git, runtime })).toMatchObject({ error: 'context_runtime_offline' });
    await lease(0, ['harness.codex']);
    expect(await outbox()).toMatchObject({ apply_error: null, parked: false });
    expect(await processContextOutbox(pool, { git, runtime })).toMatchObject({ error: 'context_runtime_unsupported' });
    expect(await outbox()).toMatchObject({ apply_error: 'context_runtime_unsupported', parked: true });
    expect(await turns()).toBe(0);
  });
  it('ends in a terminal error after three dedicated turns without a witness, waiting longer before each retry', async () => {
    await context(); const epoch = await lease(0, READY); const runtime = new DeliveryContextRuntimeSink(pool, 300);
    await request();
    const waits: (number | null)[] = [];
    for (let attempt = 1; attempt <= 3; attempt++) {
      expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
      await ack(0, epoch, await claim(0, epoch), false);
      await settleContextApplications(pool);
      const row = await outbox();
      waits.push(row.retry_in);
      expect(row.apply_error).toBe(attempt < 3 ? 'context_runtime_verification_failed' : 'context_runtime_attempts_exhausted');
      expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'idle' });
      if (attempt < 3) await pool.query('UPDATE agent_context_outbox SET apply_retry_at=now()');
    }
    expect(waits[0]).toBeGreaterThan(55); expect(waits[0]).toBeLessThanOrEqual(60);
    expect(waits[1]).toBeGreaterThan(115); expect(waits[1]).toBeLessThanOrEqual(120);
    expect(waits[2]).toBeNull();
    expect(await outbox()).toMatchObject({ applied: false, leased: false, parked: true });
    expect(await turns()).toBe(3);
    expect((await pool.query(`SELECT (metadata->>'attempt')::integer AS attempt,metadata->>'error_code' AS code
      FROM audit_events WHERE action='context.apply' ORDER BY id`)).rows).toEqual([
      { attempt: 1, code: 'context_runtime_verification_failed' }, { attempt: 2, code: 'context_runtime_verification_failed' },
      { attempt: 3, code: 'context_runtime_attempts_exhausted' }]);
  });
  it('applies a second agent while the first one still awaits the ACK of its dedicated turn', async () => {
    await context(0); await context(1);
    const epochs = [await lease(0, READY), await lease(1, READY)] as const;
    await request(0); await request(1);
    const runtime = new DeliveryContextRuntimeSink(pool, 4_000); const started = Date.now();
    expect(await processContextOutbox(pool, { git, runtime }, target(0))).toEqual({ state: 'pending', version: 1 });
    expect(await processContextOutbox(pool, { git, runtime })).toEqual({ state: 'pending', version: 1 });
    await ack(1, epochs[1], await claim(1, epochs[1]), true);
    expect(await applied(1)).toBe(1);
    expect(Date.now() - started).toBeLessThan(4_000);
    expect(await outbox(0)).toMatchObject({ applied: false, leased: true });
    expect([await turns(0), await turns(1)]).toEqual([1, 1]);
    await settleContextApplications(pool);
    expect(await outbox(0)).toMatchObject({ apply_error: 'context_runtime_verification_failed', leased: false });
    expect(await outbox(1)).toMatchObject({ apply_error: null, applied: true, leased: false });
  });
});
