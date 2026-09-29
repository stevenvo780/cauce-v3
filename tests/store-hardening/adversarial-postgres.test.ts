import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { AckSchema } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../helpers/postgres.js';
import { command } from './adversarial-postgres-helpers.js';
let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000, ['makes delivery claim token and attempt mandatory in the ACK protocol']);
beforeEach(async () => {
  if (!databaseStarted) return;
  await resetTestDatabase(pool);
  await pool.query(
    'TRUNCATE delivery_lane_fairness,job_lane_fairness,outbox_dead_letters CASCADE',
  );
  await pool.query(`
    DELETE FROM memberships WHERE tenant_id='Acme';
    DELETE FROM rooms WHERE tenant_id='Acme';
    DELETE FROM acl_edges WHERE from_tenant='Acme' OR to_tenant='Acme';
    DELETE FROM tenants WHERE id='Acme';
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE memberships SET role=CASE
      WHEN tenant_id='Steven' AND alias='kant' THEN 'operator' ELSE 'agent' END;
    UPDATE role_policies SET allow_route=true,allow_read=true,allow_control=false WHERE role='agent';
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('adversarial PostgreSQL store hardening', () => {
  it('makes delivery claim token and attempt mandatory in the ACK protocol', () => {
    expect(AckSchema.safeParse({
      version: '3.0', status: 'done', instance_id: 'worker', epoch: 1
    }).success).toBe(false);
    expect(AckSchema.parse({
      version: '3.0', status: 'done', instance_id: 'worker', epoch: 1,
      event_id: randomUUID(), claim_token: randomUUID(), attempt: 1
    })).toMatchObject({ status: 'done', attempt: 1 });
  });

  it('serializes 20 initial lease racers and rejects reuse of the live instance id', async () => {
    const racers = Array.from({ length: 20 }, (_, index) =>
      repository.acquireLease('Isa', 'salva', `racer-${String(index)}`, [], 10_000)
    );
    const results = await Promise.all(racers);
    const winners = results.map((result, index) => ({ result, index }))
      .filter(({ result }) => result.acquired);
    expect(winners).toHaveLength(1);
    const firstWinner = winners[0];
    if (!firstWinner) throw new Error('Expected a winning racer');
    const winner = `racer-${String(firstWinner.index)}`;
    expect(await repository.acquireLease('Isa', 'salva', winner, [], 10_000))
      .toMatchObject({ acquired: false, active_instance_id: winner });

    const takeover = await repository.acquireLease('Isa', 'salva', 'explicit-takeover', [], 10_000, {
      takeover: true
    });
    expect(takeover).toMatchObject({ acquired: true, epoch: 2 });
  });

  it('resumes the same stable instance and epoch only inside the configured window', async () => {
    const instanceId = 'stable-resume-worker';
    const initial = await repository.acquireLease(
      'Isa', 'salva', instanceId, ['initial-capability'], 10_000
    );
    expect(initial).toMatchObject({ acquired: true, epoch: 1 });

    const liveResume = await repository.acquireLease(
      'Isa', 'salva', instanceId, ['renewable_delivery_claims_v1'], 10_000, {
        resume: true,
        resumeWindowMs: 60_000
      }
    );
    expect(liveResume).toMatchObject({ acquired: true, epoch: initial.epoch });

    await pool.query(
      `UPDATE connection_leases
       SET lease_until=now()-interval '5 seconds'
       WHERE tenant_id='Isa' AND alias='salva'`
    );
    const recentExpiredResume = await repository.acquireLease(
      'Isa', 'salva', instanceId, ['renewable_delivery_claims_v1'], 10_000, {
        resume: true,
        resumeWindowMs: 60_000
      }
    );
    expect(recentExpiredResume).toMatchObject({ acquired: true, epoch: initial.epoch });

    const resumedRow = await pool.query<{
      instance_id: string;
      epoch: string;
      capabilities: string[];
      live: boolean;
    }>(
      `SELECT instance_id,epoch,capabilities,(lease_until > now()) AS live
       FROM connection_leases
       WHERE tenant_id='Isa' AND alias='salva'`
    );
    expect(resumedRow.rows[0]).toMatchObject({
      instance_id: instanceId,
      epoch: String(initial.epoch),
      capabilities: ['renewable_delivery_claims_v1'],
      live: true
    });

    await pool.query(
      `UPDATE connection_leases
       SET lease_until=now()-interval '2 minutes'
       WHERE tenant_id='Isa' AND alias='salva'`
    );
    const outsideWindow = await repository.acquireLease(
      'Isa', 'salva', instanceId, ['renewable_delivery_claims_v1'], 10_000, {
        resume: true,
        resumeWindowMs: 60_000
      }
    );
    expect(outsideWindow).toMatchObject({
      acquired: true,
      epoch: (initial.epoch ?? 1) + 1
    });
  });

  it('renews only a live, exactly fenced started claim with a new ACK event', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'delivery-worker', [], 10_000);
    if (!lease.acquired || lease.epoch === undefined) throw new Error('lease not acquired');
    const leaseEpoch = lease.epoch;
    const published = await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'delivery-worker', leaseEpoch, 1, 5_000
    );
    if (!delivery) throw new Error('delivery not claimed');
    const deliveryId = delivery.delivery_id;
    const attempt = delivery.attempt;
    const claimToken = delivery.claim_token;

    expect(delivery).toMatchObject({
      delivery_id: published.delivery_ids[0], attempt: 1
    });

    const stale = await repository.ackDelivery(deliveryId, 'Isa', 'salva', {
      version: '3.0', status: 'done', instance_id: 'delivery-worker', epoch: leaseEpoch,
      event_id: randomUUID(), claim_token: randomUUID(), attempt, retryable: false
    });
    expect(stale).toMatchObject({ applied: false, status: 'leased' });

    const before = await pool.query<{ ack_deadline_at: Date }>(
      'SELECT ack_deadline_at FROM deliveries WHERE id=$1', [deliveryId]
    );
    await repository.heartbeat('Isa', 'salva', 'delivery-worker', leaseEpoch, 60_000);
    const after = await pool.query<{ ack_deadline_at: Date }>(
      'SELECT ack_deadline_at FROM deliveries WHERE id=$1', [deliveryId]
    );
    const beforeRow = before.rows[0];
    const afterRow = after.rows[0];
    if (!beforeRow || !afterRow) throw new Error('Expected delivery rows');
    expect(afterRow.ack_deadline_at.getTime()).toBe(beforeRow.ack_deadline_at.getTime());

    await expect(repository.ackDelivery(deliveryId, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'delivery-worker', epoch: leaseEpoch,
      event_id: randomUUID(), claim_token: claimToken, attempt,
      retryable: false, result: { progress: 'initial' }
    }, 5_000)).resolves.toMatchObject({ applied: true, status: 'started' });

    await pool.query(
      `UPDATE deliveries
       SET ack_deadline_at=now()+interval '1 second',
           claim_expires_at=now()+interval '1 second'
       WHERE id=$1`,
      [deliveryId]
    );
    const renewalEventId = randomUUID();
    await expect(repository.ackDelivery(deliveryId, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'delivery-worker', epoch: leaseEpoch,
      event_id: renewalEventId, claim_token: claimToken, attempt,
      retryable: false, result: { progress: 'heartbeat-only' }
    }, 5_000)).resolves.toMatchObject({ applied: true, status: 'started' });
    const renewed = await pool.query<{
      ack_deadline_at: Date;
      claim_expires_at: Date;
      last_ack_rank: number;
      result: Record<string, unknown>;
    }>(
      `SELECT ack_deadline_at,claim_expires_at,last_ack_rank,result
       FROM deliveries WHERE id=$1`,
      [deliveryId]
    );
    const renewedRow = renewed.rows[0];
    if (!renewedRow) throw new Error('Expected renewed delivery row');
    expect(renewedRow).toMatchObject({
      last_ack_rank: 2,
      result: { progress: 'initial' }
    });
    expect(renewedRow.ack_deadline_at.getTime() - Date.now()).toBeGreaterThan(4_000);
    expect(Math.abs(
      renewedRow.ack_deadline_at.getTime()
      - renewedRow.claim_expires_at.getTime()
    )).toBeLessThanOrEqual(5);

    await expect(repository.ackDelivery(deliveryId, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'delivery-worker', epoch: leaseEpoch,
      event_id: renewalEventId, claim_token: claimToken, attempt,
      retryable: false
    }, 60_000)).resolves.toMatchObject({
      applied: true,
      status: 'started',
      receipt: 'duplicate'
    });
    const afterDuplicate = await pool.query<{ ack_deadline_at: Date }>(
      'SELECT ack_deadline_at FROM deliveries WHERE id=$1', [deliveryId]
    );
    const afterDuplicateRow = afterDuplicate.rows[0];
    if (!afterDuplicateRow) throw new Error('Expected afterDuplicate delivery row');
    expect(afterDuplicateRow.ack_deadline_at.getTime())
      .toBeGreaterThan(renewedRow.ack_deadline_at.getTime());

    await expect(repository.ackDelivery(deliveryId, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'other-worker', epoch: leaseEpoch,
      event_id: randomUUID(), claim_token: claimToken, attempt,
      retryable: false
    }, 60_000)).resolves.toMatchObject({ applied: false, receipt: 'ownership_lost' });
    const afterFenced = await pool.query<{ ack_deadline_at: Date }>(
      'SELECT ack_deadline_at FROM deliveries WHERE id=$1', [deliveryId]
    );
    const afterFencedRow = afterFenced.rows[0];
    if (!afterFencedRow) throw new Error('Expected afterFenced delivery row');
    expect(afterFencedRow.ack_deadline_at.getTime())
      .toBe(afterDuplicateRow.ack_deadline_at.getTime());

    await pool.query(
      `UPDATE deliveries
       SET ack_deadline_at=now()-interval '1 millisecond',
           claim_expires_at=now()-interval '1 millisecond'
       WHERE id=$1`,
      [deliveryId]
    );
    const late = await repository.ackDelivery(deliveryId, 'Isa', 'salva', {
      version: '3.0', status: 'started', instance_id: 'delivery-worker', epoch: leaseEpoch,
      event_id: randomUUID(), claim_token: claimToken, attempt,
      retryable: false
    }, 60_000);
    expect(late).toMatchObject({ applied: false, status: 'started' });
    const expired = await pool.query<{ ack_deadline_at: Date; claim_expires_at: Date }>(
      'SELECT ack_deadline_at,claim_expires_at FROM deliveries WHERE id=$1', [deliveryId]
    );
    const expiredRow = expired.rows[0];
    if (!expiredRow) throw new Error('Expected expired delivery row');
    expect(expiredRow.ack_deadline_at.getTime()).toBeLessThan(Date.now());
    expect(expiredRow.claim_expires_at.getTime()).toBeLessThan(Date.now());
    expect((await pool.query('SELECT 1 FROM delivery_acks WHERE delivery_id=$1 AND NOT applied', [
      deliveryId
    ])).rowCount).toBe(3);
  });

  it('preserves ownership_lost when replaying a rejected renewal event', async () => {
    // This collision scenario deliberately keeps two deliveries live. Declare that durable
    // capacity explicitly; relying on the legacy direct-caller fallback of one would make the
    // second claim impossible and would test admission instead of event-id ownership.
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries)
       VALUES('Isa','salva',false,2)`,
    );
    const lease = await repository.acquireLease(
      'Isa', 'salva', 'renewal-replay-worker', [], 60_000,
      { requireDeclaredCapacity: true },
    );
    if (!lease.acquired || lease.epoch === undefined) throw new Error('lease not acquired');
    const leaseEpoch = lease.epoch;
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'renewal-replay-worker', leaseEpoch, 1, 30_000
    );
    if (!delivery) throw new Error('expected a renewal replay delivery');

    await expect(repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0',
      status: 'started',
      instance_id: 'renewal-replay-worker',
      epoch: leaseEpoch,
      event_id: randomUUID(),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false
    }, 30_000)).resolves.toMatchObject({ applied: true, receipt: 'applied' });

    const appliedRenewal = AckSchema.parse({
      version: '3.0',
      status: 'started',
      instance_id: 'renewal-replay-worker',
      epoch: leaseEpoch,
      event_id: randomUUID(),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false
    });
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Isa', 'salva', appliedRenewal, 30_000
    )).resolves.toMatchObject({ applied: true, receipt: 'applied' });
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Isa', 'salva', appliedRenewal, 30_000
    )).resolves.toMatchObject({ applied: true, receipt: 'duplicate' });

    await repository.publish(command());
    const [otherDelivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'renewal-replay-worker', leaseEpoch, 1, 30_000
    );
    if (!otherDelivery) throw new Error('expected a collision test delivery');
    await expect(repository.ackDelivery(otherDelivery.delivery_id, 'Isa', 'salva', {
      ...appliedRenewal,
      claim_token: otherDelivery.claim_token,
      attempt: otherDelivery.attempt
    }, 30_000)).resolves.toMatchObject({
      applied: false,
      receipt: 'ownership_lost'
    });

    await pool.query(
      `UPDATE deliveries
       SET ack_deadline_at=now()-interval '1 second',
           claim_expires_at=now()-interval '1 second'
       WHERE id=$1`,
      [delivery.delivery_id]
    );
    const rejectedRenewal = AckSchema.parse({
      version: '3.0',
      status: 'started',
      instance_id: 'renewal-replay-worker',
      epoch: leaseEpoch,
      event_id: randomUUID(),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false
    });
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Isa', 'salva', rejectedRenewal, 30_000
    )).resolves.toMatchObject({ applied: false, receipt: 'ownership_lost' });
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Isa', 'salva', rejectedRenewal, 30_000
    )).resolves.toMatchObject({ applied: false, receipt: 'ownership_lost' });
  });

  it('never retries an allowlisted ambiguity even when a direct store caller marks it retryable', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'ambiguous-worker', [], 10_000);
    if (!lease.acquired || lease.epoch === undefined) throw new Error('lease not acquired');
    const leaseEpoch = lease.epoch;
    const published = await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'ambiguous-worker', leaseEpoch, 1, 5_000
    );
    if (!delivery) throw new Error('expected an ambiguity test delivery');
    const eventId = randomUUID();

    // The delivery MUST HAVE STARTED for its ambiguity to count: `execution_started_at` is what
    // says the harness was invoked and the quota committed. Without that mark an ambiguous
    // outcome is no longer terminal — it died before executing, so it retries — and this test
    // was passing for the wrong reason: it killed on attempt 1 a delivery that never ran.
    // What it now pins, which is its original intent: with work possibly paid for, not even
    // `retryable: true` from a direct store caller gets a retry.
    await repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0',
      status: 'started',
      instance_id: 'ambiguous-worker',
      epoch: leaseEpoch,
      event_id: randomUUID(),
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false,
      execution_started: true
    }, 30_000);

    await expect(repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0',
      status: 'failed',
      instance_id: 'ambiguous-worker',
      epoch: leaseEpoch,
      event_id: eventId,
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: true,
      error: 'execution may have completed before the transport failed',
      error_code: 'EXECUTION_TIMEOUT_AMBIGUOUS'
    })).resolves.toEqual({
      delivery_id: delivery.delivery_id,
      status: 'dead',
      applied: true,
      receipt: 'applied'
    });

    expect((await pool.query<{
      status: string; last_ack_rank: number; terminal: boolean;
    }>(
      `SELECT status,last_ack_rank,terminal_at IS NOT NULL AS terminal
       FROM deliveries WHERE id=$1`,
      [delivery.delivery_id]
    )).rows[0]).toEqual({ status: 'dead', last_ack_rank: 3, terminal: true });
    expect((await pool.query<{ status: string; applied: boolean; payload: Record<string, unknown> }>(
      `SELECT status,applied,payload FROM delivery_acks WHERE event_id=$1`,
      [eventId]
    )).rows[0]).toEqual({
      status: 'failed',
      applied: true,
      payload: {
        retryable: true,
        error: 'execution may have completed before the transport failed',
        error_code: 'EXECUTION_TIMEOUT_AMBIGUOUS'
      }
    });
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NULL`,
      [delivery.delivery_id]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM adapter_outbox WHERE delivery_id=$1 AND idempotency_key LIKE 'wake-retry:%'`,
      [delivery.delivery_id]
    )).rowCount).toBe(0);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='delivery.ack' AND delivery_id=$1
         AND metadata->>'resulting_status'='dead'
         AND metadata->>'ambiguous_execution'='true'`,
      [delivery.delivery_id]
    )).rowCount).toBe(1);
    expect(published.delivery_ids).toContain(delivery.delivery_id);
  });

  it('cuts an open runtime lease when route permission is revoked', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'revoked-worker', [], 10_000);
    if (!lease.acquired || lease.epoch === undefined) throw new Error('lease not acquired');
    const leaseEpoch = lease.epoch;
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      'Isa', 'salva', 'revoked-worker', leaseEpoch, 1, 5_000
    );
    if (!delivery) throw new Error('delivery not claimed');
    await pool.query(`UPDATE role_policies SET allow_route=false WHERE role='agent'`);

    await expect(repository.heartbeat('Isa', 'salva', 'revoked-worker', leaseEpoch, 10_000))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.claimDeliveries('Isa', 'salva', 'revoked-worker', leaseEpoch, 1))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0', status: 'done', instance_id: 'revoked-worker', epoch: leaseEpoch,
      event_id: randomUUID(), claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false
    })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.acquireLease('Isa', 'salva', 'revoked-reconnect', [], 10_000))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query('SELECT 1 FROM delivery_acks WHERE delivery_id=$1', [delivery.delivery_id])).rowCount)
      .toBe(0);
  });

  it('makes event_id idempotent before applying a second lifecycle transition', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'event-worker', [], 10_000);
    if (!lease.acquired || lease.epoch === undefined) throw new Error('lease not acquired');
    const leaseEpoch = lease.epoch;
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries('Isa', 'salva', 'event-worker', leaseEpoch, 1, 5_000);
    if (!delivery) throw new Error('delivery not claimed');
    const eventId = randomUUID();
    const accepted = await repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0', event_id: eventId, status: 'accepted', instance_id: 'event-worker', epoch: leaseEpoch,
      claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false
    });
    const replayedAsDone = await repository.ackDelivery(delivery.delivery_id, 'Isa', 'salva', {
      version: '3.0', event_id: eventId, status: 'done', instance_id: 'event-worker', epoch: leaseEpoch,
      claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false
    });
    expect(accepted).toMatchObject({ status: 'accepted', applied: true });
    expect(replayedAsDone).toMatchObject({ status: 'accepted', applied: false });
    expect((await pool.query('SELECT status FROM delivery_acks WHERE event_id=$1', [eventId])).rows)
      .toEqual([{ status: 'accepted' }]);
  });});
