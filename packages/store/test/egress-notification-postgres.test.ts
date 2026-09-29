import { describe, expect, it } from 'vitest';
import { requireValue } from './helpers.js';
import {
  acknowledgementRelays, ackWith, CHAT_ID, claim, command, createDestination, grantNotifyRole,
  notifications, notifyOutput, notifyRelays, pool, registerEgressSuite, repository, seedPriorContact,
  telegramIngress,
} from './egress-notification-postgres-helpers.js';

registerEgressSuite(import.meta.url);

describe('proactive egress authorization', () => {
  it('denies an alias whose role has no allow_notify and still applies the ACK', async () => {
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    const result = await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'steven.dm', kind: 'task_complete', body: 'la tarea larga terminó' }
      ]))
    );

    expect(result.status).toBe('done');
    expect(result.applied).toBe(true);
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.decision).toBe('denied');
    expect(rows[0]?.denial_code).toBe('notify_permission_denied');
    expect(await notifyRelays()).toHaveLength(0);
  });

  it('denies an unknown destination handle', async () => {
    await grantNotifyRole('argos');
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'nonexistent', kind: 'alert', body: 'hola' }
      ]))
    );
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.denial_code).toBe('unknown_destination');
    expect(rows[0]?.conversation_id).toBeNull();
  });

  it('denies a disabled destination and a kind outside allow_kinds', async () => {
    await grantNotifyRole('argos');
    await createDestination({ handle: 'off', enabled: false, conversation_id: '-1009999999999' });
    await createDestination({ handle: 'digest.only', allow_kinds: ['digest'] });
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'off', kind: 'alert', body: 'uno' },
        { to: 'digest.only', kind: 'alert', body: 'dos' }
      ]))
    );
    const codes = (await notifications()).map((row) => row.denial_code).sort();
    expect(codes).toEqual(['destination_disabled', 'kind_not_allowed']);
    expect(await notifyRelays()).toHaveLength(0);
  });

  it('refuses cold contact when nobody ever wrote to that alias from that chat', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'steven.dm', kind: 'task_complete', body: 'contacto en frío' }
      ]))
    );
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.denial_code).toBe('cold_contact');
    expect(await notifyRelays()).toHaveLength(0);
  });

  it('allows the notification once real prior contact exists and emits one relay', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'steven.dm', kind: 'task_complete', body: 'terminé el reporte' }
      ]))
    );

    const rows = await notifications();
    expect(rows).toHaveLength(1);
    const notification = requireValue(rows[0], 'rows');
    expect(notification.decision).toBe('allowed');
    expect(notification.denial_code).toBeNull();
    expect(notification.conversation_id).toBe(CHAT_ID);
    expect(notification.produced_message_id).not.toBeNull();
    expect(notification.produced_outbox_id).not.toBeNull();

    const relays = await notifyRelays();
    expect(relays).toHaveLength(1);
    const relay = requireValue(relays[0], 'relays');
    expect(relay.idempotency_key).toBe(`notify:${notification.id}`);
    const origin = relay.origin as Record<string, unknown>;
    expect(origin.conversation_id).toBe(CHAT_ID);
    expect(origin.external_message_id).toBeUndefined();
    expect((origin.metadata as Record<string, unknown>).proactive).toBe(true);
    const payload = relay.payload as Record<string, unknown>;
    const output = (payload.result as Record<string, unknown>).output as Record<string, unknown>;
    expect(output.reply).toBe('terminé el reporte');
    const correlation = payload.correlation as Record<string, unknown>;
    // The relay's root is its OWN message, never the inbound chain root.
    expect(correlation.root_message_id).toBe(notification.produced_message_id);
  });

  it('never leaves the notification body in the ACK or delivery result', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    await repository.ackDelivery(
      delivery.delivery_id, 'Steven', 'argos',
      ackWith(delivery, 'argos-1', epoch, notifyOutput([
        { to: 'steven.dm', kind: 'alert', body: 'SECRETO-EN-EL-CUERPO' }
      ]))
    );
    const persisted = await pool.query<{ ack: string; result: string }>(
      `SELECT coalesce(acknowledgement.payload::text,'') AS ack,coalesce(d.result::text,'') AS result
       FROM deliveries d LEFT JOIN delivery_acks acknowledgement ON acknowledgement.delivery_id=d.id
       WHERE d.id=$1`, [delivery.delivery_id]
    );
    for (const row of persisted.rows) {
      expect(row.ack).not.toContain('SECRETO-EN-EL-CUERPO');
      expect(row.result).not.toContain('SECRETO-EN-EL-CUERPO');
    }
  });
});

