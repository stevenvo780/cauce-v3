import { z } from 'zod';

export const PROTOCOL_VERSION = '3.0' as const;

/** Tenant identifiers are provisioned in PostgreSQL; the wire contract only constrains their shape. */
export const TenantSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/);
export const AliasSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);
export const MessageIdSchema = z.uuid();
export const RequestIdSchema = z.uuid();
export const DeliveryIdSchema = z.uuid();
export const EventIdSchema = z.uuid();
export const ClaimTokenSchema = z.uuid();
export const TraceIdSchema = z.string().min(1).max(256);
export const CanonicalUuidV4Schema = z.string().regex(
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
);
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/u);
export const AckStatusSchema = z.enum(['accepted', 'started', 'done', 'failed']);
export const AckErrorCodeSchema = z.string().regex(/^[A-Z][A-Z0-9_]{0,127}$/);
export const AMBIGUOUS_ACK_ERROR_CODES = [
  'EXECUTION_TIMEOUT_AMBIGUOUS',
  'EXECUTION_CANCELLED_AMBIGUOUS',
  'OUTPUT_LIMIT_AMBIGUOUS',
  'PROCESS_EXIT_AMBIGUOUS',
  'OPENCLAW_OUTPUT_LIMIT_AMBIGUOUS',
  'OPENCLAW_HTTP_AMBIGUOUS',
  'OPENCLAW_API_AMBIGUOUS',
  'INTERRUPTED_AMBIGUOUS'
] as const;
export const AmbiguousAckErrorCodeSchema = z.enum(AMBIGUOUS_ACK_ERROR_CODES);
export type AmbiguousAckErrorCode = z.infer<typeof AmbiguousAckErrorCodeSchema>;

export function isAmbiguousAckErrorCode(code: unknown): code is AmbiguousAckErrorCode {
  return AmbiguousAckErrorCodeSchema.safeParse(code).success;
}

/** Cap on the per-alias declared role (`agents.role_brief`), measured in UTF-32 code points. */
export const ROLE_BRIEF_MAX_CODE_POINTS = 1200;

/** Length of a text in code points. */
export function countCodePoints(text: string): number {
  return [...text].length;
}

/** Truncates a text to ROLE_BRIEF_MAX_CODE_POINTS code points without splitting surrogate pairs. */
export function clampToRoleBriefLimit(text: string): string {
  const codePoints = [...text];
  return codePoints.length <= ROLE_BRIEF_MAX_CODE_POINTS
    ? text
    : codePoints.slice(0, ROLE_BRIEF_MAX_CODE_POINTS).join('');
}

export const DeliveryStateSchema = z.enum([
  'pending', 'leased', 'accepted', 'started', 'done', 'failed', 'retry', 'dead'
]);
export const LaneSchema = z.enum(['interactive', 'batch']);

export const RelayHopSchema = z.object({
  tenant_id: TenantSchema,
  alias: AliasSchema,
  adapter: z.string().min(1).max(64).optional(),
  relayed_at: z.iso.datetime({ offset: true })
}).strict();

/** Immutable return route. It is copied to messages and terminal outbox events. */
export const OriginSchema = z.object({
  adapter: z.string().min(1).max(64),
  channel: z.string().min(1).max(128),
  conversation_id: z.string().min(1).max(256),
  external_message_id: z.string().min(1).max(256).optional(),
  relay: z.array(RelayHopSchema).max(32).default([]),
  metadata: z.record(z.string(), z.unknown()).default({})
}).strict();

/** Authentication facts supplied by a trusted gateway, never by a public publish payload. */
export const AuthenticatedContextSchema = z.object({
  session_id: z.string().min(1).max(256),
  channel: z.string().min(1).max(128),
  origin: OriginSchema.optional()
}).strict();

export const RecipientSchema = z.object({
  tenant_id: TenantSchema,
  alias: AliasSchema
}).strict();

/** Trusted routing inventory derived by the store for the current delivery consumer. */
export const RoutingTargetSchema = RecipientSchema.extend({
  online: z.boolean()
}).strict();
