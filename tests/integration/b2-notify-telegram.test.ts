import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { CauceRepository } from '@cauce/store';
import { TelegramActivityIndicator } from '../../services/telegram-bridge/src/activity.js';
import { TelegramEgressWorker } from '../../services/telegram-bridge/src/egress.js';
import { StoreTelegramIngress } from '../../services/telegram-bridge/src/ingress.js';
import { TelegramBridgeProgress } from '../../services/telegram-bridge/src/progress.js';
import { PostgresTelegramBridgeRepository } from '../../services/telegram-bridge/src/repository.js';
import { TelegramHttpClient } from '../../services/telegram-bridge/src/telegram.js';
import type { TelegramAliasConfig } from '../../services/telegram-bridge/src/types.js';
import { startDeliveryRuntime, type DeliveryRuntime } from './b2-delivery-runtime.js';
import { startTelegramBoundary } from './b2-telegram-http-boundary.js';

const chat = '-1001000000001';
const config: TelegramAliasConfig = {
  tenant_id: 'Steven', alias: 'argos', room_id: 'grp.steven', token_file: '/synthetic/token',
  v2_shutdown_marker_file: '/synthetic/marker', allowed_user_ids: ['1000000001'], allowed_chat_ids: [chat],
  chats: [{ chat_id: chat, mode: 'mention', default_alias: 'argos', session_scope: 'thread', reply_to_origin: false, threads: [] }],
  recipients: [{ tenant_id: 'Steven', alias: 'argos' }], poll_timeout_seconds: 1, poll_lease_ms: 60_000,
};
let runtime: DeliveryRuntime | undefined;
let boundary: Awaited<ReturnType<typeof startTelegramBoundary>> | undefined;
let activity: TelegramActivityIndicator | undefined;
afterEach(async () => {
  activity?.stop();
  try { await boundary?.close(); } finally { await runtime?.close(); }
  runtime = undefined; boundary = undefined; activity = undefined;
});

async function drain(worker: TelegramEgressWorker): Promise<void> {
  for (let cycle = 0; cycle < 10; cycle++) {
    if (await worker.runOnce() === 0) return;
  }
  throw new Error('Synthetic Telegram outbox did not drain within its bounded fixture');
}

