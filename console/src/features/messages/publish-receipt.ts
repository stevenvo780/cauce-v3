import type {
  ConfirmPublishIntentResult, DurablePublishReceipt, PublishResult,
} from '../../api/types';

export type ExactPreparePublishIntentResult =
  | { version: 1; state: 'prepared'; idempotency_key: string; receipt: null }
  | { version: 1; state: 'committed'; idempotency_key: string; receipt: DurablePublishReceipt };

const CANONICAL_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
// Request ids are caller-owned and historically include deterministic UUIDv5 values. Durable
// effect ids remain canonical UUIDv4 and are checked separately below.
const REQUEST_UUID = /^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const SUBJECT = /^([A-Za-z][A-Za-z0-9_-]{0,63}):([a-z][a-z0-9_-]{0,63})$/u;
const EXACT_RECEIPT_KEYS = [
  'actor_alias', 'causal_hash', 'delivery_ids', 'duplicate', 'idempotency_key',
  'message_id', 'request_hash', 'request_id', 'tenant_id', 'trace_id',
] as const;
const EXACT_PREPARE_KEYS = ['idempotency_key', 'receipt', 'state', 'version'] as const;
const EXACT_CONFIRM_KEYS = [
  'causal_hash', 'confirmed', 'idempotency_key', 'message_id', 'version',
] as const;

function exactKeys(value: object, expected: readonly string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === expected[index]);
}

function canonicalUuidV4(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_UUID_V4.test(value);
}

function requestUuid(value: unknown): value is string {
  return typeof value === 'string' && REQUEST_UUID.test(value);
}

function validIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && value.length >= 1 && value.length <= 200;
}

/**
 * Acepta el publish sólo cuando el 202 acredita el mensaje y TODAS sus entregas durables.
 * El store conserva el journal de intención: el navegador no persiste claves, cuerpos ni auth.
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
  if (!exactKeys(value, EXACT_RECEIPT_KEYS)
      || !canonicalUuidV4(result.message_id)
      || !requestUuid(result.request_id)
      || typeof result.trace_id !== 'string'
      || result.trace_id.length < 1
      || result.trace_id.length > 256
      || typeof result.duplicate !== 'boolean'
      || !validIdempotencyKey(expectedIdempotencyKey)
      || result.idempotency_key !== expectedIdempotencyKey
      || result.tenant_id !== subject[1]
      || result.actor_alias !== subject[2]
      || typeof result.request_hash !== 'string'
      || !SHA256.test(result.request_hash)
      || typeof result.causal_hash !== 'string'
      || !SHA256.test(result.causal_hash)
      || !Array.isArray(result.delivery_ids)
      || result.delivery_ids.length !== expectedDeliveries
      || !result.delivery_ids.every(canonicalUuidV4)) return false;
  return new Set(result.delivery_ids).size === result.delivery_ids.length;
}

/** Valida el contrato estricto que prepara o recupera una intención durable del servidor. */
export function exactPreparedPublishIntent(
  value: unknown,
  expectedDeliveries: number,
  expectedSubject: string | null | undefined,
): value is ExactPreparePublishIntentResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !exactKeys(value, EXACT_PREPARE_KEYS)) return false;
  const result = value as Record<string, unknown>;
  if (result.version !== 1 || !validIdempotencyKey(result.idempotency_key)) return false;
  if (result.state === 'prepared') return result.receipt === null;
  return result.state === 'committed'
    && exactPublishReceipt(
      result.receipt, expectedDeliveries, result.idempotency_key, expectedSubject,
    );
}

/** Valida que la confirmación corresponde exactamente al recibo que acaba de aceptar la UI. */
export function exactConfirmedPublishIntent(
  value: unknown,
  receipt: DurablePublishReceipt,
): value is ConfirmPublishIntentResult {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
      || !exactKeys(value, EXACT_CONFIRM_KEYS)) return false;
  const result = value as Record<string, unknown>;
  return result.version === 1
    && result.confirmed === true
    && result.idempotency_key === receipt.idempotency_key
    && result.message_id === receipt.message_id
    && result.causal_hash === receipt.causal_hash;
}
