import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * P0-2 — the heartbeat of a QUEUED delivery.
 *
 * The adapter no longer sends 'started' before taking the session lock: while it queues it heartbeats
 * as 'accepted'. These tests pin the store contract for that heartbeat: it renews the claim deadline
 * without faking execution, and as soon as the adapter stops heartbeating the reaper picks it up —
 * which is exactly what had never happened before.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

function command(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-queue-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'work that will wait in line' },
    idempotency_key: randomUUID(),
    lane: 'batch',
    priority: 41
  };
}

function ack(delivery: DeliveryEnvelope, epoch: number, status: Ack['status']): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: 'queue-consumer',
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false
  };
}

async function deliveryRow(id: string): Promise<{
  status: string;
  last_ack_rank: number;
  ack_deadline_at: Date;
  execution_started_at: Date | null;
}> {
  const row = (await pool.query<{
    status: string;
    last_ack_rank: number;
    ack_deadline_at: Date;
    execution_started_at: Date | null;
  }>(
    // `execution_started_at` only exists from 012_execution_started_marker.sql onward; in a tree
    // without that migration the column reads as NULL and assertions about it still hold.
    `SELECT status,last_ack_rank,ack_deadline_at,
            (to_jsonb(d)->>'execution_started_at')::timestamptz AS execution_started_at
     FROM deliveries d WHERE id=$1`,
    [id]
  )).rows[0];
  if (!row) throw new Error(`delivery ${id} not found`);
  return row;
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
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('queue heartbeat on an accepted delivery', () => {
  it('renews the claim without claiming execution', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'queue-consumer', [], 60_000);
    const published = await repository.publish(command());
    const deliveryId = requireValue(published.delivery_ids[0], 'published.delivery_ids');
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', 'queue-consumer', requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
    );
    if (!claimed) throw new Error('expected a claimed delivery');

    await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack(claimed, requireValue(lease.epoch, 'lease.epoch'), 'accepted'), 30_000);
    const afterAccept = await deliveryRow(deliveryId);
    expect(afterAccept.status).toBe('accepted');

    // Manually shortening the deadline simulates time passing: if the heartbeat does not renew it, the reaper eats it.
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()+interval '2 seconds' WHERE id=$1`, [deliveryId]
    );
    const shortened = await deliveryRow(deliveryId);

    const renewal = await repository.ackDelivery(
      deliveryId, 'Isa', 'salva', ack(claimed, requireValue(lease.epoch, 'lease.epoch'), 'accepted'), 600_000
    );
    expect(renewal).toMatchObject({ status: 'accepted', applied: true, receipt: 'applied' });

    const afterRenewal = await deliveryRow(deliveryId);
    expect(afterRenewal.ack_deadline_at.getTime()).toBeGreaterThan(shortened.ack_deadline_at.getTime());
    // What MUST NOT happen: the queue heartbeat does not promote the row or invent execution.
    expect(afterRenewal.status).toBe('accepted');
    expect(afterRenewal.last_ack_rank).toBe(1);
    expect(afterRenewal.execution_started_at).toBeNull();
  });

  it('a queued delivery that stops beating IS reaped; one that keeps beating is not', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'queue-consumer', [], 60_000);
    const silent = requireValue((await repository.publish(command())).delivery_ids[0], 'delivery_ids');
    const beating = requireValue((await repository.publish(command())).delivery_ids[0], 'delivery_ids');
    const claims = await repository.claimDeliveries(
      'Isa', 'salva', 'queue-consumer', requireValue(lease.epoch, 'lease.epoch'), 2, 30_000
    );
    expect(claims).toHaveLength(2);
    for (const claimed of claims) {
      await repository.ackDelivery(
        claimed.delivery_id, 'Isa', 'salva', ack(claimed, requireValue(lease.epoch, 'lease.epoch'), 'accepted'), 30_000
      );
    }

    // (1) Only the silent delivery's deadline is expired to evaluate differential expiration.
    // (2) The sweep runs with a real deadline to evaluate `ack_deadline_at` per row.
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1`, [silent]
    );
    const beatingClaim = requireValue(claims.find((entry) => entry.delivery_id === beating), 'value');
    const renewal = await repository.ackDelivery(
      beating, 'Isa', 'salva', ack(beatingClaim, requireValue(lease.epoch, 'lease.epoch'), 'accepted'), 600_000
    );
    // If the heartbeat stopped being applied, the test has to say so here, not through the count.
    expect(renewal).toMatchObject({ status: 'accepted', applied: true });

    const reaped = await repository.retryStaleDeliveries(30_000, 100);
    expect(reaped.retried + reaped.dead).toBe(1);
    expect((await deliveryRow(silent)).status).toBe('retry');
    expect((await deliveryRow(beating)).status).toBe('accepted');
  });

  it('a queue heartbeat cannot renew a delivery that is already executing', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'queue-consumer', [], 60_000);
    const published = await repository.publish(command());
    const deliveryId = requireValue(published.delivery_ids[0], 'published.delivery_ids');
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', 'queue-consumer', requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
    );
    if (!claimed) throw new Error('expected a claimed delivery');

    await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack(claimed, requireValue(lease.epoch, 'lease.epoch'), 'accepted'), 30_000);
    await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack(claimed, requireValue(lease.epoch, 'lease.epoch'), 'started'), 30_000);
    expect((await deliveryRow(deliveryId)).status).toBe('started');

    // A lagging queue heartbeat cannot downgrade or renew a row that is already executing.
    const late = await repository.ackDelivery(
      deliveryId, 'Isa', 'salva', ack(claimed, requireValue(lease.epoch, 'lease.epoch'), 'accepted'), 600_000
    );
    expect(late).toMatchObject({ status: 'started', applied: false, receipt: 'superseded' });
    expect((await deliveryRow(deliveryId)).status).toBe('started');
    expect((await deliveryRow(deliveryId)).last_ack_rank).toBe(2);
  });
});
