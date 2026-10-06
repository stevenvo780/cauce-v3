import type { Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { StoreError } from '../errors.js';
import type { MessageDetailRow } from '../visibility-rows.js';
import { MESSAGE_AUTHOR_SQL, withMessageAuthor } from './author.js';
import { MESSAGE_ATTACHMENTS_SQL } from './attachments.js';
import type { SenderView } from './agent-roots.js';

export async function loadMessageDetail(
  client: Pick<DatabaseClient, 'query'>, messageId: string, actorTenant: Tenant, actorAlias: string,
): Promise<MessageDetailRow> {
  const result = await client.query<MessageDetailRow & { attachments: unknown }>(
    `SELECT m.id,m.version,m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,
            m.body-'attachments_v1'::text AS body,
            ${MESSAGE_ATTACHMENTS_SQL},
            m.origin,m.lane,m.priority,m.created_at,${MESSAGE_AUTHOR_SQL},
            COALESCE(jsonb_agg(jsonb_build_object(
       'delivery_id',d.id,'tenant_id',d.recipient_tenant,'alias',d.recipient_alias,
       'status',d.status,'attempt',d.attempt,'terminal_at',d.terminal_at
     ) ORDER BY d.created_at) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS deliveries
     FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id AND (
       EXISTS (SELECT 1 FROM memberships source_member
               WHERE source_member.tenant_id=$2 AND source_member.room_id=m.room_id
                 AND source_member.alias=$3 AND source_member.enabled)
       OR (d.recipient_tenant=$2 AND d.recipient_alias=$3)
     )
     WHERE m.id=$1 AND EXISTS (
       SELECT 1 FROM memberships own JOIN role_policies role ON role.role=own.role
       WHERE own.tenant_id=$2 AND own.alias=$3 AND own.enabled AND role.allow_read
     ) AND (
       EXISTS (SELECT 1 FROM memberships source_member
               WHERE source_member.tenant_id=$2 AND source_member.room_id=m.room_id
                 AND source_member.alias=$3 AND source_member.enabled AND m.tenant_id=$2)
       OR (EXISTS (SELECT 1 FROM deliveries participant
                   WHERE participant.message_id=m.id AND participant.recipient_tenant=$2
                     AND participant.recipient_alias=$3)
           AND (m.tenant_id=$2 OR EXISTS (SELECT 1 FROM acl_edges edge
                       WHERE edge.from_tenant=$2 AND edge.to_tenant=m.tenant_id
                         AND edge.enabled AND edge.allow_read)))
     ) GROUP BY m.id`, [messageId, actorTenant, actorAlias]
  );
  const row = result.rows[0];
  if (!row) throw new StoreError('not_found', 'message not found or not visible');
  return row;
}

export function messageDetailWithReplies(
  row: MessageDetailRow, view?: SenderView,
): Record<string, unknown> {
  if (view === undefined) return withMessageAuthor(row);
  return {
    ...withMessageAuthor(row), chain_open: view.chainOpen,
    deliveries: row.deliveries.map((delivery) => ({ ...delivery, reply: view.replies.get(delivery.delivery_id) ?? null })),
  };
}
