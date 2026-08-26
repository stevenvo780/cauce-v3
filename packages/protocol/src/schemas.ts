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

/**
 * PRE-VUELO: el harness murió SIN haber empezado el turno, y consta.
 *
 * Son el reverso exacto de los ambiguos. Un código ambiguo dice «no sabemos si hubo efectos» y
 * por eso es terminal; uno de pre-vuelo dice «sabemos que NO los hubo», y por eso vuelve al
 * circuito de reintento en vez de morir en el intento 1. La garantía *at-most-once* no se
 * relaja: lo que cambia es que ahora hay una manera de DEMOSTRAR el caso fácil, y sólo se usa
 * cuando la prueba existe.
 *
 * La prueba nunca es el tiempo. Para un proceso ya invocado son dos señales positivas, y las dos
 * exigen además que no escribiera ni un byte por stdout, que es el canal donde vive la salida del
 * turno (`packages/adapter-sdk/src/harnesses/shared.ts`):
 *   1. el TESTIGO de arranque del transporte: el harness declara qué byte suyo significa «ya
 *      estoy ejecutando» y el runner atestigua que nunca llegó (`CommandRunResult.harnessStarted`);
 *   2. el DIAGNÓSTICO DE ARRANQUE que el propio CLI imprime en vez de trabajar —config que no
 *      parsea, sesión que no existe, binario ausente, argumento que no entiende—, de una lista
 *      blanca de mensajes que son imposibles una vez que el turno empezó.
 *
 * Hay además dos fallos anteriores a toda invocación: no poder fsyncar la intención durable y
 * recuperar un registro `preinvoke-v1` que todavía no la contiene. En ambos casos el propio orden
 * persistido prueba que el harness no pudo ser llamado.
 *
 * NUNCA pueden solaparse con `AMBIGUOUS_ACK_ERROR_CODES`: `BaseAckSchema` descarta
 * `retryable:true` junto a un código ambiguo, así que un código en las dos listas volvería a
 * morir en el primer intento y encima en silencio. `assertPreflightCodesAreNotAmbiguous` lo
 * comprueba al cargar el módulo para que ese error no pueda llegar a producción.
 */
export const PREFLIGHT_ACK_ERROR_CODES = [
  'PROCESS_EXIT_PREFLIGHT',
  'EXECUTION_CANCELLED_PREFLIGHT',
  'EXECUTION_INTENT_CONFIRMATION_FAILED',
  'EXECUTION_INTENT_PERSISTENCE_FAILED',
  'INTERRUPTED_PREFLIGHT'
] as const;
export const PreflightAckErrorCodeSchema = z.enum(PREFLIGHT_ACK_ERROR_CODES);
export type PreflightAckErrorCode = z.infer<typeof PreflightAckErrorCodeSchema>;

export function isPreflightAckErrorCode(code: unknown): code is PreflightAckErrorCode {
  return PreflightAckErrorCodeSchema.safeParse(code).success;
}

function assertPreflightCodesAreNotAmbiguous(): void {
  const overlap = PREFLIGHT_ACK_ERROR_CODES.filter((code) => isAmbiguousAckErrorCode(code));
  if (overlap.length > 0) {
    throw new Error(`Preflight ACK codes must never be ambiguous: ${overlap.join(', ')}`);
  }
}
assertPreflightCodesAreNotAmbiguous();

/**
 * Tope del rol declarado por alias (`agents.role_brief`), medido en PUNTOS DE CÓDIGO.
 *
 * Vive acá y no en el store porque es el número que tienen que compartir CUATRO capas, y
 * `@cauce/protocol` es la única que las tres de código pueden importar sin ciclos: el CHECK
 * `agents_role_brief_len` de la migración 020, `normalizeRoleBrief()` en `@cauce/store`,
 * `self_role` de `DeliveryEnvelopeSchema` (acá abajo) y el recorte de `selfRoleFromDelivery()` en
 * `@cauce/adapter-sdk`. La cuarta —la columna de Postgres— no puede importar nada, así que espeja
 * el número con un comentario que apunta acá; es la ÚNICA que no se puede cambiar sin migración,
 * y por eso es la que manda la unidad.
 *
 * La unidad es el punto de código porque eso es lo que mide `char_length` de Postgres. Cualquier
 * capa que cuente unidades UTF-16 (`String.length`, `z.string().max()`) deja una franja donde el
 * brief se guarda bien pero el sobre de la entrega se rechaza entero, y el alias deja de recibir
 * sin que aparezca ningún error: SORDO y en silencio.
 */
export const ROLE_BRIEF_MAX_CODE_POINTS = 1200;

