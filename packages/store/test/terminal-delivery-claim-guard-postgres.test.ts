import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { ackEnvelope, consumer, type Consumer } from './helpers/consumer.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;
let target: Consumer;

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
  target = await consumer(repository, 'Steven', 'argos', 120_000);
});

async function publish(): Promise<void> {
  await repository.publish({
    version: '3.0', request_id: randomUUID(), trace_id: randomUUID(),
    tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'work' }, idempotency_key: randomUUID(), lane: 'batch', priority: 0,
  });
}

function claim(): Promise<DeliveryEnvelope[]> {
  return repository.claimDeliveries(
    target.tenant, target.alias, target.instanceId, target.epoch, 10, 30_000,
  );
}

async function initialDelivery(): Promise<DeliveryEnvelope> {
  await publish();
  const [delivery] = await claim();
  if (!delivery) throw new Error('expected a claimed delivery');
  return delivery;
}

async function applyAck(delivery: DeliveryEnvelope, overrides: Partial<Ack>): Promise<string> {
  const result = await repository.ackDelivery(
    delivery.delivery_id, target.tenant, target.alias,
    ackEnvelope(delivery, target, {}, overrides),
  );
  expect(result.applied).toBe(true);
  return result.status;
}

async function clearTerminalShape(delivery: DeliveryEnvelope): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET status='retry',last_ack_rank=0,terminal_at=NULL,
       claimed_at=NULL,claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,
       consumer_instance_id=NULL,consumer_epoch=NULL,execution_started_at=NULL,
       available_at=now() WHERE id=$1`,
    [delivery.delivery_id],
  );
}

async function expectExcluded(delivery: DeliveryEnvelope): Promise<void> {
  await publish();
  const claimed = await claim();
  expect(claimed).toHaveLength(1);
  expect(claimed[0]?.delivery_id).not.toBe(delivery.delivery_id);
  const unchanged = await pool.query<{ status: string; attempt: number }>(
    'SELECT status,attempt FROM deliveries WHERE id=$1', [delivery.delivery_id],
  );
  expect(unchanged.rows).toEqual([{ status: 'retry', attempt: delivery.attempt }]);
}

describe('terminal evidence excludes corrupted claim candidates', () => {
  it('preserves an applied done receipt even after its row loses every terminal marker', async () => {
    const delivery = await initialDelivery();
    expect(await applyAck(delivery, { status: 'done' })).toBe('done');
    await clearTerminalShape(delivery);
    await expectExcluded(delivery);
  });

  it('preserves a non-retryable failure through its durable dead letter', async () => {
    const delivery = await initialDelivery();
    expect(await applyAck(delivery, {
      status: 'failed', error_code: 'HARNESS_REPORTED_FAILURE', retryable: false,
    })).toBe('failed');
    await clearTerminalShape(delivery);
    await expectExcluded(delivery);
  });

  it('preserves an exhausted retryable failure through its dead letter', async () => {
    const delivery = await initialDelivery();
    await pool.query('UPDATE deliveries SET max_attempts=attempt WHERE id=$1', [delivery.delivery_id]);
    expect(await applyAck(delivery, { status: 'failed', retryable: true })).toBe('dead');
    await clearTerminalShape(delivery);
    await expectExcluded(delivery);
  });

  it('preserves a timeout terminal without requiring a terminal ACK', async () => {
    const delivery = await initialDelivery();
    await applyAck(delivery, { status: 'started', execution_started: true });
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second',
         claim_expires_at=now()-interval '1 second' WHERE id=$1`, [delivery.delivery_id],
    );
    expect((await repository.retryStaleDeliveries(0)).dead).toBe(1);
    await clearTerminalShape(delivery);
    await expectExcluded(delivery);
  });

  it.each(['rank', 'terminal_at'] as const)('rejects inconsistent %s without auxiliary evidence', async (marker) => {
    const delivery = await initialDelivery();
    await clearTerminalShape(delivery);
    await pool.query(
      `UPDATE deliveries SET last_ack_rank=$2,terminal_at=CASE WHEN $3 THEN now() ELSE NULL END
        WHERE id=$1`, [delivery.delivery_id, marker === 'rank' ? 3 : 0, marker === 'terminal_at'],
    );
    await expectExcluded(delivery);
  });

  it.each([
    { retryable: true, error_code: 'HARNESS_REPORTED_FAILURE' },
    { retryable: false, error_code: 'PROCESS_EXIT_AMBIGUOUS' },
  ] as const)('still claims a legitimate pre-execution retry: $error_code', async (failure) => {
    const delivery = await initialDelivery();
    expect(await applyAck(delivery, { status: 'failed', ...failure })).toBe('retry');
    await pool.query('UPDATE deliveries SET available_at=now() WHERE id=$1', [delivery.delivery_id]);
    const retried = await claim();
    expect(retried).toHaveLength(1);
    expect(retried[0]).toMatchObject({ delivery_id: delivery.delivery_id, attempt: delivery.attempt + 1 });
  });

  it('claims the canonical replay clone, never the original with a resolved dead letter', async () => {
    const delivery = await initialDelivery();
    expect(await applyAck(delivery, { status: 'failed', retryable: false })).toBe('failed');
    await repository.replayDelivery(delivery.delivery_id, 'Steven', 'kant');
    const resolved = await pool.query<{ resolved: boolean }>(
      'SELECT resolved_at IS NOT NULL AS resolved FROM dead_letters WHERE delivery_id=$1',
      [delivery.delivery_id],
    );
    expect(resolved.rows).toEqual([{ resolved: true }]);
    await clearTerminalShape(delivery);
    const replayed = await claim();
    expect(replayed).toHaveLength(1);
    expect(replayed[0]?.delivery_id).not.toBe(delivery.delivery_id);
    expect(replayed[0]?.attempt).toBe(1);
  });
});
