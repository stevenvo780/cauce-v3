import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';

/**
 * Recovery and traceability of terminal deliveries and cancellation operations.
 */

let database: TestDatabase;
let databaseStarted = false;
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
    tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
  );
  if (!delivery) throw new Error('expected a claimed delivery');
  return { delivery, epoch: requireValue(lease.epoch, 'lease.epoch'), deliveryId: requireValue(published.delivery_ids[0], 'published.delivery_ids') };
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

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
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
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('todo final de error queda replayable', () => {

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
    expect(childDeliveryId).toEqual(
      expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u),
    );

    const cancelled = await repository.cancelDelivery(
      requireValue(childDeliveryId, 'childDeliveryId'), OPERATOR, OPERATOR_ALIAS, 'duplicado: ya lo hizo jarvis'
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
    await expect(repository.replayDelivery(requireValue(childDeliveryId, 'childDeliveryId'), OPERATOR, OPERATOR_ALIAS))
      .resolves.toMatchObject({ replayed: true });
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
    await expect(repository.cancelDelivery(requireValue(published.delivery_ids[0], 'published.delivery_ids'), OPERATOR, OPERATOR_ALIAS))
      .rejects.toMatchObject({ code: 'not_found' });
    expect((await pool.query(
      `SELECT status FROM deliveries WHERE id=$1`, [published.delivery_ids[0]]
    )).rows[0]).toMatchObject({ status: 'pending' });

    // With the control edge restored, the same call does apply: what was missing was permission,
    // not the delivery.
    await pool.query(
      `UPDATE acl_edges SET allow_control=true WHERE from_tenant='Steven' AND to_tenant='Pablo'`
    );
    await expect(repository.cancelDelivery(requireValue(published.delivery_ids[0], 'published.delivery_ids'), OPERATOR, OPERATOR_ALIAS))
      .resolves.toMatchObject({ cancelled: true });
  });
});