/**
 * Largo de un texto en puntos de código, que es la unidad de `ROLE_BRIEF_MAX_CODE_POINTS`.
 *
 * `String.length` cuenta unidades UTF-16 y NO sirve acá: un emoji fuera del BMP vale 2 para `.length`
 * y 1 para `char_length` de Postgres. El spread itera por puntos de código, que es exactamente lo
 * que mide la columna.
 */
export function countCodePoints(text: string): number {
  return [...text].length;
}

/**
 * Recorta a `ROLE_BRIEF_MAX_CODE_POINTS` sin partir jamás un par suplente.
 *
 * `text.slice(0, 1200)` indexa unidades UTF-16: sobre `'a'.repeat(1199) + '🎉'` corta el emoji por
 * la MITAD y deja un surrogate alto suelto, que al serializarse a UTF-8 viaja como U+FFFD. El
 * agente recibiría su propio rol terminado en un carácter roto. Se recorta sobre el array de
 * puntos de código, donde el emoji es un elemento indivisible.
 */
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

export const MAX_ATTACHMENT_BYTES = 10_000_000;
export const MAX_ATTACHMENTS_PER_MESSAGE = 4;
export const MAX_ATTACHMENTS_TOTAL_BYTES = 10_000_000;
/**
 * Los tipos que el bus acepta como adjunto.
 *
 * `services/telegram-bridge/src/attachments.ts` produce `.md` y `.csv` desde el 2026-08-05 y este
 * enum se quedó atrás: el puente descargaba el archivo, lo empaquetaba y RECIÉN AHÍ `publish` lo
 * rechazaba con un ZodError, que subía por fuera de los `catch` que avanzan el cursor y dejaba al
 * alias reintentando el mismo update para siempre. Medido en `heraclito` el 2026-08-05: un `.md`
 * de Steven y 4 mensajes suyos parados detrás durante horas, con el lease latiendo sano.
 *
 * Telegram no manda un mime estable para markdown: según el cliente llega `text/markdown`,
 * `text/x-markdown` o directamente `text/plain`. Los tres tienen que entrar o no entra ninguno.
 */
export const ATTACHMENT_MIME_TYPES = [
  'image/jpeg', 'image/png', 'image/webp', 'application/pdf', 'text/plain',
  'text/markdown', 'text/x-markdown', 'text/csv',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
] as const;

function hasUnsafeAttachmentCodePoint(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0)!;
    return code <= 0x1f || (code >= 0x7f && code <= 0x9f) || code === 0x61c ||
      (code >= 0x200b && code <= 0x200f) || (code >= 0x2028 && code <= 0x202e) ||
      (code >= 0x2060 && code <= 0x206f) || code === 0xfeff || (code >= 0xfff9 && code <= 0xfffb);
  });
}

const AttachmentNameSchema = z.string().min(1).max(255).superRefine((name, context) => {
  if (name === '.' || name === '..' || name.includes('/') || name.includes('\\') ||
      hasUnsafeAttachmentCodePoint(name)) {
    context.addIssue({ code: 'custom', message: 'attachment name is unsafe' });
  }
});

export const AttachmentContentSchema = z.object({
  kind: z.enum(['image', 'document']),
  name: AttachmentNameSchema,
  mime_type: z.enum(ATTACHMENT_MIME_TYPES),
  file_size: z.number().int().positive().max(MAX_ATTACHMENT_BYTES),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  content_base64: z.string().max(Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 4)
    .regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u)
}).strict().superRefine((attachment, context) => {
  const extension = attachment.name.toLowerCase().match(/\.[^.]+$/u)?.[0];
  // El valor es (extensiones admitidas, kind): `text/plain` es legítimamente el mime que Telegram
  // manda para `.txt`, `.md` y `.csv`, así que una sola extensión por mime no alcanza. Los pares
  // son EXACTAMENTE los del allowlist de la ingesta: tener dos criterios distintos para el mismo
  // valor es justo como un adjunto entra por una capa y lo rechaza la de al lado.
  const expected = new Map<string, readonly [readonly string[], 'image' | 'document']>([
    ['image/jpeg', [['.jpg'], 'image']], ['image/png', [['.png'], 'image']],
    ['image/webp', [['.webp'], 'image']], ['application/pdf', [['.pdf'], 'document']],
    ['text/plain', [['.txt', '.md', '.csv'], 'document']],
    ['text/markdown', [['.md'], 'document']],
    ['text/x-markdown', [['.md'], 'document']],
    ['text/csv', [['.csv'], 'document']],
    ['application/vnd.openxmlformats-officedocument.wordprocessingml.document', [['.docx'], 'document']]
  ]).get(attachment.mime_type);
  if (expected === undefined || extension === undefined || !expected[0].includes(extension) ||
      attachment.kind !== expected[1]) {
    context.addIssue({ code: 'custom', message: 'attachment kind, MIME and extension do not agree' });
  }
  const padding = attachment.content_base64.endsWith('==') ? 2 : attachment.content_base64.endsWith('=') ? 1 : 0;
  const decodedSize = attachment.content_base64.length / 4 * 3 - padding;
  if (decodedSize !== attachment.file_size) {
    context.addIssue({ code: 'custom', path: ['file_size'], message: 'attachment encoded size does not agree' });
  }
});

