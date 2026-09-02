import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * A dead claim plus an ACK identity the row does not recognise used to raise `fenced`. The
 * consumer cannot correlate an exception with the event it sent, so the answer is the same
 * receipt the live-claim branch returns and `lateTerminalSalvage` still decides first.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const tenant: Tenant = 'Steven';
const alias = 'argos';

function command(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: tenant,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: tenant, alias }],
    body: { text: 'una tarea que sobrevive a la reconexión' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0
  };
}

function ack(
  delivery: Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>,
  instanceId: string,
  epoch: number,
  status: Ack['status'],
  overrides: Partial<Ack> = {}
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    ...overrides
  };
}

/**
 * Leaves the delivery claimed by an epoch that no longer exists: `releaseLease` expires the
 * claim of the previous connection, and the reconnection opens a newer one that is alive.
 */
async function reconnectedOverALiveClaim(): Promise<{
  delivery: DeliveryEnvelope; instanceId: string; epoch: number;
}> {
  const instanceId = 'argos-runtime';
  const first = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
  const firstEpoch = requireValue(first.epoch, 'first.epoch');
  await repository.publish(command());
  const [delivery] = await repository.claimDeliveries(
    tenant, alias, instanceId, firstEpoch, 1, 30_000
  );
  if (!delivery) throw new Error('expected a claimed delivery');
  await repository.releaseLease(tenant, alias, instanceId, firstEpoch);
  const resumed = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
  const epoch = requireValue(resumed.epoch, 'resumed.epoch');
  expect(epoch).toBeGreaterThan(firstEpoch);
  return { delivery, instanceId, epoch };
}

async function deliveryRow(deliveryId: string): Promise<{
  status: string; attempt: number; reply: string | null;
}> {
  const result = await pool.query<{ status: string; attempt: number; reply: string | null }>(
    `SELECT status,attempt,result#>>'{output,reply}' AS reply FROM deliveries WHERE id=$1`,
    [deliveryId]
  );
  return requireValue(result.rows[0], 'result.rows');
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

describe('an ACK whose epoch was superseded while the claim died', () => {
  it('returns the correlated receipt instead of raising fenced', async () => {
    const { delivery, instanceId, epoch } = await reconnectedOverALiveClaim();

    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      ack(delivery, instanceId, epoch, 'done', {
        result: { output: { reply: 'terminé mientras se caía el socket' } }
      })
    );

    expect(result).toEqual({
      delivery_id: delivery.delivery_id,
      status: 'leased',
      applied: false,
      receipt: 'ownership_lost'
    });
    // The salvage decided first and refused: no claim of this epoch was ever recorded, so the
    // result cannot be attributed and the row keeps its state for the reaper.
    const row = await deliveryRow(delivery.delivery_id);
    expect(row).toMatchObject({ status: 'leased', attempt: 1, reply: null });
    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 1, dead: 0, parked: 0 });
  });

  it('records the rejected ACK instead of losing it in an exception', async () => {
    const { delivery, instanceId, epoch } = await reconnectedOverALiveClaim();
    const rejected = ack(delivery, instanceId, epoch, 'done', {
      result: { output: { reply: 'nadie va a leer esto' } }
    });

    await repository.ackDelivery(delivery.delivery_id, tenant, alias, rejected);

    const stored = await pool.query<{ applied: boolean; attempt: number }>(
      `SELECT applied,attempt FROM delivery_acks WHERE event_id=$1`, [rejected.event_id]
    );
    expect(stored.rows).toEqual([{ applied: false, attempt: delivery.attempt }]);
  });

  it('answers the renewal of a lost claim the same way, not with a fence', async () => {
    const { delivery, instanceId, epoch } = await reconnectedOverALiveClaim();

    const renewal = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias, ack(delivery, instanceId, epoch, 'started')
    );

    // The SDK reads `ownership_lost` and aborts the harness; a `fenced` would close the socket
    // of a connection whose lease is alive.
    expect(renewal).toMatchObject({ applied: false, receipt: 'ownership_lost', status: 'leased' });
  });
});
