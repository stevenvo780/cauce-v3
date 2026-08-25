import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import {
  CauceRepository, DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  deliveryLeaseCapMs, type DatabasePool
} from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
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
 * Deja la entrega en 'started' con el harness declarando que arrancó de verdad, que es el
 * estado exacto desde el que una entrega puede volverse inmortal.
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

async function deliveryRow(id: string): Promise<{
  status: string;
  last_error: string | null;
  ack_deadline_at: Date | null;
}> {
  const result = await pool.query<{
    status: string; last_error: string | null; ack_deadline_at: Date | null;
  }>('SELECT status,last_error,ack_deadline_at FROM deliveries WHERE id=$1', [id]);
  const row = result.rows[0];
  if (!row) throw new Error(`delivery ${id} not found`);
  return row;
}

/** Envejece el ANCLA del techo, no el plazo: es lo que separa este guarda del de ACK vencido. */
async function ageExecutionStart(id: string, ms: number): Promise<void> {
  await pool.query(
    `UPDATE deliveries
        SET execution_started_at=now()-$2*interval '1 millisecond',
            claimed_at=now()-$2*interval '1 millisecond'
      WHERE id=$1`,
    [id, ms]
  );
}

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

beforeEach(async () => {
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
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('techo de vida total de una entrega', () => {
  /**
   * EL CASO DEL INCIDENTE. La garra está PERFECTAMENTE VIVA —plazo dentro de una hora, renovado
   * recién— y sin embargo la entrega lleva horas colgada. Antes de este parche el reaper ni
   * siquiera la miraba: su WHERE sólo pregunta por plazos vencidos.
   */
  it('mata una entrega cuya garra sigue viva pero superó el techo, con motivo propio', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'harness colgado que sigue latiendo' }));
    const claimed = await claimAndStart(lease.epoch!);

    // 17,36 h fue lo medido en producción para la entrega de janus. El techo por defecto son 12 h.
    await ageExecutionStart(claimed.delivery_id, 17 * 60 * 60_000);
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()+interval '1 hour',
                            claim_expires_at=now()+interval '1 hour' WHERE id=$1`,
      [claimed.delivery_id]
    );
    expect((await deliveryRow(claimed.delivery_id)).ack_deadline_at!.getTime())
      .toBeGreaterThan(Date.now());

    // staleMs enorme: ninguna garra está vencida, así que el ÚNICO camino posible es el techo.
    const swept = await repository.retryStaleDeliveries(24 * 60 * 60_000);

    expect(swept).toEqual({ retried: 0, dead: 1, parked: 0 });
    const row = await deliveryRow(claimed.delivery_id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toContain('Lease cap exhausted');
    // El motivo NO puede confundirse con el otro camino: "dejó de responder" y "no deja de
    // responder" mandan al operador a lugares opuestos.
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
    const claimed = await claimAndStart(lease.epoch!);

    // Once horas: largo, pero por debajo de las 12 h del default. No debe morir.
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
    const claimed = await claimAndStart(lease.epoch!, leaseCap);

    // Faltan 10 s para el techo, pero el plazo de ACK son 60 s: la renovación no puede darle 60.
    await ageExecutionStart(claimed.delivery_id, 50_000);
    const renewed = await repository.ackDelivery(
      claimed.delivery_id, 'Isa', 'salva', ack(claimed, lease.epoch!, 'started', true),
      ACK_DEADLINE_MS, leaseCap
    );
    expect(renewed).toMatchObject({ applied: true, status: 'started' });

    const row = await deliveryRow(claimed.delivery_id);
    const remainingMs = row.ack_deadline_at!.getTime() - Date.now();
    expect(remainingMs).toBeLessThan(15_000);
    expect(remainingMs).toBeGreaterThan(0);
  });

  it('deja de renovar del todo una vez pasado el techo', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'latido después del techo' }));
    const leaseCap = { leaseCapMs: 60_000 };
    const claimed = await claimAndStart(lease.epoch!, leaseCap);

    await ageExecutionStart(claimed.delivery_id, 120_000);
    await repository.ackDelivery(
      claimed.delivery_id, 'Isa', 'salva', ack(claimed, lease.epoch!, 'started', true),
      ACK_DEADLINE_MS, leaseCap
    );

    // El plazo quedó en el pasado: el reaper la recoge en el tick siguiente aunque el harness
    // siga latiendo, y con el motivo del techo.
    expect((await deliveryRow(claimed.delivery_id)).ack_deadline_at!.getTime())
      .toBeLessThanOrEqual(Date.now());
    await repository.retryStaleDeliveries(30_000, 100, leaseCap);
    expect((await deliveryRow(claimed.delivery_id)).last_error).toContain('Lease cap exhausted');
  });

  it('mata por techo aunque esté prendida la palanca de reintento a ciegas', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'la palanca no desactiva el techo' }));
    const claimed = await claimAndStart(lease.epoch!);

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
    // Basura o fuera de rango: cae al default, nunca rompe.
    expect(deliveryLeaseCapMs({ timeout_ms: 'pronto' })).toBe(DEFAULT_DELIVERY_LEASE_CAP_MS);
    expect(deliveryLeaseCapMs({ timeout_ms: -1 })).toBe(DEFAULT_DELIVERY_LEASE_CAP_MS);
    expect(deliveryLeaseCapMs({ timeout_ms: 8 * 24 * 60 * 60_000 }))
      .toBe(DEFAULT_DELIVERY_LEASE_CAP_MS);
  });

  /**
   * El par es lo que prueba el punto: con el MISMO default y la misma edad, la entrega que
   * declara un presupuesto corto muere y la que declara uno largo sobrevive.
   */
  it('el reaper respeta el timeout_ms del mensaje en vez del default', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    const policy = { leaseCapMs: 6 * 60 * 60_000, leaseCapGraceMs: 60_000 };

    await repository.publish(command({ text: 'tarea corta declarada', timeout_ms: 60_000 }));
    const corta = await claimAndStart(lease.epoch!, policy);
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
    // El motivo lleva el techo REAL de esta entrega (60 s + 60 s de gracia), no el default.
    expect(cortaRow.last_error).toContain('120000 ms');

    await repository.publish(command({
      text: 'tarea larga declarada', timeout_ms: 20 * 60 * 60_000
    }));
    const larga = await claimAndStart(lease.epoch!, policy);
    // Ocho horas: por encima del default de 6 h de esta política, pero muy por debajo de las 20 h
    // que el mensaje pidió. No debe morir.
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
   * `timeout_ms` viejo o corrupto no puede tumbar el tick del reaper. Es el modo de falla que ya
   * dejó una vez a la flota con los agentes vivos y las entregas muertas.
   */
  it('sobrevive a un timeout_ms corrupto en una fila ya persistida', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'lease-cap-consumer', [], 120_000);
    await repository.publish(command({ text: 'fila vieja con basura' }));
    const claimed = await claimAndStart(lease.epoch!);
    await pool.query(
      `UPDATE messages SET body=jsonb_set(body,'{timeout_ms}','"pronto"'::jsonb)
        WHERE id=(SELECT message_id FROM deliveries WHERE id=$1)`, [claimed.delivery_id]
    );
    await ageExecutionStart(claimed.delivery_id, 17 * 60 * 60_000);

    // Cae al default de 12 h y muere por techo, sin error de conversión.
    expect(await repository.retryStaleDeliveries(24 * 60 * 60_000)).toEqual({ retried: 0, dead: 1, parked: 0 });
    expect((await deliveryRow(claimed.delivery_id)).last_error).toContain('Lease cap exhausted');
  });
});
