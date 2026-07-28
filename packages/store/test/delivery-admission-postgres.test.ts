import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, timeoutRetryBackoffSeconds, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Reparto de cupo y reaper que no vuelve a pagar el trabajo dos veces.
 *
 * Incidente que motiva todo esto (medido el 2026-07-27 con SQL sobre producción): en 7 días el
 * bus pagó 6.106 corridas de harness para 4.050 entregas reales. En los agentes con harness
 * codex, 2.240 corridas para 1.312 entregas: 71% de desperdicio, y eso agotó la cuota SEMANAL
 * de una cuenta ChatGPT Pro en 5 horas. El error dominante fueron 1.001 "ACK timeout" de 1.622.
 * Del otro lado, midas (asistente de una persona) esperaba 114 minutos de mediana antes de que
 * su entrega fuera siquiera reclamada.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const humanTenant: Tenant = 'Steven';
const consumerTenant: Tenant = 'Steven';
const consumerAlias = 'argos';

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: humanTenant,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: consumerTenant, alias: consumerAlias }],
    body: { text: 'mensaje de una persona' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

/**
 * Publica una entrega agente-a-agente sin pasar por la cadena completa de delegación: escribe
 * el mismo `body.type` que escribe `materializeAgentOutputs` y el mismo `lane='batch'`.
 * `publish()` rechaza los tipos reservados a propósito, así que el INSERT va directo.
 */
async function publishAgentDelivery(text: string): Promise<string> {
  const message = await pool.query<{ id: string }>(
    `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority)
     VALUES($1,$2,$3,'grp.steven','kant',$4::jsonb,'batch',0) RETURNING id`,
    [randomUUID(), `trace-${randomUUID()}`, humanTenant, JSON.stringify({
      type: 'agent.message', text, from_alias: 'kant'
    })]
  );
  const messageId = message.rows[0]!.id;
  const delivery = await pool.query<{ id: string }>(
    `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
     VALUES($1,$2,$3) RETURNING id`,
    [messageId, consumerTenant, consumerAlias]
  );
  return delivery.rows[0]!.id;
}

function ack(
  delivery: DeliveryEnvelope,
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
 * Reproduce lo que hace el SDK cuando el harness ARRANCA de verdad: un 'started' normal primero
 * (que es sólo "la entrega fue admitida") y después, ya con el turno de sesión en la mano y a
 * punto de invocar al harness, otro 'started' con `execution_started`. Los dos hacen falta
 * porque la diferencia entre ellos es justamente lo que el reaper tiene que poder distinguir.
 */
async function startExecution(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number
): Promise<void> {
  await repository.ackDelivery(
    delivery.delivery_id, consumerTenant, consumerAlias,
    ack(delivery, instanceId, epoch, 'started')
  );
  await repository.ackDelivery(
    delivery.delivery_id, consumerTenant, consumerAlias,
    ack(delivery, instanceId, epoch, 'started', { execution_started: true })
  );
}

async function expire(deliveryId: string): Promise<void> {
  await pool.query(
    `UPDATE deliveries SET ack_deadline_at=now()-interval '1 second',
       claim_expires_at=now()-interval '1 second' WHERE id=$1`,
    [deliveryId]
  );
}

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

describe('claim admission with a reserve for humans', () => {
  it('admits a human delivery through the reserve while the general budget is exhausted', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-1', [], 30_000);
    await publishAgentDelivery('tarea larga entre agentes');
    await publishAgentDelivery('otra tarea larga');
    await repository.publish(command({ body: { text: '¿cómo venís?' } }));

    // `limit: 0` es el estado real del gateway cuando el agente ya tiene su trabajo en vuelo.
    // Sin cupo reservado esto devolvería cero y la persona esperaría a que termine la tarea.
    const claimed = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-1', lease.epoch!, 0, 30_000, 3,
      { humanReservedLimit: 1 }
    );

    expect(claimed).toHaveLength(1);
    expect(claimed[0]!.body).toMatchObject({ text: '¿cómo venís?' });
    // Y las dos tareas entre agentes siguen esperando: el humano usó su cupo, no el de ellas.
    expect((await pool.query(
      `SELECT 1 FROM deliveries WHERE status='pending'`
    )).rowCount).toBe(2);
  });

  it('serves the human delivery first even when it was queued last', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-2', [], 30_000);
    for (let index = 0; index < 4; index += 1) await publishAgentDelivery(`hop ${index}`);
    await repository.publish(command({ body: { text: 'llegué última' } }));

    const [first] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-2', lease.epoch!, 1, 30_000
    );

    expect(first?.body).toMatchObject({ text: 'llegué última' });
  });

  it('yields one turn to agent work after the configured human burst', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-3', [], 30_000);
    for (let index = 0; index < 4; index += 1) await publishAgentDelivery(`hop ${index}`);
    for (let index = 0; index < 4; index += 1) {
      await repository.publish(command({ body: { text: `humano ${index}` } }));
    }

    const claimed = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-3', lease.epoch!, 8, 30_000, 3
    );

    // Tres humanos, después uno de agentes, después humano de nuevo: la misma alternancia que
    // ya hacía `delivery_lane_fairness`, sólo que ahora la partición discrimina de verdad.
    expect(claimed.map(
      (delivery) => typeof delivery.body.type === 'string' ? delivery.body.type : 'human'
    )).toEqual([
      'human', 'human', 'human', 'agent.message', 'human', 'agent.message', 'agent.message', 'agent.message'
    ]);
  });

  /**
   * El presupuesto de admisión tiene que poder reconstruirse desde la base, o una reconexión lo
   * multiplica: el gateway creaba un mapa de garras vacío en cada `hello` y le devolvía el cupo
   * entero al adaptador. Con `renewable_delivery_claims_v1` eso es doblemente grave, porque esa
   * capacidad existe para CONSERVAR el lease entre reconexiones.
   */
  it('reports the live claims of an alias with their admission class', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-5', [], 30_000);
    await publishAgentDelivery('trabajo entre agentes');
    await repository.publish(command({ body: { text: 'mensaje de una persona' } }));
    const claimed = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-5', lease.epoch!, 2, 30_000
    );
    expect(claimed).toHaveLength(2);

    const live = await repository.liveDeliveryClaims(consumerTenant, consumerAlias);
    expect(live).toHaveLength(2);
    expect(new Set(live.map((claim) => claim.agent_to_agent))).toEqual(new Set([true, false]));

    // Una garra terminada deja de ocupar cupo en el acto.
    const first = claimed.find((delivery) => delivery.body.type === undefined)!;
    await repository.ackDelivery(
      first.delivery_id, consumerTenant, consumerAlias,
      ack(first, 'assistant-5', lease.epoch!, 'done')
    );
    const remaining = await repository.liveDeliveryClaims(consumerTenant, consumerAlias);
    expect(remaining.map((claim) => claim.agent_to_agent)).toEqual([true]);
  });

  it('rejects a claim with no general budget and no reserve', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'assistant-4', [], 30_000);
    await expect(repository.claimDeliveries(
      consumerTenant, consumerAlias, 'assistant-4', lease.epoch!, 0, 30_000
    )).rejects.toMatchObject({ code: 'conflict' });
  });
});

