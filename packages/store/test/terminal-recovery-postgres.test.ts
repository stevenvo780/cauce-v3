import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Recovery and traceability of terminal deliveries and cancellation operations.
 */

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

const OPERATOR: Tenant = 'Steven';
const OPERATOR_ALIAS = 'socrates';

function telegramOrigin(conversation: string) {
  return {
    adapter: 'telegram',
    channel: 'dm',
    conversation_id: conversation,
    relay: [],
    metadata: {}
  };
}

function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-recovery-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'trabajo que hay que poder rescatar' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    authenticated_context: {
      session_id: `session-${randomUUID()}`,
      channel: 'telegram-dm',
      origin: telegramOrigin(`chat-${randomUUID()}`)
    },
    ...overrides
  };
}

async function publishAndClaim(
  input: PublishMessage,
  tenant: Tenant,
  alias: string,
  instanceId: string
): Promise<{ delivery: DeliveryEnvelope; epoch: number; deliveryId: string }> {
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  const published = await repository.publish(input);
  const [delivery] = await repository.claimDeliveries(
    tenant, alias, instanceId, lease.epoch!, 1, 30_000
  );
  if (!delivery) throw new Error('expected a claimed delivery');
  return { delivery, epoch: lease.epoch!, deliveryId: published.delivery_ids[0]! };
}

/** Terminal error ACK NOT retryable: the branch that used to leave the delivery in 'failed'. */
function nonRetryableFailure(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number,
  error = "Structured output is missing 'reply'"
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'failed',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    error,
    error_code: 'MISSING_FINAL_REPLY'
  };
}

