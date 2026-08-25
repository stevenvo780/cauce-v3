import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { AckSchema, isAmbiguousAckErrorCode, PREFLIGHT_ACK_ERROR_CODES } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Política de reintentos: R1 (código de pre-vuelo), R3 (no quemar intentos contra un alias sin
 * adaptador) y R6 (toda muerte deja rastro auditable).
 *
 * Contra el código anterior al 2026-08-06:
 *  - R3 falla porque una entrega con los intentos agotados moría SIEMPRE, hubiera o no
 *    adaptador conectado del otro lado. 881 entregas murieron así, 829 en una sola noche.
 *  - R6 falla porque la rama de intentos agotados NO escribía `audit_events`: esas 881 muertes
 *    no aparecieron nunca en ningún informe.
 *  - El invariante del esquema falla si alguien mete un código de pre-vuelo en la lista de
 *    ambiguos: ahí el ACK volvería a morir en el intento 1, y en silencio.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const ACK_DEADLINE_MS = 60_000;
const CONSUMER = 'retry-policy-consumer';

function command(text: string): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-retry-policy-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Isa', alias: 'salva' }],
    body: { type: 'command', text },
    idempotency_key: randomUUID(),
    lane: 'batch',
    priority: 0
  };
}

function ack(
  delivery: DeliveryEnvelope,
  epoch: number,
  status: Ack['status'],
  extra: Partial<Ack> = {}
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status,
    instance_id: CONSUMER,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    ...extra
  };
}

async function deliveryRow(id: string): Promise<{
  status: string; attempt: number; last_error: string | null; terminal_at: Date | null;
}> {
  const result = await pool.query<{
    status: string; attempt: number; last_error: string | null; terminal_at: Date | null;
  }>('SELECT status,attempt,last_error,terminal_at FROM deliveries WHERE id=$1', [id]);
  const row = result.rows[0];
  if (!row) throw new Error(`delivery ${id} not found`);
  return row;
}

/**
 * Gasta los `max_attempts` con reclamos REALES, no tocando el contador.
 *
 * Cada vuelta es un ciclo completo del sistema: el adaptador reclama, no ACKea, el reaper vence
 * la garra y la devuelve a `retry` con espera. Lo único que se adelanta a mano es esa espera
 * (`available_at`), que es planificación y no estado del trabajo: si se falsificara `attempt` el
 * test dejaría de probar el camino que importa.
 */
async function burnAttempts(epoch: number, times: number): Promise<string> {
  let deliveryId = '';
  for (let round = 0; round < times; round += 1) {
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', CONSUMER, epoch, 1, ACK_DEADLINE_MS
    );
    if (!claimed) throw new Error(`expected a claimed delivery on round ${round + 1}`);
    deliveryId = claimed.delivery_id;
    if (round + 1 < times) {
      // staleMs=0 vence toda garra en vuelo: es el barrido del reaper, no un atajo.
      await repository.retryStaleDeliveries(0, 100);
      await pool.query('UPDATE deliveries SET available_at=now() WHERE id=$1', [deliveryId]);
    }
  }
  return deliveryId;
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

