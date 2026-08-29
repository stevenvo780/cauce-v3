import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Handling of failures with ambiguous codes:
 *
 * The `execution_started_at` signal distinguishes whether the harness actually ran or not:
 *  1. ambiguous WITHOUT starting        -> 'retry', consuming an attempt (not free).
 *  2. ambiguous AFTER starting         -> 'dead' + dead_letter (paid work is not re-executed).
 *  3. ambiguous without starting on the LAST attempt -> 'dead' (cap exists, no infinite loop).
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

function command(): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-ambiguous-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { text: 'work whose ambiguity must be judged by whether it ran' },
    idempotency_key: randomUUID(),
    lane: 'batch',
    priority: 41
  };
}

/** The 'started' ACK that DOES seal the flag: the one the SDK sends before invoking the harness. */
function executionStartedAck(delivery: DeliveryEnvelope, epoch: number): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'started',
    instance_id: 'ambiguous-worker',
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    execution_started: true
  };
}

/**
 * The ambiguous failure is sent with `retryable: false`, which is what the real harness emits
 * (`harnesses/shared.ts`). The fix is NOT flipping it to `true`: that `false` is still correct
 * for the delivery that executed. What decides is the execution flag.
 */
function ambiguousFailureAck(
  delivery: DeliveryEnvelope,
  epoch: number,
  code = 'PROCESS_EXIT_AMBIGUOUS'
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'failed',
    instance_id: 'ambiguous-worker',
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    error: 'harness exited without structured output',
    error_code: code
  };
}

async function deliveryRow(id: string): Promise<{
  status: string;
  attempt: number;
  max_attempts: number;
  terminal: boolean;
  execution_started_at: Date | null;
}> {
  const row = (await pool.query<{
    status: string;
    attempt: number;
    max_attempts: number;
    terminal: boolean;
    execution_started_at: Date | null;
  }>(
    `SELECT status,attempt,max_attempts,terminal_at IS NOT NULL AS terminal,execution_started_at
     FROM deliveries WHERE id=$1`,
    [id]
  )).rows[0];
  if (!row) throw new Error(`delivery ${id} not found`);
  return row;
}

async function deadLetterCount(id: string): Promise<number> {
  return (await pool.query(
    `SELECT 1 FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NULL`, [id]
  )).rowCount ?? 0;
}

