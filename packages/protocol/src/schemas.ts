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

export const DeliveryStateSchema = z.enum([
  'pending', 'leased', 'accepted', 'started', 'done', 'failed', 'retry', 'dead'
]);
export const LaneSchema = z.enum(['interactive', 'batch']);

export const CorrelationSchema = z.object({
  request_id: RequestIdSchema,
  message_id: MessageIdSchema,
  delivery_id: DeliveryIdSchema.optional(),
  trace_id: TraceIdSchema
}).strict();

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

/** Internal authenticated publish command. Identity and origin are populated by the gateway. */
export const PublishMessageSchema = z.object({
  version: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  request_id: RequestIdSchema,
  trace_id: TraceIdSchema,
  tenant_id: TenantSchema,
  room_id: z.string().min(1).max(128),
  actor_alias: AliasSchema,
  recipients: z.array(RecipientSchema).max(100),
  body: z.record(z.string(), z.unknown()),
  idempotency_key: z.string().min(1).max(200),
  origin: OriginSchema.optional(),
  session_id: z.string().min(1).max(256).optional(),
  channel: z.string().min(1).max(128).optional(),
  authenticated_context: AuthenticatedContextSchema.optional(),
  lane: LaneSchema.default('interactive'),
  priority: z.number().int().min(-100).max(100).default(0)
}).strict();

const ReservedInternalMessageTypes = new Set([
  'agent.message',
  'agent.response',
  'agent.fanin',
  'agent.notify'
]);
const AuthenticatedPublishBodySchema = z.record(z.string(), z.unknown()).superRefine(
  (body, context) => {
    if (typeof body.type === 'string' && ReservedInternalMessageTypes.has(body.type)) {
      context.addIssue({
        code: 'custom',
        path: ['type'],
        message: 'reserved internal message types cannot be published by clients'
      });
    }
  }
);

/** Public HTTP/console payload. It deliberately has no actor, tenant, session, channel or origin fields. */
export const AuthenticatedPublishSchema = z.object({
  room_id: z.string().min(1).max(128),
  recipients: z.array(RecipientSchema).max(100),
  body: AuthenticatedPublishBodySchema,
  idempotency_key: z.string().min(1).max(200),
  lane: LaneSchema.default('interactive'),
  priority: z.number().int().min(-100).max(100).default(0)
}).strict();

/** Proactive egress. An agent never names a chat: it names a logical handle an operator created. */
export const NOTIFY_KINDS = ['task_complete', 'decision_request', 'digest', 'alert'] as const;
export const NotifyKindSchema = z.enum(NOTIFY_KINDS);
export const EgressHandleSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
export const MAX_NOTIFY_BODY_BYTES = 4_096;

/**
 * Public proactive-egress payload. Like AuthenticatedPublishSchema it deliberately
 * has no actor, tenant, session, channel, origin or conversation_id: the only
 * destination a caller can express is a handle that is already on the allowlist.
 */
export const NotifyRequestSchema = z.object({
  destination: EgressHandleSchema,
  kind: NotifyKindSchema,
  body: z.string().min(1).max(MAX_NOTIFY_BODY_BYTES),
  idempotency_key: z.string().min(1).max(200),
  dry_run: z.boolean().default(false)
}).strict();

export const CreateJobSchema = z.object({
  lane: LaneSchema,
  priority: z.number().int().min(-100).max(100),
  kind: z.string().min(1).max(80),
  payload: z.record(z.string(), z.unknown())
}).strict();

const ConfigActionSchema = z.enum(['create', 'update', 'delete']);
const ConfigRevisionSchema = z.number().int().nonnegative();
const OptionalLabelSchema = z.string().trim().min(1).max(128).nullable().optional();

