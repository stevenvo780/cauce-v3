import { TenantSchema, type Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { consolePublishConversationHash } from '../config.js';
import type { HumanPublishProvenance } from './contracts.js';
import { StoreError } from '../errors.js';
import { MESSAGE_DELIVERIES_SQL, MESSAGE_VISIBILITY_SQL } from './message-detail.js';

export interface AuthorizedMessageAttachments {
  readonly message: Record<string, unknown>;
  readonly attachments: unknown;
}

export async function loadMessageAttachment(
  client: Pick<DatabaseClient, 'query'>, messageId: string, actorTenant: Tenant, actorAlias: string,
): Promise<AuthorizedMessageAttachments> {
  // Authorization and inline content must share one PostgreSQL statement snapshot.
  const result = await client.query<{
    id: string; tenant_id: string; actor_alias: string; deliveries: unknown; attachments: unknown;
  }>(
    `SELECT m.id,m.tenant_id,m.actor_alias,m.body->'attachments_v1' AS attachments,
            ${MESSAGE_DELIVERIES_SQL}
     ${MESSAGE_VISIBILITY_SQL}`, [messageId, actorTenant, actorAlias],
  );
  const row = result.rows[0];
  if (row === undefined) throw new StoreError('not_found', 'message not found or not visible');
  return {
    message: { id: row.id, tenant_id: row.tenant_id, actor_alias: row.actor_alias, deliveries: row.deliveries },
    attachments: row.attachments,
  };
}

export async function loadHumanMessageAttachment(
  client: DatabaseClient, messageId: string, human: HumanPublishProvenance,
): Promise<AuthorizedMessageAttachments> {
  // The human ledger, read authority and bytes must share one statement snapshot.
  const result = await client.query<{
    id: string; tenant_id: string; actor_alias: string; attachments: unknown; conversation_id: string;
    room_id: string; recipients: { tenant_id: string; alias: string }[];
  }>(
    `SELECT m.id,m.tenant_id,m.actor_alias,m.room_id,m.body->'attachments_v1' AS attachments,
       owner.conversation_id,
       (SELECT jsonb_agg(jsonb_build_object('tenant_id',recipient.recipient_tenant,'alias',recipient.recipient_alias)
         ORDER BY recipient.id) FROM deliveries recipient WHERE recipient.message_id=m.id) AS recipients
     FROM messages m JOIN human_message_initiators owner ON owner.message_id=m.id
     JOIN memberships membership ON membership.tenant_id=m.tenant_id
       AND membership.room_id=m.room_id AND membership.alias=$4
     JOIN role_policies policy ON policy.role=membership.role
     JOIN tenants tenant ON tenant.id=m.tenant_id
     JOIN rooms room ON room.id=m.room_id AND room.tenant_id=m.tenant_id
     WHERE m.id=$1::uuid AND m.tenant_id=$2 AND m.actor_alias=$4
       AND owner.initiating_human_id=$3::uuid AND owner.initiating_tenant_id=$2
       AND owner.message_tenant_id=$2 AND owner.root_message_id=m.id
       AND membership.enabled AND policy.allow_read AND tenant.enabled AND room.enabled
     FOR SHARE OF membership,policy,tenant,room`,
    [messageId, human.tenantId, human.humanId, human.actorAlias],
  );
  const row = result.rows[0];
  if (result.rows.length !== 1 || row === undefined || !Array.isArray(row.recipients)
      || row.conversation_id !== consolePublishConversationHash({
        tenant_id: human.tenantId, actor_alias: human.actorAlias, room_id: row.room_id,
        recipients: row.recipients.map((recipient) => ({ tenant_id: TenantSchema.parse(recipient.tenant_id), alias: recipient.alias })),
      })) throw new StoreError('not_found', 'message not found or not visible');
  return { message: { id: row.id, tenant_id: row.tenant_id, actor_alias: row.actor_alias }, attachments: row.attachments };
}