beforeAll(async () => {
  database = await startTestDatabase();
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
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('an ambiguous failure is judged by whether execution ever started', () => {
  it('retries an ambiguity that never started executing, and consumes an attempt', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'ambiguous-worker', [], 60_000);
    const published = await repository.publish(command());
    const deliveryId = published.delivery_ids[0]!;
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', 'ambiguous-worker', lease.epoch!, 1, 30_000
    );
    if (!claimed) throw new Error('expected a claimed delivery');

    // The CLI died on startup: the delivery never ACKed `execution_started`.
    const before = await deliveryRow(deliveryId);
    expect(before.attempt).toBe(1);
    expect(before.max_attempts).toBeGreaterThan(1);
    expect(before.execution_started_at).toBeNull();

    await expect(repository.ackDelivery(
      deliveryId, 'Isa', 'salva', ambiguousFailureAck(claimed, lease.epoch!), 30_000
    )).resolves.toMatchObject({ status: 'retry', applied: true, receipt: 'applied' });

    const after = await deliveryRow(deliveryId);
    expect(after.status).toBe('retry');
    // Not a terminal outcome: no `terminal_at` and no `dead_letters`, which is what would have
    // sent it to manual review with two intact attempts.
    expect(after.terminal).toBe(false);
    expect(await deadLetterCount(deliveryId)).toBe(0);

    // And the retry CONSUMES budget: the next claim advances the attempt. Without this the fix
    // would be a free loop instead of a retry.
    await pool.query(`UPDATE deliveries SET available_at=now() WHERE id=$1`, [deliveryId]);
    const [reclaimed] = await repository.claimDeliveries(
      'Isa', 'salva', 'ambiguous-worker', lease.epoch!, 1, 30_000
    );
    expect(reclaimed?.delivery_id).toBe(deliveryId);
    expect((await deliveryRow(deliveryId)).attempt).toBe(2);
  });

  it('keeps sending an ambiguity that DID start executing to dead, preserving paid work', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'ambiguous-worker', [], 60_000);
    const published = await repository.publish(command());
    const deliveryId = published.delivery_ids[0]!;
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', 'ambiguous-worker', lease.epoch!, 1, 30_000
    );
    if (!claimed) throw new Error('expected a claimed delivery');

    // The harness actually started: lease taken, process invoked, quota committed.
    await repository.ackDelivery(
      deliveryId, 'Isa', 'salva', executionStartedAck(claimed, lease.epoch!), 30_000
    );
    const started = await deliveryRow(deliveryId);
    expect(started.execution_started_at).not.toBeNull();
    // With attempts to spare: what keeps the delivery is the flag, not exhausted budget.
    expect(started.attempt).toBeLessThan(started.max_attempts);

    await expect(repository.ackDelivery(
      deliveryId, 'Isa', 'salva', ambiguousFailureAck(claimed, lease.epoch!), 30_000
    )).resolves.toMatchObject({ status: 'dead', applied: true, receipt: 'applied' });

    const after = await deliveryRow(deliveryId);
    expect(after.status).toBe('dead');
    expect(after.terminal).toBe(true);
    // It is left for manual replay, which is the point of preserving already-paid work.
    expect(await deadLetterCount(deliveryId)).toBe(1);
    // And it is audited as ambiguity WITH execution, not as the rescued case.
    expect((await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE action='delivery.ack' AND delivery_id=$1 AND metadata->>'resulting_status'='dead'
       ORDER BY id DESC LIMIT 1`,
      [deliveryId]
    )).rows[0]?.metadata).toMatchObject({ ambiguous_execution: true });
  });

  it('still dies once max_attempts is exhausted, so there is no infinite retry loop', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'ambiguous-worker', [], 60_000);
    const published = await repository.publish(command());
    const deliveryId = published.delivery_ids[0]!;
    const { max_attempts: maxAttempts } = await deliveryRow(deliveryId);

    // The full cycle is repeated: every round dies ambiguously WITHOUT starting. The early ones
    // retry; the last one must end up as 'dead'.
    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      await pool.query(`UPDATE deliveries SET available_at=now() WHERE id=$1`, [deliveryId]);
      const [claimed] = await repository.claimDeliveries(
        'Isa', 'salva', 'ambiguous-worker', lease.epoch!, 1, 30_000
      );
      if (!claimed) throw new Error(`expected a claimed delivery on attempt ${attempt}`);
      const row = await deliveryRow(deliveryId);
      expect(row.attempt).toBe(attempt);
      expect(row.execution_started_at).toBeNull();

      const result = await repository.ackDelivery(
        deliveryId, 'Isa', 'salva', ambiguousFailureAck(claimed, lease.epoch!), 30_000
      );
      expect(result.status).toBe(attempt < maxAttempts ? 'retry' : 'dead');
    }

    const final = await deliveryRow(deliveryId);
    expect(final.status).toBe('dead');
    expect(final.attempt).toBe(maxAttempts);
    expect(final.terminal).toBe(true);
    expect(await deadLetterCount(deliveryId)).toBe(1);

    // With the budget exhausted, nothing is claimable: the cap is real.
    await pool.query(`UPDATE deliveries SET available_at=now() WHERE id=$1`, [deliveryId]);
    expect(await repository.claimDeliveries(
      'Isa', 'salva', 'ambiguous-worker', lease.epoch!, 1, 30_000
    )).toHaveLength(0);
  });

  it('applies the same rule to every ambiguous code, not just the three best known', async () => {
    // The EIGHT codes from `AMBIGUOUS_ACK_ERROR_CODES`. If someone adds a new one to the schema
    // without covering it, this test will not catch it: what it pins is that the rule is on the
    // SET, not on a handful of special cases.
    const codes = [
      'EXECUTION_TIMEOUT_AMBIGUOUS',
      'EXECUTION_CANCELLED_AMBIGUOUS',
      'OUTPUT_LIMIT_AMBIGUOUS',
      'PROCESS_EXIT_AMBIGUOUS',
      'OPENCLAW_OUTPUT_LIMIT_AMBIGUOUS',
      'OPENCLAW_HTTP_AMBIGUOUS',
      'OPENCLAW_API_AMBIGUOUS',
      'INTERRUPTED_AMBIGUOUS'
    ];
    const lease = await repository.acquireLease('Isa', 'salva', 'ambiguous-worker', [], 60_000);

    for (const code of codes) {
      const unstarted = (await repository.publish(command())).delivery_ids[0]!;
      const startedDelivery = (await repository.publish(command())).delivery_ids[0]!;
      const claims = await repository.claimDeliveries(
        'Isa', 'salva', 'ambiguous-worker', lease.epoch!, 2, 30_000
      );
      const unstartedClaim = claims.find((entry) => entry.delivery_id === unstarted)!;
      const startedClaim = claims.find((entry) => entry.delivery_id === startedDelivery)!;

      await repository.ackDelivery(
        startedDelivery, 'Isa', 'salva', executionStartedAck(startedClaim, lease.epoch!), 30_000
      );

      expect({
        code,
        unstarted: (await repository.ackDelivery(
          unstarted, 'Isa', 'salva', ambiguousFailureAck(unstartedClaim, lease.epoch!, code), 30_000
        )).status,
        started: (await repository.ackDelivery(
          startedDelivery, 'Isa', 'salva',
          ambiguousFailureAck(startedClaim, lease.epoch!, code), 30_000
        )).status
      }).toEqual({ code, unstarted: 'retry', started: 'dead' });
    }
  });
});
