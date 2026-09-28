import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach } from 'vitest';
import type { Ack, DeliveryEnvelope, PublishMessage, Tenant } from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';
import { ackEnvelope } from './helpers/consumer.js';
export let database: TestDatabase;
export let databaseStarted = false;
export let pool: DatabasePool;
export let repository: CauceRepository;
export const NOTIFY_ROLE = 'agent_notify';
export const CHAT_ID = '-1001234567890';
export interface NotificationRow {
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
export function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
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
export function telegramIngress(overrides: Partial<PublishMessage> = {}): PublishMessage {
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

export async function claim(
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

export const ackWith = (
  delivery: DeliveryEnvelope, instanceId: string, epoch: number,
  result: Record<string, unknown>, overrides: Partial<Ack> = {}
): Ack => ackEnvelope(delivery, { instanceId, epoch }, result, overrides);
export function notifyOutput(
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

export async function grantNotifyRole(alias: string): Promise<void> {
  await pool.query(
    `INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
     VALUES($1,true,true,false,true) ON CONFLICT(role) DO UPDATE SET allow_notify=true`,
    [NOTIFY_ROLE]
  );
  await pool.query('UPDATE memberships SET role=$2 WHERE alias=$1', [alias, NOTIFY_ROLE]);
}

export async function createDestination(
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

export async function notifications(): Promise<NotificationRow[]> {
  const result = await pool.query<NotificationRow>(
    `SELECT id,alias,handle,kind,source,decision,denial_code,conversation_id,produced_message_id,
            produced_outbox_id,source_root_message_id,idempotency_key,created_at
     FROM egress_notifications ORDER BY created_at,id`
  );
  return result.rows;
}

export async function notifyRelays(): Promise<Record<string, unknown>[]> {
  const result = await pool.query<Record<string, unknown>>(
    `SELECT id,tenant_id,adapter,kind,idempotency_key,origin,payload,status
     FROM adapter_outbox WHERE kind='origin_relay' AND payload->>'relay_kind'='notify'
     ORDER BY created_at`
  );
  return result.rows;
}

export async function acknowledgementRelays(): Promise<{ message_id: string }[]> {
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
export async function seedPriorContact(): Promise<void> {
  await repository.publish(telegramIngress({ recipients: [{ tenant_id: 'Steven', alias: 'kant' }] }));
}

export function registerEgressSuite(sourceUrl: string): void {
  preparePostgresSuite(sourceUrl, async () => {
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
}
