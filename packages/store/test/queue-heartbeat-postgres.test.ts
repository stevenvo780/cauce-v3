import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * P0-2 — el latido de una entrega EN COLA.
 *
 * El adaptador ya no manda 'started' antes de tomar el candado de sesión: mientras hace fila late
 * en 'accepted'. Estas pruebas fijan el contrato del store para ese latido: renueva el plazo de la
 * garra sin fingir ejecución, y en cuanto el adaptador deja de latir el reaper la recoge — que es
 * justamente lo que hasta ahora no pasaba nunca.
 */

let database: TestDatabase;
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
    // `execution_started_at` sólo existe a partir de 012_execution_started_marker.sql; en un árbol
    // sin esa migración la columna se lee como NULL y las aserciones sobre ella siguen valiendo.
    `SELECT status,last_ack_rank,ack_deadline_at,
            (to_jsonb(d)->>'execution_started_at')::timestamptz AS execution_started_at
     FROM deliveries d WHERE id=$1`,
    [id]
  )).rows[0];
  if (!row) throw new Error(`delivery ${id} not found`);
  return row;
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

describe('queue heartbeat on an accepted delivery', () => {
  it('renews the claim without claiming execution', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'queue-consumer', [], 60_000);
    const published = await repository.publish(command());
    const deliveryId = published.delivery_ids[0]!;
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', 'queue-consumer', lease.epoch!, 1, 30_000
    );
    if (!claimed) throw new Error('expected a claimed delivery');

    await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack(claimed, lease.epoch!, 'accepted'), 30_000);
    const afterAccept = await deliveryRow(deliveryId);
    expect(afterAccept.status).toBe('accepted');

    // Acortar el plazo a mano simula que pasó el tiempo: si el latido no renueva, el reaper la come.
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()+interval '2 seconds' WHERE id=$1`, [deliveryId]
    );
    const shortened = await deliveryRow(deliveryId);

    const renewal = await repository.ackDelivery(
      deliveryId, 'Isa', 'salva', ack(claimed, lease.epoch!, 'accepted'), 600_000
    );
    expect(renewal).toMatchObject({ status: 'accepted', applied: true, receipt: 'applied' });

    const afterRenewal = await deliveryRow(deliveryId);
    expect(afterRenewal.ack_deadline_at.getTime()).toBeGreaterThan(shortened.ack_deadline_at.getTime());
    // Lo que NO puede pasar: el latido de cola no promueve la fila ni inventa ejecución.
    expect(afterRenewal.status).toBe('accepted');
    expect(afterRenewal.last_ack_rank).toBe(1);
    expect(afterRenewal.execution_started_at).toBeNull();
  });

  it('a queued delivery that stops beating IS reaped; one that keeps beating is not', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'queue-consumer', [], 60_000);
    const silent = (await repository.publish(command())).delivery_ids[0]!;
    const beating = (await repository.publish(command())).delivery_ids[0]!;
    const claims = await repository.claimDeliveries(
      'Isa', 'salva', 'queue-consumer', lease.epoch!, 2, 30_000
    );
    expect(claims).toHaveLength(2);
    for (const claimed of claims) {
      await repository.ackDelivery(
        claimed.delivery_id, 'Isa', 'salva', ack(claimed, lease.epoch!, 'accepted'), 30_000
      );
    }

    // (1) Sólo se vence el plazo de la entrega silenciosa para evaluar la expiración diferencial.
    // (2) El barrido se ejecuta con plazo real para evaluar `ack_deadline_at` por fila.
    await pool.query(
      `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second' WHERE id=$1`, [silent]
    );
    const beatingClaim = claims.find((entry) => entry.delivery_id === beating)!;
    const renewal = await repository.ackDelivery(
      beating, 'Isa', 'salva', ack(beatingClaim, lease.epoch!, 'accepted'), 600_000
    );
    // Si el latido dejara de aplicarse, el test tiene que decirlo acá y no a través del conteo.
    expect(renewal).toMatchObject({ status: 'accepted', applied: true });

    const reaped = await repository.retryStaleDeliveries(30_000, 100);
    expect(reaped.retried + reaped.dead).toBe(1);
    expect((await deliveryRow(silent)).status).toBe('retry');
    expect((await deliveryRow(beating)).status).toBe('accepted');
  });

  it('a queue heartbeat cannot renew a delivery that is already executing', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', 'queue-consumer', [], 60_000);
    const published = await repository.publish(command());
    const deliveryId = published.delivery_ids[0]!;
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', 'queue-consumer', lease.epoch!, 1, 30_000
    );
    if (!claimed) throw new Error('expected a claimed delivery');

    await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack(claimed, lease.epoch!, 'accepted'), 30_000);
    await repository.ackDelivery(deliveryId, 'Isa', 'salva', ack(claimed, lease.epoch!, 'started'), 30_000);
    expect((await deliveryRow(deliveryId)).status).toBe('started');

    // Un latido de cola rezagado no puede degradar ni renovar una fila que ya ejecuta.
    const late = await repository.ackDelivery(
      deliveryId, 'Isa', 'salva', ack(claimed, lease.epoch!, 'accepted'), 600_000
    );
    expect(late).toMatchObject({ status: 'started', applied: false, receipt: 'superseded' });
    expect((await deliveryRow(deliveryId)).status).toBe('started');
    expect((await deliveryRow(deliveryId)).last_ack_rank).toBe(2);
  });
});