describe('proactive egress idempotency', () => {
  it('re-ACKing the same event produces exactly one notification and one relay', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const { delivery, epoch } = await claim(command(), 'Steven', 'argos', 'argos-1');
    const ack = ackWith(delivery, 'argos-1', epoch, notifyOutput([
      { to: 'steven.dm', kind: 'task_complete', body: 'una sola vez' }
    ]));
    await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack);
    await repository.ackDelivery(delivery.delivery_id, 'Steven', 'argos', ack);

    expect(await notifications()).toHaveLength(1);
    expect(await notifyRelays()).toHaveLength(1);
  });

  it('replays the stored verdict for a repeated HTTP idempotency key', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const request = {
      destination: 'steven.dm', kind: 'digest' as const, body: 'resumen diario',
      idempotency_key: 'daily-digest-2026-07-25', dry_run: false
    };
    const first = await repository.enqueueNotification('Steven', 'argos', request);
    const second = await repository.enqueueNotification('Steven', 'argos', request);

    expect(first.decision).toBe('allowed');
    expect(first.duplicate).toBe(false);
    expect(second.decision).toBe('allowed');
    expect(second.duplicate).toBe(true);
    expect(second.notification_id).toBe(first.notification_id);
    expect(await notifications()).toHaveLength(1);
    expect(await notifyRelays()).toHaveLength(1);
  });

  it('previews a destination without writing to the human', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await seedPriorContact();
    const verdict = await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'prueba', idempotency_key: 'preview-1', dry_run: true
    });
    expect(verdict.decision).toBe('allowed');
    expect(verdict.dry_run).toBe(true);
    expect(await notifications()).toHaveLength(0);
    expect(await notifyRelays()).toHaveLength(0);
  });

  it('records a denial verdict for the HTTP path without throwing', async () => {
    await grantNotifyRole('argos');
    const verdict = await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'sin destino', idempotency_key: 'k1', dry_run: false
    });
    expect(verdict.decision).toBe('denied');
    expect(verdict.denial_code).toBe('unknown_destination');
    const rows = await notifications();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.source).toBe('http');
    expect(rows[0]?.idempotency_key).toBe('http:k1');
  });
});

describe('Telegram ingress acknowledgement window', () => {
  it('emits the first ACK, suppresses a repeated ACK, and emits again after ten minutes', async () => {
    const first = await repository.publish(telegramIngress());
    expect(await acknowledgementRelays()).toEqual([{ message_id: first.message_id }]);

    await repository.publish(telegramIngress());
    expect(await acknowledgementRelays()).toEqual([{ message_id: first.message_id }]);

    await pool.query(
      `UPDATE egress_contacts SET last_inbound_at=now()-interval '11 minutes'
       WHERE tenant_id='Steven' AND alias='argos' AND adapter='telegram' AND conversation_id=$1`,
      [CHAT_ID]
    );
    const outsideWindow = await repository.publish(telegramIngress());
    expect(await acknowledgementRelays()).toEqual([
      { message_id: first.message_id },
      { message_id: outsideWindow.message_id }
    ]);
  });
});

