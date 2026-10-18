import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { deliveryRow as selectDeliveryRow } from './helpers/consumer.js';

/**
 * Handling of late terminal ACKs:
 *
 * Distinguishes lease-exclusivity expiry from the validity of the carried result, allowing valid
 * replies to be recovered in cases where the delivery expired by timeout.
 */

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const tenant: Tenant = 'Steven';
const alias = 'argos';

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: tenant,
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: tenant, alias }],
    body: { text: 'una pregunta de una persona' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}

/** Publishes with a Telegram origin, which is what makes a relay to the human exist. */
function humanCommand(conversation: string, overrides: Partial<PublishMessage> = {}): PublishMessage {
  return command({
    authenticated_context: {
      session_id: `telegram-${conversation}`,
      channel: 'telegram',
      origin: {
        adapter: 'telegram',
        channel: 'telegram',
        conversation_id: conversation,
        external_message_id: `msg-${conversation}`,
        relay: [],
        metadata: { bridge_alias: alias, bridge_tenant: tenant }
      }
    },
    ...overrides
  });
}

function ack(
  delivery: Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>,
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

function doneAck(
  delivery: Pick<DeliveryEnvelope, 'claim_token' | 'attempt'>,
  instanceId: string,
  epoch: number,
  reply: string,
  overrides: Partial<Ack> = {}
): Ack {
  return ack(delivery, instanceId, epoch, 'done', {
    result: { output: { reply } },
    ...overrides
  });
}

/** What the SDK does when the harness really starts: without this the reaper retries. */
async function startExecution(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number
): Promise<void> {
  await repository.ackDelivery(
    delivery.delivery_id, tenant, alias, ack(delivery, instanceId, epoch, 'started')
  );
  await repository.ackDelivery(
    delivery.delivery_id, tenant, alias,
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

interface LateAckRow {
  status: string; attempt: number; reply: string | null; last_error: string | null;
  late_result_at: Date | null; late_result_attempt: number | null;
}

const deliveryRow = (deliveryId: string): Promise<LateAckRow> => selectDeliveryRow<LateAckRow>(
  pool, deliveryId,
  `status,attempt,result#>>'{output,reply}' AS reply,last_error,late_result_at,late_result_attempt`
);

async function relayRows(deliveryId: string): Promise<{
  idempotency_key: string; status: string; outcome: string | null; reply: string | null;
  late_result: boolean | null;
}[]> {
  const result = await pool.query<{
    idempotency_key: string; status: string; outcome: string | null; reply: string | null;
    late_result: boolean | null;
  }>(
    `SELECT idempotency_key,status,payload->>'outcome' AS outcome,
            payload#>>'{result,output,reply}' AS reply,
            (payload->>'late_result')::boolean AS late_result
     FROM adapter_outbox
     WHERE kind='origin_relay' AND delivery_id=$1 AND payload->>'relay_kind' IS DISTINCT FROM 'ack'
     ORDER BY created_at`,
    [deliveryId]
  );
  return result.rows;
}

/**
 * Leaves a human delivery dead by "ACK timeout: execution already started", which is exactly the
 * state the 387 lost replies were left in.
 */
async function killByTimeout(conversation: string): Promise<{
  delivery: DeliveryEnvelope; epoch: number; instanceId: string;
}> {
  const instanceId = `assistant-${conversation}`;
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
  await repository.publish(humanCommand(conversation));
  const [delivery] = await repository.claimDeliveries(
    tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
  );
  if (!delivery) throw new Error('expected a claimed delivery');
  await startExecution(delivery, instanceId, requireValue(lease.epoch, 'lease.epoch'));
  await expire(delivery.delivery_id);
  expect(await repository.retryStaleDeliveries(30_000)).toEqual({ retried: 0, dead: 1, parked: 0 });
  return { delivery, epoch: requireValue(lease.epoch, 'lease.epoch'), instanceId };
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

describe('(b) la entrega ya es dead por timeout y llega el done', () => {
  it('acepta el resultado, revive la entrega y resuelve el dead letter', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('caso-b-basico');
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');

    const late = doneAck(delivery, instanceId, epoch, 'La respuesta que nadie vio.');
    const result = await repository.ackDelivery(delivery.delivery_id, tenant, alias, late);

    expect(result).toMatchObject({ status: 'done', applied: true, receipt: 'applied' });
    const row = await deliveryRow(delivery.delivery_id);
    expect(row.status).toBe('done');
    expect(row.reply).toBe('La respuesta que nadie vio.');
    expect(row.late_result_at).not.toBeNull();
    expect(row.late_result_attempt).toBe(delivery.attempt);

    // The operator's replay button cannot offer an already answered delivery: that is a duplicate
    // run waiting for someone to click.
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NULL`,
      [delivery.delivery_id]
    )).rowCount).toBe(0);

    // The ACK is recorded as applied, not as discarded.
    const stored = await pool.query<{ applied: boolean }>(
      `SELECT applied FROM delivery_acks WHERE event_id=$1`, [late.event_id]
    );
    expect(stored.rows[0]?.applied).toBe(true);

    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action='delivery.late_result' AND delivery_id=$1`,
      [delivery.delivery_id]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.metadata).toMatchObject({
      resulting_status: 'done',
      previous_status: 'dead',
      claim_provenance: 'current',
      origin_relay: 'rewritten'
    });
  });

  it('manda un mensaje nuevo y redactado cuando el aviso de fallo YA salió', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('caso-b-enviado');
    await pool.query(
      `UPDATE adapter_outbox SET status='sent',sent_at=now()
       WHERE kind='origin_relay' AND delivery_id=$1 AND idempotency_key=$2`,
      [delivery.delivery_id, `relay:${delivery.delivery_id}`]
    );

    await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      doneAck(delivery, instanceId, epoch, 'Acá está tu respuesta.')
    );

    const relays = await relayRows(delivery.delivery_id);
    expect(relays).toHaveLength(2);
    // The old notice stays intact: the person already read it and rewriting it would lie to the log.
    expect(relays[0]).toMatchObject({ status: 'sent', outcome: 'dead' });
    expect(relays[1]).toMatchObject({
      idempotency_key: `relay-late:${delivery.delivery_id}:${String(delivery.attempt)}`,
      status: 'pending',
      outcome: 'done',
      late_result: true
    });
    expect(relays[1]?.reply).toContain('[respuesta tardía]');
    expect(relays[1]?.reply).toContain('El aviso de fallo anterior queda sin efecto');
    expect(relays[1]?.reply?.endsWith('Acá está tu respuesta.')).toBe(true);
  });
});

