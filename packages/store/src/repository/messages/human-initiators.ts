import type { DatabaseClient } from '../../db.js';
import { StoreError } from '../errors.js';
import type { HumanPublishProvenance } from './contracts.js';

export interface HumanMessageInitiator {
  readonly messageId: string;
  readonly messageTenantId: string;
  readonly humanId: string;
  readonly tenantId: string;
  readonly rootMessageId: string;
  readonly conversationId: string;
}

export async function loadHumanMessageInitiator(
  client: DatabaseClient, messageId: string,
): Promise<HumanMessageInitiator | undefined> {
  const result = await client.query<HumanMessageInitiator>(
    `SELECT message_id AS "messageId",message_tenant_id AS "messageTenantId",
            initiating_human_id AS "humanId",initiating_tenant_id AS "tenantId",
            root_message_id AS "rootMessageId",conversation_id AS "conversationId"
       FROM human_message_initiators WHERE message_id=$1::uuid FOR SHARE`,
    [messageId],
  );
  const row = result.rows[0];
  return row === undefined ? undefined : Object.freeze(row);
}

export async function putHumanMessageInitiator(
  client: DatabaseClient, initiator: HumanMessageInitiator,
): Promise<void> {
  await client.query(
    `INSERT INTO human_message_initiators(message_id,message_tenant_id,initiating_human_id,
       initiating_tenant_id,root_message_id,conversation_id)
     VALUES($1::uuid,$2,$3::uuid,$4,$5::uuid,$6) ON CONFLICT(message_id) DO NOTHING`,
    [initiator.messageId, initiator.messageTenantId, initiator.humanId,
      initiator.tenantId, initiator.rootMessageId, initiator.conversationId],
  );
  const existing = await loadHumanMessageInitiator(client, initiator.messageId);
  if (existing?.messageId !== initiator.messageId
      || existing.messageTenantId !== initiator.messageTenantId || existing.humanId !== initiator.humanId
      || existing.tenantId !== initiator.tenantId || existing.rootMessageId !== initiator.rootMessageId
      || existing.conversationId !== initiator.conversationId) {
    throw new StoreError('conflict', 'durable human message initiator is inconsistent');
  }
}

export async function assertHumanMessageRoot(
  client: DatabaseClient, messageId: string, human: HumanPublishProvenance, conversationId?: string,
): Promise<void> {
  const owner = await loadHumanMessageInitiator(client, messageId);
  if (owner?.humanId !== human.humanId || owner.tenantId !== human.tenantId
      || owner.messageTenantId !== human.tenantId || owner.rootMessageId !== messageId
      || (conversationId !== undefined && owner.conversationId !== conversationId)) {
    throw new StoreError('not_found', 'message not found or not owned');
  }
}