function delegatingAck(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number,
  messages: unknown[]
): Ack {
  return {
    version: '3.0',
    event_id: randomUUID(),
    status: 'done',
    instance_id: instanceId,
    epoch,
    claim_token: delivery.claim_token,
    attempt: delivery.attempt,
    retryable: false,
    result: { output: { reply: 'delego', messages, status: 'done', retryable: false, artifacts: [] } }
  };
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
    UPDATE memberships SET role=CASE
      WHEN tenant_id='Steven' AND alias='socrates' THEN 'operator' ELSE 'agent' END;
    UPDATE role_policies SET allow_route=true,allow_read=true,allow_control=false WHERE role='agent';
  `);
});

afterAll(async () => {
  if (pool) await pool.end();
  if (database?.container) await database.container.stop();
});

describe('todo final de error queda replayable', () => {
  it('deja dead letter para una entrega que el agente declaró no reintentable', async () => {
    const { delivery, epoch, deliveryId } = await publishAndClaim(
      command(), 'Steven', 'argos', 'failed-consumer'
    );

    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      nonRetryableFailure(delivery, 'failed-consumer', epoch)
    )).resolves.toMatchObject({ status: 'failed', applied: true });

    // The state is NOT merged with 'dead': it is preserved because fan-in counting, the table
    // CHECK, the protocol enum, dispatcher series, and the console all consume it.
    const stored = await pool.query<{ status: string; last_error: string }>(
      `SELECT status,last_error FROM deliveries WHERE id=$1`, [deliveryId]
    );
    expect(stored.rows[0]).toMatchObject({ status: 'failed' });

    // What changes is that the replayable trail now exists.
    const deadLetter = await pool.query<{ reason: string; attempts: number; resolved_at: Date | null }>(
      `SELECT reason,attempts,resolved_at FROM dead_letters WHERE delivery_id=$1`, [deliveryId]
    );
    expect(deadLetter.rowCount).toBe(1);
    expect(deadLetter.rows[0]).toMatchObject({
      reason: "Structured output is missing 'reply'",
      resolved_at: null
    });
  });

  it('replaya una entrega failed y consume su dead letter una sola vez', async () => {
    const { delivery, epoch, deliveryId } = await publishAndClaim(
      command(), 'Steven', 'argos', 'failed-replay-consumer'
    );
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      nonRetryableFailure(delivery, 'failed-replay-consumer', epoch)
    );

    const replay = await repository.replayDelivery(deliveryId, OPERATOR, OPERATOR_ALIAS);
    expect(replay).toMatchObject({
      replayed: true, replayed_from_delivery_id: deliveryId, state: 'pending'
    });

    const clone = await pool.query<{ id: string; status: string; recipient_alias: string }>(
      `SELECT id,status,recipient_alias FROM deliveries WHERE id=$1`, [replay.delivery_id]
    );
    expect(clone.rows[0]).toMatchObject({ status: 'pending', recipient_alias: 'argos' });
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NOT NULL`, [deliveryId]
    )).rowCount).toBe(1);

    // The idempotency lock is still the same one that already protected 'dead'.
    await expect(repository.replayDelivery(deliveryId, OPERATOR, OPERATOR_ALIAS))
      .rejects.toMatchObject({ code: 'conflict' });
  });

  it('sigue exigiendo permiso de control para replayar un failed', async () => {
    const { delivery, epoch, deliveryId } = await publishAndClaim(
      command(), 'Steven', 'argos', 'failed-rbac-consumer'
    );
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      nonRetryableFailure(delivery, 'failed-rbac-consumer', epoch)
    );
    await expect(repository.replayDelivery(deliveryId, 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('cancelación de primera clase', () => {
  it('avisa al padre de la delegación y deja la rama replayable', async () => {
    const { delivery, epoch } = await publishAndClaim(
      command(), 'Steven', 'argos', 'parent-consumer'
    );
    // argos delegates to kant: the branch the parent will wait for is born.
    await expect(repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      delegatingAck(delivery, 'parent-consumer', epoch, [{ to: 'kant', body: 'trabajá en esto' }])
    )).resolves.toMatchObject({ status: 'done', applied: true });

    const child = await pool.query<{ produced_delivery_id: string }>(
      `SELECT produced_delivery_id FROM agent_output_materializations
       WHERE status='materialized' AND target_alias='kant'`
    );
    const childDeliveryId = child.rows[0]?.produced_delivery_id;
    expect(childDeliveryId).toBeTruthy();

    const cancelled = await repository.cancelDelivery(
      childDeliveryId!, OPERATOR, OPERATOR_ALIAS, 'duplicado: ya lo hizo jarvis'
    );
    expect(cancelled).toMatchObject({
      delivery_id: childDeliveryId,
      state: 'dead',
      cancelled: true,
      cancelled_from_state: 'pending',
      // The parent IS notified: that is the difference from the manual UPDATE.
      parent_notice: 'returned',
      replayable: true
    });

    // (1) replayable trail
    const deadLetter = await pool.query<{ reason: string }>(
      `SELECT reason FROM dead_letters WHERE delivery_id=$1 AND resolved_at IS NULL`,
      [childDeliveryId]
    );
    expect(deadLetter.rowCount).toBe(1);
    expect(deadLetter.rows[0]?.reason)
      .toBe('Cancelled by operator Steven:socrates: duplicado: ya lo hizo jarvis');

    // (2) the parent receives a response delivery with the outcome, not silence.
    const notice = await pool.query<{ recipient_alias: string; outcome: string; text: string }>(
      `SELECT reply.recipient_alias,response.body->>'outcome' AS outcome,response.body->>'text' AS text
       FROM messages response JOIN deliveries reply ON reply.message_id=response.id
       WHERE response.body->>'type'='agent.response'`
    );
    expect(notice.rowCount).toBe(1);
    expect(notice.rows[0]).toMatchObject({ recipient_alias: 'argos', outcome: 'dead' });
    expect(notice.rows[0]?.text).toContain('Cancelled by operator');

    // Fan-in counts branches closed by this audit; without it the counter gets stuck.
    expect((await pool.query(
      `SELECT 1 FROM audit_events
       WHERE action='agent_output.response' AND decision='allow'
         AND metadata->>'child_delivery_id'=$1`, [childDeliveryId]
    )).rowCount).toBe(1);

    // (3) its own audit, distinguishable from a timeout.
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action='delivery.cancel' AND delivery_id=$1`,
      [childDeliveryId]
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.metadata).toMatchObject({
      cancelled_from_status: 'pending', parent_notice: 'returned'
    });

    // The cancelled branch remains rescuable: cancelling is not irreversible.
    await expect(repository.replayDelivery(childDeliveryId!, OPERATOR, OPERATOR_ALIAS))
      .resolves.toMatchObject({ replayed: true });
  });

  it('avisa al humano del origen cuando la entrega no es hija de nadie', async () => {
    const input = command();
    const published = await repository.publish(input);
    const deliveryId = published.delivery_ids[0]!;

    const cancelled = await repository.cancelDelivery(deliveryId, OPERATOR, OPERATOR_ALIAS);
    expect(cancelled).toMatchObject({
      state: 'dead', cancelled: true, parent_notice: 'not_child', origin_relayed: true
    });
    expect(cancelled.reason).toBe('Cancelled by operator Steven:socrates');

    const relay = await pool.query<{ payload: Record<string, unknown> }>(
      `SELECT payload FROM adapter_outbox
       WHERE kind='origin_relay' AND delivery_id=$1 AND adapter='telegram'`,
      [deliveryId]
    );
    expect(relay.rowCount).toBe(1);
    expect(relay.rows[0]?.payload).toMatchObject({
      outcome: 'dead',
      error: 'Cancelled by operator Steven:socrates',
      error_code: 'DELIVERY_CANCELLED'
    });

    // It releases the alias quota and does not leave the fence standing.
    const row = await pool.query<{
      status: string; claim_token: string | null; consumer_epoch: string | null;
    }>(
      `SELECT status,claim_token,consumer_epoch FROM deliveries WHERE id=$1`, [deliveryId]
    );
    expect(row.rows[0]).toMatchObject({ status: 'dead', claim_token: null, consumer_epoch: null });
  });

  it('cancela una entrega ya reclamada por un adaptador y rebota su ACK tardío', async () => {
    const { delivery, epoch, deliveryId } = await publishAndClaim(
      command(), 'Steven', 'argos', 'inflight-consumer'
    );
    await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', {
      version: '3.0', event_id: randomUUID(), status: 'started', instance_id: 'inflight-consumer',
      epoch, claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: true
    });

    await expect(repository.cancelDelivery(deliveryId, OPERATOR, OPERATOR_ALIAS))
      .resolves.toMatchObject({ cancelled: true, cancelled_from_state: 'started' });

    // The harness is still alive on its own; its final ACK can no longer resurrect or overwrite anything.
    await expect(repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', {
      version: '3.0', event_id: randomUUID(), status: 'done', instance_id: 'inflight-consumer',
      epoch, claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false,
      result: { output: { reply: 'tarde', messages: [], status: 'done', retryable: false, artifacts: [] } }
    })).resolves.toMatchObject({ applied: false, receipt: 'ownership_lost', status: 'dead' });
  });

  it('rechaza cancelar algo ya terminal y rechaza al actor sin control', async () => {
    const { delivery, epoch, deliveryId } = await publishAndClaim(
      command(), 'Steven', 'argos', 'terminal-consumer'
    );

    await expect(repository.cancelDelivery(deliveryId, 'Steven', 'kant'))
      .rejects.toMatchObject({ code: 'forbidden' });

    await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', {
      version: '3.0', event_id: randomUUID(), status: 'done', instance_id: 'terminal-consumer',
      epoch, claim_token: delivery.claim_token, attempt: delivery.attempt, retryable: false,
      result: { output: { reply: 'ya estaba hecho', messages: [], status: 'done', retryable: false, artifacts: [] } }
    });

    await expect(repository.cancelDelivery(deliveryId, OPERATOR, OPERATOR_ALIAS))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1`, [deliveryId]
    )).rowCount).toBe(0);
  });

  // Same authorization as replay, and for the same reason: `not_found` does not distinguish between
  // "it does not exist" and "I cannot show it to you". An entire conversation inside another tenant,
  // with no control edge to it, is not cancellable even by a hub operator.
  it('no revela una entrega fuera del alcance del actor', async () => {
    const published = await repository.publish(command({
      tenant_id: 'Pablo',
      room_id: 'grp.pablo',
      actor_alias: 'dedalo',
      recipients: [{ tenant_id: 'Pablo', alias: 'midas' }]
    }));
    await pool.query(
      `UPDATE acl_edges SET allow_control=false WHERE from_tenant='Steven' AND to_tenant='Pablo'`
    );
    await expect(repository.cancelDelivery(published.delivery_ids[0]!, OPERATOR, OPERATOR_ALIAS))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await pool.query(
      `SELECT status FROM deliveries WHERE id=$1`, [published.delivery_ids[0]]
    )).rows[0]).toMatchObject({ status: 'pending' });

    // With the control edge restored, the same call does apply: what was missing was permission,
    // not the delivery.
    await pool.query(
      `UPDATE acl_edges SET allow_control=true WHERE from_tenant='Steven' AND to_tenant='Pablo'`
    );
    await expect(repository.cancelDelivery(published.delivery_ids[0]!, OPERATOR, OPERATOR_ALIAS))
      .resolves.toMatchObject({ cancelled: true });
  });
});

