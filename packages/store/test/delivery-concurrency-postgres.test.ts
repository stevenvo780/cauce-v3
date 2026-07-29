import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

// Techo de concurrencia por agente (agents.max_concurrent_deliveries).
//
// Lo que se está protegiendo, medido en producción: el gateway reclamaba de a 20 por drain
// mientras el harness ejecuta UNA por sessionKey. argos llegó a 92 entregas en vuelo ejecutando 2,
// con espera mediana de 3 horas y 73% muerto sin ejecutarse jamás. Reclamar no es gratis: arranca
// ack_deadline_at, y ese reloj corre mientras la entrega hace cola detrás del mutex del harness.
//
// Estas pruebas fijan las dos mitades del contrato, porque una sin la otra es peor que no hacer
// nada: (1) no se reclama por encima del techo, y (2) lo que NO se reclama sigue reclamable —
// queda 'pending', intacto y sin haber gastado un intento.

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'work' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}

interface Consumer {
  tenant: Tenant;
  alias: string;
  instanceId: string;
  epoch: number;
}

async function consumer(tenant: Tenant, alias: string): Promise<Consumer> {
  const instanceId = `${alias}-${randomUUID()}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
  return { tenant, alias, instanceId, epoch: lease.epoch! };
}

/**
 * `resetTestDatabase` trunca `agents`, así que por defecto ningún alias tiene fila y el techo no
 * aplica. Cada prueba declara explícitamente el agente que quiere acotar. Se inserta con
 * enabled=false y sin placement para no arrastrar las constraints agents_enabled_requires_runtime
 * ni agents_placement_atomic, que no tienen nada que ver con lo que se está probando.
 */
async function declareAgent(
  tenant: Tenant, alias: string, maxConcurrent: number | null
): Promise<void> {
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,enabled,max_concurrent_deliveries)
     VALUES($1,$2,false,$3)
     ON CONFLICT(tenant_id,alias) DO UPDATE SET max_concurrent_deliveries=EXCLUDED.max_concurrent_deliveries`,
    [tenant, alias, maxConcurrent]
  );
}

async function publishMany(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await repository.publish(command({ body: { text: `work ${index}` } }));
  }
}

async function statusCounts(alias: string): Promise<Record<string, number>> {
  const result = await pool.query<{ status: string; total: string }>(
    `SELECT status, count(*) AS total FROM deliveries
     WHERE recipient_alias=$1 GROUP BY status`, [alias]
  );
  return Object.fromEntries(result.rows.map((row) => [row.status, Number(row.total)]));
}

function terminalAck(target: Consumer, delivery: { claim_token: string; attempt: number }): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: target.instanceId,
    epoch: target.epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: { output: { reply: 'ok', messages: [], status: 'done', retryable: false, artifacts: [] } }
  };
}

function progressAck(
  target: Consumer,
  delivery: { claim_token: string; attempt: number },
  status: 'accepted' | 'started'
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: target.instanceId,
    epoch: target.epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false
  };
}

