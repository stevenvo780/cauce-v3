import type { DatabaseClient } from '../../db.js';
import { sha256Hex } from '@cauce/protocol';
import { insertClientMailboxDelivery, isClientMailboxAlias } from '../../client-mailbox.js';
import { agentContextReconcileLockKey } from '../agent-context-lock.js';
import { StoreError } from '../errors.js';

export const MESSAGE_INSERT_COLUMNS = [
  'request_id', 'trace_id', 'tenant_id', 'room_id', 'actor_alias', 'body', 'origin', 'lane', 'priority',
  'auth_session_id', 'auth_channel',
] as const;

interface MessageInsert {
  requestId: string;
  traceId: string;
  tenantId: string;
  roomId: string;
  actorAlias: string;
  body: unknown;
  origin: unknown;
  lane: string;
  priority: number;
  authSessionId: string | null;
  authChannel: string | null;
}

interface DeliveryInsert {
  messageId: string;
  recipientTenant: string;
  recipientAlias: string;
  maxAttempts?: number;
}

export function insertMessage(client: DatabaseClient, message: MessageInsert) {
  return client.query<{ id: string }>(
    `INSERT INTO messages(${MESSAGE_INSERT_COLUMNS.join(',')})
     VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11) RETURNING id`,
    [
      message.requestId, message.traceId, message.tenantId, message.roomId, message.actorAlias,
      JSON.stringify(message.body), message.origin === null ? null : JSON.stringify(message.origin),
      message.lane, message.priority, message.authSessionId, message.authChannel,
    ],
  );
}

export async function insertDelivery(client: DatabaseClient, delivery: DeliveryInsert) {
  if (isClientMailboxAlias(delivery.recipientAlias)) {
    const row = await insertClientMailboxDelivery(client, delivery.messageId, delivery.recipientTenant, delivery.recipientAlias);
    return { rows: [row] };
  }
  // Internal producers may already hold delivery or membership rows, so never wait on a later context fence.
  const lock = (await client.query<{ acquired: boolean }>(
    'SELECT pg_try_advisory_xact_lock_shared(hashtextextended($1,0)) AS acquired',
    [agentContextReconcileLockKey(delivery.recipientTenant, delivery.recipientAlias)],
  )).rows[0];
  if (lock?.acquired !== true) throw new StoreError('conflict', 'recipient context is being reconciled; retry the delivery');
  const maintenance = await client.query(`SELECT 1 FROM fleet_operations operation WHERE operation.target_key=$1
    AND operation.desired_revision IS NOT NULL AND operation.status NOT IN ('cancelled','succeeded')
    AND EXISTS (SELECT 1 FROM fleet_operation_events origin WHERE origin.operation_id=operation.id
      AND origin.event='queued' AND origin.metadata ? 'maintenance') LIMIT 1`,
  [sha256Hex({ resource: 'agent', tenant_id: delivery.recipientTenant, alias: delivery.recipientAlias })]);
  if (maintenance.rowCount) throw new StoreError('conflict', 'recipient runtime maintenance is prepared; retry after admission');
  if (delivery.maxAttempts === undefined) {
    return client.query<{ id: string }>(
      'INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,$2,$3) RETURNING id',
      [delivery.messageId, delivery.recipientTenant, delivery.recipientAlias],
    );
  }
  return client.query<{ id: string }>(
    'INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias,max_attempts) VALUES($1,$2,$3,$4) RETURNING id',
    [delivery.messageId, delivery.recipientTenant, delivery.recipientAlias, delivery.maxAttempts],
  );
}