async function setup(options: { permission?: boolean; contact?: boolean; maxPerRoot?: number } = {}) {
  const current = await startDeliveryRuntime(); runtime = current;
  const provider = await startTelegramBoundary(); boundary = provider;
  const pool = current.database.pool;
  await pool.query(`INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
    VALUES('b2_notify',true,true,false,$1)`, [options.permission ?? true]);
  await pool.query("UPDATE memberships SET role='b2_notify' WHERE tenant_id='Steven' AND alias='argos'");
  await pool.query(`INSERT INTO egress_destinations(tenant_id,alias,handle,adapter,channel,conversation_id,
    conversation_kind,allow_kinds,require_prior_contact,contact_ttl_days,min_interval_seconds,max_per_hour,
    max_per_day,max_per_root,enabled) VALUES('Steven','argos','b2.owner','telegram','telegram',$1,'group',
    ARRAY['task_complete','decision_request','digest','alert'],true,30,0,10,50,$2,true)`, [chat, options.maxPerRoot ?? 5]);
  if (options.contact !== false) {
    await new StoreTelegramIngress(new CauceRepository(pool)).publish({ tenant_id: 'Steven', alias: 'argos',
      room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven', alias: 'kant' }],
      bot_id: '900001', update_id: 1, session_id: `b2-prior-${randomUUID()}`, human: true,
      body: { text: 'Synthetic prior human contact' },
      origin: { adapter: 'telegram', channel: 'telegram', conversation_id: chat, external_message_id: '1000000001',
        relay: [], metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven', chat_type: 'group' } } });
  }
  const api = new TelegramHttpClient({ token: `900001:${'a'.repeat(30)}`, apiBase: provider.origin, requestTimeoutMs: 2000 });
  activity = new TelegramActivityIndicator();
  const observer = new TelegramBridgeProgress(); observer.registerEgress(60_000);
  const worker = new TelegramEgressWorker({ repository: new PostgresTelegramBridgeRepository(pool),
    aliases: [config], apis: new Map([['Steven/argos', api]]), activity, observer });
  const { wire, epoch } = await current.connect();
  await current.publish(`B2-NOTIFY-${randomUUID()}`);
  const delivery = await wire.next('delivery');
  return { current, provider, worker, pool, delivery,
    ack: (notify: object[]) => {
      return { delivery_id: delivery.delivery_id, ...current.ack(delivery, epoch, {
        result: { output: { reply: null, messages: [], notify, status: 'done', retryable: false, artifacts: [] } },
      }) };
    },
  };
}

describe('notify from public delivery ACK through durable outbox and real Telegram HTTP client', () => {
  it('sends a proactive notice once and exposes the provider receipt after duplicate ACK and worker restart', async () => {
    const { current, provider, worker, pool, delivery, ack } = await setup();
    const text = `B2-NOTICE-${randomUUID()}`;
    const output = ack([{ to: 'b2.owner', kind: 'task_complete', body: text }]);
    expect(await current.request('/v3/ack', output)).toMatchObject({ status: 200, body: { applied: true, status: 'done' } });
    expect(await current.request('/v3/ack', output)).toMatchObject({ status: 200, body: { applied: false } });
    await drain(worker);
    const restartedObserver = new TelegramBridgeProgress(); restartedObserver.registerEgress(60_000);
    const restarted = new TelegramEgressWorker({ repository: new PostgresTelegramBridgeRepository(pool), aliases: [config],
      apis: new Map([['Steven/argos', new TelegramHttpClient({ token: `900001:${'a'.repeat(30)}`, apiBase: provider.origin })]]),
      activity: activity ?? new TelegramActivityIndicator(), observer: restartedObserver });
    await restarted.runOnce();
    const sends = provider.calls.filter(call => call.method === 'sendMessage' && call.body.text === text);
    expect(sends).toHaveLength(1); expect(sends[0]?.body.chat_id).toBe(chat);
    const receipt = await current.request(`/v3/agent/egress?delivery_ids=${delivery.delivery_id}`);
    expect(receipt).toMatchObject({ status: 200, body: { items: [{ state: 'sent', notify_index: 0,
      chunks: { expected: 1, sent: 1 }, destination: { handle: 'b2.owner', conversation_id: chat } }] } });
    const persisted = await pool.query<{ decision: string; status: string; state: string; provider_message_id: string }>(`SELECT n.decision,o.status,e.state,e.provider_message_id
      FROM egress_notifications n JOIN adapter_outbox o ON o.id=n.produced_outbox_id
      JOIN telegram_egress_effects e ON e.outbox_id=o.id WHERE n.source_delivery_id=$1`, [delivery.delivery_id]);
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]).toMatchObject({ decision: 'allowed', status: 'sent', state: 'sent' });
    expect(persisted.rows[0]?.provider_message_id).toMatch(/^\d+$/u);
    expect((await pool.query<{ adapter: string }>("SELECT origin->>'adapter' AS adapter FROM messages WHERE id=$1",
      [delivery.message_id])).rows).toEqual([{ adapter: 'dev-auth' }]);
  });

  it.each([
    { label: 'missing permission', options: { permission: false }, denial: 'notify_permission_denied' },
    { label: 'cold contact', options: { contact: false }, denial: 'cold_contact' },
  ])('denies $label without cancelling the delivery or sending the denied notice', async ({ options, denial }) => {
    const { current, provider, worker, pool, delivery, ack } = await setup(options);
    const text = `B2-DENIED-${randomUUID()}`;
    expect(await current.request('/v3/ack', ack([{ to: 'b2.owner', kind: 'alert', body: text }])))
      .toMatchObject({ status: 200, body: { applied: true, status: 'done' } });
    await drain(worker);
    expect(provider.calls.some(call => call.method === 'sendMessage' && call.body.text === text)).toBe(false);
    expect((await pool.query('SELECT decision,denial_code,produced_outbox_id FROM egress_notifications WHERE source_delivery_id=$1',
      [delivery.delivery_id])).rows).toEqual([{ decision: 'denied', denial_code: denial, produced_outbox_id: null }]);
  });

  it.each(['root', 'hour', 'day', 'interval'] as const)('enforces the %s quota before the second notice reaches Telegram', async limit => {
    const { current, provider, worker, pool, delivery, ack } = await setup({ maxPerRoot: limit === 'root' ? 1 : 5 });
    await pool.query(`UPDATE egress_destinations SET max_per_hour=$1,max_per_day=$2,min_interval_seconds=$3
      WHERE tenant_id='Steven' AND alias='argos' AND handle='b2.owner'`,
    [limit === 'hour' ? 1 : 10, limit === 'day' ? 1 : 50, limit === 'interval' ? 3600 : 0]);
    const first = `B2-QUOTA-1-${randomUUID()}`; const second = `B2-QUOTA-2-${randomUUID()}`;
    expect((await current.request('/v3/ack', ack([
      { to: 'b2.owner', kind: 'alert', body: first }, { to: 'b2.owner', kind: 'alert', body: second },
    ]))).status).toBe(200);
    await drain(worker);
    expect(provider.calls.filter(call => call.method === 'sendMessage' && call.body.text === first)).toHaveLength(1);
    expect(provider.calls.filter(call => call.method === 'sendMessage' && call.body.text === second)).toHaveLength(0);
    expect((await pool.query(`SELECT decision,denial_code FROM egress_notifications
      WHERE source_delivery_id=$1 ORDER BY notify_index`, [delivery.delivery_id])).rows)
      .toEqual([{ decision: 'allowed', denial_code: null },
        { decision: 'denied', denial_code: limit === 'root' ? 'root_quota_exhausted' : 'rate_limited' }]);
  });

  it.each(['quiet_hours', 'destination_disabled', 'kind_not_allowed'] as const)('honors the %s destination policy without sending the denied notice', async denial => {
    const { current, provider, worker, pool, delivery, ack } = await setup();
    if (denial === 'quiet_hours') {
      await pool.query(`UPDATE egress_destinations SET quiet_hours_start=extract(hour FROM now() AT TIME ZONE 'UTC')::int,
        quiet_hours_end=(extract(hour FROM now() AT TIME ZONE 'UTC')::int+2)%24,quiet_hours_tz='UTC'
        WHERE tenant_id='Steven' AND alias='argos' AND handle='b2.owner'`);
    } else if (denial === 'destination_disabled') {
      await pool.query("UPDATE egress_destinations SET enabled=false WHERE tenant_id='Steven' AND alias='argos' AND handle='b2.owner'");
    } else {
      await pool.query("UPDATE egress_destinations SET allow_kinds=ARRAY['digest'] WHERE tenant_id='Steven' AND alias='argos' AND handle='b2.owner'");
    }
    const text = `B2-POLICY-${randomUUID()}`;
    expect(await current.request('/v3/ack', ack([{ to: 'b2.owner', kind: 'alert', body: text }])))
      .toMatchObject({ status: 200, body: { applied: true, status: 'done' } });
    await drain(worker);
    expect(provider.calls.some(call => call.method === 'sendMessage' && call.body.text === text)).toBe(false);
    expect((await pool.query('SELECT decision,denial_code,produced_outbox_id FROM egress_notifications WHERE source_delivery_id=$1',
      [delivery.delivery_id])).rows).toEqual([{ decision: 'denied', denial_code: denial, produced_outbox_id: null }]);
  });
});