describe('agent-derived messages leave the interactive lane', () => {
  it('materializes delegated work on the batch lane instead of inheriting the parent lane', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'delegator-1', [], 30_000);
    const source = command({ lane: 'interactive', body: { text: 'delegá esto' } });
    await repository.publish(source);
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'delegator-1', lease.epoch!, 1, 30_000
    );

    await repository.ackDelivery(delivery!.delivery_id, consumerTenant, consumerAlias, {
      ...ack(delivery!, 'delegator-1', lease.epoch!, 'done'),
      result: {
        output: {
          reply: null,
          messages: [{ to: 'socrates', body: 'hacé la parte dos' }],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      }
    });

    const derived = await pool.query<{ lane: string; type: string }>(
      `SELECT lane,body->>'type' AS type FROM messages WHERE body->>'type'='agent.message'`
    );
    expect(derived.rowCount).toBe(1);
    // El mensaje original de la persona sigue en 'interactive'; sólo la descendencia baja a
    // 'batch'. Heredarlo era lo que hacía que la cola del asistente y la cola de trabajo
    // fueran la misma cola.
    expect(derived.rows[0]).toEqual({ lane: 'batch', type: 'agent.message' });
    expect((await pool.query<{ lane: string }>(
      `SELECT lane FROM messages WHERE request_id=$1`, [source.request_id]
    )).rows[0]).toEqual({ lane: 'interactive' });
  });
});

