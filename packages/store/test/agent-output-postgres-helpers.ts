import { preparePostgresSuite } from './postgres-suite.js';
import { randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { afterAll, afterEach, beforeEach } from 'vitest';
import {
  type Ack, type DeliveryEnvelope, type PublishMessage, type Tenant,
} from '@cauce/protocol';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, startTestCaseDatabase, type TestDatabase, type EmptyTestDatabase
} from '../../../tests/helpers/postgres.js';
import { PostgresTelegramBridgeRepository } from '../../../services/telegram-bridge/src/repository.js';
import { terminalAck as buildTerminalAck } from './helpers/consumer.js';
export let database: TestDatabase;
export let databaseStarted = false;
export let pool: DatabasePool;
export let repository: CauceRepository;
export const ROUTABLE_FLEET_EXCEPT_ARGOS = [
  'Isa:salva', 'Jhon:hegel', 'Miguel:atlas', 'Miguel:iza',
  'Miguel:janus', 'Miguel:kratos', 'Pablo:dedalo', 'Pablo:midas',
  'Pablo:seneca', 'Pablo:vulcano', 'Steven:jarvis', 'Steven:kant',
  'Steven:socrates', 'Steven:zeus'
] as const;
export function command(overrides: Partial<PublishMessage> = {}): PublishMessage {
  return {
    version: '3.0',
    request_id: randomUUID(),
    trace_id: `trace-${randomUUID()}`,
    tenant_id: 'Steven',
    room_id: 'grp.steven',
    actor_alias: 'kant',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'agent output source' },
    idempotency_key: randomUUID(),
    lane: 'interactive',
    priority: 7,
    ...overrides
  };
}
export async function claim(
  input: PublishMessage,
  tenant: Tenant,
  alias: string,
  instanceId: string
): Promise<{ delivery: DeliveryEnvelope; epoch: number }> {
  const lease = await repository.acquireLease(tenant, alias, instanceId, [], 30_000);
  await repository.publish(input);
  const [delivery] = await repository.claimDeliveries(
    tenant, alias, instanceId, requireValue(lease.epoch, 'lease.epoch'), 1, 30_000
  );
  if (!delivery) throw new Error('expected a claimed delivery');
  return { delivery, epoch: requireValue(lease.epoch, 'lease.epoch') };
}

export const terminalAck = (
  delivery: DeliveryEnvelope, instanceId: string, epoch: number, messages: unknown[],
  eventId = randomUUID(), reply: string | null = 'done'
): Ack => buildTerminalAck(delivery, { instanceId, epoch }, { messages, eventId, reply });

export async function claimFanin(
  tenant: Tenant,
  alias: string,
  instanceId: string,
  epoch: number
): Promise<DeliveryEnvelope> {
  const claimed = await repository.claimDeliveries(
    tenant, alias, instanceId, epoch, 10, 30_000
  );
  const fanin = claimed.find((delivery) => delivery.body.type === 'agent.fanin');
  if (!fanin) {
    throw new Error(`expected agent.fanin delivery, received: ${JSON.stringify(
      claimed.map((delivery) => delivery.body.type)
    )}`);
  }
  return fanin;
}

export async function seedTelegramAckAndFinal(
  finalStatus: 'pending' | 'processing' | 'sent' | 'dead'
): Promise<{
  ackId: string;
  finalId: string;
  messageId: string;
  deliveryId: string;
}> {
  const input = command({
    actor_alias: 'argos',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    authenticated_context: {
      session_id: `telegram-order-${finalStatus}`,
      channel: 'telegram',
      origin: {
        adapter: 'telegram',
        channel: 'telegram',
        conversation_id: `telegram-order-${finalStatus}`,
        external_message_id: `telegram-order-${finalStatus}`,
        relay: [],
        metadata: { bridge_alias: 'argos', bridge_tenant: 'Steven' }
      }
    }
  });
  const published = await repository.publish(input);
  const deliveryId = published.delivery_ids[0];
  if (!deliveryId) throw new Error('expected a Telegram root delivery');
  const acknowledgement = await pool.query<{ id: string }>(
    `SELECT id FROM adapter_outbox WHERE idempotency_key=$1`,
    [`relay-ack:${published.message_id}`]
  );
  const ackId = acknowledgement.rows[0]?.id;
  if (!ackId) throw new Error('expected a Telegram acceptance ACK');
  const final = await pool.query<{ id: string }>(
    `INSERT INTO adapter_outbox(
       tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,
       origin,payload,status,claimed_at,claim_expires_at,sent_at,dead_at
     ) VALUES(
       'Steven','telegram','origin_relay',$1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,
       CASE WHEN $8='processing' THEN now() ELSE NULL END,
       CASE WHEN $8='processing' THEN now()+interval '1 minute' ELSE NULL END,
       CASE WHEN $8='sent' THEN now() ELSE NULL END,
       CASE WHEN $8='dead' THEN now() ELSE NULL END
     ) RETURNING id`,
    [
      `relay-root:${published.message_id}`,
      input.request_id,
      published.message_id,
      deliveryId,
      input.trace_id,
      JSON.stringify(requireValue(input.authenticated_context, 'input.authenticated_context').origin),
      JSON.stringify({
        outcome: 'done',
        result: { output: { reply: 'final', messages: [] } },
        correlation: {
          request_id: input.request_id,
          message_id: published.message_id,
          delivery_id: deliveryId,
          trace_id: input.trace_id,
          root_message_id: published.message_id
        }
      }),
      finalStatus
    ]
  );
  const finalId = final.rows[0]?.id;
  if (!finalId) throw new Error('expected a correlated final relay');
  return { ackId, finalId, messageId: published.message_id, deliveryId };
}

