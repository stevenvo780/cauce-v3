import type { DatabaseClient } from '../../db.js';

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

export function insertDelivery(client: DatabaseClient, delivery: DeliveryInsert) {
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
