import type { PublishMessage, Tenant } from '@cauce/protocol';
import {
  OriginSchema,
  PublishMessageSchema,
  PublishResultSchema,
  buildPublishReceipt,
  consolePublishIntentSemanticHash,
  publishReceiptCausalHash,
  publishRequestHash,
} from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { canonicallyEqual, consolePublishConversationHash } from '../config.js';
import { StoreError } from '../errors.js';
import type { PublishResult } from './contracts.js';

interface DurablePublishedMessage {
  id: string;
  version: string;
  request_id: string;
  trace_id: string;
  tenant_id: string;
  room_id: string;
  actor_alias: string;
  body: unknown;
  origin: unknown;
  lane: string;
  priority: number;
  auth_session_id: string | null;
  auth_channel: string | null;
}

interface DurablePublishedDelivery {
  id: string;
  recipient_tenant: string;
  recipient_alias: string;
}

const legacyPublishReceiptKeys = new Set([
  'message_id', 'delivery_ids', 'duplicate', 'request_id', 'trace_id',
  'idempotency_key', 'tenant_id', 'actor_alias', 'request_hash', 'causal_hash',
]);

const legacyPublishReceiptRequiredKeys = [
  'message_id', 'delivery_ids', 'duplicate', 'request_id', 'trace_id',
] as const;

// Message and delivery rows are the durable effect; stored JSON is only a consistency witness.
// Reconstructing on replay upgrades old receipts without inserting another message.
export async function reconstructPublishReceipt(
  client: DatabaseClient,
  input: PublishMessage,
  messageId: string,
  requestHash: string,
  storedResponse: unknown,
): Promise<PublishResult> {
  const messageResult = await client.query<DurablePublishedMessage>(
    `SELECT id,version,request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
            auth_session_id,auth_channel
       FROM messages WHERE id=$1 FOR SHARE`,
    [messageId],
  );
  const message = messageResult.rows[0];
  const authenticated = input.authenticated_context;
  const expectedOrigin = authenticated?.origin ?? input.origin ?? null;
  const expectedSession = authenticated?.session_id ?? input.session_id ?? null;
  const expectedChannel = authenticated?.channel ?? input.channel ?? null;
  if (messageResult.rowCount !== 1 || !message
      || message.id !== messageId
      || message.version !== input.version
      || message.tenant_id !== input.tenant_id
      || message.room_id !== input.room_id
      || message.actor_alias !== input.actor_alias
      || message.lane !== input.lane
      || message.priority !== input.priority
      || message.auth_session_id !== expectedSession
      || message.auth_channel !== expectedChannel
      || !canonicallyEqual(message.body, input.body)
      || !canonicallyEqual(message.origin, expectedOrigin)) {
    throw new StoreError('conflict', 'idempotent publish durable message differs from its request');
  }

  const deliveryResult = await client.query<DurablePublishedDelivery>(
    `SELECT id,recipient_tenant,recipient_alias FROM deliveries WHERE message_id=$1 FOR SHARE`,
    [messageId],
  );
  const byRecipient = new Map<string, string>();
  for (const row of deliveryResult.rows) {
    const key = `${row.recipient_tenant}\u0000${row.recipient_alias}`;
    if (byRecipient.has(key)) {
      throw new StoreError('conflict', 'idempotent publish has duplicate durable recipients');
    }
    byRecipient.set(key, row.id);
  }
  const deliveryIds = input.recipients.map((recipient) => (
    byRecipient.get(`${recipient.tenant_id}\u0000${recipient.alias}`)
  ));
  if (deliveryResult.rowCount !== input.recipients.length
      || deliveryIds.some((deliveryId) => deliveryId === undefined)) {
    throw new StoreError('conflict', 'idempotent publish deliveries differ from its request');
  }

  const receipt = buildPublishReceipt(input, {
    message_id: message.id,
    delivery_ids: deliveryIds as string[],
    duplicate: false,
    request_id: message.request_id,
    trace_id: message.trace_id,
  });
  const parsed = PublishResultSchema.safeParse(receipt);
  if (!parsed.success) {
    throw new StoreError('conflict', 'idempotent publish durable effect is not canonical');
  }

  if (storedResponse === null || typeof storedResponse !== 'object' || Array.isArray(storedResponse)) {
    throw new StoreError('conflict', 'idempotent publish has no durable historical receipt');
  }
  const historical = storedResponse as Record<string, unknown>;
  const keys = Object.keys(historical);
  if (keys.some((key) => !legacyPublishReceiptKeys.has(key))
      || legacyPublishReceiptRequiredKeys.some((key) => !Object.hasOwn(historical, key))
      || historical.message_id !== parsed.data.message_id
      || historical.request_id !== parsed.data.request_id
      || historical.trace_id !== parsed.data.trace_id
      || historical.duplicate !== false
      || !Array.isArray(historical.delivery_ids)
      || historical.delivery_ids.length !== parsed.data.delivery_ids.length
      || historical.delivery_ids.some((value, index) => value !== parsed.data.delivery_ids[index])
      || (Object.hasOwn(historical, 'idempotency_key')
        && historical.idempotency_key !== parsed.data.idempotency_key)
      || (Object.hasOwn(historical, 'tenant_id') && historical.tenant_id !== parsed.data.tenant_id)
      || (Object.hasOwn(historical, 'actor_alias') && historical.actor_alias !== parsed.data.actor_alias)
      || (Object.hasOwn(historical, 'request_hash') && historical.request_hash !== requestHash)
      || (Object.hasOwn(historical, 'causal_hash')
        && historical.causal_hash !== parsed.data.causal_hash)) {
    throw new StoreError('conflict', 'historical publish receipt differs from its durable effect');
  }
  return parsed.data;
}