export const AttachmentsV1Schema = z.array(AttachmentContentSchema)
  .min(1)
  .max(MAX_ATTACHMENTS_PER_MESSAGE)
  .superRefine((attachments, context) => {
    if (attachments.reduce((total, attachment) => total + attachment.file_size, 0) > MAX_ATTACHMENTS_TOTAL_BYTES) {
      context.addIssue({ code: 'custom', message: 'aggregate attachment size exceeds limit' });
    }
  });

/**
 * Techo absoluto de `body.timeout_ms`: 7 días. Es el MISMO número que
 * `MAX_AGENT_EXECUTION_TIMEOUT_MS` de packages/adapter-sdk, y tiene que seguir siéndolo: el SDK
 * ya rechazaba con `INVALID_TIMEOUT` cualquier valor fuera de rango, pero lo hacía DESPUÉS de
 * reclamar la entrega y en un error NO reintentable, o sea que un dedazo del publicador se
 * pagaba como una entrega muerta en vez de como un 400 en la puerta.
 */
export const MAX_MESSAGE_TIMEOUT_MS = 7 * 24 * 60 * 60_000;

/**
 * Presupuesto de reloj de pared que el publicador le da a ESTE mensaje, en milisegundos.
 *
 * Existía de facto —el SDK lee `body.timeout_ms` desde siempre— pero no estaba en ningún
 * esquema, así que nadie lo validaba, nadie lo documentaba y en la práctica ningún mensaje lo
 * traía: todos caían en el default de 24 h del harness. Declararlo acá lo vuelve parte del
 * contrato y, sobre todo, lo vuelve legible para el STORE, que es quien tiene que decidir
 * cuánto tiempo puede una entrega seguir renovando su garra (ver `deliveryLeaseCapMs`).
 */
export const MessageTimeoutMsSchema = z.number().int().positive().max(MAX_MESSAGE_TIMEOUT_MS);

/**
 * Lee `body.timeout_ms` con la MISMA regla que el esquema, sin lanzar.
 *
 * Devuelve `undefined` tanto para "no lo trae" como para "trae basura". Es deliberado: esta
 * función la usan el store y el reaper sobre filas que YA están en la base, incluidas las que
 * se insertaron antes de que el esquema existiera. Ahí "no sé" tiene que caer del lado del
 * default configurado, no del lado de romper el barrido de garras vencidas por una fila vieja.
 */
export function messageTimeoutMs(body: unknown): number | undefined {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return undefined;
  const parsed = MessageTimeoutMsSchema.safeParse((body as Record<string, unknown>).timeout_ms);
  return parsed.success ? parsed.data : undefined;
}

export const MessageBodySchema = z.record(z.string(), z.unknown()).superRefine((body, context) => {
  if (body.timeout_ms !== undefined) {
    const timeout = MessageTimeoutMsSchema.safeParse(body.timeout_ms);
    if (!timeout.success) {
      context.addIssue({
        code: 'custom',
        path: ['timeout_ms'],
        message: `body.timeout_ms must be an integer between 1 and ${MAX_MESSAGE_TIMEOUT_MS}`
      });
    }
  }
  if (body.attachments_v1 === undefined) return;
  const parsed = AttachmentsV1Schema.safeParse(body.attachments_v1);
  if (parsed.success) return;
  for (const issue of parsed.error.issues) {
    context.addIssue({ ...issue, path: ['attachments_v1', ...issue.path] });
  }
});

/** Internal authenticated publish command. Identity and origin are populated by the gateway. */
export const PublishMessageSchema = z.object({
  version: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  request_id: RequestIdSchema,
  trace_id: TraceIdSchema,
  tenant_id: TenantSchema,
  room_id: z.string().min(1).max(128),
  actor_alias: AliasSchema,
  recipients: z.array(RecipientSchema).max(100),
  body: MessageBodySchema,
  idempotency_key: z.string().min(1).max(200),
  origin: OriginSchema.optional(),
  session_id: z.string().min(1).max(256).optional(),
  channel: z.string().min(1).max(128).optional(),
  authenticated_context: AuthenticatedContextSchema.optional(),
  lane: LaneSchema.default('interactive'),
  // The full range is NOT the ceiling. Who may reach the human band (>= HUMAN_PRIORITY_FLOOR) is
  // decided where the producer's authenticated role is known — see priority.ts.
  priority: z.number().int().min(-100).max(100).default(0)
}).strict();