describe('proactive egress rate limits', () => {
  it('denies the second notification in the hour window', async () => {
    await grantNotifyRole('argos');
    await createDestination({ max_per_hour: 1 });
    await seedPriorContact();
    await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'primera', idempotency_key: 'a', dry_run: false
    });
    const second = await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'segunda', idempotency_key: 'b', dry_run: false
    });
    expect(second.decision).toBe('denied');
    expect(second.denial_code).toBe('rate_limited');
    expect(await notifyRelays()).toHaveLength(1);
  });

  it('denies a notification inside min_interval_seconds', async () => {
    await grantNotifyRole('argos');
    await createDestination({ min_interval_seconds: 300 });
    await seedPriorContact();
    await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'primera', idempotency_key: 'a', dry_run: false
    });
    const second = await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'segunda', idempotency_key: 'b', dry_run: false
    });
    expect(second.denial_code).toBe('rate_limited');
  });

  it('enforces max_per_root across different deliveries of the same chain', async () => {
    await grantNotifyRole('argos');
    await createDestination({ max_per_root: 1 });
    await seedPriorContact();

    // The chain must be built the way the runtime builds one: the root is a
    // normal client publish and every later hop is a server-materialized
    // `agent.message` carrying the inherited correlation. A client cannot
    // declare `correlation.root_message_id` itself -- `rootMessageId()` only
    // honours it on reserved internal types, which `publish` rejects -- so a
    // fabricated chain would exercise nothing. The relay hops go through
    // socrates and jarvis because an agent may not address itself, nor reply
    // to the actor of an internal delivery, so argos cannot loop back alone.
    // One lease per alias, held for the whole chain: re-acquiring would fence
    // the previous epoch and the next claim would be rejected.
    const leases = new Map<string, number>();
    const step = async (alias: string, result: Record<string, unknown>): Promise<string | null> => {
      const instance = `${alias}-1`;
      if (!leases.has(alias)) {
        const lease = await repository.acquireLease('Steven', alias, instance, [], 30_000);
        leases.set(alias, requireValue(lease.epoch, 'lease.epoch'));
      }
      const [delivery] = await repository.claimDeliveries(
        'Steven', alias, instance, requireValue(leases.get(alias), 'value'), 1, 30_000
      );
      expect(delivery, `${alias} should have a pending delivery`).toBeDefined();
      await repository.ackDelivery(
        requireValue(delivery, 'delivery').delivery_id, 'Steven', alias,
        ackWith(requireValue(delivery, 'delivery'), instance, requireValue(leases.get(alias), 'value'), result)
      );
      const rows = await notifications();
      return rows[rows.length - 1]?.denial_code ?? null;
    };
    const notify = (body: string): unknown[] =>
      [{ to: 'steven.dm', kind: 'decision_request', body }];

    const root = await repository.publish(command({ idempotency_key: 'chain-root' }));

    // Hop 1: the root delivery notifies and hands the chain on.
    const firstOutcome = await step('argos', notifyOutput(notify('paso 0'), {
      messages: [{ to: 'socrates', body: 'sigue la cadena' }]
    }));
    await step('socrates', notifyOutput([], { messages: [{ to: 'jarvis', body: 'sigue' }] }));
    await step('jarvis', notifyOutput([], { messages: [{ to: 'argos', body: 'cierra' }] }));

    // Hop 4: a distinct delivery to argos, same chain root.
    const secondOutcome = await step('argos', notifyOutput(notify('paso 1')));

    // Both notifications belong to the same conversation chain, so the second
    // must exhaust the per-chain quota rather than slip through on the
    // notification's own (always unique) root_message_id.
    const rows = await notifications();
    expect(rows).toHaveLength(2);
    expect(firstOutcome).toBeNull();
    expect(secondOutcome).toBe('root_quota_exhausted');
    expect(rows.every((row) => row.source_root_message_id === root.message_id)).toBe(true);
  });

  it('denies a notification inside the quiet hours window', async () => {
    await grantNotifyRole('argos');
    await createDestination();
    await pool.query(
      `UPDATE egress_destinations SET quiet_hours_start=0,quiet_hours_end=23,quiet_hours_tz='UTC'
       WHERE tenant_id='Steven' AND alias='argos' AND handle='steven.dm'`
    );
    await seedPriorContact();
    const hour = await pool.query<{ hour: number }>(
      `SELECT extract(hour FROM clock_timestamp() AT TIME ZONE 'UTC')::int AS hour`
    );
    const inWindow = (hour.rows[0]?.hour ?? 0) < 23;
    const verdict = await repository.enqueueNotification('Steven', 'argos', {
      destination: 'steven.dm', kind: 'alert', body: 'de madrugada', idempotency_key: 'q', dry_run: false
    });
    expect(verdict.denial_code === 'quiet_hours').toBe(inWindow);
  });
});