describe('stale delivery reaper', () => {
  it('retries a delivery that never started, with backoff instead of immediately', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'crashed-1', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'crashed-1', lease.epoch!, 1, 30_000
    );
    await expire(delivery!.delivery_id);

    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 1, dead: 0 });

    const row = await pool.query<{ status: string; available_in: number }>(
      `SELECT status,EXTRACT(EPOCH FROM (available_at-now())) AS available_in
       FROM deliveries WHERE id=$1`, [delivery!.delivery_id]
    );
    expect(row.rows[0]?.status).toBe('retry');
    // `available_at=now()` devolvía la entrega al mismo agente saturado en el tick siguiente:
    // es la realimentación positiva del incidente, cada muerte generando más carga.
    expect(Number(row.rows[0]?.available_in)).toBeGreaterThan(timeoutRetryBackoffSeconds(1) - 5);
  });

  /**
   * EL caso que hacía perder trabajo del usuario, y por eso va antes que el del ahorro.
   *
   * Un ACK 'started' NO prueba ejecución: el SDK lo emite antes de llamar al harness y la
   * entrega puede quedarse minutos esperando el candado de sesión, renovando cada 60 s, sin
   * haber gastado un centavo. La versión anterior del reaper lo tomaba como prueba y mandaba
   * esas entregas a `dead`: trabajo pedido por una persona, perdido para siempre, sin haberse
   * corrido jamás.
   */
  it('retries a delivery that only ACKed started, because that is not proof of execution', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'waiting-1', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'waiting-1', lease.epoch!, 1, 30_000
    );
    await repository.ackDelivery(
      delivery!.delivery_id, consumerTenant, consumerAlias,
      ack(delivery!, 'waiting-1', lease.epoch!, 'started')
    );
    await expire(delivery!.delivery_id);

    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 1, dead: 0 });
    expect((await pool.query<{ status: string; execution_started_at: Date | null }>(
      'SELECT status,execution_started_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    )).rows[0]).toMatchObject({ status: 'retry', execution_started_at: null });
  });

  it('holds a delivery that already started for manual review instead of paying the run twice', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'worker-1', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-1', lease.epoch!, 1, 30_000
    );
    // Marca explícita del SDK: el harness obtuvo el turno de sesión y se lo invocó. ESO es lo
    // que significa que ya se pagó una corrida.
    await startExecution(delivery!, 'worker-1', lease.epoch!);
    await expire(delivery!.delivery_id);

    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 0, dead: 1 });

    const row = await pool.query<{ status: string; attempt: number; last_error: string }>(
      'SELECT status,attempt,last_error FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    expect(row.rows[0]).toMatchObject({
      status: 'dead',
      // No consumió un intento más: no se re-ejecutó nada.
      attempt: 1,
      last_error: 'ACK timeout: execution already started; held for manual replay'
    });
    // `dead` + fila en dead_letters es exactamente lo que exige `replayDelivery`, o sea que
    // el operador tiene el botón de reencolar sin que se haya reencolado solo.
    expect((await pool.query(
      `SELECT 1 FROM dead_letters
       WHERE delivery_id=$1 AND reason='ACK timeout: execution already started; held for manual replay'`,
      [delivery!.delivery_id]
    )).rowCount).toBe(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE delivery_id=$1 AND action='delivery.ack_timeout'
         AND metadata->>'reason'='execution_already_started'`,
      [delivery!.delivery_id]
    )).rowCount).toBe(1);
    // Y sobre todo: nadie se lo puede volver a llevar.
    // `takeover: true` a proposito: sin el, acquireLease devuelve acquired:false SIN epoch
    // (worker-1 todavia tiene el lease vivo) y el reclamo siguiente saldria con epoch undefined,
    // o sea rechazado por fencing -- que es correcto, pero probaria otra cosa. Lo que se quiere
    // demostrar aca es que ni un consumidor legitimo, con lease propio y epoca nueva, puede
    // llevarse una entrega retenida para revision manual.
    const secondLease = await repository.acquireLease(
      consumerTenant, consumerAlias, 'worker-2', [], 30_000, { takeover: true }
    );
    expect(await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-2', secondLease.epoch!, 5, 30_000
    )).toHaveLength(0);
  });

  it('still relays the failure to the origin so the human is not left in silence', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'worker-3', [], 30_000);
    await repository.publish(command({
      origin: {
        adapter: 'telegram', channel: 'dm', conversation_id: '42', relay: [], metadata: {}
      }
    }));
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-3', lease.epoch!, 1, 30_000
    );
    await startExecution(delivery!, 'worker-3', lease.epoch!);
    await expire(delivery!.delivery_id);

    await repository.retryStaleDeliveries(0);

    // "Se quedó a medias" es una respuesta; el silencio no lo es. El dueño del sistema pidió
    // explícitamente poder saber qué pasó, aunque la respuesta sea que falló.
    const relay = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM adapter_outbox WHERE kind='origin_relay' AND delivery_id=$1`,
      [delivery!.delivery_id]
    );
    expect(relay.rowCount).toBe(1);
    expect(relay.rows[0]?.payload).toMatchObject({
      outcome: 'dead',
      error: 'ACK timeout: execution already started; held for manual replay'
    });
  });

  it('restores the blind retry when the emergency lever is on', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'worker-4', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-4', lease.epoch!, 1, 30_000
    );
    await startExecution(delivery!, 'worker-4', lease.epoch!);
    await expire(delivery!.delivery_id);

    expect(await repository.retryStaleDeliveries(0, 100, { retryStartedDeliveries: true }))
      .toEqual({ retried: 1, dead: 0 });
    expect((await pool.query<{ status: string }>(
      'SELECT status FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    )).rows[0]?.status).toBe('retry');
  });

  it('scopes the started evidence to the current attempt', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'worker-5', [], 30_000);
    await repository.publish(command());
    const [first] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-5', lease.epoch!, 1, 30_000
    );
    await startExecution(first!, 'worker-5', lease.epoch!);
    await expire(first!.delivery_id);
    // Se fuerza el reintento del intento 1 con la palanca, para dejar en delivery_acks un
    // 'started' aplicado de un intento VIEJO. El backoff corre available_at al futuro, así que
    // hay que rehabilitarla para poder reclamarla dentro del test.
    expect(await repository.retryStaleDeliveries(0, 100, { retryStartedDeliveries: true }))
      .toEqual({ retried: 1, dead: 0 });
    await pool.query('UPDATE deliveries SET available_at=now() WHERE id=$1', [first!.delivery_id]);

    const [second] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'worker-5', lease.epoch!, 1, 30_000
    );
    expect(second?.attempt).toBe(2);
    await expire(second!.delivery_id);

    // El intento 2 no arrancó nunca. La marca pertenece al intento y se limpia tanto en el
    // reintento como en el reclamo; sin eso, una entrega quedaría retenida para siempre por
    // evidencia de una corrida anterior.
    expect(await repository.retryStaleDeliveries(0)).toEqual({ retried: 1, dead: 0 });
  });
});