/**
 * Los tres `body.type` que el store escribe cuando un agente le habla a otro:
 * `materializeAgentOutputs` (delegación), `materializeAgentResponse` (retorno al padre) y
 * `materializeAgentFanin` (síntesis). Son los únicos tipos que pueden aparecer en una fila de
 * `deliveries` nacida de otro agente, y por eso son la marca durable que separa tráfico
 * agente-a-agente de tráfico humano.
 *
 * Por qué esta marca y no `origin.adapter`: el `origin` se copia byte a byte en cada salto,
 * así que una cadena de cinco agentes nacida en Telegram sigue diciendo `adapter:'telegram'`
 * en el salto cinco — medido el 2026-07-27, 2.374 de 2.429 entregas de 12 h decían 'telegram'.
 * `body.type` se reescribe en CADA salto: dice qué es ESTA entrega, no de dónde desciende.
 * Y como cada fila lo tiene desde que se insertó, el histórico se clasifica solo: no hay
 * backfill, ni migración, ni categoría "mensaje viejo sin marca".
 */
export const AGENT_TO_AGENT_MESSAGE_TYPES = [
  'agent.message',
  'agent.response',
  'agent.fanin'
] as const;

/**
 * Sonda operativa reservada. El gateway sólo admite este tipo desde la identidad mTLS exacta
 * `Steven:gate-probe`; el SDK la termina sin abrir sesión ni invocar un harness/modelo.
 */
export const SYSTEM_GATE_PROBE_MESSAGE_TYPE = 'system.gate.probe' as const;
/** Principals técnicos cerrados: nunca son destinos ni aparecen en routing_targets. */
export const SYSTEM_PRINCIPAL_ALIASES = ['gate-probe', 'quota-collector'] as const;
export const SystemGateProbeBodySchema = z.object({
  type: z.literal(SYSTEM_GATE_PROBE_MESSAGE_TYPE),
  nonce: z.string().regex(/^[a-f0-9]{32}$/),
  timeout_ms: MessageTimeoutMsSchema,
}).strict();
export type SystemGateProbeBody = z.infer<typeof SystemGateProbeBodySchema>;

export function isSystemGateProbeBody(body: unknown): body is SystemGateProbeBody {
  return SystemGateProbeBodySchema.safeParse(body).success;
}

/** Tipos que nunca deben gastar la reserva de admisión destinada a mensajes humanos. */
export const NON_HUMAN_DELIVERY_MESSAGE_TYPES = [
  ...AGENT_TO_AGENT_MESSAGE_TYPES,
  SYSTEM_GATE_PROBE_MESSAGE_TYPE,
] as const;

/**
 * `agent.notify` es egress proactivo hacia un handle externo: va a `adapter_outbox` y nunca a
 * `deliveries`, así que no participa del reparto de cupo. Sigue reservado igual porque la
 * protección anti-suplantación de abajo tiene que cubrirlo.
 */
export const RESERVED_INTERNAL_MESSAGE_TYPES = [
  ...AGENT_TO_AGENT_MESSAGE_TYPES,
  'agent.notify'
] as const;

const ReservedInternalMessageTypes = new Set<string>(RESERVED_INTERNAL_MESSAGE_TYPES);
const AgentToAgentMessageTypes = new Set<string>(AGENT_TO_AGENT_MESSAGE_TYPES);

