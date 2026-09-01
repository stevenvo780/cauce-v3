import type {
  ConfirmPublishIntentResult, DurablePublishReceipt, PublishResult,
} from '../../api/types';
import {
  hasExactKeys, isBoundedKey, isCanonicalUuidV4, isLowercaseSha256, isRequestUuid,
} from '../../api/contract-guards';

export type ExactPreparePublishIntentResult =
  | { version: 1; state: 'prepared'; idempotency_key: string; receipt: null }
  | { version: 1; state: 'committed'; idempotency_key: string; receipt: DurablePublishReceipt };

const SUBJECT = /^([A-Za-z][A-Za-z0-9_-]{0,63}):([a-z][a-z0-9_-]{0,63})$/u;
const EXACT_RECEIPT_KEYS = [
  'actor_alias', 'causal_hash', 'delivery_ids', 'duplicate', 'idempotency_key',
  'message_id', 'request_hash', 'request_id', 'tenant_id', 'trace_id',
] as const;
const EXACT_PREPARE_KEYS = ['idempotency_key', 'receipt', 'state', 'version'] as const;
const EXACT_CONFIRM_KEYS = [
  'causal_hash', 'confirmed', 'idempotency_key', 'message_id', 'version',
] as const;

/**
 * Accepts the publish only when the 202 certifies the message AND ALL its durable deliveries.
 * The store keeps the intent journal: the browser does not persist keys, bodies or auth.
 */
export function exactPublishReceipt(
  value: unknown,
  expectedDeliveries: number,
  expectedIdempotencyKey: string,
  expectedSubject: string | null | undefined,
): value is DurablePublishReceipt {
  if (!Number.isSafeInteger(expectedDeliveries) || expectedDeliveries < 1) return false;
  const subject = typeof expectedSubject === 'string' ? SUBJECT.exec(expectedSubject) : null;
  if (!subject || value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as PublishResult;
  if (!hasExactKeys(value, EXACT_RECEIPT_KEYS)
      || !isCanonicalUuidV4(result.message_id)
      || !isRequestUuid(result.request_id)
      || typeof result.trace_id !== 'string'
      || result.trace_id.length < 1
      || result.trace_id.length > 256
      || typeof result.duplicate !== 'boolean'
      || !isBoundedKey(expectedIdempotencyKey)
      || result.idempotency_key !== expectedIdempotencyKey
      || result.tenant_id !== subject[1]
      || result.actor_alias !== subject[2]
      || typeof result.request_hash !== 'string'
      || !isLowercaseSha256(result.request_hash)
      || typeof result.causal_hash !== 'string'
      || !isLowercaseSha256(result.causal_hash)
      || !Array.isArray(result.delivery_ids)
      || result.delivery_ids.length !== expectedDeliveries
      || !result.delivery_ids.every(isCanonicalUuidV4)) return false;
  return new Set(result.delivery_ids).size === result.delivery_ids.length;
}

/** Validates the strict contract that prepares or recovers a durable intent from the server. */
export function exactPreparedPublishIntent(
  value: unknown,
  expectedDeliveries: number,
  expectedSubject: string | null | undefined,
): value is ExactPreparePublishIntentResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !hasExactKeys(value, EXACT_PREPARE_KEYS)) return false;
  const result = value;
  if (result.version !== 1 || !isBoundedKey(result.idempotency_key)) return false;
  if (result.state === 'prepared') return result.receipt === null;
  return result.state === 'committed'
    && exactPublishReceipt(
      result.receipt, expectedDeliveries, result.idempotency_key, expectedSubject,
    );
}

/** Validates that the confirmation matches exactly the receipt the UI just accepted. */
export function exactConfirmedPublishIntent(
  value: unknown,
  receipt: DurablePublishReceipt,
): value is ConfirmPublishIntentResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !hasExactKeys(value, EXACT_CONFIRM_KEYS)) return false;
  const result = value;
  return result.version === 1
    && result.confirmed === true
    && result.idempotency_key === receipt.idempotency_key
    && result.message_id === receipt.message_id
    && result.causal_hash === receipt.causal_hash;
}