describe('per-agent delivery concurrency cap', () => {
  it('never hands out more than the agent can execute, however much is queued', async () => {
    // El caso exacto del incidente en miniatura: mucha cola, un solo drain generoso.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );

    // Antes del arreglo esto devolvía 9: el límite pedido, no el ejecutable.
    expect(claimed).toHaveLength(2);
  });

  it('leaves everything it did not claim as pending, with no attempt spent', async () => {
    // La mitad que importa de verdad. Un techo que reclamara menos pero rompiera o encolara mal
    // el resto sería un cambio peor que el problema: ahí es donde el backlog se incinera.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    await repository.claimDeliveries(argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000);

    expect(await statusCounts('argos')).toEqual({ leased: 2, pending: 7 });
    const attempts = await pool.query<{ attempt: number }>(
      `SELECT DISTINCT attempt FROM deliveries WHERE recipient_alias='argos' AND status='pending'`
    );
    // Ningún intento gastado y ningún reloj de ACK corriendo sobre lo no reclamado.
    expect(attempts.rows).toEqual([{ attempt: 0 }]);
    const armed = await pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM deliveries
       WHERE recipient_alias='argos' AND status='pending' AND ack_deadline_at IS NOT NULL`
    );
    expect(Number(armed.rows[0]!.total)).toBe(0);
  });

  it('counts what is already in flight, so repeated drains cannot stack past the cap', async () => {
    // Un solo claim acotado no alcanza: el gateway drena muchas veces (wake, ACK, reconexión).
    await declareAgent('Steven', 'argos', 3);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const first = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    const second = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    const third = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );

    expect(first).toHaveLength(3);
    expect(second).toHaveLength(0);
    expect(third).toHaveLength(0);
    expect(await statusCounts('argos')).toEqual({ leased: 3, pending: 6 });
  });

  it('keeps counting a delivery the harness has accepted or started', async () => {
    // 'accepted' y 'started' son ocupación real: el harness ya la tiene. Si el conteo mirara sólo
    // 'leased', el primer ACK de progreso liberaría un cupo falso y volvería el sobre-reclamo.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(6);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(claimed).toHaveLength(2);

    await repository.ackDelivery(claimed[0]!.delivery_id, argos.tenant, argos.alias,
      progressAck(argos, claimed[0]!, 'accepted'), 30_000);
    await repository.ackDelivery(claimed[1]!.delivery_id, argos.tenant, argos.alias,
      progressAck(argos, claimed[1]!, 'started'), 30_000);
    expect(await statusCounts('argos')).toEqual({ accepted: 1, started: 1, pending: 4 });

    const afterProgress = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(afterProgress).toHaveLength(0);
  });

  it('hands out the next batch as soon as a terminal ACK frees the slot', async () => {
    // El drenaje. Si esto no pasa, el techo deja de ser un techo y pasa a ser un tapón.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(5);
    const argos = await consumer('Steven', 'argos');

    const first = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(first).toHaveLength(2);

    await repository.ackDelivery(
      first[0]!.delivery_id, argos.tenant, argos.alias, terminalAck(argos, first[0]!), 30_000
    );

    const afterOne = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(afterOne).toHaveLength(1);

    await repository.ackDelivery(
      first[1]!.delivery_id, argos.tenant, argos.alias, terminalAck(argos, first[1]!), 30_000
    );
    await repository.ackDelivery(
      afterOne[0]!.delivery_id, argos.tenant, argos.alias, terminalAck(argos, afterOne[0]!), 30_000
    );

    const afterTwo = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(afterTwo).toHaveLength(2);

    // Las 5 llegaron a ejecutarse. Ninguna se perdió ni murió esperando.
    const delivered = new Set([...first, ...afterOne, ...afterTwo].map((item) => item.delivery_id));
    expect(delivered.size).toBe(5);
  });

  it('does not cap a consumer that has no row in agents', async () => {
    // Fail-open deliberado: puentes y recolectores no están modelados como agentes y tienen que
    // seguir comportándose exactamente como antes de este cambio.
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );

    expect(claimed).toHaveLength(9);
  });

  it('treats a NULL cap as unlimited, the in-place escape hatch', async () => {
    // Es el rollback sin deploy: UPDATE agents SET max_concurrent_deliveries=NULL.
    await declareAgent('Steven', 'argos', null);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );

    expect(claimed).toHaveLength(9);
  });

  it('still honours a caller limit below the cap', async () => {
    // El techo acota, no reemplaza. Un llamador que pide menos sigue recibiendo menos.
    await declareAgent('Steven', 'argos', 5);
    await publishMany(9);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 1, 30_000
    );

    expect(claimed).toHaveLength(1);
  });

  it('caps each agent independently', async () => {
    // El techo es del agente, no de la instalación: un agente lleno no puede frenar a otro.
    await declareAgent('Steven', 'argos', 1);
    await declareAgent('Steven', 'jarvis', 3);
    for (let index = 0; index < 5; index += 1) {
      await repository.publish(command({
        recipients: [
          { tenant_id: 'Steven', alias: 'argos' },
          { tenant_id: 'Steven', alias: 'jarvis' }
        ]
      }));
    }
    const argos = await consumer('Steven', 'argos');
    const jarvis = await consumer('Steven', 'jarvis');

    const argosClaim = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    const jarvisClaim = await repository.claimDeliveries(
      jarvis.tenant, jarvis.alias, jarvis.instanceId, jarvis.epoch, 20, 30_000
    );

    expect(argosClaim).toHaveLength(1);
    expect(jarvisClaim).toHaveLength(3);
  });

  it('wakes the recipient when the reaper kills the last in-flight delivery', async () => {
    // El último camino por el que se libera un cupo: no un ACK, sino el reaper venciendo la garra.
    // La rama de retry ya encolaba un wake; la de 'dead' no. Sin techo eso era inocuo — el reclamo
    // previo ya se había llevado la cola. Con techo, un alias cuyas entregas en vuelo mueren todas
    // por timeout se queda con cupo libre, sin ACK que vaya a llegar nunca (por eso vencieron) y
    // con la cola quieta hasta que alguien publique un mensaje nuevo.
    await declareAgent('Steven', 'argos', 1);
    await publishMany(4);
    const argos = await consumer('Steven', 'argos');

    const claimed = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(claimed).toHaveLength(1);

    // Agota los intentos para forzar la rama 'dead' y no la de reintento.
    await pool.query(
      `UPDATE deliveries SET attempt=max_attempts WHERE id=$1`, [claimed[0]!.delivery_id]
    );
    const reaped = await repository.retryStaleDeliveries(0, 100);
    expect(reaped.dead).toBe(1);

    const wakes = await pool.query<{ total: string }>(
      `SELECT count(*) AS total FROM adapter_outbox
       WHERE kind='wake' AND idempotency_key LIKE 'wake-dead:%'
         AND payload->>'recipient_alias'='argos'`
    );
    expect(Number(wakes.rows[0]!.total)).toBe(1);

    // Y el cupo liberado es reclamable de verdad.
    const afterReap = await repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    );
    expect(afterReap).toHaveLength(1);
  });

  it('does not let concurrent claims for the same alias exceed the cap together', async () => {
    // Dos drains simultáneos del mismo alias (un wake y un ACK, por ejemplo) leen y reclaman en
    // transacciones distintas. Lo que impide que ambos vean en_vuelo=0 y reclamen el techo entero
    // es el FOR UPDATE sobre delivery_lane_fairness, cuñado por (tenant_id, alias), que ya
    // serializa el par ANTES de que se cuente. Esta prueba fija esa garantía.
    await declareAgent('Steven', 'argos', 2);
    await publishMany(12);
    const argos = await consumer('Steven', 'argos');

    const results = await Promise.all(Array.from({ length: 4 }, async () => repository.claimDeliveries(
      argos.tenant, argos.alias, argos.instanceId, argos.epoch, 20, 30_000
    )));

    const total = results.reduce((sum, batch) => sum + batch.length, 0);
    expect(total).toBe(2);
    expect(await statusCounts('argos')).toEqual({ leased: 2, pending: 10 });
  });
});