/**
 * Falla hacia "humano" a propósito. Un `body.type` desconocido (un adapter que todavía no
 * existe, un cuerpo sin `type`, lo que mande la consola) se clasifica como humano: en el peor
 * caso le damos prioridad a algo que no la necesitaba, que es infinitamente preferible a dejar
 * a una persona esperando 114 minutos detrás de la cola de agentes.
 *
 * LÍMITE CONOCIDO, y hay que decirlo porque la versión anterior de este comentario afirmaba lo
 * contrario: la señal **es falsificable hacia arriba**. `AuthenticatedPublishBodySchema` sólo
 * prohíbe que un publish declare uno de los tipos reservados; no exige que un agente marque los
 * suyos. Un agente autenticado con permiso 'route' puede hacer POST /v3/messages con
 * `{"text":"..."}` sin `type` y esta función lo va a leer como humano, colándose en el cupo
 * reservado del destinatario.
 *
 * No se puede arreglar hoy derivando la clase del actor autenticado, que sería lo correcto:
 * (a) el telegram-bridge publica con `actor_alias` igual al alias del PROPIO agente
 *     (services/telegram-bridge/src/poller.ts pasa `alias: this.config.alias`), así que el actor
 *     de un mensaje humano y el de un mensaje de agente son literalmente el mismo string;
 * (b) `/v3/messages`, `/v3/publish` y `/v3/console/messages` comparten un único `publishHandler`
 *     y un único schema, así que tampoco la superficie discrimina;
 * (c) los roles del registro de identidades no sirven: en la flota real los agentes están
 *     configurados como `operator` (ver ops/runbooks/authentication.md, identidad de `kant`).
 * Clasificar por actor con esos datos rompería en la dirección PELIGROSA — mandar humanos al
 * carril de agentes — que es exactamente el defecto que este parche existe para arreglar.
 *
 * El radio de daño del abuso está acotado a propósito: quien falsifica gana como mucho
 * `CAUCE_HUMAN_RESERVED_DELIVERIES` lugares en la admisión de su destinatario, no puede
 * cancelar ni interrumpir nada, sigue alternando con el humano real por el contador de ráfaga,
 * y paga la corrida con su propia cuota. Ver services/gateway/CONFIGURATION.md.
 */
export function isAgentToAgentBody(body: unknown): boolean {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return false;
  const type = (body as Record<string, unknown>).type;
  return typeof type === 'string' && AgentToAgentMessageTypes.has(type);
}

const AuthenticatedPublishBodySchema = MessageBodySchema.superRefine(
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
  // A caller may ASK for anything in range; the gateway holds every non-operator principal at
  // AGENT_PRIORITY_CEILING before the command reaches the store. Enforcing the ceiling here
  // instead would reject the request, and a 400 on a canary or on an over-eager adapter is a
  // worse outcome than a clamped number.
  priority: z.number().int().min(-100).max(100).default(0)
}).strict();

/**
 * Console preflight for a durable publish intent. The server supplies the opaque idempotency key
 * after binding this exact semantic command to the authenticated principal; a browser can never
 * choose or forge that key through this surface.
 */
export const ConsolePublishIntentPrepareSchema = AuthenticatedPublishSchema.omit({
  idempotency_key: true,
}).safeExtend({
  /** Fresh per deliberate submit; retries of that submit reuse it. */
  intent_nonce: CanonicalUuidV4Schema,
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

// ---------------------------------------------------------------------------
// Quota ingestion: POST /v3/quotas/samples. Wire contract for the out-of-band
// quota collector (get_ai_quotas) that runs on kratos and inside agent
// containers, well away from the gateway. Deliberately shaped like
// NotifyRequestSchema, not AuthenticatedPublishSchema: no tenant/actor/session
// field exists here because the collector's identity comes from its mTLS
// certificate, never from the body -- a machine caller cannot claim to be
// publishing on behalf of a tenant it does not authenticate as.
// ---------------------------------------------------------------------------
export const QuotaHostSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/);
export const QuotaProviderNameSchema = z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/);
export const QuotaGroupKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const QuotaWindowKeySchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
export const QuotaStatusSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/);
export const QuotaAccountIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/**
 * MAJOR schema versions this gateway knows how to interpret. get_ai_quotas reports
 * schemaVersion 2 today (see docs handed to the collector implementer). A future
 * incompatible reshape bumps this number, and an unknown value MUST be rejected
 * with 422 rather than mapped field-by-field: a misread window that claims 0%
 * remaining is what triggers the auto-pause of a real, paying subscription.
 */
export const SUPPORTED_QUOTA_SCHEMA_VERSIONS = [1, 2] as const;

export const QuotaWindowSampleSchema = z.object({
  // Normalized upstream by the collector: group_key = window.limitId ?? 'default',
  // window_key = window.key. The gateway trusts this split rather than recomputing
  // it, because the collector is the only component that saw the raw CLI output.
  group_key: QuotaGroupKeySchema,
  window_key: QuotaWindowKeySchema,
  label: z.string().min(1).max(64).nullable().optional(),
  used_percent: z.number().min(0).max(100).nullable().optional(),
  remaining_percent: z.number().min(0).max(100).nullable().optional(),
  used_units: z.number().int().nonnegative().nullable().optional(),
  limit_units: z.number().int().positive().nullable().optional(),
  window_minutes: z.number().int().positive().nullable().optional(),
  // Absolute instant, not a resetInSeconds delta: a relative countdown goes stale
  // the moment it is persisted and would mislead every later read of the history.
  reset_at: z.iso.datetime({ offset: true }).nullable().optional(),
  status: QuotaStatusSchema.nullable().optional(),
  family: z.string().min(1).max(64).nullable().optional(),
  model: z.string().min(1).max(128).nullable().optional(),
  // The subscription this window draws from, when the collector knows it. Absent
  // or unknown to the registry is not an error: the sample is still stored, with
  // account_id nulled server-side and surfaced under unbound_groups[].
  account_id: QuotaAccountIdSchema.nullable().optional(),
  binding_note: z.string().min(1).max(128).nullable().optional()
}).strict().refine(
  (window) => window.used_percent != null || window.remaining_percent != null || window.used_units != null,
  { message: 'a window sample needs at least one of used_percent, remaining_percent or used_units' }
);

