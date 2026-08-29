import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { AckSchema, isAmbiguousAckErrorCode, PREFLIGHT_ACK_ERROR_CODES } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Retry policy: R1 (preflight code), R3 (do not burn attempts against an adapter-less alias),
 * and R6 (every death leaves an auditable trail).
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
 * Spends the `max_attempts` with REAL claims, without touching the counter.
 *
 * Each round is a full system cycle: the adapter claims, does not ACK, the reaper expires the
 * claim and returns it to `retry` with a wait. The only thing advanced by hand is that wait
 * (`available_at`), which is planning and not work state: if `attempt` were forged, the test
 * would stop exercising the path that matters.
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
      // staleMs=0 expires every in-flight claim: it is the reaper's sweep, not a shortcut.
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

describe('R3 — no attempts are burned against an adapter-less alias', () => {
  it('aparca la entrega y le devuelve el intento cuando no hay ningún consumidor conectado', async () => {
    const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
    await repository.publish(command('trabajo para un alias que se cayó'));
    const deliveryId = await burnAttempts(lease.epoch!, 3);
    expect((await deliveryRow(deliveryId)).attempt).toBe(3);

    // The adapter leaves: from here on there is nobody on the other side.
    await repository.releaseLease('Isa', 'salva', CONSUMER, lease.epoch!);

    const swept = await repository.retryStaleDeliveries(0, 100);

    expect(swept).toEqual({ retried: 0, dead: 0, parked: 1 });
    const row = await deliveryRow(deliveryId);
    expect(row.status).toBe('pending');
    expect(row.terminal_at).toBeNull();
    // The attempt comes back: nobody executed it, so it was not an attempt.
    expect(row.attempt).toBe(2);
    expect(row.last_error).toContain('no adapter connected');

    // Parking is NOT dying: there is no dead letter.
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

describe('R6 — no delivery death goes unaudited', () => {
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

describe('R1 — a preflight code returns to the retry circuit', () => {
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
   * This was R1's contrast: "a preflight code returns to retry, an AMBIGUOUS one does not".
   * It was written asserting bare `dead` because at the time an ambiguous always died on attempt
   * 1. `merge/ambiguo-a-main` changed that rule on purpose and with production measurement: an
   * ambiguous only kills if `execution_started_at` is set; of 652 ambiguous deaths with attempts
   * available, 445 had never started.
   *
   * What R1 meant to protect was NOT the literal `dead`: it was that an ambiguous code not be
   * mistaken for a preflight one, which IS retryable on its own. That distinction still stands
   * and is what is checked here, now in its two halves:
   *
   *  - with the execution mark, the ambiguous dies on attempt 1 and with the budget intact —
   *    a preflight, in the same situation, would retry;
   *  - without the mark it retries, but is audited separately (`ambiguous_without_execution`),
   *    which prevents it from being read as just another preflight retry.
   *
   * If someone collapses ambiguous codes into the retryable class, the first half fails.
   * The full case lives in packages/store/test/ambiguous-without-execution-postgres.test.ts.
   */
  it('un código AMBIGUO no es un pre-vuelo: muere en el primer intento si llegó a ejecutar',
    async () => {
      const lease = await repository.acquireLease('Isa', 'salva', CONSUMER, [], 120_000);
      await repository.publish(command('turno que pudo haber terminado'));
      const [claimed] = await repository.claimDeliveries(
        'Isa', 'salva', CONSUMER, lease.epoch!, 1, ACK_DEADLINE_MS
      );
      if (!claimed) throw new Error('expected a claimed delivery');

      // The harness actually started: lease taken and process invoked. This is the mark that
      // separates "we don't know whether it did something" from "it did nothing".
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

      // Without an `execution_started` ACK: the process died before invoking anything.
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
      // The trail that distinguishes it from a preflight retry: opposite diagnoses over the same
      // error code, and the operator must be able to tell them apart at a glance.
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
