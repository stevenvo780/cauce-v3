import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import {
  CauceRepository, DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  deliveryLeaseCapMs, type DatabasePool
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { deliveryRow as selectDeliveryRow } from './helpers/consumer.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const ACK_DEADLINE_MS = 60_000;

function command(body: Record<string, unknown>): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-lease-cap-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body,
    idempotency_key: randomUUID(),
    lane: 'batch',
    priority: 0
  };
}

function ack(
  delivery: DeliveryEnvelope,
  epoch: number,
  status: Ack['status'],
  executionStarted = false
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: 'lease-cap-consumer',
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    ...(executionStarted ? { execution_started: true } : {})
  };
}

/**
 * Leaves the delivery in 'started' with the harness declaring it really started, which is the
 * exact state from which a delivery can become immortal.
 */
async function claimAndStart(
  epoch: number,
  leaseCap: { leaseCapMs?: number; leaseCapGraceMs?: number } = {}
): Promise<DeliveryEnvelope> {
  const [claimed] = await repository.claimDeliveries(
    'Isa', 'salva', 'lease-cap-consumer', epoch, 1, ACK_DEADLINE_MS
  );
  if (!claimed) throw new Error('expected a claimed delivery');
  await repository.ackDelivery(
    claimed.delivery_id, 'Isa', 'salva', ack(claimed, epoch, 'accepted'), ACK_DEADLINE_MS, leaseCap
  );
  await repository.ackDelivery(
    claimed.delivery_id, 'Isa', 'salva', ack(claimed, epoch, 'started', true),
    ACK_DEADLINE_MS, leaseCap
  );
  return claimed;
}

interface LeaseCapRow { status: string; last_error: string | null; ack_deadline_at: Date | null }

const deliveryRow = (id: string): Promise<LeaseCapRow> =>
  selectDeliveryRow<LeaseCapRow>(pool, id, 'status,last_error,ack_deadline_at');

/** Ages the cap ANCHOR, not the deadline: that is what separates this guard from the ACK-expired one. */
async function ageExecutionStart(id: string, ms: number): Promise<void> {
  await pool.query(
    `UPDATE deliveries
        SET execution_started_at=now()-$2*interval '1 millisecond',
            claimed_at=now()-$2*interval '1 millisecond'
      WHERE id=$1`,
    [id, ms]
  );
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000, ['deriva el techo del timeout declarado, hacia abajo y hacia arriba']);