describe('(a) la entrega sigue no terminal, con un intento mayor', () => {
  /**
   * The reaper retried (execution was never recorded) and the SAME adapter picked it up again.
   * This is the realistic case: there is a single live instance per alias, so the connection lease
   * is still the same one and attempt 2 is running when the 'done' from attempt 1 arrives.
   */
  async function retriedTwice(conversation: string): Promise<{
    first: DeliveryEnvelope; second: DeliveryEnvelope; epoch: number; instanceId: string;
  }> {
    const instanceId = `assistant-${conversation}`;
    const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
    await repository.publish(humanCommand(conversation));
    const [first] = await repository.claimDeliveries(
      tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
    );
    if (!first) throw new Error('expected a first claim');
    await repository.ackDelivery(
      first.delivery_id, tenant, alias, ack(first, instanceId, requireValue(lease.epoch, 'lease.epoch'), 'started')
    );
    await expire(first.delivery_id);
    expect(await repository.retryStaleDeliveries(30_000)).toEqual({ retried: 1, dead: 0, parked: 0 });
    await pool.query(
      `UPDATE deliveries SET available_at=now()-interval '1 second' WHERE id=$1`,
      [first.delivery_id]
    );
    const [second] = await repository.claimDeliveries(
      tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
    );
    if (!second) throw new Error('expected a second claim');
    expect(second.attempt).toBe(first.attempt + 1);
    return { first, second, epoch: requireValue(lease.epoch, 'lease.epoch'), instanceId };
  }

  it('acepta el done del intento viejo y deja la corrida nueva sin garra', async () => {
    const { first, second, epoch, instanceId } = await retriedTwice('caso-a');

    const result = await repository.ackDelivery(
      first.delivery_id, tenant, alias,
      doneAck(first, instanceId, epoch, 'terminé, sólo que tarde')
    );

    expect(result).toMatchObject({ status: 'done', applied: true, receipt: 'applied' });
    const row = await deliveryRow(first.delivery_id);
    expect(row.status).toBe('done');
    expect(row.reply).toBe('terminé, sólo que tarde');
    expect(row.late_result_attempt).toBe(first.attempt);

    // The in-flight run finds out at its next renewal: the SDK aborts the harness with
    // CLAIM_OWNERSHIP_LOST and stops burning quota repeating work that is already done.
    const renewal = await repository.ackDelivery(
      second.delivery_id, tenant, alias, ack(second, instanceId, epoch, 'started')
    );
    expect(renewal).toMatchObject({ applied: false, receipt: 'ownership_lost' });
  });
});

