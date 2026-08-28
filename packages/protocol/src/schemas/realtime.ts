import { z } from 'zod';
import {
  AckErrorCodeSchema,
  AckStatusSchema,
  AliasSchema,
  AuthenticatedContextSchema,
  ClaimTokenSchema,
  countCodePoints,
  DeliveryIdSchema,
  DeliveryStateSchema,
  EventIdSchema,
  isAmbiguousAckErrorCode,
  MessageIdSchema,
  OriginSchema,
  PROTOCOL_VERSION,
  RequestIdSchema,
  ROLE_BRIEF_MAX_CODE_POINTS,
  RoutingTargetSchema,
  Sha256HexSchema,
  TenantSchema,
  TraceIdSchema,
} from './core.js';
import { MessageBodySchema } from './messages.js';

export const BaseAckSchema = z.object({
  version: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  status: AckStatusSchema,
  instance_id: z.string().min(1).max(128),
  epoch: z.number().int().positive(),
  retryable: z.boolean().default(false),
  /**
   * The adapter durably committed to invoking the harness, not only admitted the delivery.
   *
   * It is needed because the `started` ACK does NOT prove execution: the SDK emits it inside
   * `handleDelivery` before calling the harness, and in between the delivery can sit for minutes waiting
   * on the session lock without spending a cent. The reaper used that signal to decide whether an expired
   * claim could have had effects; plain `started` sent to `dead` work that never ran — work lost forever.
   *
   * The new SDK fsyncs it after taking the reservation and waits for the exact receipt before invoking. A
   * later crash may have executed, which is why automatic retry is no longer admitted.
   *
   * OPTIONAL on purpose. An older adapter never sends it; without the flag, the reaper falls back to the
   * usual retry. The error falls on the expensive side (paying twice), never on the side that loses work.
   */
  execution_started: z.boolean().optional(),
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

/**
 * Exact runtime files which a real harness turn must have consumed before a profile revision can
 * be called applied.  Paths and hashes are evidence, not instructions; the gateway only adds the
 * contract to adapters which explicitly advertise `agent_profile_adoption_v1`.
 */
export const ProfileRuntimeDocumentSchema = z.object({
  name: z.string().min(1).max(128).regex(/^[A-Za-z0-9._-]+$/u),
  path: z.string().min(1).max(4_096).refine((path) => path.startsWith('/') && !path.includes('\0'), {
    message: 'profile runtime document path must be absolute',
  }),
  sha: Sha256HexSchema,
}).strict().refine(
  (document) => document.path.slice(document.path.lastIndexOf('/') + 1) === document.name,
  { path: ['path'], message: 'profile runtime document name must match the path basename' },
);

const ProfileRuntimeDocumentsSchema = z.array(ProfileRuntimeDocumentSchema).min(1).max(7)
  .superRefine((documents, context) => {
    const names = new Set<string>();
    const paths = new Set<string>();
    documents.forEach((document, index) => {
      if (names.has(document.name)) {
        context.addIssue({
          code: 'custom', path: [index, 'name'], message: 'profile runtime document names must be unique',
        });
      }
      if (paths.has(document.path)) {
        context.addIssue({
          code: 'custom', path: [index, 'path'], message: 'profile runtime document paths must be unique',
        });
      }
      names.add(document.name);
      paths.add(document.path);
    });
  });

export const ProfileRuntimeContractSchema = z.object({
  revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  /** Opaque container generation measured by the terminal plane. */
  generation: z.string().min(1).max(128),
  documents: ProfileRuntimeDocumentsSchema,
}).strict();

/** Evidence produced locally by the adapter after a real harness result, never by model stdout. */
export const ProfileRuntimeAdoptionEvidenceSchema = ProfileRuntimeContractSchema.safeExtend({
  evidence: z.literal('adapter_delivery'),
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
  body: MessageBodySchema,
  origin: OriginSchema.optional(),
  authenticated_context: AuthenticatedContextSchema.optional(),
  routing_targets: z.array(RoutingTargetSchema).max(100).optional(),
  // Recipient's declared role (agents.role_brief). The adapter prepends it to the contract as an identity
  // preamble. Optional and behind the `agent_identity_v1` capability for the same reason as routing_targets:
  // this schema is .strict(), so an adapter from an earlier image would REJECT the entire envelope if the
  // store sent it a field it does not know, and would be unable to consume any delivery. The cap mirrors
  // the CHECK from migration 020 via `ROLE_BRIEF_MAX_CODE_POINTS`.
  //
  // DO NOT USE `.max(ROLE_BRIEF_MAX_CODE_POINTS)`: zod's `.max()` counts UTF-16 units and the Postgres
  // column counts code points. A brief of 1200 code points with emoji measures 1300 in UTF-16: the store
  // accepts it, the CHECK accepts it, the screen says "saved"... and on the next delivery
  // `WsOutboundSchema.parse()` rejects the ENTIRE envelope because of this field. The alias stops receiving
  // and nobody sees an error. That is why we count with `countCodePoints`, and that is why the message
  // says how many code points were sent: if it ever fails again, the error number must be the one the
  // database counts, not UTF-16's. `.min(1)` can stay: at the empty boundary the two units agree.
  self_role: z.string().min(1).superRefine((text, ctx) => {
    const codePoints = countCodePoints(text);
    if (codePoints <= ROLE_BRIEF_MAX_CODE_POINTS) return;
    ctx.addIssue({
      code: 'custom',
      message: `self_role admits ${ROLE_BRIEF_MAX_CODE_POINTS} code points at most; ${codePoints} were sent`
    });
  }).optional(),
  /**
   * Desired profile revision and exact live files for this runtime generation. Optional and sent
   * only behind `agent_profile_adoption_v1`; old strict adapters must never see it.
   */
  profile_runtime_contract: ProfileRuntimeContractSchema.optional(),
}).strict();

/**
 * Durable vocabulary for why a `messages` output did NOT become a delegation.
 *
 * It lives here and not in the store that produces it because it travels in the `ack_result`
 * frame: the adapter must be able to validate it without depending on `@cauce/store`. The store's
 * `DelegationRejectionCode` is DERIVED from this list, so adding a code there without adding it
 * here does not compile — which is exactly the drift that left the frame outside the schema the
 * first time.
 */
export const DELEGATION_REJECTION_CODES = [
  'invalid_output',
  'unroutable_alias',
  'ambiguous_alias',
  'hop_budget_exhausted',
  'cycle_detected',
  'fanout_exceeded',
  'edge_repeat_exceeded',
  'root_budget_exhausted',
  'chain_gated',
  'human_gate_opened'
] as const;

/**
 * The rejected destination is text from the AGENT, not a validated alias: `unroutable_alias`
 * exists precisely for the `to` that does not route, and `agentOutputEntries` copies it as-is.
 * That is why it is NOT `AliasSchema` and why the store trims it to this length before putting
 * it in the frame: a cap smaller than what the producer can emit would tear down the whole
 * connection again.
 */
export const MAX_DELEGATION_REJECTION_TARGET_CHARS = 256;

/**
 * `reason` of `chain_gated` embeds the gate's question, which the database caps at 8 KiB. The
 * cap must stay ABOVE that with room to spare, or the longest rejection the store knows how to
 * generate would not pass its own schema.
 */
export const MAX_DELEGATION_REJECTION_REASON_CHARS = 12_000;

/**
 * Wire and durable replay share one hard ceiling. Producers must reject an oversized fan-out
 * before writing any child row; consumers must never silently truncate a durable receipt.
 */
export const MAX_DELEGATION_FEEDBACK_ITEMS = 1_000;

export const DelegationRejectionSchema = z.object({
  code: z.enum(DELEGATION_REJECTION_CODES),
  reason: z.string().min(1).max(MAX_DELEGATION_REJECTION_REASON_CHARS),
  guidance: z.string().min(1).max(2_000),
  /**
   * Index of the rejected output. The `@all` expansion deliberately shifts it
   * (`maxAgentOutputMessages + index*100 + targetIndex`), so there is no ceiling here: it only
   * has to be a non-negative integer.
   */
  output_index: z.number().int().min(0),
  target: z.string().min(1).max(MAX_DELEGATION_REJECTION_TARGET_CHARS).optional()
}).strict();

/**
 * Exact branch identity materialized from one StructuredOutput.messages entry.
 *
 * Bodies and hashes deliberately stay server-side. The adapter only needs the stable output
 * index, authorized destination pair and child delivery id to correlate later agent.response
 * frames without collapsing two branches sent to the same alias.
 */
export const DelegationMaterializationSchema = z.object({
  output_index: z.number().int().min(0),
  target_tenant: TenantSchema,
  target_alias: AliasSchema,
  child_delivery_id: DeliveryIdSchema
}).strict();

export const DelegationMaterializationsSchema = z.array(DelegationMaterializationSchema)
  .max(MAX_DELEGATION_FEEDBACK_ITEMS)
  .superRefine((items, context) => {
    const outputIndexes = new Set<number>();
    const childDeliveries = new Set<string>();
    items.forEach((item, index) => {
      if (outputIndexes.has(item.output_index)) {
        context.addIssue({
          code: 'custom',
          message: 'delegation output_index values must be unique',
          path: [index, 'output_index']
        });
      }
      if (childDeliveries.has(item.child_delivery_id)) {
        context.addIssue({
          code: 'custom',
          message: 'delegation child_delivery_id values must be unique',
          path: [index, 'child_delivery_id']
        });
      }
      outputIndexes.add(item.output_index);
      childDeliveries.add(item.child_delivery_id);
    });
  });

export const ChainGateSchema = z.object({
  gate_id: z.string().min(1).max(128),
  /** Same cap as the CHECK on `agent_chain_gates.question`. */
  question: z.string().min(1).max(8_192)
}).strict();

/**
 * THE PROFILE AND FACTS AS THEY TRAVEL ON THE WIRE.
 *
 * They are the same fields as `AgentProfile` and `HechosDelAlias` from `agent-profile.ts`, written
 * as a schema because what arrives over the socket is FOREIGN data and must be validated before
 * writing it to a container's disk. TS types check nothing at runtime, and what we do with this
 * is write files that a model will read as authoritative.
 *
 * `.strict()` on both: an extra field is a sign the two ends do not speak the same version, and
 * in that case it is better to fail the hello than to seed half a profile.
 */
export const AgentProfileWireSchema = z.object({
  tenant_id: TenantSchema,
  alias: AliasSchema,
  purpose: z.string().nullable(),
  role_summary: z.string().nullable(),
  human_brief: z.string().nullable(),
  responsibilities: z.array(z.string()),
  restrictions: z.array(z.string()),
  tools: z.array(z.string()),
  operating_rules: z.array(z.string())
}).strict();

export const HechosDelAliasWireSchema = z.object({
  permisos: z.object({
    ruta: z.boolean(), lectura: z.boolean(), control: z.boolean(), notificacion: z.boolean()
  }).strict(),
  cuotas: z.array(z.object({
    proveedor: z.string(), cuenta: z.string(), limite: z.string().optional()
  }).strict()),
  arnes: z.object({
    harness: z.string(), home: z.string(),
    contenedor: z.string().optional(),
    capacidades: z.array(z.string())
  }).strict(),
  destinos: z.array(z.string())
}).strict();

export const WsInboundSchema = z.discriminatedUnion('type', [HelloSchema, HeartbeatSchema, WsAckSchema]);

export const WsOutboundSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('hello_ack'), version: z.literal(PROTOCOL_VERSION),
    epoch: z.number().int().positive(), lease_expires_at: z.iso.datetime({ offset: true }),
    /*
     * THE ALIAS PROFILE, ONCE PER CONNECTION AND NOT PER DELIVERY.
     *
     * The fixed configuration lives in the harness's file. It travels in the initial hello and
     * not in each delivery envelope to minimize transport overhead.
     *
     * Optional in the schema and gated behind the `agent_profile_v1` capability to ensure
     * backward compatibility with earlier adapters.
     */
    agent_profile: z.object({
      perfil: AgentProfileWireSchema,
      hechos: HechosDelAliasWireSchema
    }).strict().optional()
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
    receipt: z.enum(['applied', 'duplicate', 'superseded', 'ownership_lost']).optional(),
    /**
     * The two delegation discipline fields. Optional in the schema and ALSO gated in the gateway
     * behind `delegation_feedback_v1`: the schema makes them valid for those who understand them,
     * the capability prevents sending them to those who did not ask for them. Both are needed
     * because an old adapter validates with `.strict()` and, on failure, kills the entire
     * connection queue — it does not discard the frame.
     */
    delegation_rejections: z.array(DelegationRejectionSchema)
      .max(MAX_DELEGATION_FEEDBACK_ITEMS).optional(),
    delegation_materializations: DelegationMaterializationsSchema.optional(),
    chain_gate: ChainGateSchema.optional()
  }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict()
]);