beforeEach(async () => {
  if (!databaseStarted) return;
  await resetTestDatabase(pool);
  await pool.query(`
    UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
    UPDATE tenants SET enabled=true;
    UPDATE rooms SET enabled=true;
    UPDATE memberships SET enabled=true;
    UPDATE role_policies SET allow_route=true,allow_read=true WHERE role='agent';
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('techo de vida total de una entrega', () => {
  /**
   * THE INCIDENT CASE. The lease is PERFECTLY ALIVE —deadline within an hour, just renewed—
   * and yet the delivery has been hanging for hours. Before this patch the reaper did not even
   * look at it: its WHERE only asks about expired deadlines.
   */
  it('mata una entrega cuya garra sigue viva pero superó el techo, con motivo propio', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'harness colgado que sigue latiendo' }));
    const claimed = await claimAndStart(requireValue(lease.epoch, 'lease.epoch'));

    // 17.36 h was what was measured in production for janus's delivery. The default cap is 12 h.
    await ageExecutionStart(claimed.delivery_id, 17 * 60 * 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()+interval '1 hour',
                            claim_expires_at=now()+interval '1 hour' WHERE id=$1`,
      [claimed.delivery_id]
    );
    expect(requireValue((await deliveryRow(claimed.delivery_id)).ack_deadline_at, 'ack_deadline_at').getTime())
      .toBeGreaterThan(Date.now());

    // staleMs huge: no lease is expired, so the ONLY possible path is the cap.
    const swept = await repository.retryStaleDeliveries(24 * 60 * 60_000);

    expect(swept).toEqual({ retried: 0, dead: 1, parked: 0 });
    const row = await deliveryRow(claimed.delivery_id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toContain('Lease cap exhausted');
    // The reason MUST NOT be confused with the other path: "stopped responding" and "won't stop
    // responding" send the operator to opposite places.
    expect(row.last_error).not.toContain('ACK timeout');

    const dlq = await pool.query<{ reason: string }>(
      'SELECT reason FROM dead_letters WHERE delivery_id=$1', [claimed.delivery_id]
    );
    expect(dlq.rows[0]?.reason).toContain('Lease cap exhausted');

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE delivery_id=$1 AND action='delivery.lease_cap'`, [claimed.delivery_id]
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      reason: 'lease_cap_exhausted',
      lease_cap_ms: DEFAULT_DELIVERY_LEASE_CAP_MS,
      execution_started: true
    });
  });

  it('no toca una entrega larga que todavía está dentro de su techo', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'turno legítimo de once horas' }));
    const claimed = await claimAndStart(requireValue(lease.epoch, 'lease.epoch'));

    // Eleven hours: long, but below the 12 h default. It must not die.
    await ageExecutionStart(claimed.delivery_id, 11 * 60 * 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()+interval '1 hour',
                            claim_expires_at=now()+interval '1 hour' WHERE id=$1`,
      [claimed.delivery_id]
    );

    expect(await repository.retryStaleDeliveries(24 * 60 * 60_000)).toEqual({ retried: 0, dead: 0, parked: 0 });
    expect((await deliveryRow(claimed.delivery_id)).status).toBe('started');
  });

  it('congela el plazo en el techo en vez de empujarlo otros 30 minutos', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'renovación que no puede pasarse del techo' }));
    const leaseCap = { leaseCapMs: 60_000 };
    const claimed = await claimAndStart(requireValue(lease.epoch, 'lease.epoch'), leaseCap);

    // 10 s left until the cap, but the ACK deadline is 60 s: the renewal cannot give 60.
    await ageExecutionStart(claimed.delivery_id, 50_000);
    const renewed = await repository.ackDelivery(
      claimed.delivery_id, 'Isa', 'salva', ack(claimed, requireValue(lease.epoch, 'lease.epoch'), 'started', true),
      ACK_DEADLINE_MS, leaseCap
    );
    expect(renewed).toMatchObject({ applied: true, status: 'started' });

    const row = await deliveryRow(claimed.delivery_id);
    const remainingMs = requireValue(row.ack_deadline_at, 'row.ack_deadline_at').getTime() - Date.now();
    expect(remainingMs).toBeLessThan(15_000);
    expect(remainingMs).toBeGreaterThan(0);
  });

  it('deja de renovar del todo una vez pasado el techo', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'latido después del techo' }));
    const leaseCap = { leaseCapMs: 60_000 };
    const claimed = await claimAndStart(requireValue(lease.epoch, 'lease.epoch'), leaseCap);

    await ageExecutionStart(claimed.delivery_id, 120_000);
    await repository.ackDelivery(
      claimed.delivery_id, 'Isa', 'salva', ack(claimed, requireValue(lease.epoch, 'lease.epoch'), 'started', true),
      ACK_DEADLINE_MS, leaseCap
    );

    // The deadline ended up in the past: the reaper picks it up on the next tick even though the
    // harness keeps beating, and with the cap reason.
    expect(requireValue((await deliveryRow(claimed.delivery_id)).ack_deadline_at, 'ack_deadline_at').getTime())
      .toBeLessThanOrEqual(Date.now());
    await repository.retryStaleDeliveries(30_000, 100, leaseCap);
    expect((await deliveryRow(claimed.delivery_id)).last_error).toContain('Lease cap exhausted');
  });

  it('mata por techo aunque esté prendida la palanca de reintento a ciegas', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'la palanca no desactiva el techo' }));
    const claimed = await claimAndStart(requireValue(lease.epoch, 'lease.epoch'));

    await ageExecutionStart(claimed.delivery_id, 17 * 60 * 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()+interval '1 hour' WHERE id=$1`,
      [claimed.delivery_id]
    );

    expect(await repository.retryStaleDeliveries(24 * 60 * 60_000, 100, {
      retryStartedDeliveries: true
    })).toEqual({ retried: 0, dead: 1, parked: 0 });
    expect((await deliveryRow(claimed.delivery_id)).last_error).toContain('Lease cap exhausted');
  });
});

describe('timeout_ms por mensaje', () => {
  it('deriva el techo del timeout declarado, hacia abajo y hacia arriba', () => {
    expect(deliveryLeaseCapMs({ text: 'sin declarar' }))
      .toBe(DEFAULT_DELIVERY_LEASE_CAP_MS);
    expect(deliveryLeaseCapMs({ timeout_ms: 300_000 }))
      .toBe(300_000 + DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS);
    expect(deliveryLeaseCapMs({ timeout_ms: 24 * 60 * 60_000 }))
      .toBe(24 * 60 * 60_000 + DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS);
    // Garbage or out of range: falls back to the default, never breaks.
    expect(deliveryLeaseCapMs({ timeout_ms: 'pronto' })).toBe(DEFAULT_DELIVERY_LEASE_CAP_MS);
    expect(deliveryLeaseCapMs({ timeout_ms: -1 })).toBe(DEFAULT_DELIVERY_LEASE_CAP_MS);
    expect(deliveryLeaseCapMs({ timeout_ms: 8 * 24 * 60 * 60_000 }))
      .toBe(DEFAULT_DELIVERY_LEASE_CAP_MS);
  });

  /**
   * The pair is what proves the point: with the SAME default and the same age, the delivery that
   * declares a short budget dies and the one that declares a long one survives.
   */
  it('el reaper respeta el timeout_ms del mensaje en vez del default', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    const policy = { leaseCapMs: 6 * 60 * 60_000, leaseCapGraceMs: 60_000 };

    await repository.publish(command({ text: 'tarea corta declarada', timeout_ms: 60_000 }));
    const corta = await claimAndStart(requireValue(lease.epoch, 'lease.epoch'), policy);
    await ageExecutionStart(corta.delivery_id, 30 * 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()+interval '1 hour' WHERE id=$1`,
      [corta.delivery_id]
    );
    expect(await repository.retryStaleDeliveries(24 * 60 * 60_000, 100, policy))
      .toEqual({ retried: 0, dead: 1, parked: 0 });
    const cortaRow = await deliveryRow(corta.delivery_id);
    expect(cortaRow.status).toBe('dead');
    expect(cortaRow.last_error).toContain('Lease cap exhausted');
    // The reason carries this delivery's REAL cap (60 s + 60 s grace), not the default.
    expect(cortaRow.last_error).toContain('120000 ms');

    await repository.publish(command({
      text: 'tarea larga declarada', timeout_ms: 20 * 60 * 60_000
    }));
    const larga = await claimAndStart(requireValue(lease.epoch, 'lease.epoch'), policy);
    // Eight hours: above the 6 h default of this policy, but well below the 20 h the message
    // requested. It must not die.
    await ageExecutionStart(larga.delivery_id, 8 * 60 * 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()+interval '1 hour' WHERE id=$1`,
      [larga.delivery_id]
    );
    expect(await repository.retryStaleDeliveries(24 * 60 * 60_000, 100, policy))
      .toEqual({ retried: 0, dead: 0, parked: 0 });
    expect((await deliveryRow(larga.delivery_id)).status).toBe('started');
  });

  /**
   * An old or corrupted `timeout_ms` must not topple the reaper tick. This is the failure mode
   * that once left the fleet with live agents and dead deliveries.
   */
  it('sobrevive a un timeout_ms corrupto en una fila ya persistida', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'fila vieja con basura' }));
    const claimed = await claimAndStart(requireValue(lease.epoch, 'lease.epoch'));
    await pool.query(
      `UPDATE messages SET body=jsonb_set(body,'{timeout_ms}','"pronto"'::jsonb)
        WHERE id=(SELECT message_id FROM deliveries WHERE id=$1)`, [claimed.delivery_id]
    );
    await ageExecutionStart(claimed.delivery_id, 17 * 60 * 60_000);

    // It falls back to the 12 h default and dies by cap, without a conversion error.
    expect(await repository.retryStaleDeliveries(24 * 60 * 60_000)).toEqual({ retried: 0, dead: 1, parked: 0 });
    expect((await deliveryRow(claimed.delivery_id)).last_error).toContain('Lease cap exhausted');
  });
});
