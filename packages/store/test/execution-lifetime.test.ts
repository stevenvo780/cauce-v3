import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * El tope de vida de ejecución acota lo que `ack_deadline_at` no puede acotar: el deadline es
 * DESLIZANTE (cada ACK 'started' lo empuja 30 min más) y el adaptador lo emite cada 60 s con
 * independencia total de si el harness avanza. Estos tests fijan las dos superficies que tienen
 * que estar de acuerdo —`ackDelivery` y el reaper— y los dos bugs que reventaron en producción:
 * la entrega inmortal con latido sano, y el reloj heredado que mataba el intento siguiente.
 */

const consumerInstanceId = 'execution-lifetime-consumer';
const twelveHoursMs = 43_200_000;

let database: TestDatabase;
let pool: DatabasePool;
let previousExecutionLifetime: string | undefined;

/**
 * El techo se lee UNA vez, al construir el repositorio, y se congela por fila. Cada escenario se
 * construye el suyo para no depender del orden de los tests.
 */
function repositoryWithLifetime(lifetimeMs: number | undefined): CauceRepository {
  const restore = process.env.CAUCE_EXECUTION_LIFETIME_MS;
  if (lifetimeMs === undefined) {
    delete process.env.CAUCE_EXECUTION_LIFETIME_MS;
  } else {
    process.env.CAUCE_EXECUTION_LIFETIME_MS = String(lifetimeMs);
  }
  try {
    return new CauceRepository(pool);
  } finally {
    if (restore === undefined) {
      delete process.env.CAUCE_EXECUTION_LIFETIME_MS;
    } else {
      process.env.CAUCE_EXECUTION_LIFETIME_MS = restore;
    }
  }
}

function command(text: string): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-execution-lifetime-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7
  };
}

/**
 * `execution_started` es la marca durable de "el harness ARRANCÓ" (012_execution_started_marker).
 * El contrato de esta rama todavía no la declara, de ahí el cast: el store la lee de forma
 * opcional justamente para poder convivir con adaptadores viejos, que es lo que prueba el caso
 * del latido fantasma.
 */
function startedAck(
  delivery: DeliveryEnvelope, epoch: number, executionStarted = false
): Ack {
  const ack = {
    version: '3.0',
    event_id: randomUUID(),
    status: 'started',
    instance_id: consumerInstanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false
  };
  return (executionStarted ? { ...ack, execution_started: true } : ack) as Ack;
}

function failedAck(delivery: DeliveryEnvelope, epoch: number): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'failed',
    instance_id: consumerInstanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: true,
    error: 'harness died'
  };
}

interface DeliveryState {
  status: string;
  attempt: number;
  execution_started_at: Date | null;
  execution_lifetime_ms: number;
  ack_deadline_at: Date | null;
  last_error: string | null;
  deadline_in_future: boolean;
}

async function deliveryState(deliveryId: string): Promise<DeliveryState> {
  const row = (await pool.query<DeliveryState>(
    `SELECT status,attempt,execution_started_at,execution_lifetime_ms,ack_deadline_at,last_error,
            (ack_deadline_at > now()) AS deadline_in_future
     FROM deliveries WHERE id=$1`,
    [deliveryId]
  )).rows[0];
  if (!row) throw new Error(`delivery ${deliveryId} vanished`);
  return row;
}

async function claimOne(
  repository: CauceRepository, epoch: number, ackDeadlineMs = 30_000
): Promise<DeliveryEnvelope> {
  const [delivery] = await repository.claimDeliveries(
    'Steven', 'argos', consumerInstanceId, epoch, 1, ackDeadlineMs
  );
  if (!delivery) throw new Error('expected a claimed delivery');
  return delivery;
}

