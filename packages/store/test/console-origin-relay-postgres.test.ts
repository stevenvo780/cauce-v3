import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * The console reads messages and deliveries straight from PostgreSQL; there is no
 * `adapter=console` bridge that could ever claim a durable relay. A terminal ack on a
 * console-originated delivery must not leave a permanently unclaimable `origin_relay` row.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const tenant: Tenant = 'Steven';
const alias = 'argos';

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: tenant,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: tenant, alias }],
    body: { text: 'una pregunta de una persona' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

function doneAck(
  delivery: Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>,
  instanceId: string,
  epoch: number,
  reply: string
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: { output: { reply } }
  };
}

async function relayRowCount(deliveryId: string): Promise<number> {
  const result = await pool.query(
    `SELECT 1 FROM adapter_outbox
     WHERE kind='origin_relay' AND delivery_id=$1 AND payload->>'relay_kind' IS DISTINCT FROM 'ack'`,
    [deliveryId]
  );
  return result.rowCount ?? 0;
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

it('does not enqueue a durable relay for a console-originated delivery', async () => {
  const instanceId = 'worker-console';
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  await repository.publish(command({
    origin: {
      adapter: 'console', channel: 'console', conversation_id: `console:${randomUUID()}`,
      relay: [], metadata: { auth: 'console-password', user_id: randomUUID() }
    }
  }));
  const [delivery] = await repository.claimDeliveries(tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
  if (!delivery) throw new Error('expected a claimed delivery');

  await repository.ackDelivery(
    delivery.delivery_id, tenant, alias,
    doneAck(delivery, instanceId, requireValue(lease.epoch, 'lease.epoch'), 'la consola ya la lee de la base')
  );

  expect(await relayRowCount(delivery.delivery_id)).toBe(0);
});

it('still relays a telegram-originated delivery, proving the console guard is adapter-specific', async () => {
  const instanceId = 'worker-telegram';
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  await repository.publish(command({
    origin: {
      adapter: 'telegram', channel: 'dm', conversation_id: '42', relay: [], metadata: {}
    }
  }));
  const [delivery] = await repository.claimDeliveries(tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
  if (!delivery) throw new Error('expected a claimed delivery');

  await repository.ackDelivery(
    delivery.delivery_id, tenant, alias,
    doneAck(delivery, instanceId, requireValue(lease.epoch, 'lease.epoch'), 'esto sí tiene un puente de vuelta')
  );

  expect(await relayRowCount(delivery.delivery_id)).toBe(1);
});