describe('migración 018: rescate de las entregas que ya murieron sin dead letter', () => {
  async function runBackfill(): Promise<void> {
    const sql = await readFile(
      new URL('../migrations/018_terminal_recovery_backfill.sql', import.meta.url), 'utf8'
    );
    await pool.query(sql);
  }

  it('adopta las failed sin fila y las dead que un humano marcó a mano, sin duplicar', async () => {
    // (a) the 'failed' case from before the patch: the row that the new code writes is deleted.
    const { delivery, epoch, deliveryId: failedId } = await publishAndClaim(
      command(), 'Steven', 'argos', 'legacy-failed'
    );
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      nonRetryableFailure(delivery, 'legacy-failed', epoch, 'OpenClaw result contained a malformed JSON object')
    );
    // Historical fixture predating 030: production 030 forbids deleting incidents. The trigger is
    // disabled only in this disposable database to recreate the legacy state exactly.
    await pool.query(`ALTER TABLE dead_letters DISABLE TRIGGER cauce_fence_dead_letter_030`);
    try {
      await pool.query(`DELETE FROM dead_letters WHERE delivery_id=$1`, [failedId]);
    } finally {
      await pool.query(`ALTER TABLE dead_letters ENABLE TRIGGER cauce_fence_dead_letter_030`);
    }

    // (b) the 'cancelled by zeus' case: manual UPDATE, no dead letter and no terminal_at.
    const manual = await repository.publish(command());
    const manualId = manual.delivery_ids[0]!;
    await pool.query(
      `UPDATE deliveries
         SET status='dead',last_error='cancelado por zeus 2026-07-28: aviso duplicado',
             terminal_at=NULL,updated_at=now()-interval '2 days'
       WHERE id=$1`, [manualId]
    );

    // (c) a healthy delivery: the migration cannot touch it.
    const healthy = await repository.publish(command());
    const healthyId = healthy.delivery_ids[0]!;

    await runBackfill();

    const rescued = await pool.query<{ delivery_id: string; reason: string; created_at: Date }>(
      `SELECT delivery_id,reason,created_at FROM dead_letters
       WHERE reason LIKE 'backfill 018 (%' ORDER BY delivery_id`
    );
    expect(rescued.rowCount).toBe(2);
    const byId = new Map(rescued.rows.map((row) => [row.delivery_id, row]));
    expect(byId.get(failedId)?.reason)
      .toBe('backfill 018 (failed): OpenClaw result contained a malformed JSON object');
    expect(byId.get(manualId)?.reason)
      .toBe('backfill 018 (dead): cancelado por zeus 2026-07-28: aviso duplicado');
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE delivery_id=$1`, [healthyId]
    )).rowCount).toBe(0);

    // `created_at` is when it died, not when the migration ran: the row without `terminal_at`
    // falls on `updated_at` (two days ago), not on `now()`.
    expect(byId.get(manualId)!.created_at.getTime())
      .toBeLessThan(Date.now() - 24 * 60 * 60 * 1000);

    // And the only thing that matters: now they can be rescued.
    await expect(repository.replayDelivery(failedId, OPERATOR, OPERATOR_ALIAS))
      .resolves.toMatchObject({ replayed: true });
    await expect(repository.replayDelivery(manualId, OPERATOR, OPERATOR_ALIAS))
      .resolves.toMatchObject({ replayed: true });

    // Reapplying does not duplicate nor audit again: the condition looks at the state, not a marker.
    await runBackfill();
    expect((await pool.query(
      `SELECT 1 FROM dead_letters WHERE reason LIKE 'backfill 018 (%'`
    )).rowCount).toBe(2);
    expect((await pool.query(
      `SELECT 1 FROM audit_events WHERE action='migration.dead_letter_backfill'`
    )).rowCount).toBe(1);
  });

  it('registra cuántas rescató y por estado', async () => {
    const manual = await repository.publish(command());
    await pool.query(
      `UPDATE deliveries SET status='dead',last_error=NULL,terminal_at=now() WHERE id=$1`,
      [manual.delivery_ids[0]]
    );
    await runBackfill();
    const audit = await pool.query<{ metadata: Record<string, unknown> }>(
      `SELECT metadata FROM audit_events WHERE action='migration.dead_letter_backfill'`
    );
    expect(audit.rowCount).toBe(1);
    expect(audit.rows[0]?.metadata).toMatchObject({
      migration: '018_terminal_recovery_backfill',
      rescued: 1,
      by_status: { dead: 1 }
    });
    // `reason` is NOT NULL and `last_error` may be NULL: the fallback text is required.
    expect((await pool.query(
      `SELECT 1 FROM dead_letters
       WHERE reason='backfill 018 (dead): terminal error without recorded text'`
    )).rowCount).toBe(1);
  });
});