export async function reconstructCommittedConsoleIntentReceipt(
  client: DatabaseClient,
  expected: {
    tenant_id: Tenant;
    actor_alias: string;
    idempotency_key: string;
    semantic_hash: string;
    conversation_hash: string;
  },
  durable: { request_hash: string; response: unknown; message_id: string },
): Promise<PublishResult> {
  const storedReceipt = PublishResultSchema.safeParse(durable.response);
  if (!storedReceipt.success
      || storedReceipt.data.duplicate
      || storedReceipt.data.tenant_id !== expected.tenant_id
      || storedReceipt.data.actor_alias !== expected.actor_alias
      || storedReceipt.data.idempotency_key !== expected.idempotency_key
      || storedReceipt.data.message_id !== durable.message_id
      || storedReceipt.data.request_hash !== durable.request_hash
      || publishReceiptCausalHash(storedReceipt.data) !== storedReceipt.data.causal_hash) {
    throw new StoreError('conflict', 'committed console publish receipt is invalid');
  }
  const messageResult = await client.query<DurablePublishedMessage>(
    `SELECT id,version,request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
            auth_session_id,auth_channel
       FROM messages WHERE id=$1 FOR SHARE`,
    [durable.message_id],
  );
  const message = messageResult.rows[0];
  if (messageResult.rowCount !== 1 || message === undefined
      || message.auth_session_id === null || message.auth_channel === null) {
    throw new StoreError('conflict', 'committed console publish auth context is unavailable');
  }
  const origin = message.origin === null ? undefined : OriginSchema.safeParse(message.origin);
  if (origin !== undefined && !origin.success) {
    throw new StoreError('conflict', 'committed console publish origin is invalid');
  }
  const deliveryResult = await client.query<DurablePublishedDelivery>(
    `SELECT id,recipient_tenant,recipient_alias
       FROM deliveries WHERE message_id=$1 FOR SHARE`,
    [durable.message_id],
  );
  const deliveriesById = new Map(deliveryResult.rows.map((delivery) => [delivery.id, delivery]));
  if (deliveryResult.rowCount !== storedReceipt.data.delivery_ids.length
      || deliveriesById.size !== deliveryResult.rowCount) {
    throw new StoreError('conflict', 'committed console publish deliveries are inconsistent');
  }
  const recipients = storedReceipt.data.delivery_ids.map((deliveryId) => {
    const delivery = deliveriesById.get(deliveryId);
    if (delivery === undefined) {
      throw new StoreError('conflict', 'committed console publish receipt names an alien delivery');
    }
    return { tenant_id: delivery.recipient_tenant, alias: delivery.recipient_alias };
  });
  const originalCommand = PublishMessageSchema.safeParse({
    version: message.version,
    request_id: message.request_id,
    trace_id: message.trace_id,
    tenant_id: message.tenant_id,
    room_id: message.room_id,
    actor_alias: message.actor_alias,
    recipients,
    body: message.body,
    idempotency_key: expected.idempotency_key,
    lane: message.lane,
    priority: message.priority,
    authenticated_context: {
      session_id: message.auth_session_id,
      channel: message.auth_channel,
      ...(origin === undefined ? {} : { origin: origin.data }),
    },
  });
  if (!originalCommand.success
      || consolePublishIntentSemanticHash(originalCommand.data) !== expected.semantic_hash
      || consolePublishConversationHash(originalCommand.data) !== expected.conversation_hash) {
    throw new StoreError('conflict', 'committed console publish semantic effect is inconsistent');
  }
  const requestHash = publishRequestHash(originalCommand.data);
  if (durable.request_hash !== requestHash) {
    throw new StoreError('conflict', 'committed console publish request hash is inconsistent');
  }
  const reconstructed = await reconstructPublishReceipt(
    client,
    originalCommand.data,
    durable.message_id,
    requestHash,
    durable.response,
  );
  if (!canonicallyEqual(reconstructed, storedReceipt.data)) {
    throw new StoreError('conflict', 'committed console publish receipt differs from durable rows');
  }
  return reconstructed;
}
