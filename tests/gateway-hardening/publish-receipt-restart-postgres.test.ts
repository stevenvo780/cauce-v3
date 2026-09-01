import { afterAll, beforeEach, expect, it } from 'vitest';
import { PublishResultSchema, publishReceiptCausalHash } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { buildGateway } from '../../services/gateway/src/app.js';
import { DevOnlyAuthProvider } from '../../services/gateway/src/auth.js';
import {
  closeTestDatabase, dockerTestRequirement, resetTestDatabase, startTestDatabase,
  type TestDatabase,
} from '../helpers/postgres.js';

type Gateway = Awaited<ReturnType<typeof buildGateway>>;

let database: TestDatabase | undefined;
let pool: DatabasePool;
let app: Gateway | undefined;
const databaseRequirement = dockerTestRequirement(
  'publish receipt replay and durable single-effect repair across gateway restart against real PostgreSQL',
);
const testDatabaseNeedsDocker = !process.env.CAUCE_TEST_DATABASE_URL;

const headers = {
  'x-cauce-tenant': 'Steven',
  'x-cauce-alias': 'kant',
};
const payload = {
  room_id: 'grp.steven',
  recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
  body: { text: 'upgrade-safe causal receipt' },
  idempotency_key: 'publish-receipt-upgrade-restart',
  lane: 'interactive',
  priority: 10,
};

async function bootGateway() {
  return buildGateway({
    pool,
    repository: new CauceRepository(pool),
    authProvider: DevOnlyAuthProvider.forTests(),
    deliveryWakeSubscriber: async () => async () => undefined,
    outboxPollMs: 60_000,
    exposeHealthRoutes: false,
  });
}

beforeEach(async ({ skip }) => {
  if (testDatabaseNeedsDocker) await databaseRequirement.skipIfUnavailable(skip);
  if (database === undefined) {
    database = await startTestDatabase();
    pool = database.pool;
  }
  await app?.close();
  await resetTestDatabase(pool);
  app = await bootGateway();
}, 180_000);

afterAll(async () => {
  await app?.close();
  await closeTestDatabase(database);
});

it('returns 202 after restart for a pre-upgrade receipt and never repeats its durable effect', async () => {
  if (app === undefined) throw new Error('gateway test setup did not complete');
  const firstResponse = await app.inject({ method: 'POST', url: '/v3/messages', headers, payload });
  expect(firstResponse.statusCode).toBe(202);
  const first = PublishResultSchema.parse(firstResponse.json());
  const before = (await pool.query<{
    messages: string;
    deliveries: string;
    wakes: string;
    audits: string;
  }>(
    `SELECT (SELECT count(*) FROM messages)::text AS messages,
            (SELECT count(*) FROM deliveries)::text AS deliveries,
            (SELECT count(*) FROM adapter_outbox WHERE kind='wake')::text AS wakes,
            (SELECT count(*) FROM audit_events WHERE action='message.publish')::text AS audits`,
  )).rows[0];

  await pool.query(
    `UPDATE idempotency_keys
        SET response=response - ARRAY[
          'idempotency_key','tenant_id','actor_alias','request_hash','causal_hash'
        ]::text[]
      WHERE tenant_id='Steven' AND actor_alias='kant' AND idempotency_key=$1`,
    [payload.idempotency_key],
  );

  // Both process and repository are new. The second HTTP request also receives a new generated
  // request/trace pair, which is the production retry shape after a rolling upgrade.
  await app.close();
  app = await bootGateway();
  const replayResponse = await app.inject({ method: 'POST', url: '/v3/messages', headers, payload });

  expect(replayResponse.statusCode).toBe(202);
  const replay = PublishResultSchema.parse(replayResponse.json());
  expect(replay).toMatchObject({
    message_id: first.message_id,
    delivery_ids: first.delivery_ids,
    duplicate: true,
    request_id: first.request_id,
    trace_id: first.trace_id,
    idempotency_key: payload.idempotency_key,
    tenant_id: 'Steven',
    actor_alias: 'kant',
    request_hash: first.request_hash,
    causal_hash: first.causal_hash,
  });
  expect(replay.causal_hash).toBe(publishReceiptCausalHash(replay));
  expect((await pool.query(
    `SELECT (SELECT count(*) FROM messages)::text AS messages,
            (SELECT count(*) FROM deliveries)::text AS deliveries,
            (SELECT count(*) FROM adapter_outbox WHERE kind='wake')::text AS wakes,
            (SELECT count(*) FROM audit_events WHERE action='message.publish')::text AS audits`,
  )).rows[0]).toEqual(before);

  const repaired = (await pool.query<{ response: Record<string, unknown> }>(
    `SELECT response FROM idempotency_keys
      WHERE tenant_id='Steven' AND actor_alias='kant' AND idempotency_key=$1`,
    [payload.idempotency_key],
  )).rows[0]?.response;
  expect(repaired).toMatchObject({ ...replay, duplicate: false });
}, 180_000);