export async function deadTelegramAckEffect(ackId: string): Promise<{
  bridge: PostgresTelegramBridgeRepository;
  effectId: string;
  payloadHash: string;
  deadLetterId: string;
  incidentEvidenceSha256: string;
}> {
  const bridge = new PostgresTelegramBridgeRepository(pool);
  const effectId = `${ackId}:0`;
  const payloadHash = 'a'.repeat(64);
  await pool.query(
    `UPDATE adapter_outbox SET status='processing',claimed_at=now(),
       claim_expires_at=now()+interval '1 minute' WHERE id=$1`,
    [ackId]
  );
  await bridge.prepareEffect({
    effect_id: effectId,
    outbox_id: ackId,
    tenant_id: 'Steven',
    bridge_alias: 'argos',
    chunk_index: 0,
    chunk_count: 1,
    payload_hash: payloadHash
  });
  await bridge.markEffectDead(effectId, payloadHash, 'operator review required');
  await pool.query(
    `UPDATE adapter_outbox SET status='dead',dead_at=now(),
       last_error='operator review required',claim_expires_at=NULL
     WHERE id=$1`,
    [ackId]
  );
  await pool.query(
    `INSERT INTO outbox_dead_letters(
       outbox_id,tenant_id,adapter,kind,reason,payload,attempts
     )
     SELECT id,tenant_id,adapter,kind,'operator review required',payload,attempts
     FROM adapter_outbox WHERE id=$1
     ON CONFLICT(outbox_id) DO NOTHING`,
    [ackId]
  );
  const incidentEvidenceSha256 = 'c'.repeat(64);
  const incident = await pool.query<{ id: string }>(
    `UPDATE outbox_dead_letters SET disposition='ambiguous',disposition_at=now(),
       evidence_sha256=$2 WHERE outbox_id=$1 RETURNING id`,
    [ackId, incidentEvidenceSha256],
  );
  return {
    bridge, effectId, payloadHash, deadLetterId: requireValue(incident.rows[0], 'incident.rows').id, incidentEvidenceSha256,
  };
}

export function registerAgentOutputSuite(sourceUrl: string): void {
  let currentCase: EmptyTestDatabase | undefined;
  preparePostgresSuite(sourceUrl, async () => {
    database = await startTestDatabase();
    databaseStarted = true;
    pool = database.pool;
    repository = new CauceRepository(pool);
  }, 120_000);

  beforeEach(async () => {
    currentCase = await startTestCaseDatabase(database);
    pool = currentCase.pool;
    repository = new CauceRepository(pool);
    await resetTestDatabase(pool);
    await pool.query(`
      DELETE FROM memberships WHERE tenant_id='Pablo' AND alias='kant';
      INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
        ('Miguel','grp.miguel','atlas','agent'),('Miguel','grp.miguel','iza','agent'),
        ('Steven','grp.steven','zeus','agent')
      ON CONFLICT DO NOTHING;
      UPDATE acl_edges SET enabled=true,allow_route=true,allow_read=true,allow_control=true;
      UPDATE tenants SET enabled=true;
      UPDATE rooms SET enabled=true;
      UPDATE memberships SET enabled=true;
      UPDATE role_policies SET allow_route=true WHERE role IN ('agent','operator','adapter');
    `);
  });

  afterEach(async () => { await currentCase?.close(); currentCase = undefined; });

  afterAll(async () => {
    if (!databaseStarted) return;
    await currentCase?.close();
    await database.pool.end();
    await database.container.stop();
  });
}
