import { describe, expect, it } from 'vitest';
import {
  ackWith, claim, command, createDestination, grantNotifyRole, notifications, notifyOutput,
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
});

describe('proactive egress durable constraints', () => {
  it('forbids a direct message destination that waives prior contact', async () => {
    await expect(createDestination({
      handle: 'cold.dm', conversation_kind: 'dm', require_prior_contact: false,
      conversation_id: '123456789'
    })).rejects.toMatchObject({ code: '23514' });
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
