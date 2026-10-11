import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { VERSIONED_CONTEXT_CAPABILITY } from '@cauce/protocol';
import { CauceRepository, lockCompanyAuthority, type DatabasePool } from '@cauce/store';
import { ContextVersionStore, readContextVersion } from '../../../packages/store/src/context-version.js';
import { seedSyntheticCompanyContexts } from '../../../packages/store/src/seed-dev-cli.js';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { DeliveryContextRuntimeSink } from './context-version-runtime.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let store: ContextVersionStore;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); store = new ContextVersionStore(pool);
  await current.adminPool.query("UPDATE agents SET harness_id='codex' WHERE alias='director' AND tenant_id='ContextAlpha'");
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function target() { const value = fixtures[0]; if (!value) throw new Error('fixture absent'); return value; }
function source(client: import('@cauce/store').DatabaseClient) { const value = target(); return lockCompanyAuthority(client,
  { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
async function context() {
  await store.write(source, target().tenant_id, target().alias, { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: 'Read this context.' }] });
  const client = await pool.connect();
  try { return await readContextVersion(client, target(), 1); } finally { client.release(); }
}

describe('real bus application sink waits for consumed and fenced ACK', () => {
  it('publishes from the company director, reuses an outstanding request and observes only exact context adoption', async () => {
    const version = await context(); const repository = new CauceRepository(pool);
    const lease = await repository.acquireLease(target().tenant_id, target().alias, 'native-context-consumer', [VERSIONED_CONTEXT_CAPABILITY], 60_000);
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
    expect((await store.read(source, target().tenant_id, target().alias)).applied_version).toBe(0);
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
    expect((await store.read(source, target().tenant_id, target().alias)).applied_version).toBe(0);
  });
  it('never borrows a director from another company when the target company lacks one', async () => {
    const version = await context();
    if (!current) throw new Error('database unavailable');
    await current.adminPool.query("DELETE FROM company_system_principals WHERE company_id='context_alpha' AND kind='director'");
    await expect(new DeliveryContextRuntimeSink(pool, 50).apply(version)).rejects.toThrow('director is unavailable');
    expect((await pool.query("SELECT count(*)::integer AS count FROM messages WHERE auth_channel='context-broker'")).rows).toEqual([{ count: 0 }]);
  });
});
