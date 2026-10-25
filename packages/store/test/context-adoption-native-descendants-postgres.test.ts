import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { randomUUID } from 'node:crypto';
import { VERSIONED_CONTEXT_CAPABILITY } from '@cauce/protocol';
import { CauceRepository, lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { ContextVersionStore, ingestNativeContextVersion, lockContextTarget, persistContextVersionInTransaction } from '../src/context-version.js';
import { withTransaction } from '../src/db.js';
import type { ContextSnapshot } from '../src/context-version-model.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

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
function source(client: DatabaseClient) { const value = target(); return lockCompanyAuthority(client,
  { tenant: value.tenant_id, alias: 'owner', humanId: value.human_id }); }
const write = (expected: number, content: string) => store.write(source, target().tenant_id, target().alias,
  { expected_version: expected, source: 'ui', files: [{ path: 'context/mission.md', content }] });
async function claimedNativeBase() {
  const initial = await write(0, 'Native chain base.');
  const repository = new CauceRepository(pool); const instance = 'zz-canary-native-chain';
  const lease = await repository.acquireLease(target().tenant_id, target().alias, instance, [VERSIONED_CONTEXT_CAPABILITY, 'harness.codex'], 60_000);
  if (!lease.acquired || !lease.epoch) throw new Error('consumer lease unavailable');
  await repository.publish({ version: '3.0', request_id: randomUUID(), trace_id: randomUUID(), tenant_id: target().tenant_id,
    room_id: 'context-room', actor_alias: 'owner', recipients: [{ tenant_id: target().tenant_id, alias: target().alias }],
    body: { type: 'command', text: 'Consume the native edit.' }, lane: 'interactive', priority: 0, idempotency_key: randomUUID() });
  const [delivery] = await repository.claimDeliveries(target().tenant_id, target().alias, instance, lease.epoch, 1, 60_000);
  if (!delivery) throw new Error('native base was not delivered');
  return { repository, instance, epoch: lease.epoch, delivery, initial };
}
async function nativeEdit(base: ContextSnapshot, content: string) {
  const result = await ingestNativeContextVersion(pool, target().tenant_id, target().alias, { base_version: base.version,
    files: [...base.files.filter(file => file.path !== 'context/notes/native.md'), { path: 'context/notes/native.md', content }] });
  if (result.state !== 'ingested') throw new Error('native fixture was not ingested');
  return result.snapshot;
}
async function acknowledgeNative(claimed: Awaited<ReturnType<typeof claimedNativeBase>>, version: number, digest: string) {
  return claimed.repository.ackDelivery(claimed.delivery.delivery_id, target().tenant_id, target().alias, {
    version: '3.0', event_id: randomUUID(), status: 'done', instance_id: claimed.instance, epoch: claimed.epoch,
    attempt: claimed.delivery.attempt, claim_token: claimed.delivery.claim_token, retryable: false,
    result: { output: { reply: 'Native context consumed.', messages: [], notify: [], status: 'done', retryable: false, artifacts: [] },
      context_adoption: { version, digest, input_sha256: 'a'.repeat(64) },
      harness_consumption_v1: { version: 1, harness_id: 'codex', native_session_id: 'zz-canary-session', native_turn_id: randomUUID(),
        input_sha256: 'a'.repeat(64), evidence_kind: 'canonical_final_response' } },
  });
}

describe('a fenced turn adopts only its own native descendants of the attached context', () => {
  it('adopts a contiguous native chain with the final digest and preserves the originally delivered version', async () => {
    const claimed = await claimedNativeBase();
    const second = await nativeEdit(claimed.initial, 'First native edit.');
    const third = await nativeEdit(second, 'Second native edit.');
    expect((await acknowledgeNative(claimed, third.version, third.digest ?? '')).applied).toBe(true);
    expect(await store.read(source, target().tenant_id, target().alias)).toMatchObject({ desired_version: 3, applied_version: 3 });
    expect((await pool.query(`SELECT context_version::integer,context_digest FROM deliveries WHERE id=$1`, [claimed.delivery.delivery_id])).rows)
      .toEqual([{ context_version: 1, context_digest: claimed.initial.digest }]);
    expect((await pool.query(`SELECT version::integer,applied_at IS NOT NULL AS applied FROM agent_context_outbox ORDER BY version`)).rows)
      .toEqual([{ version: 1, applied: false }, { version: 2, applied: false }, { version: 3, applied: true }]);
    expect((await pool.query("SELECT metadata FROM audit_events WHERE action='context.adopted'")).rows)
      .toMatchObject([{ metadata: { delivered_version: 1, version: 3, digest: third.digest } }]);
  });
  it('records the consumed native descendant while a newer server version remains pending', async () => {
    const claimed = await claimedNativeBase(); const second = await nativeEdit(claimed.initial, 'Consumed native edit.');
    await write(2, 'Newer operator instruction.');
    await acknowledgeNative(claimed, second.version, second.digest ?? '');
    expect(await store.read(source, target().tenant_id, target().alias)).toMatchObject({ desired_version: 3, applied_version: 2 });
  });
  it.each(['ui', 'mixed', 'foreign_actor', 'human_actor', 'foreign_target', 'future', 'digest', 'anchor', 'desired'] as const)(
    'rejects %s descendants without recording context adoption', async kind => {
      const claimed = await claimedNativeBase(); let candidate: ContextSnapshot;
      if (kind === 'ui' || kind === 'mixed') {
        candidate = await write(1, 'Operator change.');
        if (kind === 'mixed') candidate = await nativeEdit(candidate, 'Native edit after the operator change.');
      } else if (kind === 'foreign_actor' || kind === 'human_actor') {
        candidate = await withTransaction(pool, async client => {
          await lockContextTarget(client, target());
          return persistContextVersionInTransaction(client, target(), { homeTenant: target().tenant_id,
            alias: kind === 'foreign_actor' ? 'owner' : target().alias, humanId: kind === 'human_actor' ? target().human_id : null },
          1, claimed.initial.files, 'native');
        });
      } else if (kind === 'foreign_target') {
        const foreign = fixtures[1]; if (!foreign) throw new Error('foreign fixture absent');
        candidate = await withTransaction(pool, async client => {
          await lockContextTarget(client, foreign);
          const actor = { homeTenant: foreign.tenant_id, alias: foreign.alias, humanId: null };
          await persistContextVersionInTransaction(client, foreign, actor, 0, [{ path: 'context/notes/foreign.md', content: 'Foreign base.' }], 'native');
          return persistContextVersionInTransaction(client, foreign, actor, 1, [{ path: 'context/notes/foreign.md', content: 'Foreign descendant.' }], 'native');
        });
      } else candidate = await nativeEdit(claimed.initial, 'Native edit.');
      if (kind === 'anchor') await pool.query('UPDATE deliveries SET context_digest=$2 WHERE id=$1', [claimed.delivery.delivery_id, '0'.repeat(64)]);
      if (kind === 'desired') await pool.query('UPDATE agent_context_state SET desired_version=1');
      await acknowledgeNative(claimed, kind === 'future' ? candidate.version + 1 : candidate.version,
        kind === 'digest' ? '0'.repeat(64) : candidate.digest ?? '');
      expect((await store.read(source, target().tenant_id, target().alias)).applied_version).toBe(0);
      expect((await pool.query("SELECT 1 FROM audit_events WHERE action='context.adopted'")).rowCount).toBe(0);
      expect((await pool.query('SELECT 1 FROM agent_context_outbox WHERE applied_at IS NOT NULL')).rowCount).toBe(0);
    });
});
