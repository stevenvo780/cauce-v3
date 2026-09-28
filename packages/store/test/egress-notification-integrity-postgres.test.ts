import { describe, expect, it } from 'vitest';
import { requireValue } from './helpers.js';
import {
  ackWith, CHAT_ID, claim, command, createDestination, grantNotifyRole, notifications, notifyOutput,
  notifyRelays, pool, registerEgressSuite, repository, seedPriorContact, telegramIngress,
} from './egress-notification-postgres-helpers.js';

registerEgressSuite(import.meta.url);

describe('proactive egress does not disturb the delegation tree', () => {
  it('keeps the deferred disposition when the same ACK also delegates messages', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput(
        [{ to: 'steven.dm', kind: 'task_complete', body: 'aviso' }],
        { messages: [{ to: 'socrates', body: 'seguí vos' }] }
      ))
    );
    const delegated = await pool.query<{ status: string }>(
      `SELECT status FROM agent_output_materializations`
    );
    expect(delegated.rows[0]?.status).toBe('materialized');
    expect((await notifications())[0]?.decision).toBe('allowed');
  });

  it('still returns agent.response to the delegating parent when only notify is emitted', async () => {
    await grantNotifyRole('socrates');
    await createDestination({ alias: 'socrates', handle: 'steven.dm' });
    await pool.query(
      `INSERT INTO egress_contacts(tenant_id,alias,adapter,conversation_id,conversation_kind)
       VALUES('Steven','socrates','telegram',$1,'group')`, [CHAT_ID]
    );
    // kant delegates to argos, argos delegates to socrates; socrates notifies and replies.
    const parent = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      parent.delivery.delivery_id, 'Steven', 'argos',
      ackWith(parent.delivery, 'argos-1', parent.epoch, {
        output: {
          reply: null,
          messages: [{ to: 'socrates', body: 'hacé el trabajo' }],
          status: 'done',
          retryable: false,
          artifacts: []
        }
      })
    );
    const lease = await repository.acquireLease('Steven', 'socrates', 'socrates-1', [], 30_000);
    const [child] = await repository.claimDeliveries('Steven', 'socrates', 'socrates-1', requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
    expect(child).toBeDefined();
    await repository.ackDelivery(
      requireValue(child, 'child').delivery_id, 'Steven', 'socrates',
      ackWith(requireValue(child, 'child'), 'socrates-1', requireValue(lease.epoch, 'lease.epoch'), notifyOutput([
        { to: 'steven.dm', kind: 'task_complete', body: 'listo, Steven' }
      ], { reply: 'trabajo terminado' }))
    );

    expect((await notifications())[0]?.decision).toBe('allowed');
    const response = await pool.query<{ count: string }>(
      `SELECT count(*) AS count FROM messages WHERE body->>'type'='agent.response'`
    );
    expect(Number(response.rows[0]?.count)).toBe(1);
  });

  it('does not supersede the pending Telegram acknowledgement of its own chain', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    const ingress = telegramIngress();
    const published = await repository.publish(ingress);
    const lease = await repository.acquireLease('Steven', 'argos', 'argos-1', [], 30_000);
    const [delivery] = await repository.claimDeliveries('Steven', 'argos', 'argos-1', requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
    expect(delivery).toBeDefined();

    const before = await pool.query<{ id: string; status: string }>(
      `SELECT id,status FROM adapter_outbox WHERE idempotency_key=$1`,
      [`relay-ack:${published.message_id}`]
    );
    expect(before.rows[0]?.status).toBe('pending');

    // A mid-chain notification must not look like a final relay of this chain.
    await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'decision_request', body: '¿sigo?', idempotency_key: 'mid', dry_run: false
    });
    await repository.claimOutbox('origin_relay', 'worker-1', 10, 30_000, 'telegram');

    const after = await pool.query<{ status: string }>(
      `SELECT status FROM adapter_outbox WHERE id=$1`, [requireValue(before.rows[0], 'before.rows').id]
    );
    expect(after.rows[0]?.status).not.toBe('dead');
    void delivery;
  });
});

