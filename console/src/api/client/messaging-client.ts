import type {
  CancelResult,
  ConfirmPublishIntentInput,
  ConfirmPublishIntentResult,
  DlqPage,
  MessageDetail,
  MessagePage,
  OriginRelayPage,
  PreparePublishIntentInput,
  PreparePublishIntentResult,
  PublishMessageInput,
  PublishResult,
  QueueSnapshot,
  ReplayResult,
  ResolveDlqWithoutReplayInput,
  ResolveDlqWithoutReplayResult,
} from '../types';
import {
  expirationBody,
  rateLimitBody,
  reconciliationBody,
  PublishIntentExpiredError,
  PublishIntentRateLimitedError,
  PublishIntentReconciliationError,
} from './core';
import type { RequestFn } from './system-client';

export function listMessages(request: RequestFn): Promise<MessagePage> {
  return request('/v3/console/messages');
}

export function getMessage(request: RequestFn, messageId: string): Promise<MessageDetail> {
  return request(`/v3/console/messages/${encodeURIComponent(messageId)}`);
}

export function publishMessage(request: RequestFn, input: PublishMessageInput): Promise<PublishResult> {
  const payload: PublishMessageInput = {
    room_id: input.room_id,
    recipients: input.recipients.map(({ tenant_id, alias }) => ({ tenant_id, alias })),
    body: { text: input.body.text },
    lane: input.lane,
    priority: input.priority,
    idempotency_key: input.idempotency_key,
  };
  return request('/v3/console/messages', {
    method: 'POST', body: JSON.stringify(payload),
  }, {
    mapError: (status, body) => {
      if (status !== 410) return undefined;
      const expiration = expirationBody(body);
      return expiration === undefined ? undefined : new PublishIntentExpiredError(expiration);
    },
  });
}

export function preparePublishIntent(request: RequestFn, input: PreparePublishIntentInput): Promise<PreparePublishIntentResult> {
  const payload: PreparePublishIntentInput = {
    room_id: input.room_id,
    recipients: input.recipients.map(({ tenant_id, alias }) => ({ tenant_id, alias })),
    body: { text: input.body.text },
    lane: input.lane,
    priority: input.priority,
    intent_nonce: input.intent_nonce,
  };
  return request('/v3/console/publish-intents', {
    method: 'POST', body: JSON.stringify(payload),
  }, {
    mapError: (status, body) => {
      if (status === 409) {
        const reconciliation = reconciliationBody(body);
        return reconciliation === undefined
          ? undefined
          : new PublishIntentReconciliationError(reconciliation);
      }
      if (status === 429) {
        const rateLimit = rateLimitBody(body);
        return rateLimit === undefined ? undefined : new PublishIntentRateLimitedError(rateLimit);
      }
      return undefined;
    },
  });
}

export function confirmPublishIntent(request: RequestFn, input: ConfirmPublishIntentInput): Promise<ConfirmPublishIntentResult> {
  const payload: ConfirmPublishIntentInput = {
    idempotency_key: input.idempotency_key,
    message_id: input.message_id,
    causal_hash: input.causal_hash,
  };
  return request('/v3/console/publish-intents/confirm', {
    method: 'POST', body: JSON.stringify(payload),
  });
}

export function getQueues(request: RequestFn): Promise<QueueSnapshot> {
  return request('/v3/console/queues');
}

export function getDlq(request: RequestFn, limit = 200, cursor?: string, signal?: AbortSignal): Promise<DlqPage> {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
    throw new RangeError('DLQ limit must be an integer between 1 and 500');
  }
  if (cursor !== undefined && (
    cursor.length < 2 || cursor.length > 1_024 || cursor.length % 2 !== 0
    || !/^[a-f0-9]+$/u.test(cursor)
  )) {
    throw new RangeError('DLQ cursor must be a bounded lower-case hexadecimal token');
  }
  const query = new URLSearchParams({ limit: String(limit) });
  if (cursor !== undefined) query.set('cursor', cursor);
  return request(`/v3/console/dlq?${query.toString()}`, { signal });
}

export function resolveDlqWithoutReplay(request: RequestFn, input: ResolveDlqWithoutReplayInput): Promise<ResolveDlqWithoutReplayResult> {
  const target = encodeURIComponent(input.target);
  const id = encodeURIComponent(input.id);
  return request(`/v3/console/dlq/${target}/${id}/resolve-without-replay`, {
    method: 'POST',
    body: JSON.stringify({
      evidence_sha256: input.evidenceSha256,
      reason: input.reason,
      possible_duplicate_acknowledged: input.possibleDuplicateAcknowledged,
      possible_no_delivery_acknowledged: input.possibleNoDeliveryAcknowledged,
    }),
  });
}

export function replayDelivery(request: RequestFn, deliveryId: string): Promise<ReplayResult> {
  const encoded = encodeURIComponent(deliveryId);
  return request(`/v3/console/deliveries/${encoded}/replay`, {
    method: 'POST',
    body: '{}',
  });
}

export function cancelDelivery(request: RequestFn, deliveryId: string, reason?: string): Promise<CancelResult> {
  const encoded = encodeURIComponent(deliveryId);
  return request(`/v3/console/deliveries/${encoded}/cancel`, {
    method: 'POST',
    body: JSON.stringify(reason === undefined ? {} : { reason }),
  });
}

export function listOriginRelays(request: RequestFn): Promise<OriginRelayPage> {
  return request('/v3/console/origin-relays');
}

export interface MessagingClient {
  listMessages(): Promise<MessagePage>;
  getMessage(messageId: string): Promise<MessageDetail>;
  publishMessage(input: PublishMessageInput): Promise<PublishResult>;
  preparePublishIntent(input: PreparePublishIntentInput): Promise<PreparePublishIntentResult>;
  confirmPublishIntent(input: ConfirmPublishIntentInput): Promise<ConfirmPublishIntentResult>;
  getQueues(): Promise<QueueSnapshot>;
  getDlq(limit?: number, cursor?: string, signal?: AbortSignal): Promise<DlqPage>;
  resolveDlqWithoutReplay(input: ResolveDlqWithoutReplayInput): Promise<ResolveDlqWithoutReplayResult>;
  replayDelivery(deliveryId: string): Promise<ReplayResult>;
  cancelDelivery(deliveryId: string, reason?: string): Promise<CancelResult>;
  listOriginRelays(): Promise<OriginRelayPage>;
}

export function messagingClient(request: RequestFn): MessagingClient {
  return {
    listMessages: () => listMessages(request),
    getMessage: (messageId) => getMessage(request, messageId),
    publishMessage: (input) => publishMessage(request, input),
    preparePublishIntent: (input) => preparePublishIntent(request, input),
    confirmPublishIntent: (input) => confirmPublishIntent(request, input),
    getQueues: () => getQueues(request),
    getDlq: (limit, cursor, signal) => getDlq(request, limit, cursor, signal),
    resolveDlqWithoutReplay: (input) => resolveDlqWithoutReplay(request, input),
    replayDelivery: (deliveryId) => replayDelivery(request, deliveryId),
    cancelDelivery: (deliveryId, reason) => cancelDelivery(request, deliveryId, reason),
    listOriginRelays: () => listOriginRelays(request),
  };
}