describe('R3 — no se queman intentos contra un alias sin adaptador', () => {
  it('aparca la entrega y le devuelve el intento cuando no hay ningún consumidor conectado', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
    await repository.publish(command('trabajo para un alias que se cayó'));
    const deliveryId = await burnAttempts(lease.epoch!, 3);
    expect((await deliveryRow(deliveryId)).attempt).toBe(3);

    // El adaptador se va: a partir de acá no hay nadie del otro lado.
    await repository.releaseLease('Isa', 'salva', CONSUMER, lease.epoch!);

    const swept = await repository.retryStaleDeliveries(0, 100);

    expect(swept).toEqual({ retried: 0, dead: 0, parked: 1 });
    const row = await deliveryRow(deliveryId);
    expect(row.status).toBe('pending');
    expect(row.terminal_at).toBeNull();
    // El intento vuelve: nadie lo ejecutó, así que no fue un intento.
    expect(row.attempt).toBe(2);
    expect(row.last_error).toContain('no adapter connected');

    // Aparcar NO es morir: no hay dead letter.
    const dlq = await pool.query('SELECT 1 FROM dead_letters WHERE delivery_id=$1', [deliveryId]);
    expect(dlq.rowCount).toBe(0);

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE delivery_id=$1 AND action='delivery.parked_no_consumer'`, [deliveryId]
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      reason: 'no_adapter_connected',
      attempt_refunded: true,
      max_attempts: 3
    });
  });

  it('NO aparca cuando el adaptador está vivo: ahí el fallo sí es del destino y muere', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
    await repository.publish(command('el alias está vivo y no contesta'));
    const deliveryId = await burnAttempts(lease.epoch!, 3);

    const swept = await repository.retryStaleDeliveries(0, 100);

    expect(swept).toEqual({ retried: 0, dead: 1, parked: 0 });
    const row = await deliveryRow(deliveryId);
    expect(row.status).toBe('dead');
    expect(row.last_error).toBe('ACK timeout: max attempts exhausted');
  });

  it('NO aparca para siempre: pasado el horizonte de retención la entrega muere', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
    await repository.publish(command('encargo cuyo contexto ya venció'));
    const deliveryId = await burnAttempts(lease.epoch!, 3);
    await repository.releaseLease('Isa', 'salva', CONSUMER, lease.epoch!);

    const swept = await repository.retryStaleDeliveries(0, 100, { noConsumerParkMaxAgeMs: 1 });

    expect(swept).toEqual({ retried: 0, dead: 1, parked: 0 });
    expect((await deliveryRow(deliveryId)).status).toBe('dead');
  });

  it('la palanca devuelve el comportamiento viejo sin redesplegar código', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
    await repository.publish(command('con la palanca apagada muere como antes'));
    const deliveryId = await burnAttempts(lease.epoch!, 3);
    await repository.releaseLease('Isa', 'salva', CONSUMER, lease.epoch!);

    const swept = await repository.retryStaleDeliveries(0, 100, { parkWithoutConsumer: false });

    expect(swept).toEqual({ retried: 0, dead: 1, parked: 0 });
    expect((await deliveryRow(deliveryId)).status).toBe('dead');
  });
});

describe('R6 — ninguna muerte de entrega queda sin rastro', () => {
  it('la rama de intentos agotados escribe audit_events', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
    await repository.publish(command('tres intentos contra un adaptador vivo'));
    const deliveryId = await burnAttempts(lease.epoch!, 3);

    await repository.retryStaleDeliveries(0, 100);

    const audit = await pool.query<{ metadata: Record<string, unknown>; decision: string }>(
      `SELECT metadata,decision FROM audit_events
        WHERE delivery_id=$1 AND action='delivery.ack_timeout'`, [deliveryId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.decision).toBe('deny');
    expect(audit.rows[0]?.metadata).toMatchObject({
      reason: 'max_attempts_exhausted',
      attempts_exhausted: true,
      held_for_manual_replay: false,
      execution_started: false,
      max_attempts: 3
    });
  });

  it('sigue distinguiendo la retención por ejecución ya empezada', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
    await repository.publish(command('el harness arrancó y se perdió el ACK final'));
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', CONSUMER, lease.epoch!, 1, ACK_DEADLINE_MS
    );
    if (!claimed) throw new Error('expected a claimed delivery');
    await repository.ackDelivery(
      claimed.delivery_id, 'Isa', 'salva', ack(claimed, lease.epoch!, 'accepted'), ACK_DEADLINE_MS
    );
    await repository.ackDelivery(
      claimed.delivery_id, 'Isa', 'salva',
      ack(claimed, lease.epoch!, 'started', { execution_started: true }), ACK_DEADLINE_MS
    );

    await repository.retryStaleDeliveries(0, 100);

    const row = await deliveryRow(claimed.delivery_id);
    expect(row.status).toBe('dead');
    expect(row.last_error).toContain('execution already started');
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
        WHERE delivery_id=$1 AND action='delivery.ack_timeout'`, [claimed.delivery_id]
    );
    expect(audit.rows[0]?.metadata).toMatchObject({
      reason: 'execution_already_started',
      held_for_manual_replay: true,
      execution_started: true
    });
  });
});

