import { randomUUID } from 'node:crypto';
import { withTransaction } from '@cauce/store';
import type { DatabasePool } from '@cauce/store';
import { insertDelivery, insertMessage } from '../../packages/store/src/repository/messages/_insert.js';
import { putHumanMessageInitiator } from '../../packages/store/src/repository/messages/human-initiators.js';
import { isaTenant, type FunctionalTenant } from './console-functional-browser.fixtures.js';

export const DETALLE_OWNER = 'p1-detalle-mensaje-404-1025';
export const BATCH_TAIL = 'zz-canary-batch-tail';
export const TELEGRAM_TAIL = 'zz-canary-telegram-tail';
export const OTHER_ROOM_TEXT = 'zz-canary-other-room-body';
export const OTHER_TENANT_TEXT = 'zz-canary-other-tenant-body';
const CONVERSATION = 'zz-canary-p1-detalle-mensaje-404-1025';

export function longText(stem: string, tail: string): string {
  return `${stem.repeat(20)}${tail}`;
}

export interface SeededRoom {
  readonly batchId: string;
  readonly telegramId: string;
  readonly otherRoomId: string;
  readonly otherTenantId: string;
  readonly batchText: string;
  readonly telegramText: string;
}

export async function seedDetalleMensajes(pool: DatabasePool, tenant: FunctionalTenant = isaTenant): Promise<SeededRoom> {
  const human = await pool.query<{ id: string }>(
    'SELECT id FROM console_users WHERE email_normalized=$1', [tenant.email.toLowerCase()]);
  const humanId = human.rows[0]?.id;
  if (!humanId) throw new Error('Console human for the room detail fixture is missing');
  const batchText = longText('lote de consola ', BATCH_TAIL);
  const telegramText = longText('aviso de telegram ', TELEGRAM_TAIL);
  const stamp = randomUUID().slice(0, 8);
  const anchorRoom = `zzanchor${stamp}`;
  const anchorAlias = `zzanchor${stamp}`;
  const otherRoom = `zzother${stamp}`;
  const otherAlias = `zzother${stamp}`;
  await pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2),($3,$2)', [anchorRoom, tenant.tenant, otherRoom]);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
    VALUES($1,$2,'codex',$2,true,$3,'stev','/tmp/zz-canary-anchor','/tmp/zz-canary-anchor'),
          ($1,$4,'codex',$4,true,$5,'stev','/tmp/zz-canary-other','/tmp/zz-canary-other')`,
  [tenant.tenant, anchorAlias, `cauce-e2e-${anchorAlias}`, otherAlias, `cauce-e2e-${otherAlias}`]);
  await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'agent'),($1,$4,$5,'agent')`,
    [tenant.tenant, anchorRoom, anchorAlias, otherRoom, otherAlias]);
  await pool.query(`UPDATE agents SET harness_id='codex' WHERE tenant_id=$1 AND alias=$2`, [tenant.tenant, tenant.operator]);
  return withTransaction(pool, async (client) => {
    const origin = {
      adapter: 'telegram', channel: 'telegram', conversation_id: '1000000001', relay: [],
      metadata: { bridge_alias: tenant.operator, bridge_tenant: tenant.tenant, chat_type: 'private', proactive: true },
    };
    const anchor = await insertMessage(client, {
      requestId: randomUUID(), traceId: randomUUID(), tenantId: tenant.tenant, roomId: anchorRoom,
      actorAlias: anchorAlias, body: { text: 'zz-canary-anchor' }, origin: null, lane: 'batch', priority: 1,
      authSessionId: null, authChannel: 'console',
    });
    const anchorId = anchor.rows[0]?.id;
    if (!anchorId) throw new Error('Anchor message was not inserted');
    const initiator = { humanId, tenantId: tenant.tenant, rootMessageId: anchorId, conversationId: CONVERSATION };
    await putHumanMessageInitiator(client, { ...initiator, messageId: anchorId, messageTenantId: tenant.tenant });
    const batch = await insertMessage(client, {
      requestId: randomUUID(), traceId: randomUUID(), tenantId: tenant.tenant, roomId: tenant.room,
      actorAlias: tenant.operator, body: { text: batchText }, origin: null, lane: 'batch', priority: 1,
      authSessionId: `console:${humanId}`, authChannel: 'console',
    });
    const telegram = await insertMessage(client, {
      requestId: randomUUID(), traceId: randomUUID(), tenantId: tenant.tenant, roomId: tenant.room,
      actorAlias: tenant.operator, body: { type: 'agent.notify', text: telegramText }, origin, lane: 'interactive',
      priority: 0, authSessionId: `egress:${humanId}`, authChannel: 'telegram',
    });
    const other = await insertMessage(client, {
      requestId: randomUUID(), traceId: randomUUID(), tenantId: tenant.tenant, roomId: otherRoom,
      actorAlias: otherAlias, body: { text: OTHER_ROOM_TEXT }, origin: null, lane: 'batch', priority: 1,
      authSessionId: null, authChannel: 'console',
    });
    const abroad = await insertMessage(client, {
      requestId: randomUUID(), traceId: randomUUID(), tenantId: 'Jhon', roomId: 'e2e.jhon',
      actorAlias: 'e2ejhon', body: { text: OTHER_TENANT_TEXT }, origin: null, lane: 'batch', priority: 1,
      authSessionId: null, authChannel: 'console',
    });
    const batchId = batch.rows[0]?.id;
    const telegramId = telegram.rows[0]?.id;
    const otherRoomId = other.rows[0]?.id;
    const otherTenantId = abroad.rows[0]?.id;
    if (!batchId || !telegramId || !otherRoomId || !otherTenantId) throw new Error('Room detail messages were not inserted');
    await insertDelivery(client, { messageId: batchId, recipientTenant: tenant.tenant, recipientAlias: tenant.target });
    await insertDelivery(client, { messageId: telegramId, recipientTenant: tenant.tenant, recipientAlias: tenant.target });
    await putHumanMessageInitiator(client, { ...initiator, messageId: batchId, messageTenantId: tenant.tenant });
    await putHumanMessageInitiator(client, { ...initiator, messageId: telegramId, messageTenantId: tenant.tenant });
    return { batchId, telegramId, otherRoomId, otherTenantId, batchText, telegramText };
  });
}