export const TenantConfigMutationSchema = z.object({
  resource: z.literal('tenant'), action: ConfigActionSchema, id: TenantSchema,
  value: z.object({ display_name: OptionalLabelSchema, is_hub: z.boolean().optional(), enabled: z.boolean().optional() }).strict().optional()
}).strict();
export const RoomConfigMutationSchema = z.object({
  resource: z.literal('room'), action: ConfigActionSchema, tenant_id: TenantSchema,
  id: z.string().min(1).max(128),
  value: z.object({ display_name: OptionalLabelSchema, enabled: z.boolean().optional() }).strict().optional()
}).strict();
export const MembershipConfigMutationSchema = z.object({
  resource: z.literal('membership'), action: ConfigActionSchema, tenant_id: TenantSchema,
  room_id: z.string().min(1).max(128), alias: AliasSchema,
  value: z.object({ role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(), enabled: z.boolean().optional() }).strict().optional()
}).strict();
export const AclEdgeConfigMutationSchema = z.object({
  resource: z.literal('acl_edge'), action: ConfigActionSchema,
  from_tenant: TenantSchema, to_tenant: TenantSchema,
  value: z.object({
    enabled: z.boolean().optional(), allow_route: z.boolean().optional(),
    allow_read: z.boolean().optional(), allow_control: z.boolean().optional()
  }).strict().optional()
}).strict();
export const HarnessConfigMutationSchema = z.object({
  resource: z.literal('harness'), action: ConfigActionSchema,
  id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  value: z.object({
    display_name: z.string().trim().min(1).max(128).optional(),
    command: z.string().min(1).max(512).nullable().optional(),
    capabilities: z.array(z.string().min(1).max(80)).max(100).optional(), enabled: z.boolean().optional()
  }).strict().optional()
}).strict();
export const RolePolicyConfigMutationSchema = z.object({
  resource: z.literal('role_policy'), action: ConfigActionSchema,
  role: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/),
  value: z.object({
    allow_route: z.boolean().optional(), allow_read: z.boolean().optional(),
    allow_control: z.boolean().optional(), allow_notify: z.boolean().optional()
  }).strict().optional()
}).strict();
/** The proactive-egress allowlist is versioned configuration, not runtime data. */
export const EgressDestinationConfigMutationSchema = z.object({
  resource: z.literal('egress_destination'), action: ConfigActionSchema,
  tenant_id: TenantSchema, alias: AliasSchema, handle: EgressHandleSchema,
  value: z.object({
    adapter: z.literal('telegram').optional(),
    channel: z.string().min(1).max(128).optional(),
    conversation_id: z.string().regex(/^-?[1-9][0-9]{0,19}$/).optional(),
    conversation_kind: z.enum(['dm', 'group']).optional(),
    display_label: OptionalLabelSchema,
    allow_kinds: z.array(NotifyKindSchema).min(1).max(4).optional(),
    require_prior_contact: z.boolean().optional(),
    contact_ttl_days: z.number().int().min(1).max(3650).optional(),
    min_interval_seconds: z.number().int().min(0).max(86_400).optional(),
    max_per_hour: z.number().int().min(0).max(60).optional(),
    max_per_day: z.number().int().min(0).max(500).optional(),
    max_per_root: z.number().int().min(0).max(20).optional(),
    quiet_hours_start: z.number().int().min(0).max(23).nullable().optional(),
    quiet_hours_end: z.number().int().min(0).max(23).nullable().optional(),
    quiet_hours_tz: z.string().min(1).max(64).optional(),
    enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

/**
 * Chain visibility policy. It is a hub-only singleton: the store reads it once per
 * terminal ACK, so it inherits optimistic revision locking, preview, audit and rollback
 * instead of living in an environment variable or in raw SQL.
 */
export const ChainPolicyConfigMutationSchema = z.object({
  resource: z.literal('chain_policy'), action: z.literal('update'), id: z.literal('default'),
  value: z.object({
    progress_relay_enabled: z.boolean().optional(),
    progress_relay_max_events: z.number().int().min(1).max(64).optional(),
    cycle_cut_enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

export const ConfigMutationSchema = z.discriminatedUnion('resource', [
  TenantConfigMutationSchema, RoomConfigMutationSchema, MembershipConfigMutationSchema,
  AclEdgeConfigMutationSchema, HarnessConfigMutationSchema, RolePolicyConfigMutationSchema,
  ChainPolicyConfigMutationSchema, EgressDestinationConfigMutationSchema
]);
export const ConfigChangeRequestSchema = z.object({
  dry_run: z.boolean().default(true), expected_revision: ConfigRevisionSchema.optional(), mutation: ConfigMutationSchema
}).strict();
export const ConfigRollbackRequestSchema = z.object({
  dry_run: z.boolean().default(true), expected_revision: ConfigRevisionSchema.optional()
}).strict();

export const PublishResultSchema = z.object({
  message_id: MessageIdSchema,
  delivery_ids: z.array(DeliveryIdSchema),
  duplicate: z.boolean(),
  request_id: RequestIdSchema,
  trace_id: TraceIdSchema
}).strict();

export const BaseAckSchema = z.object({
  version: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  status: AckStatusSchema,
  instance_id: z.string().min(1).max(128),
  epoch: z.number().int().positive(),
  retryable: z.boolean().default(false),
  error: z.string().max(2_000).optional(),
  error_code: AckErrorCodeSchema.optional(),
  result: z.record(z.string(), z.unknown()).optional()
}).strict().superRefine((ack, context) => {
  if (ack.retryable && isAmbiguousAckErrorCode(ack.error_code)) {
    context.addIssue({
      code: 'custom',
      path: ['retryable'],
      message: 'Ambiguous ACK errors must not be retryable'
    });
  }
});

/** Every delivery ACK is fenced by the exact claim and delivery attempt. */
export const AckSchema = BaseAckSchema.safeExtend({
  event_id: EventIdSchema,
  claim_token: ClaimTokenSchema,
  attempt: z.number().int().positive()
}).strict();
export const ClaimedAckSchema = AckSchema;

export const HelloSchema = z.object({
  type: z.literal('hello'),
  version: z.literal(PROTOCOL_VERSION),
  tenant_id: TenantSchema,
  alias: AliasSchema,
  instance_id: z.string().min(1).max(128),
  capabilities: z.array(z.string().min(1).max(80)).max(100)
}).strict();

export const HeartbeatSchema = z.object({
  type: z.literal('heartbeat'),
  instance_id: z.string().min(1).max(128),
  epoch: z.number().int().positive()
}).strict();

export const QueryDeliveriesSchema = z.object({
  instance_id: z.string().min(1).max(128),
  epoch: z.number().int().positive(),
  limit: z.number().int().min(1).max(100).default(20)
}).strict();

export const WsAckSchema = AckSchema.safeExtend({
  type: z.literal('ack'),
  delivery_id: DeliveryIdSchema
}).strict();

export const HttpAckSchema = AckSchema.safeExtend({
  delivery_id: DeliveryIdSchema
}).strict();

export const DeliveryEnvelopeSchema = z.object({
  type: z.literal('delivery'),
  version: z.literal(PROTOCOL_VERSION),
  event_id: EventIdSchema,
  delivery_id: DeliveryIdSchema,
  message_id: MessageIdSchema,
  request_id: RequestIdSchema,
  trace_id: TraceIdSchema,
  epoch: z.number().int().positive(),
  attempt: z.number().int().positive(),
  claim_token: ClaimTokenSchema,
  ack_deadline_at: z.iso.datetime({ offset: true }),
  tenant_id: TenantSchema,
  room_id: z.string().min(1).max(128),
  actor_alias: AliasSchema,
  recipient_alias: AliasSchema,
  body: z.record(z.string(), z.unknown()),
  origin: OriginSchema.optional(),
  authenticated_context: AuthenticatedContextSchema.optional(),
  routing_targets: z.array(RoutingTargetSchema).max(100).optional()
}).strict();

export const WsInboundSchema = z.discriminatedUnion('type', [HelloSchema, HeartbeatSchema, WsAckSchema]);

export const WsOutboundSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello_ack'), version: z.literal(PROTOCOL_VERSION),
    epoch: z.number().int().positive(), lease_expires_at: z.iso.datetime({ offset: true })
  }).strict(),
  z.object({
    type: z.literal('takeover_rejected'), reason: z.string(), active_instance_id: z.string(),
    lease_expires_at: z.iso.datetime({ offset: true })
  }).strict(),
  z.object({ type: z.literal('heartbeat_ack'), lease_expires_at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ type: z.literal('wake'), alias: AliasSchema, reason: z.literal('delivery_available') }).strict(),
  DeliveryEnvelopeSchema,
  z.object({
    type: z.literal('ack_result'), event_id: EventIdSchema, delivery_id: DeliveryIdSchema,
    attempt: z.number().int().positive(), claim_token: ClaimTokenSchema,
    status: DeliveryStateSchema, applied: z.boolean(),
    receipt: z.enum(['applied', 'duplicate', 'superseded', 'ownership_lost']).optional()
  }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict()
]);

export type Tenant = z.infer<typeof TenantSchema>;
export type PublishMessage = z.infer<typeof PublishMessageSchema>;
export type AuthenticatedPublish = z.infer<typeof AuthenticatedPublishSchema>;
export type PublishResult = z.infer<typeof PublishResultSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type ClaimedAck = Ack;
export type Hello = z.infer<typeof HelloSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type AuthenticatedContext = z.infer<typeof AuthenticatedContextSchema>;
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
export type DeliveryEnvelope = z.infer<typeof DeliveryEnvelopeSchema>;
export type ConfigMutation = z.infer<typeof ConfigMutationSchema>;
export type NotifyKind = z.infer<typeof NotifyKindSchema>;
export type NotifyRequest = z.infer<typeof NotifyRequestSchema>;
export type ConfigChangeRequest = z.infer<typeof ConfigChangeRequestSchema>;
export type WsInbound = z.infer<typeof WsInboundSchema>;
export type WsOutbound = z.infer<typeof WsOutboundSchema>;