describe('(c) la entrega ya es done y llega otro done de una corrida vieja', () => {
  it('no pisa el resultado que ya se entregó', async () => {
    const { first, second, epoch, instanceId } = await (async () => {
      const instanceId = 'assistant-caso-c';
      const lease = await repository.acquireLease(tenant, alias, instanceId, [], 60_000);
      await repository.publish(humanCommand('caso-c'));
      const [first] = await repository.claimDeliveries(
        tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
      );
      if (!first) throw new Error('expected a first claim');
      await repository.ackDelivery(
        first.delivery_id, tenant, alias, ack(first, instanceId, requireValue(lease.epoch, 'lease.epoch'), 'started')
      );
      await expire(first.delivery_id);
      await repository.retryStaleDeliveries(30_000);
      await pool.query(
        `UPDATE deliveries SET available_at=now()-interval '1 second' WHERE id=$1`,
        [first.delivery_id]
      );
      const [second] = await repository.claimDeliveries(
        tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
      );
      if (!second) throw new Error('expected a second claim');
      return { first, second, epoch: requireValue(lease.epoch, 'lease.epoch'), instanceId };
    })();

    // The NEW run answers first, within the deadline.
    await repository.ackDelivery(
      second.delivery_id, tenant, alias,
      doneAck(second, instanceId, epoch, 'respuesta de la corrida nueva')
    );

    const late = await repository.ackDelivery(
      first.delivery_id, tenant, alias,
      doneAck(first, instanceId, epoch, 'respuesta de la corrida vieja')
    );

    expect(late).toMatchObject({ applied: false, receipt: 'ownership_lost', status: 'done' });
    const row = await deliveryRow(first.delivery_id);
    expect(row.reply).toBe('respuesta de la corrida nueva');
    expect(row.late_result_at).toBeNull();
    // A new event_id on a terminal row does not grow the history forever. The applied ACK of the
    // winning run already preserves the canonical result; the old run receives ownership_lost but
    // cannot populate delivery_acks after closure.
    expect((await pool.query(
      `SELECT 1 FROM delivery_acks WHERE delivery_id=$1 AND applied=false AND status='done'`,
      [first.delivery_id]
    )).rowCount).toBe(0);
  });

  it('la carrera de dos corridas devolviendo done a la vez la gana una sola', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('carrera');

    // Two terminal ACKs from the same attempt, with different contents, launched at once.
    // `ackDelivery`'s `FOR UPDATE OF d` serialises them: the second one re-reads the already closed row.
    const [left, right] = await Promise.all([
      repository.ackDelivery(
        delivery.delivery_id, tenant, alias, doneAck(delivery, instanceId, epoch, 'izquierda')
      ),
      repository.ackDelivery(
        delivery.delivery_id, tenant, alias, doneAck(delivery, instanceId, epoch, 'derecha')
      )
    ]);

    const applied = [left, right].filter((result) => result.applied);
    expect(applied).toHaveLength(1);
    const row = await deliveryRow(delivery.delivery_id);
    expect(row.status).toBe('done');
    expect(['izquierda', 'derecha']).toContain(row.reply);
    // A single salvage, a single notice to the human.
    expect(await relayRows(delivery.delivery_id)).toHaveLength(1);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='delivery.late_result' AND delivery_id=$1`,
      [delivery.delivery_id]
    )).rowCount).toBe(1);
  });
});

describe('qué NO se acepta tarde', () => {

  it('un done que pide delegar: la ventana de delegación ya pasó', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('con-delegacion');
    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      ack(delivery, instanceId, epoch, 'done', {
        result: {
          output: {
            reply: 'listo, y de paso le pedí algo a kant',
            messages: [{ to: 'kant', body: 'seguí vos' }]
          }
        }
      })
    );
    expect(result).toMatchObject({ applied: false, receipt: 'ownership_lost' });
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');
    // The point: NO new delivery was created for kant.
    expect((await pool.query(
      `SELECT 1 FROM deliveries WHERE recipient_alias='kant'`
    )).rowCount).toBe(0);
  });

  it('un claim_token que nunca existió sobre esta entrega', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('garra-inventada');
    const result = await repository.ackDelivery(
      delivery.delivery_id, tenant, alias,
      doneAck({ claim_token: randomUUID(), attempt: delivery.attempt }, instanceId, epoch, 'inventado')
    );
    expect(result).toMatchObject({ applied: false, receipt: 'ownership_lost' });
    expect((await deliveryRow(delivery.delivery_id)).status).toBe('dead');
  });
});

describe('el mismo evento rechazado y reenviado', () => {
  it('sube de applied=false a applied=true cuando la segunda vuelta sí se rescata', async () => {
    const { delivery, epoch, instanceId } = await killByTimeout('reenvio');
    await repository.releaseLease(tenant, alias, instanceId, epoch);
    const late = doneAck(delivery, instanceId, epoch, 'el adaptador no se rindió');

    const rejected = await repository.ackDelivery(delivery.delivery_id, tenant, alias, late);
    expect(rejected).toMatchObject({ applied: false, receipt: 'ownership_lost' });

    // The adapter reconnects with the SAME identity (resume) and resends the same event.
    const resumed = await repository.acquireLease(
      tenant, alias, instanceId, [], 60_000, { resume: true }
    );
    expect(resumed.epoch).toBe(epoch);
    const accepted = await repository.ackDelivery(delivery.delivery_id, tenant, alias, late);

    expect(accepted).toMatchObject({ status: 'done', applied: true, receipt: 'applied' });
    const stored = await pool.query<{ applied: boolean; count: string }>(
      `SELECT applied,count(*)::text AS count FROM delivery_acks
       WHERE event_id=$1 GROUP BY applied`, [late.event_id]
    );
    expect(stored.rows).toEqual([{ applied: true, count: '1' }]);
  });
});