export const QuotaProviderReportSchema = z.object({
  provider: QuotaProviderNameSchema,
  // ok=false with zero windows is information ("the CLI stopped answering"), not
  // absence of information ("the provider was not used") -- the two are opposite
  // diagnoses and this shape is what keeps them distinguishable.
  ok: z.boolean(),
  available: z.boolean().default(false),
  kind: z.string().min(1).max(64).nullable().optional(),
  source: z.string().min(1).max(64).nullable().optional(),
  plan: z.string().min(1).max(64).nullable().optional(),
  note: z.string().max(512).nullable().optional(),
  effective_remaining_percent: z.number().min(0).max(100).nullable().optional(),
  observed_at: z.iso.datetime({ offset: true }).nullable().optional(),
  available_groups: z.array(z.string().min(1).max(128)).max(64).default([]),
  limiting_groups: z.array(z.string().min(1).max(128)).max(64).default([]),
  windows: z.array(QuotaWindowSampleSchema).max(64).default([])
}).strict();

export const MAX_QUOTA_WINDOWS_PER_COLLECTION = 512;

export const QuotaSampleRequestSchema = z.object({
  host: QuotaHostSchema,
  captured_at: z.iso.datetime({ offset: true }),
  schema_version: z.number().int().min(1).max(999),
  app_version: z.string().min(1).max(64).nullable().optional(),
  providers: z.array(QuotaProviderReportSchema).max(32).default([])
}).strict().superRefine((sample, context) => {
  const totalWindows = sample.providers.reduce((count, provider) => count + provider.windows.length, 0);
  if (totalWindows > MAX_QUOTA_WINDOWS_PER_COLLECTION) {
    context.addIssue({
      code: 'custom',
      message: `a collection cannot report more than ${MAX_QUOTA_WINDOWS_PER_COLLECTION} windows in total`
    });
  }
  const seenProviders = new Set<string>();
  for (const provider of sample.providers) {
    if (seenProviders.has(provider.provider)) {
      context.addIssue({ code: 'custom', message: `duplicate provider report in one collection: ${provider.provider}` });
    }
    seenProviders.add(provider.provider);
  }
});

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
    cycle_cut_enabled: z.boolean().optional(),
    // Coalescencia de avisos de fracaso. El 0 se admite y significa "ventana nula": es el modo
    // de desactivación gradual (deja de plegar sin borrar el histórico ya acumulado), distinto
    // de failure_coalesce_enabled=false, que apaga la maquinaria entera.
    failure_coalesce_enabled: z.boolean().optional(),
    failure_coalesce_window_seconds: z.number().int().min(0).max(86_400).optional(),
    /*
     * LOS CINCO TOPES DE LA MIGRACIÓN 019, que el servidor ya APLICA y la consola no podía tocar.
     *
     * `repository.ts` los lee y corta delegaciones con ellos; su única vía de cambio era un
     * `UPDATE` crudo contra la base —la propia 019 lo documenta como el apagado de emergencia—,
     * o sea sin revisión, sin mutación inversa que alcance el botón de deshacer, sin asiento en
     * `audit_events` y sin quién lo hizo.
     *
     * LOS RANGOS SON LOS DEL CHECK DE POSTGRES, copiados uno a uno: fanout 1-100, repeticiones de
     * arista 1-1000, delegaciones por raíz 1-10000. Que coincidan es lo que hace que un valor
     * fuera de rango se rechace con un mensaje que nombra el campo, en vez de estallar como un
     * error de restricción a mitad de la transacción. En un desacuerdo MANDA EL SQL: la columna es
     * la que no se puede mover sin migración.
     */
    delegation_caps_enabled: z.boolean().optional(),
    max_fanout_per_turn: z.number().int().min(1).max(100).optional(),
    max_edge_repeats_per_root: z.number().int().min(1).max(1_000).optional(),
    max_delegations_per_root: z.number().int().min(1).max(10_000).optional(),
    human_gate_enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

