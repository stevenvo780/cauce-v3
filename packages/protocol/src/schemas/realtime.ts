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
   * El adaptador comprometió durablemente invocar el harness, no sólo admitió la entrega.
   *
   * Hace falta porque el ACK `started` NO prueba ejecución: el SDK lo emite en
   * `handleDelivery` antes de llamar al harness, y entre medio la entrega puede quedarse
   * minutos esperando el candado de sesión sin gastar un centavo. El reaper usaba esa señal
   * para decidir si una garra vencida podía haber tenido efectos; con `started` a secas mandaba a
   * `dead` trabajo que nunca corrió — trabajo del usuario perdido para siempre.
   *
   * El SDK nuevo la fsynca después de tomar la reserva y espera el receipt exacto del store antes
   * de invocar. Un crash posterior puede haber ejecutado, por eso ya no admite retry automático.
   *
   * OPCIONAL a propósito. Un adaptador viejo nunca la manda y el sistema tiene que seguir
   * funcionando: sin la marca, el reaper vuelve al reintento de siempre. El error cae del lado
   * caro (pagar dos veces) y nunca del lado que pierde trabajo.
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
  // Rol declarado del destinatario (agents.role_brief). El adaptador lo antepone al contrato como
  // preámbulo de identidad. Opcional y detrás de la capability `agent_identity_v1` por el mismo
  // motivo que routing_targets: este esquema es .strict(), así que un adaptador de una imagen
  // anterior RECHAZARÍA el sobre entero si el store le mandara un campo que no conoce, y se
  // quedaría sin poder consumir ninguna entrega. El tope espeja el CHECK de la migración 020 a
  // través de `ROLE_BRIEF_MAX_CODE_POINTS`.
  //
  // NO USAR `.max(ROLE_BRIEF_MAX_CODE_POINTS)`: el `.max()` de zod cuenta unidades UTF-16 y la
  // columna de Postgres cuenta puntos de código. Un brief de 1200 puntos con emoji mide 1300 en
  // UTF-16: el store lo acepta, el CHECK lo acepta, la pantalla dice «guardado»… y en la entrega
  // siguiente `WsOutboundSchema.parse()` rechaza el sobre ENTERO por este campo. El alias deja de
  // recibir y nadie ve un error. Por eso se cuenta con `countCodePoints`, y por eso el mensaje
  // dice cuántos puntos de código se mandaron: si algún día vuelve a fallar, el número del error
  // tiene que ser el mismo que el que cuenta la base, no el de UTF-16.
  //
  // `.min(1)` sí puede quedarse: en el borde del vacío las dos unidades coinciden (una cadena con
  // 0 unidades UTF-16 tiene 0 puntos de código y viceversa).
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
 * Vocabulario durable de por qué una salida `messages` NO se convirtió en delegación.
 *
 * Vive acá y no en el store que lo produce porque viaja en el frame `ack_result`: el adaptador
 * tiene que poder validarlo sin depender de `@cauce/store`. `DelegationRejectionCode` del store
 * se DERIVA de esta lista, así que agregar un código allá sin agregarlo acá no compila — que es
 * exactamente la deriva que dejó el frame fuera del esquema la primera vez.
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
 * El destino rechazado es texto del AGENTE, no un alias validado: `unroutable_alias` existe
 * justamente para el `to` que no rutea, y `agentOutputEntries` lo copia tal cual. Por eso NO es
 * `AliasSchema` y por eso el store lo recorta a este largo antes de ponerlo en el frame: un tope
 * más chico que lo que el productor puede emitir volvería a tirar la conexión entera.
 */
export const MAX_DELEGATION_REJECTION_TARGET_CHARS = 256;

/**
 * `reason` de `chain_gated` incrusta la pregunta del gate, que la base acota a 8 KiB. El tope
 * tiene que quedar por ENCIMA de eso con aire, o el rechazo más largo que el store sabe generar
 * no pasaría su propio esquema.
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
   * Índice de la salida rechazada. La expansión de `@all` lo desplaza a propósito
   * (`maxAgentOutputMessages + index*100 + targetIndex`), así que acá no hay techo: sólo tiene
   * que ser un entero no negativo.
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
  /** Mismo techo que el CHECK de `agent_chain_gates.question`. */
  question: z.string().min(1).max(8_192)
}).strict();

/**
 * EL PERFIL Y LOS HECHOS TAL Y COMO VIAJAN POR EL CABLE.
 *
 * Son los mismos campos que `AgentProfile` y `HechosDelAlias` de `agent-profile.ts`, escritos como
 * esquema porque el que llega por el socket es dato AJENO y hay que validarlo antes de escribirlo
 * en el disco de un contenedor. Los tipos de TS no comprueban nada en tiempo de ejecución, y lo
 * que se hace con esto es escribir ficheros que un modelo va a leer como autoritativos.
 *
 * `.strict()` en los dos: un campo de más es una señal de que las dos puntas no hablan la misma
 * versión, y ante eso vale más fallar el saludo que sembrar medio perfil.
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
     * EL PERFIL DEL ALIAS, UNA VEZ POR CONEXIÓN Y NO POR ENTREGA.
     *
     * La configuración fija reside en el fichero del arnés. Viaja en el saludo inicial
     * y no en cada sobre de entrega para minimizar la sobrecarga de transporte.
     *
     * Opcional en el esquema y gateado tras la capability `agent_profile_v1`
     * para asegurar compatibilidad hacia atrás con adaptadores anteriores.
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
     * Los dos campos de disciplina de delegación. Opcionales en el esquema y ADEMÁS gateados en
     * el gateway detrás de `delegation_feedback_v1`: el esquema los hace válidos para quien los
     * entiende, la capability evita mandárselos a quien no los pidió. Hacen falta las dos cosas
     * porque un adaptador viejo valida con `.strict()` y, al fallar, mata la cola entera de la
     * conexión — no descarta el frame.
     */
    delegation_rejections: z.array(DelegationRejectionSchema)
      .max(MAX_DELEGATION_FEEDBACK_ITEMS).optional(),
    delegation_materializations: DelegationMaterializationsSchema.optional(),
    chain_gate: ChainGateSchema.optional()
  }).strict(),
  z.object({ type: z.literal('error'), code: z.string(), message: z.string() }).strict()
]);