describe('proactive egress refuses ambiguous and malformed outputs', () => {
  it('refuses to notify about an execution whose outcome is unknown', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    // For the OUTCOME to be unknown, execution must have HAPPENED first: `execution_started` is
    // what says the harness was invoked. An ambiguous one without that mark is no longer terminal
    // —it is retried, because nothing ran— so there is no terminal turn where to materialize
    // notifications. What this test pins down is unchanged: when the work may have run, the notice
    // to the human stays DENIED instead of going out saying "I think I finished".
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, {}, { status: 'started', execution_started: true })
    );
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'steven.dm', kind: 'task_complete', body: 'creo que terminé' }
      ], { status: 'failed', retryable: false }), {
        status: 'failed',
        error_code: 'EXECUTION_TIMEOUT_AMBIGUOUS',
        error: 'ambiguous',
        retryable: false
      })
    );
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.denial_code).toBe('ambiguous_execution');
    expect(await notifyRelays()).toHaveLength(0);
  });

  it('still notifies a definite failure', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'steven.dm', kind: 'alert', body: 'la tarea larga falló' }
      ], { status: 'failed', retryable: false }), {
        status: 'failed', error: 'boom', retryable: false
      })
    );
    const rows = await notifications();
    expect(rows[0]?.decision).toBe('allowed');
  });

  it('rejects a malformed directive without touching the ACK', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    const result = await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'UPPERCASE', kind: 'task_complete', body: 'malo' },
        { to: 'steven.dm', kind: 'not_a_kind', body: 'peor' }
      ]))
    );
    expect(result.status).toBe('done');
    const rows = await notifications();
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.denial_code === 'invalid_output')).toBe(true);
  });

  it('collapses an over-limit notify batch into one bounded denial row', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput(
        Array.from({ length: 9 }, () => ({ to: 'steven.dm', kind: 'alert', body: 'spam' }))
      ))
    );
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.denial_code).toBe('invalid_output');
    expect(await notifyRelays()).toHaveLength(0);
  });

  it('rejects a body over the per-directive byte limit', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'steven.dm', kind: 'digest', body: 'x'.repeat(5_000) }
      ]))
    );
    expect((await notifications())[0]?.denial_code).toBe('body_too_large');
  });

  it('is a total no-op for the legacy five-key output', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, {
        output: { reply: 'listo', messages: [], status: 'done', retryable: false, artifacts: [] }
      })
    );
    expect(await notifications()).toHaveLength(0);
    expect(await notifyRelays()).toHaveLength(0);
  });
});

describe('proactive egress durable constraints', () => {
  it('forbids a direct message destination that waives prior contact', async () => {
    await expect(createDestination({
      handle: 'cold.dm', conversation_kind: 'dm', require_prior_contact: false,
      conversation_id: '123456789'
    })).rejects.toMatchObject({ code: '23514' });
  });

  it('forbids an empty allow_kinds list', async () => {
    await expect(createDestination({ handle: 'empty', allow_kinds: [] }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('forbids a destination for an alias with no enabled membership', async () => {
    await expect(createDestination({ alias: 'ghost', handle: 'ghost.dm' }))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('records the inbound contact ledger on authenticated Telegram ingress', async () => {
    await repository.publish(telegramIngress());
    await repository.publish(telegramIngress());
    const contacts = await pool.query<{
      alias: string; conversation_kind: string; inbound_count: string; last_session_hash: string;
    }>(`SELECT alias,conversation_kind,inbound_count,last_session_hash FROM egress_contacts`);
    expect(contacts.rows).toHaveLength(1);
    expect(contacts.rows[0]?.alias).toBe('argos');
    expect(contacts.rows[0]?.conversation_kind).toBe('group');
    expect(Number(contacts.rows[0]?.inbound_count)).toBe(2);
    expect(contacts.rows[0]?.last_session_hash).toMatch(/^[a-f0-9]{64}$/);
  });

  it('refuses agent.notify as a client publishable message type', async () => {
    await expect(repository.publish(command({ body: { type: 'agent.notify', text: 'x' } })))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
});

describe('proactive egress visibility', () => {
  it('lists denied notifications, which have no produced message to join through', async () => {
    await pool.query(`UPDATE role_policies SET allow_read=true WHERE role='agent'`);
    await grantNotifyRole('argos');
    await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'sin destino', idempotency_key: 'z', dry_run: false
    });
    const listed = await repository.listNotifications('Steven', 'argos');
    const items = listed.items as Record<string, unknown>[];
    expect(items).toHaveLength(1);
    expect(items[0]?.decision).toBe('denied');
    expect(items[0]?.denial_code).toBe('unknown_destination');
    expect(items[0]?.produced_message_id).toBeNull();
  });

  it('surfaces a relay the bridge refused so an approved destination cannot fail silently', async () => {
    await pool.query(`UPDATE role_policies SET allow_read=true WHERE role='agent'`);
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const verdict = await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'aviso', idempotency_key: 'r', dry_run: false
    });
    // The bridge is an independent second key: a chat outside allowed_chat_ids
    // dead-letters the relay even though the store approved the destination.
    await pool.query(
      `UPDATE adapter_outbox SET status='dead',dead_at=now() WHERE id=$1`, [verdict.outbox_id]
    );
    const listed = await repository.listNotifications('Steven', 'argos');
    const items = listed.items as Record<string, unknown>[];
    expect(items[0]).toMatchObject({ decision: 'allowed', relay_status: 'dead' });
  });

  it('hides notifications emitted by an alias in another tenant', async () => {
    await pool.query(`UPDATE role_policies SET allow_read=true WHERE role='agent'`);
    await grantNotifyRole('argos');
    await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'x', idempotency_key: 'z', dry_run: false
    });
    const listed = await repository.listNotifications('Pablo', 'midas');
    expect(listed.items as unknown[]).toHaveLength(0);
  });
});
