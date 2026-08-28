import { z } from 'zod';
import {
  AliasSchema,
  CanonicalUuidV4Schema,
  RequestIdSchema,
  Sha256HexSchema,
  TenantSchema,
  TraceIdSchema,
} from './core.js';

export const PublishResultSchema = z.object({
  message_id: CanonicalUuidV4Schema,
  delivery_ids: z.array(CanonicalUuidV4Schema).min(1).max(100),
  duplicate: z.boolean(),
  // A request id is caller-owned and historically includes deterministic UUIDv5 values (Telegram
  // ingress). Durable effect ids are generated here and remain canonical UUIDv4 above.
  request_id: RequestIdSchema,
  trace_id: TraceIdSchema,
  /**
   * Correlacion causal que el publicador ya conoce antes del POST. `request_id` y `trace_id`
   * nacen en el gateway, por lo que un cliente no puede usarlos para distinguir su recibo de
   * otro recibo estructuralmente valido. La clave viaja de vuelta para cerrar ese hueco sin
   * exponer identidad ni contenido del mensaje.
   */
  idempotency_key: z.string().min(1).max(200),
  tenant_id: TenantSchema,
  actor_alias: AliasSchema,
  /** Exact bytes already persisted in idempotency_keys.request_hash. */
  request_hash: Sha256HexSchema,
  /** Canonical binding of request_hash/request identity to message_id and ordered delivery_ids. */
  causal_hash: Sha256HexSchema,
}).strict();

/** A prepare retry either returns the still-open key or the exact durable publish receipt. */
export const ConsolePublishIntentPrepareResultSchema = z.discriminatedUnion('state', [
  z.object({
    version: z.literal(1),
    state: z.literal('prepared'),
    idempotency_key: z.string().min(1).max(200),
    receipt: z.null(),
  }).strict(),
  z.object({
    version: z.literal(1),
    state: z.literal('committed'),
    idempotency_key: z.string().min(1).max(200),
    receipt: PublishResultSchema,
  }).strict(),
]);

export const ConsolePublishIntentReconciliationSchema = z.object({
  version: z.literal(1),
  error: z.literal('publish_intent_reconciliation_required'),
  state: z.literal('committed'),
  idempotency_key: z.string().min(1).max(200),
  receipt: PublishResultSchema,
}).strict();

/** A prepared reservation was closed before it produced an effect; resubmit as a new intent. */
export const ConsolePublishIntentExpiredSchema = z.object({
  version: z.literal(1),
  error: z.literal('publish_intent_expired'),
  state: z.literal('expired'),
  idempotency_key: z.string().min(1).max(200),
  safe_to_resubmit: z.literal(true),
}).strict();

/** Durable per-operator write bound for brand-new intent nonces. */
export const ConsolePublishIntentRateLimitedSchema = z.object({
  version: z.literal(1),
  error: z.literal('publish_intent_rate_limited'),
  retry_after_seconds: z.number().int().min(1).max(86_400),
  safe_to_retry: z.literal(true),
}).strict();

export const ConsolePublishIntentConfirmSchema = z.object({
  idempotency_key: z.string().min(1).max(200),
  message_id: CanonicalUuidV4Schema,
  causal_hash: Sha256HexSchema,
}).strict();

export const ConsolePublishIntentConfirmResultSchema = z.object({
  version: z.literal(1),
  confirmed: z.literal(true),
  idempotency_key: z.string().min(1).max(200),
  message_id: CanonicalUuidV4Schema,
  causal_hash: Sha256HexSchema,
}).strict();
