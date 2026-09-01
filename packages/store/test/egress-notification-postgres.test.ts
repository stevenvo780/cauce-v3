import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';
let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;
const NOTIFY_ROLE = 'agent_notify';
const CHAT_ID = '-1001234567890';
interface NotificationRow {
  id: string;
  alias: string;
  handle: string;
  kind: string;
  source: string;
  decision: string;
  denial_code: string | null;
  conversation_id: string | null;
  produced_message_id: string | null;
  produced_outbox_id: string | null;
  source_root_message_id: string | null;
  idempotency_key: string;
  created_at: Date;
}
function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'long running task' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 0,
    ...overrides
  };
}
function telegramIngress(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return command({
    actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    authenticated_context: {
      session_id: `tg-session-${randomUUID()}`,
      channel: 'telegram',
      origin: {
        adapter: 'telegram',
        channel: 'telegram',
        conversation_id: CHAT_ID,
        external_message_id: String(Math.floor(Math.random() * 100_000)),
        relay: [],
        metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven', chat_type: 'group' }
      }
    },
    ...overrides
  });
}

async function claim(
  input: PublishMessage,
  tenant: Tenant,
  alias: string,
  instanceId: string
): Promise<{ delivery: DeliveryEnvelope; epoch: number }> {
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  await repository.publish(input);
  const [delivery] = await repository.claimDeliveries(tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000);
  if (!delivery) throw new Error('expected a claimed delivery');
  return { delivery, epoch: requireValue(lease.epoch, 'lease.epoch') };
}

function ackWith(
  delivery: DeliveryEnvelope,
  instanceId: string,
  epoch: number,
  result: Record<string, unknown>,
  overrides: Partial<Ack> = {}
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
    result,
    ...overrides
  };
}

function notifyOutput(
  notify: unknown[],
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    output: {
      reply: 'work finished',
      messages: [],
      notify,
      status: 'done',
      retryable: false,
      artifacts: [],
      ...overrides
    }
  };
}

async function grantNotifyRole(alias: string): Promise<void> {
  await pool.query(
    `INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
     VALUES($1,true,true,false,true) ON CONFLICT(role) DO UPDATE SET allow_notify=true`,
    [NOTIFY_ROLE]
  );
  await pool.query('UPDATE memberships SET role=$2 WHERE alias=$1', [alias, NOTIFY_ROLE]);
}

async function createDestination(
  overrides: Record<string, unknown> = {}
): Promise<void> {
  const values = {
    tenant_id: 'Steven',
    alias: 'argos',
    handle: 'steven.dm',
    adapter: 'telegram',
    channel: 'telegram',
    conversation_id: CHAT_ID,
    conversation_kind: 'group',
    allow_kinds: ['task_complete', 'decision_request', 'digest', 'alert'],
    require_prior_contact: true,
    contact_ttl_days: 30,
    min_interval_seconds: 0,
    max_per_hour: 10,
    max_per_day: 50,
    max_per_root: 5,
    enabled: true,
    ...overrides
  } as Record<string, unknown>;
  await pool.query(
    `INSERT INTO egress_destinations(
       tenant_id,alias,handle,adapter,channel,conversation_id,conversation_kind,allow_kinds,
       require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,max_per_day,
       max_per_root,enabled
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [values.tenant_id, values.alias, values.handle, values.adapter, values.channel,
      values.conversation_id, values.conversation_kind, values.allow_kinds,
      values.require_prior_contact, values.contact_ttl_days, values.min_interval_seconds,
      values.max_per_hour, values.max_per_day, values.max_per_root, values.enabled]
  );
}

async function notifications(): Promise<NotificationRow[]> {
  const result = await pool.query<NotificationRow>(
    `SELECT id,alias,handle,kind,source,decision,denial_code,conversation_id,produced_message_id,
            produced_outbox_id,source_root_message_id,idempotency_key,created_at
     FROM egress_notifications ORDER BY created_at,id`
  );
  return result.rows;
}

async function notifyRelays(): Promise<Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT id,tenant_id,adapter,kind,idempotency_key,origin,payload,status
     FROM adapter_outbox WHERE kind='origin_relay' AND payload->>'relay_kind'='notify'
     ORDER BY created_at`
  );
  return result.rows;
}

async function acknowledgementRelays(): Promise<{ message_id: string }[]> {
  const result = await pool.query<{ message_id: string }>(
    `SELECT message_id FROM adapter_outbox
     WHERE adapter='telegram' AND kind='origin_relay' AND payload->>'relay_kind'='ack'
     ORDER BY created_at,id`
  );
  return result.rows;
}

/**
 * Real authenticated Telegram ingress so the destination has genuine prior
 * contact. It is routed to a different recipient on purpose, so it does not
 * leave an extra pending delivery for argos that later claims would pick up.
 */
async function seedPriorContact(): Promise<void> {
  await repository.publish(telegramIngress({ recipients: [{ tenant_id: 'Steven', alias: 'kant' }] }));
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
    UPDATE memberships SET enabled=true,role='agent';
    UPDATE role_policies SET allow_route=true,allow_notify=false WHERE role IN ('agent','operator','adapter');
    DELETE FROM role_policies WHERE role='agent_notify';
  `);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

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