describe('ack deadline bookkeeping', () => {
  /**
   * El PRIMER 'started' también corre el plazo. Antes sólo lo movían las renovaciones, así que
   * la base seguía contando desde el reclamo mientras el gateway —que sí lo corre al ver el ACK
   * aplicado— daba la garra por viva más tiempo del real. Las dos vistas de la misma garra se
   * separaban por lo que hubiera tardado el arranque, y el cupo del gateway quedaba retenido
   * contra una entrega que la base ya podía reclamarle al reaper.
   */
  it('moves the ack deadline on the first started, not only on renewals', async () => {
    const lease = await repository.acquireLease(consumerTenant, consumerAlias, 'deadline-1', [], 30_000);
    await repository.publish(command());
    const [delivery] = await repository.claimDeliveries(
      consumerTenant, consumerAlias, 'deadline-1', lease.epoch!, 1, 5_000
    );
    const claimed = Date.parse(delivery!.ack_deadline_at);

    await repository.ackDelivery(
      delivery!.delivery_id, consumerTenant, consumerAlias,
      ack(delivery!, 'deadline-1', lease.epoch!, 'started'),
      60_000
    );

    const row = await pool.query<{ ack_deadline_at: Date; claim_expires_at: Date }>(
      'SELECT ack_deadline_at,claim_expires_at FROM deliveries WHERE id=$1', [delivery!.delivery_id]
    );
    expect(row.rows[0]!.ack_deadline_at.getTime()).toBeGreaterThan(claimed);
    expect(row.rows[0]!.claim_expires_at.getTime())
      .toBe(row.rows[0]!.ack_deadline_at.getTime());
  });
});