const AccountIdSchema = z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/);

/** The runtime/harness binding for an alias. Placement fields travel together (see the
 *  migration's agents_placement_atomic CHECK): partial placement is rejected by Postgres. */
export const AgentConfigMutationSchema = z.object({
  resource: z.literal('agent'), action: ConfigActionSchema,
  tenant_id: TenantSchema, alias: AliasSchema,
  value: z.object({
    harness_id: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).nullable().optional(),
    display_name: OptionalLabelSchema,
    enabled: z.boolean().optional(),
    container_name: z.string().trim().min(1).max(256).nullable().optional(),
    runtime_user: z.string().trim().min(1).max(64).nullable().optional(),
    home_directory: z.string().trim().min(1).max(512).nullable().optional(),
    state_directory: z.string().trim().min(1).max(512).nullable().optional(),
    // `role_brief` es una proyección legacy de `agent_profiles.role_summary` desde la migración
    // 028. No se acepta en esta mutación: guardarlo por el editor genérico sólo acreditaría una
    // fila de Postgres, mientras el fichero que lee el arnés seguiría en la revisión anterior.
    // La única escritura pública es el PUT canónico de perfil, que exige CAS y ACK del runtime.
    /*
     * El techo REAL de entregas en vuelo de este agente (columna `max_concurrent_deliveries`,
     * migración 015). `repository.ts` lo aplica al repartir cupo, y no estaba en ninguna pantalla:
     * su única vía de cambio era un `UPDATE` a mano.
     *
     * `null` NO es «no declarado»: significa SIN TECHO, y es la salida de emergencia que la propia
     * 015 documenta —«si este cambio estrangula a un agente que de verdad puede paralelizar (o si
     * hay que desactivar el techo en caliente sin desplegar)»—. Por eso es `.nullable()` y no sólo
     * `.optional()`: son dos estados distintos y colapsarlos perdería justo la salida.
     *
     * El rango 1-100 es el del CHECK `agents_max_concurrent_deliveries_sane`, copiado tal cual.
     */
    max_concurrent_deliveries: z.number().int().min(1).max(100).nullable().optional()
  }).strict().optional()
}).strict();

/**
 * A provider subscription. The id is global — an account is not owned by the tenant that uses
 * it, it is PAID FOR by payer_tenant_id and lent to whoever the hub puts it in front of.
 * credential_ref is a locator (env var name, file path, secret-manager path), never the secret
 * itself; provider, external_account_id, payer_tenant_id and the credential locator are
 * immutable after create, so rotation is delete+create (enforced in configuration.ts).
 */
