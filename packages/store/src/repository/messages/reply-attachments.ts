import { TenantSchema } from '@cauce/protocol';
import { consolePublishConversationHash } from '../config.js';
import type { DatabaseClient } from '../../db.js';
import { StoreError } from '../errors.js';
import type { HumanPublishProvenance } from './contracts.js';
import { CANONICAL_REPLY_JOIN_SQL } from './reply-attachments-selector.js';

export async function loadReplyAttachments(
  client: DatabaseClient, messageId: string, deliveryId: string, attempt: number,
  human: HumanPublishProvenance,
): Promise<unknown> {
  // Bytes, canonical selection and the human ledger are evaluated in one statement snapshot.
  const result = await client.query<{ attachments: unknown; conversation_id: string; room_id: string;
    recipients: { tenant_id: string; alias: string }[] }>(
    `SELECT effective.result->'reply_attachments_v1' AS attachments,owner.conversation_id,m.room_id,
       (SELECT jsonb_agg(jsonb_build_object('tenant_id',recipient.recipient_tenant,'alias',recipient.recipient_alias)
         ORDER BY recipient.id) FROM deliveries recipient WHERE recipient.message_id=m.id) AS recipients
     FROM messages m JOIN human_message_initiators owner ON owner.message_id=m.id
     JOIN memberships membership ON membership.tenant_id=m.tenant_id
       AND membership.room_id=m.room_id AND membership.alias=$4
     JOIN role_policies policy ON policy.role=membership.role
     JOIN tenants tenant ON tenant.id=m.tenant_id
     JOIN rooms room ON room.id=m.room_id AND room.tenant_id=m.tenant_id
     JOIN deliveries d ON d.message_id=m.id ${CANONICAL_REPLY_JOIN_SQL}
     WHERE m.id=$1::uuid AND m.tenant_id=$2 AND m.actor_alias=$4
       AND owner.initiating_human_id=$3::uuid AND owner.initiating_tenant_id=$2
       AND owner.message_tenant_id=$2 AND owner.root_message_id=m.id
       AND membership.enabled AND policy.allow_read AND tenant.enabled AND room.enabled
       AND effective.id=$5::uuid AND effective.attempt=$6 AND effective.status='done'
     FOR SHARE OF membership,policy,tenant,room`,
    [messageId, human.tenantId, human.humanId, human.actorAlias, deliveryId, attempt],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined) throw new StoreError('not_found', 'message not found or not visible');
  if (row.conversation_id !== consolePublishConversationHash({
    tenant_id: human.tenantId, actor_alias: human.actorAlias, room_id: row.room_id,
    recipients: row.recipients.map((recipient) => ({ tenant_id: TenantSchema.parse(recipient.tenant_id), alias: recipient.alias })),
  })) throw new StoreError('not_found', 'message not found or not visible');
  return row.attachments;
}