describe('R1 — un código de pre-vuelo vuelve al circuito de reintento', () => {
  it('el ACK de pre-vuelo deja la entrega en retry, no en dead', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
    await repository.publish(command('codex reventó parseando su config.toml'));
    const [claimed] = await repository.claimDeliveries(
      'Isa', 'salva', CONSUMER, lease.epoch!, 1, ACK_DEADLINE_MS
    );
    if (!claimed) throw new Error('expected a claimed delivery');
    expect(claimed.attempt).toBe(1);

    const applied = await repository.ackDelivery(
      claimed.delivery_id, 'Isa', 'salva',
      ack(claimed, lease.epoch!, 'failed', {
        retryable: true,
        error_code: 'PROCESS_EXIT_PREFLIGHT',
        error: 'Harness exited with code 1 before beginning the turn'
      }),
      ACK_DEADLINE_MS
    );

    expect(applied).toMatchObject({ applied: true, status: 'retry' });
    const row = await deliveryRow(claimed.delivery_id);
    expect(row.status).toBe('retry');
    expect(row.terminal_at).toBeNull();
  });

  /**
   * Este era el contraste de R1: "un código de pre-vuelo vuelve al reintento, uno AMBIGUO no".
   * Se escribió afirmando `dead` a secas porque en ese momento un ambiguo moría siempre en el
   * intento 1. `merge/ambiguo-a-main` cambió esa regla a propósito y con medición de prod: un
   * ambiguo sólo mata si consta que ALGO corrió (`execution_started_at`); de 652 muertes
   * ambiguas con intentos disponibles, 445 nunca habían arrancado.
   *
   * Lo que R1 quería proteger NO era el `dead` literal: era que un código ambiguo no se
   * confundiera con uno de pre-vuelo, que sí es retryable por sí solo. Esa distinción sigue
   * viva y es lo que se comprueba acá, ahora en sus dos mitades:
   *
   *  - con la marca de ejecución, el ambiguo muere en el primer intento y con presupuesto
   *    intacto — un pre-vuelo, en la misma situación, reintentaría;
   *  - sin la marca reintenta, pero queda auditado aparte (`ambiguous_without_execution`), que
   *    es lo que impide que se lo lea como un reintento de pre-vuelo cualquiera.
   *
   * Si alguien colapsara los ambiguos dentro de la clase retryable, la primera mitad falla.
   * El caso completo vive en packages/store/test/ambiguous-without-execution-postgres.test.ts.
   */
  it('un código AMBIGUO no es un pre-vuelo: muere en el primer intento si llegó a ejecutar',
    async () => {
      const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
      await repository.publish(command('turno que pudo haber terminado'));
      const [claimed] = await repository.claimDeliveries(
        'Isa', 'salva', CONSUMER, lease.epoch!, 1, ACK_DEADLINE_MS
      );
      if (!claimed) throw new Error('expected a claimed delivery');

      // El harness arrancó de verdad: reserva tomada y proceso invocado. Esta es la marca que
      // separa "no sabemos si hizo algo" de "no hizo nada".
      await repository.ackDelivery(
        claimed.delivery_id, 'Isa', 'salva',
        ack(claimed, lease.epoch!, 'started', { execution_started: true }), ACK_DEADLINE_MS
      );

      await repository.ackDelivery(
        claimed.delivery_id, 'Isa', 'salva',
        ack(claimed, lease.epoch!, 'failed', {
          error_code: 'PROCESS_EXIT_AMBIGUOUS',
          error: 'Harness exited with code 1 without structured output'
        }),
        ACK_DEADLINE_MS
      );

      const row = await deliveryRow(claimed.delivery_id);
      expect(row.status).toBe('dead');
      // Con presupuesto de sobra: lo que mata es la ambigüedad con ejecución, no el agotamiento.
      // Un PROCESS_EXIT_PREFLIGHT en este mismo punto habría quedado en 'retry'.
      expect(row.attempt).toBeLessThan(3);
    });

  it('el mismo código AMBIGUO sin ejecución reintenta, pero se audita aparte del pre-vuelo',
    async () => {
      const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
      await repository.publish(command('turno que nunca llegó a arrancar'));
      const [claimed] = await repository.claimDeliveries(
        'Isa', 'salva', CONSUMER, lease.epoch!, 1, ACK_DEADLINE_MS
      );
      if (!claimed) throw new Error('expected a claimed delivery');

      // Sin ACK de `execution_started`: el proceso murió antes de invocar nada.
      await repository.ackDelivery(
        claimed.delivery_id, 'Isa', 'salva',
        ack(claimed, lease.epoch!, 'failed', {
          error_code: 'PROCESS_EXIT_AMBIGUOUS',
          error: 'Harness exited with code 1 without structured output'
        }),
        ACK_DEADLINE_MS
      );

      const row = await deliveryRow(claimed.delivery_id);
      expect(row.status).toBe('retry');
      expect(row.terminal_at).toBeNull();
      // El rastro que lo distingue de un reintento de pre-vuelo: son diagnósticos opuestos
      // sobre el mismo código de error y el operador tiene que poder separarlos de un vistazo.
      const audit = await pool.query<{ metadata: Record<string, unknown> }>(
        `SELECT metadata FROM audit_events
          WHERE delivery_id=$1 AND action='delivery.ack'
          ORDER BY id DESC LIMIT 1`, [claimed.delivery_id]
      );
      expect(audit.rows[0]?.metadata).toMatchObject({ ambiguous_without_execution: true });
    });

  it('el esquema impide que un código de pre-vuelo entre en la lista de ambiguos', () => {
    for (const code of PREFLIGHT_ACK_ERROR_CODES) {
      expect(isAmbiguousAckErrorCode(code)).toBe(false);
      expect(AckSchema.safeParse({
        version: '3.0',
        event_id: randomUUID(),
        status: 'failed',
        instance_id: CONSUMER,
        epoch: 1,
        claim_token: randomUUID(),
        attempt: 1,
        retryable: true,
        error_code: code
      }).success).toBe(true);
    }
    // Y el candado del otro lado sigue puesto: un ambiguo NO puede declararse reintentable.
    expect(AckSchema.safeParse({
      version: '3.0',
      event_id: randomUUID(),
      status: 'failed',
      instance_id: CONSUMER,
      epoch: 1,
      claim_token: randomUUID(),
      attempt: 1,
      retryable: true,
      error_code: 'PROCESS_EXIT_AMBIGUOUS'
    }).success).toBe(false);
  });
});