export const ProviderAccountConfigMutationSchema = z.object({
  resource: z.literal('provider_account'), action: ConfigActionSchema, id: AccountIdSchema,
  value: z.object({
    provider: z.string().regex(/^[a-z][a-z0-9_.-]{0,63}$/).optional(),
    external_account_id: z.string().trim().min(1).max(256).optional(),
    payer_tenant_id: TenantSchema.optional(),
    label: OptionalLabelSchema,
    credential_ref_kind: z.enum(['env_path', 'file', 'secret_manager']).optional(),
    credential_ref: z.string().min(1).max(1024).optional(),
    shared_with_pool: z.boolean().optional(),
    enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

/** The exhaustive set of accounts an alias may ever be routed to. It carries no mutable state,
 *  so it is granted and revoked, never updated. */
export const AliasRoutingCeilingConfigMutationSchema = z.object({
  resource: z.literal('alias_routing_ceiling'), action: z.enum(['create', 'delete']),
  tenant_id: TenantSchema, alias: AliasSchema, account_id: AccountIdSchema
}).strict();

/** Fallback order within the ceiling; lower priority is tried first. There is no 'main' entry
 *  here by design — see the migration and ADR-006. */
export const AgentAccountBindingConfigMutationSchema = z.object({
  resource: z.literal('agent_account_binding'), action: ConfigActionSchema,
  tenant_id: TenantSchema, agent_alias: AliasSchema, account_id: AccountIdSchema,
  value: z.object({
    priority: z.number().int().min(0).max(32_767).optional(), enabled: z.boolean().optional()
  }).strict().optional()
}).strict();

export const ConfigMutationSchema = z.discriminatedUnion('resource', [
  TenantConfigMutationSchema, RoomConfigMutationSchema, MembershipConfigMutationSchema,
  AclEdgeConfigMutationSchema, HarnessConfigMutationSchema, RolePolicyConfigMutationSchema,
  ChainPolicyConfigMutationSchema, EgressDestinationConfigMutationSchema,
  AgentConfigMutationSchema, ProviderAccountConfigMutationSchema,
  AliasRoutingCeilingConfigMutationSchema, AgentAccountBindingConfigMutationSchema
]);
export const ConfigChangeRequestSchema = z.object({
  dry_run: z.boolean().default(true), expected_revision: ConfigRevisionSchema.optional(), mutation: ConfigMutationSchema
}).strict();
export const ConfigRollbackRequestSchema = z.object({
  dry_run: z.boolean().default(true), expected_revision: ConfigRevisionSchema.optional()
}).strict();

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
     * Es la mitad que faltaba del encargo: lo FIJO tiene que vivir en el fichero del arnés, y para
     * escribirlo ahí el adaptador necesita conocerlo. Viaja en el saludo —una vez, al conectar— y
     * no en el sobre, porque mandarlo en cada entrega sería exactamente el problema que este
     * trabajo vino a cerrar: 11.546 caracteres de andamiaje para un pedido de 62.
     *
     * OPCIONAL EN EL ESQUEMA Y ADEMÁS GATEADO detrás de la capability `agent_profile_v1`, por el
     * mismo motivo que los dos campos de disciplina de delegación: un adaptador viejo valida con
     * `.strict()` y, al fallar, MATA LA COLA ENTERA de la conexión — no descarta el frame. El
     * esquema lo hace válido para quien lo entiende; la capability evita mandárselo a quien no lo
     * pidió. Hacen falta las dos cosas.
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

export type Tenant = z.infer<typeof TenantSchema>;
export type PublishMessage = z.infer<typeof PublishMessageSchema>;
export type AuthenticatedPublish = z.infer<typeof AuthenticatedPublishSchema>;
export type PublishResult = z.infer<typeof PublishResultSchema>;
export type ConsolePublishIntentPrepare = z.infer<typeof ConsolePublishIntentPrepareSchema>;
export type ConsolePublishIntentPrepareResult = z.infer<typeof ConsolePublishIntentPrepareResultSchema>;
export type ConsolePublishIntentReconciliation = z.infer<typeof ConsolePublishIntentReconciliationSchema>;
export type ConsolePublishIntentExpired = z.infer<typeof ConsolePublishIntentExpiredSchema>;
export type ConsolePublishIntentRateLimited = z.infer<typeof ConsolePublishIntentRateLimitedSchema>;
export type ConsolePublishIntentConfirm = z.infer<typeof ConsolePublishIntentConfirmSchema>;
export type ConsolePublishIntentConfirmResult = z.infer<typeof ConsolePublishIntentConfirmResultSchema>;
export type Ack = z.infer<typeof AckSchema>;
export type ClaimedAck = Ack;
export type Hello = z.infer<typeof HelloSchema>;
export type Origin = z.infer<typeof OriginSchema>;
export type AuthenticatedContext = z.infer<typeof AuthenticatedContextSchema>;
export type RoutingTarget = z.infer<typeof RoutingTargetSchema>;
export type AttachmentContent = z.infer<typeof AttachmentContentSchema>;
export type Lane = z.infer<typeof LaneSchema>;
export type DeliveryState = z.infer<typeof DeliveryStateSchema>;
export type DeliveryEnvelope = z.infer<typeof DeliveryEnvelopeSchema>;
export type ProfileRuntimeDocument = z.infer<typeof ProfileRuntimeDocumentSchema>;
export type ProfileRuntimeContract = z.infer<typeof ProfileRuntimeContractSchema>;
export type ProfileRuntimeAdoptionEvidence = z.infer<typeof ProfileRuntimeAdoptionEvidenceSchema>;
export type DelegationRejectionCode = (typeof DELEGATION_REJECTION_CODES)[number];
export type DelegationRejectionNotice = z.infer<typeof DelegationRejectionSchema>;
export type DelegationMaterializationNotice = z.infer<typeof DelegationMaterializationSchema>;
export type ChainGateNotice = z.infer<typeof ChainGateSchema>;
export type ConfigMutation = z.infer<typeof ConfigMutationSchema>;
export type NotifyKind = z.infer<typeof NotifyKindSchema>;
export type NotifyRequest = z.infer<typeof NotifyRequestSchema>;
export type ConfigChangeRequest = z.infer<typeof ConfigChangeRequestSchema>;
export type WsInbound = z.infer<typeof WsInboundSchema>;
export type WsOutbound = z.infer<typeof WsOutboundSchema>;
export type QuotaWindowSample = z.infer<typeof QuotaWindowSampleSchema>;
export type QuotaProviderReport = z.infer<typeof QuotaProviderReportSchema>;
export type QuotaSampleRequest = z.infer<typeof QuotaSampleRequestSchema>;