async function lease(repository: CauceRepository): Promise<number> {
  const acquired = await repository.acquireLease(
    'Steven', 'argos', consumerInstanceId, [], 60_000
  );
  if (!acquired.epoch) throw new Error('expected a lease epoch');
  return acquired.epoch;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

beforeAll(async () => {
  previousExecutionLifetime = process.env.CAUCE_EXECUTION_LIFETIME_MS;
  delete process.env.CAUCE_EXECUTION_LIFETIME_MS;
  database = await startTestDatabase();
  pool = database.pool;
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
});

afterAll(async () => {
  if (previousExecutionLifetime === undefined) {
    delete process.env.CAUCE_EXECUTION_LIFETIME_MS;
  } else {
    process.env.CAUCE_EXECUTION_LIFETIME_MS = previousExecutionLifetime;
  }
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('execution lifetime configuration', () => {
  it('defaults to twelve hours when the variable is absent or declared empty', async () => {
    for (const raw of [undefined, '', '   ']) {
      const repository = repositoryWithLifetime(raw as unknown as number | undefined);
      const published = await repository.publish(command(`default lifetime ${String(raw)}`));
      const stored = (await pool.query<{ execution_lifetime_ms: number }>(
        `SELECT execution_lifetime_ms FROM deliveries WHERE message_id=$1`,
        [published.message_id]
      )).rows[0];
      expect(stored?.execution_lifetime_ms).toBe(twelveHoursMs);
    }
  });

  it.each(['0', '-1', 'abc', '1.5', String(2_147_483_648)])(
    'fails closed on the invalid value %s instead of silently using the default',
    (raw) => {
      expect(() => repositoryWithLifetime(raw as unknown as number)).toThrow(/CAUCE_EXECUTION_LIFETIME_MS/u);
    }
  );

  it('freezes the budget per row so a config change cannot kill work already in flight', async () => {
    const shortLived = repositoryWithLifetime(250);
    const published = await shortLived.publish(command('frozen budget'));
    const raised = repositoryWithLifetime(twelveHoursMs);
    const raisedPublish = await raised.publish(command('frozen budget, raised default'));

    const budgets = (await pool.query<{ message_id: string; execution_lifetime_ms: number }>(
      `SELECT message_id,execution_lifetime_ms FROM deliveries WHERE message_id=ANY($1)`,
      [[published.message_id, raisedPublish.message_id]]
    )).rows;
    expect(new Map(budgets.map((row) => [row.message_id, row.execution_lifetime_ms])))
      .toEqual(new Map([
        [published.message_id, 250],
        [raisedPublish.message_id, twelveHoursMs]
      ]));
  });
});

describe('the reaper collects deliveries whose absolute cap expired', () => {
  it('kills a delivery whose ack_deadline_at is still in the future', async () => {
    // Éste es el wedge exacto de janus: latido sano cada 60 s, deadline siempre 30 min adelante,
    // reaper sano, y la entrega igual inmortal. Con el tope, muere.
    const repository = repositoryWithLifetime(250);
    const epoch = await lease(repository);
    await repository.publish(command('sliding deadline, dead harness'));
    const delivery = await claimOne(repository, epoch, 30_000);
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos', startedAck(delivery, epoch, true)
    );

    await sleep(400);

    const beforeSweep = await deliveryState(delivery.delivery_id);
    // La prueba de que el WHERE viejo no la habría tocado: el deadline sigue en el futuro.
    expect(beforeSweep.deadline_in_future).toBe(true);
    expect(beforeSweep.status).toBe('started');
    expect(beforeSweep.attempt).toBeLessThan(3);

    // staleMs normal, NO el barrido forzado con 0.
    await expect(repository.retryStaleDeliveries(30_000)).resolves.toEqual({ retried: 0, dead: 1 });

    const afterSweep = await deliveryState(delivery.delivery_id);
    expect(afterSweep.status).toBe('dead');
    expect(afterSweep.last_error).toMatch(/^EXECUTION_LIFETIME_EXCEEDED: /u);

    const deadLetter = (await pool.query<{ reason: string }>(
      `SELECT reason FROM dead_letters WHERE delivery_id=$1`, [delivery.delivery_id]
    )).rows[0];
    // Separable de los dos motivos de ACK timeout que ya conviven en dead_letters.
    expect(deadLetter?.reason).toMatch(/^EXECUTION_LIFETIME_EXCEEDED: /u);
    expect(deadLetter?.reason).toContain('250 ms');

    const audit = (await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events
       WHERE delivery_id=$1 AND action='delivery.execution_lifetime_exceeded'`,
      [delivery.delivery_id]
    )).rows[0];
    expect(audit?.metadata).toMatchObject({
      execution_lifetime_exceeded: true,
      execution_lifetime_ms: 250,
      execution_started: true,
      attempts_exhausted: false,
      held_for_manual_replay: true
    });
  });

  it('kills the phantom heartbeat too: no execution marker, same outcome', async () => {
    // Producción, 2026-07-29: de 5 entregas en vuelo, 2 acusaban 'started' con
    // execution_started_at NULL, y dos de ellas eran la MISMA corrida de janus. Si el tope se
    // anclara sólo en la marca, una moriría y la otra sería inmortal. El ancla cae en claimed_at.
    const repository = repositoryWithLifetime(250);
    const epoch = await lease(repository);
    await repository.publish(command('marked run'));
    await repository.publish(command('phantom heartbeat run'));

    const marked = await claimOne(repository, epoch, 30_000);
    const phantom = await claimOne(repository, epoch, 30_000);
    await repository.ackDelivery(
      marked.delivery_id, 'Steven', 'argos', startedAck(marked, epoch, true)
    );
    // Adaptador viejo: acusa 'started' pero nunca afirma que el harness arrancó.
    await repository.ackDelivery(
      phantom.delivery_id, 'Steven', 'argos', startedAck(phantom, epoch, false)
    );

    const sealed = await deliveryState(marked.delivery_id);
    const unsealed = await deliveryState(phantom.delivery_id);
    expect(sealed.execution_started_at).toBeInstanceOf(Date);
    expect(unsealed.execution_started_at).toBeNull();
    expect(unsealed.status).toBe('started');

    await sleep(400);
    await expect(repository.retryStaleDeliveries(30_000)).resolves.toEqual({ retried: 0, dead: 2 });

    const outcomes = await Promise.all(
      [marked.delivery_id, phantom.delivery_id].map(deliveryState)
    );
    // Sin limbo: las dos entregas de la misma corrida terminan igual.
    expect(outcomes.map((row) => row.status)).toEqual(['dead', 'dead']);
    for (const row of outcomes) expect(row.last_error).toMatch(/^EXECUTION_LIFETIME_EXCEEDED: /u);

    const audits = (await pool.query<{ execution_started: boolean }>(
      `SELECT (metadata->>'execution_started')::boolean AS execution_started
       FROM audit_events
       WHERE action='delivery.execution_lifetime_exceeded' AND delivery_id=ANY($1)
       ORDER BY delivery_id`,
      [[marked.delivery_id, phantom.delivery_id]]
    )).rows;
    // Mueren igual, pero el histórico distingue "quemó cuota" de "nunca consta que arrancara".
    expect(audits.map((row) => row.execution_started).sort()).toEqual([false, true]);
  });

  it('leaves a healthy in-flight delivery alone', async () => {
    // El reaper corre ~10 ticks/s: un falso positivo acá mataría el trabajo de toda la flota.
    const repository = repositoryWithLifetime(twelveHoursMs);
    const epoch = await lease(repository);
    await repository.publish(command('healthy work in progress'));
    const delivery = await claimOne(repository, epoch, 30_000);
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos', startedAck(delivery, epoch, true)
    );

    await sleep(150);
    await expect(repository.retryStaleDeliveries(30_000)).resolves.toEqual({ retried: 0, dead: 0 });
    expect((await deliveryState(delivery.delivery_id)).status).toBe('started');
  });
});

describe('the ACK path and the reaper agree on the same clock', () => {
  it('vetoes the renewal, kills the delivery and never moves the sealed instant', async () => {
    const repository = repositoryWithLifetime(250);
    const epoch = await lease(repository);
    await repository.publish(command('renewal past the cap'));
    const delivery = await claimOne(repository, epoch, 30_000);

    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos', startedAck(delivery, epoch, true)
    )).resolves.toMatchObject({ status: 'started', applied: true });
    const sealed = await deliveryState(delivery.delivery_id);
    expect(sealed.execution_started_at).toBeInstanceOf(Date);
    expect(sealed.execution_lifetime_ms).toBe(250);

    // Renovación intermedia: NO puede mover el sello hacia adelante, o el tope sería tan
    // deslizante como el ack_deadline_at que vino a acotar.
    await sleep(100);
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos', startedAck(delivery, epoch, true)
    );
    expect((await deliveryState(delivery.delivery_id)).execution_started_at)
      .toEqual(sealed.execution_started_at);

    await sleep(250);
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos', startedAck(delivery, epoch, true)
    )).resolves.toMatchObject({
      status: 'dead',
      applied: true,
      error_code: 'EXECUTION_LIFETIME_EXCEEDED'
    });

    const terminal = await deliveryState(delivery.delivery_id);
    expect(terminal.status).toBe('dead');
    expect(terminal.execution_started_at).toEqual(sealed.execution_started_at);
    expect(terminal.last_error).toMatch(/^EXECUTION_LIFETIME_EXCEEDED: /u);

    const deadLetter = (await pool.query<{ reason: string }>(
      `SELECT reason FROM dead_letters WHERE delivery_id=$1`, [delivery.delivery_id]
    )).rows[0];
    expect(deadLetter?.reason).toMatch(/^EXECUTION_LIFETIME_EXCEEDED: /u);
  });

  it('still accepts a terminal ACK that arrives after the cap', async () => {
    // El tope prohíbe estirar el plazo, no tirar trabajo ya pagado: si el agente por fin entrega
    // un resultado, se toma.
    const repository = repositoryWithLifetime(250);
    const epoch = await lease(repository);
    await repository.publish(command('late but real result'));
    const delivery = await claimOne(repository, epoch, 30_000);
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos', startedAck(delivery, epoch, true)
    );
    await sleep(400);

    await expect(repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', {
      version: '3.0',
      event_id: randomUUID(),
      status: 'done',
      instance_id: consumerInstanceId,
      epoch,
      claim_token: delivery.claim_token,
      attempt: delivery.attempt,
      retryable: false,
      result: { reply: 'llegué tarde pero llegué' }
    })).resolves.toMatchObject({ status: 'done', applied: true });
    expect((await deliveryState(delivery.delivery_id)).status).toBe('done');
  });
});

describe('the lifetime clock belongs to the attempt, not to the delivery', () => {
  it('clears the clock on a reaper retry so the next attempt starts fresh', async () => {
    // El bug reproducido sobre el WIP: sin este NULL el intento 2 heredaba el reloj vencido del
    // intento 1 y moría en su PRIMER ACK sin haber ejecutado nada.
    const repository = repositoryWithLifetime(twelveHoursMs);
    const epoch = await lease(repository);
    await repository.publish(command('attempt one dies of ack timeout'));
    const first = await claimOne(repository, epoch, 120);
    await repository.ackDelivery(
      first.delivery_id, 'Steven', 'argos', startedAck(first, epoch, true)
    );
    expect((await deliveryState(first.delivery_id)).execution_started_at).toBeInstanceOf(Date);

    await sleep(300);
    await expect(repository.retryStaleDeliveries(30_000)).resolves.toEqual({ retried: 1, dead: 0 });
    const afterRetry = await deliveryState(first.delivery_id);
    expect(afterRetry.status).toBe('retry');
    expect(afterRetry.execution_started_at).toBeNull();

    const second = await claimOne(repository, epoch, 30_000);
    expect(second.delivery_id).toBe(first.delivery_id);
    expect(second.attempt).toBe(2);
    const afterReclaim = await deliveryState(first.delivery_id);
    expect(afterReclaim.execution_started_at).toBeNull();

    await expect(repository.ackDelivery(
      second.delivery_id, 'Steven', 'argos', startedAck(second, epoch, true)
    )).resolves.toMatchObject({ status: 'started', applied: true });
  });

  it('clears the clock when an ACK sends the delivery back to retry', async () => {
    const repository = repositoryWithLifetime(twelveHoursMs);
    const epoch = await lease(repository);
    await repository.publish(command('retryable failure'));
    const delivery = await claimOne(repository, epoch, 30_000);
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos', startedAck(delivery, epoch, true)
    );
    expect((await deliveryState(delivery.delivery_id)).execution_started_at).toBeInstanceOf(Date);

    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos', failedAck(delivery, epoch)
    );
    const afterRetry = await deliveryState(delivery.delivery_id);
    expect(afterRetry.status).toBe('retry');
    expect(afterRetry.execution_started_at).toBeNull();
  });

  it('clears an inherited clock at claim time even if a retry left it behind', async () => {
    // Defensa en profundidad: si una fila llega a 'retry' por un camino que no borró el reloj
    // (una versión vieja del código, una edición manual), el claim la limpia igual. Sin esto,
    // el intento nuevo nace muerto.
    const repository = repositoryWithLifetime(250);
    const epoch = await lease(repository);
    await repository.publish(command('inherited clock'));
    const first = await claimOne(repository, epoch, 30_000);
    await pool.query(
      `UPDATE deliveries SET status='retry',claimed_at=NULL,claim_expires_at=NULL,
        ack_deadline_at=NULL,claim_token=NULL,consumer_instance_id=NULL,consumer_epoch=NULL,
        available_at=now(),execution_started_at=now()-interval '1 hour' WHERE id=$1`,
      [first.delivery_id]
    );

    const second = await claimOne(repository, epoch, 30_000);
    expect(second.delivery_id).toBe(first.delivery_id);
    expect((await deliveryState(first.delivery_id)).execution_started_at).toBeNull();
    await expect(repository.ackDelivery(
      second.delivery_id, 'Steven', 'argos', startedAck(second, epoch, true)
    )).resolves.toMatchObject({ status: 'started', applied: true });
  });
});
