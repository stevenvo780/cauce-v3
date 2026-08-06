import type {
  Ack,
  ChainGateNotice,
  DelegationRejectionNotice,
  DeliveryEnvelope,
  DeliveryState,
  Hello,
  Origin,
  WsInbound,
  WsOutbound,
} from '@cauce/protocol';
import { PROTOCOL_VERSION } from '@cauce/protocol';

export { PROTOCOL_VERSION };
export type HarnessId = 'hermes' | 'opencode' | 'claude' | 'codex' | 'openclaw' | 'fake';

/** Human-readable manifest; converted to string capabilities on the V3 hello frame. */
export interface AdapterCapabilities {
  readonly protocol_version: typeof PROTOCOL_VERSION;
  readonly harness: HarnessId;
  readonly structured_output: true;
  readonly stdin_prompt: true;
  readonly durable_inbox: true;
  readonly durable_outbox: true;
  readonly idempotent_delivery: true;
  readonly heartbeat: true;
  readonly cancellation: 'process_group';
  readonly fencing_epoch: true;
  readonly origin_relay: true;
  readonly attempt_scoped_delivery: true;
  readonly event_id_correlation: true;
  readonly claim_token_correlation: true;
  readonly authenticated_session_scope: true;
  readonly routing_targets_v1: true;
  readonly attachments_v1: true;
  readonly native_image_input_v1?: true;
  readonly native_document_input_v1?: true;
  readonly persistent_sessions: boolean;
  readonly loopback_api?: true;
  readonly stable_alias_sessions?: true;
  readonly api_cancellation?: 'abort_signal';
  readonly renewable_delivery_claims_v1?: true;
  /**
   * Declara que el adaptador sabe validar `ack_result.delegation_rejections` y
   * `ack_result.chain_gate`. El gateway NO manda esos campos a quien no lo declare, porque un
   * adaptador que valida el frame con `.strict()` no descarta el frame que rechaza: falla la cola
   * entera de la conexión.
   */
  readonly delegation_feedback_v1?: true;
  /** Acepta `self_role` en el sobre y lo emite como preámbulo de identidad. Ver migración 020. */
  readonly agent_identity_v1?: true;
}

export type RelayOrigin = Origin;

export interface RelayMessage {
  readonly to: string;
  readonly body: string;
}

export interface OutputArtifact {
  readonly name: string;
  readonly uri: string;
  readonly media_type?: string;
  readonly sha256?: string;
}

export type StructuredStatus = 'done' | 'failed';

export type NotifyKind = 'task_complete' | 'decision_request' | 'digest' | 'alert';

/**
 * Proactive egress directive. `to` is a logical handle an operator put on the
 * allowlist, never a chat id: the harness cannot name a destination the store
 * has not already authorized for this alias.
 */
export interface NotifyDirective {
  readonly to: string;
  readonly body: string;
  readonly kind: NotifyKind;
}

export interface StructuredOutput {
  readonly reply: string | null;
  readonly messages: readonly RelayMessage[];
  readonly notify: readonly NotifyDirective[];
  readonly status: StructuredStatus;
  readonly retryable: boolean;
  readonly artifacts: readonly OutputArtifact[];
}

/** Trusted session facts copied into a delivery by the authenticated gateway. */
export interface DeliveryAuthenticatedContext {
  readonly session_id: string;
  readonly channel: string;
  readonly origin?: Origin;
}

/**
 * Exact core delivery frame. The intersection keeps this package compatible
 * while protocol producers roll out authenticated session context.
 */
export type Delivery = DeliveryEnvelope & {
  readonly authenticated_context?: DeliveryAuthenticatedContext;
};

/** Local cancellation primitive. V3 has no remote cancel frame. */
export interface CancelDelivery {
  readonly type: 'cancel';
  readonly delivery_id: string;
  readonly epoch: number;
  readonly reason?: string;
}

export type HelloAck = Extract<WsOutbound, { type: 'hello_ack' }>;
export type HelloFrame = Hello;
export type HeartbeatFrame = Extract<WsInbound, { type: 'heartbeat' }>;

/** Correlated receipt for one exact durable ACK event. */
export interface AckResultFrame {
  readonly type: 'ack_result';
  readonly event_id: string;
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly status: DeliveryState;
  readonly applied: boolean;
  readonly receipt?: 'applied' | 'duplicate' | 'superseded' | 'ownership_lost';
  /** Salidas `messages` que NO se convirtieron en entrega. Sólo con `delegation_feedback_v1`. */
  readonly delegation_rejections?: readonly DelegationRejectionNotice[];
  /** La rama quedó suspendida esperando a una persona. Sólo con `delegation_feedback_v1`. */
  readonly chain_gate?: ChainGateNotice;
}

/** Every ACK is scoped to one delivery attempt and one opaque claim. */
export interface DeliveryAckFrame {
  readonly type: 'ack';
  readonly version: typeof PROTOCOL_VERSION;
  readonly event_id: string;
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly status: Ack['status'];
  readonly instance_id: string;
  readonly epoch: number;
  readonly retryable: boolean;
  readonly error?: string;
  readonly error_code?: string;
  readonly result?: Readonly<Record<string, unknown>>;
}

export type ServerFrame =
  | Exclude<WsOutbound, { type: 'delivery' | 'ack_result' }>
  | Delivery
  | AckResultFrame;
export type ClientFrame = Exclude<WsInbound, { type: 'ack' }> | DeliveryAckFrame;

export type DeliveryPhase = Ack['status'];

export interface AdapterErrorPayload {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
}

/** Durable local ACK record. The transport maps this to the canonical V3 ack frame. */
export interface DeliveryEvent {
  readonly event_id: string;
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
  readonly epoch: number;
  readonly phase: DeliveryPhase;
  readonly occurred_at: string;
  readonly origin?: Origin;
  readonly duplicate?: boolean;
  /** Local-only marker; the transport maps it to a normal `started` ACK. */
  readonly claim_renewal?: true;
  /**
   * "El harness EMPEZÓ a ejecutar", no "la entrega fue admitida". Se emite una vez por intento,
   * después de obtener la reserva de sesión y justo antes de invocar al harness. El ACK
   * `started` normal no sirve para esto: sale ANTES de todo eso, y el reaper que lo tomaba como
   * prueba de ejecución mandaba a `dead` entregas que nunca habían corrido. A diferencia de
   * `claim_renewal`, este campo SÍ viaja por el cable; es opcional en el protocolo y un gateway
   * viejo simplemente lo ignora.
   */
  readonly execution_started?: true;
  readonly output?: StructuredOutput;
  readonly error?: AdapterErrorPayload;
}

export interface ConsumerConnection {
  readonly mode: 'consumer';
  readonly ephemeral: false;
  send(frame: ClientFrame): Promise<void>;
  frames(): AsyncIterable<ServerFrame>;
  close(): Promise<void>;
}

export interface ConsumerConnector {
  connect(signal: AbortSignal): Promise<ConsumerConnection>;
}

export interface AdapterConfig {
  readonly tenantId: DeliveryEnvelope['tenant_id'];
  readonly alias: string;
  readonly ownRoom?: string;
  readonly instanceId: string;
  readonly stateDirectory: string;
  readonly heartbeatMs?: number;
  readonly defaultTimeoutMs?: number;
  readonly reconnect?: Partial<BackoffConfig>;
}

export interface BackoffConfig {
  readonly initialMs: number;
  readonly maxMs: number;
  readonly factor: number;
  readonly jitter: number;
}

export interface CommandInvocation {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd?: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly harness: HarnessId;
}

/**
 * Marca que los puentes propios (`bridge/*.mjs`, `bridge/*.py`) escriben en stderr JUSTO ANTES
 * de la llamada que puede tener efectos. No va por stdout a propósito: stdout es el contrato
 * estructurado del turno y `definition.parse` lo lee entero.
 *
 * La POSICIÓN es todo el arreglo. Si la marca saliera tarde —al primer byte que el harness
 * imprime, por ejemplo— un turno que se cayó a la mitad sin llegar a imprimir quedaría marcado
 * como «nunca arrancó» y se reintentaría trabajo ya pagado. Sale temprano: como mucho se pierde
 * un reintento legítimo, nunca se repite un efecto.
 */
export const HARNESS_START_MARKER = '<<cauce:harness-started>>';

/**
 * Cómo sabe el transporte que el harness EMPEZÓ a ejecutar de verdad.
 *
 * Es por harness porque la respuesta depende de qué escribe cada CLI y cuándo:
 *  - `stdout-first-byte`: el CLI emite eventos según avanza el turno (codex `--json` escribe su
 *    primer evento de hilo antes de cualquier llamada al modelo). Cero bytes en stdout prueba
 *    entonces que el turno no empezó.
 *  - `stderr-marker`: el harness lo invoca un puente NUESTRO, que escribe `HARNESS_START_MARKER`
 *    en stderr inmediatamente antes de la llamada efectiva.
 *  - ausente: no hay manera de atestiguarlo (claude `--print --output-format json` sólo escribe
 *    al final, y un turno completo que muere antes de imprimir es indistinguible de uno que
 *    nunca arrancó). Sin testigo NO se degrada nada: la entrega sigue siendo ambigua, que es el
 *    comportamiento de siempre.
 */
export type HarnessStartWitness =
  | { readonly kind: 'stdout-first-byte' }
  | { readonly kind: 'stderr-marker'; readonly marker: string };

export interface CommandRunRequest extends CommandInvocation {
  readonly stdin: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  /** Internal native session id; never logged or sent as a credential. */
  readonly sessionId?: string;
  /** Testigo declarado por el harness. Ausente = el transporte no atestigua nada. */
  readonly startWitness?: HarnessStartWitness;
  /**
   * Se invoca UNA sola vez, en el instante exacto en que el testigo se cumple. Es lo que permite
   * que `execution_started_at` se selle con el primer byte del harness y no con el `spawn`.
   */
  readonly onHarnessStart?: () => void;
}

export interface CommandRunResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly cancelled: boolean;
  /**
   * Veredicto del testigo de arranque. `true` se cumplió, `false` NO se cumplió (prueba positiva
   * de que el turno no empezó), `undefined` este transporte no atestigua —el runner de sesión
   * compartida y el cliente HTTP de OpenClaw no ven bytes del proceso—. `undefined` se trata
   * siempre como ambiguo.
   */
  readonly harnessStarted?: boolean;
}

export interface HarnessAttachment {
  readonly kind: 'image' | 'document';
  readonly name: string;
  readonly mimeType: string;
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface CommandRunner {
  /**
   * `true` sólo si este transporte VE los bytes del harness y por lo tanto puede cumplir el
   * `startWitness` que declara el harness. Lo cumple el runner de procesos y nadie más: el de
   * sesión compartida cosecha un panel de tmux y el cliente HTTP de OpenClaw recibe una
   * respuesta entera, así que ninguno de los dos puede decir cuándo salió el primer byte.
   *
   * Ausente = no atestigua, y ése es el default correcto: el motor entonces sella
   * `execution_started_at` antes de invocar, como siempre. Si esto se declarara de más, un turno
   * largo que perdiera su ACK final quedaría marcado como «nunca arrancó» y el reaper lo
   * volvería a pagar entero.
   */
  readonly witnessesHarnessStart?: boolean;
  run(request: CommandRunRequest): Promise<CommandRunResult>;
}

export interface SafeRunnerLog {
  /**
   * `orphaned_pipes`: el hijo salió pero un descendiente heredó stdout/stderr y las dejó
   * abiertas, así que la entrega se cerró cosechando el grupo de procesos. Es la huella
   * operativa de una entrega que antes quedaba colgada para siempre y en silencio.
   */
  readonly event: 'spawn' | 'exit' | 'terminate' | 'orphaned_pipes';
  readonly harness: HarnessId;
  readonly exitCode?: number | null;
  readonly timedOut?: boolean;
  readonly cancelled?: boolean;
}

export type SafeRunnerLogger = (entry: SafeRunnerLog) => void;

/**
 * One field a schema rejected. Deliberately path-first and value-free: the operator
 * needs to know *which* field of the frame was refused and by which constraint, and
 * frame bodies carry message text that must never reach the unit journal.
 */
export interface FrameValidationIssue {
  /** Dotted/bracketed path of the rejected field, e.g. `error` or `result.output.reply`. */
  readonly path: string;
  /** Validator code, e.g. `too_big`, `invalid_type`, `unrecognized_keys`. */
  readonly code: string;
  /** Constraint text from the validator. Never the rejected value. */
  readonly message?: string;
}

/**
 * Adapter operational event logger (observability). Optional; graceful degradation if
 * not provided.
 *
 * There is deliberately no `claim_token` field. The claim token is the capability that
 * authorizes ACKing a delivery, and these entries land in the unit journal, so carrying
 * one here would put a live credential in a log an operator reads and pastes around.
 * A delivery_id plus attempt identifies the same work without granting anything.
 * `claim_token_fingerprint` exists for the one case that needs to be correlated with
 * the gateway's view of a claim, and it is a truncated digest, not the capability.
 */
export interface AdapterLog {
  event:
    | 'delivery_start'
    | 'delivery_state'
    | 'delivery_end'
    | 'claim_renewal_start'
    | 'claim_renewal_end'
    | 'connection_error'
    | 'outbound_frame_invalid'
    /** Un frame del gateway que el esquema rechazó y el adaptador DESCARTÓ sin cortar la cola. */
    | 'inbound_frame_invalid'
    /**
     * Un turno del bus que NO pasó por la terminal compartida del dueño, o que la encontró
     * reiniciada. Se emite al journal ADEMÁS de viajar dentro del "reply": el intento anterior
     * murió justamente porque esa situación no dejaba rastro en ninguna parte.
     */
    | 'shared_session_degraded'
    /**
     * Qué pasó al intentar devolverle al panel su conversación anterior.
     *
     * Sólo se emite cuando NO salió bien. Hace falta porque el fallo es mudo por naturaleza: el
     * alias arranca, contesta y parece sano — simplemente no se acuerda de nada. Sin esta línea,
     * la única señal de que se perdió la memoria sería que el agente responde raro, que fue
     * exactamente cómo se descubrió la pérdida de los 38 MB de kant.
     */
    | 'shared_session_resume'
    /**
     * El puente que este adaptador va a ejecutar NO escribe la marca de arranque, así que su
     * testigo se apaga y todo fallo sin salida estructurada vuelve a ser ambiguo. Es la señal de
     * un despliegue a medias (`CAUCE_*_BRIDGE` apuntando fuera del paquete): degrada el ahorro,
     * nunca la corrección, pero hay que verlo.
     */
    | 'harness_start_witness_disabled';
  timestamp?: string; // ISO8601, optional for convenience
  delivery_id?: string;
  phase?: DeliveryPhase;
  alias?: string;
  /** Qué harness ejecuta este adaptador. No es secreto y nunca lleva argumentos ni prompt. */
  harness?: HarnessId;
  attempt?: number;
  error_code?: string;
  error_message?: string;
  /** Connection failure code, or why a claim renewal ended. */
  reason?: string;
  /** Discriminator of the offending frame (`ack`, `hello`, `heartbeat`); never its body. */
  frame_type?: string;
  /** Fields a schema rejected. Set on `outbound_frame_invalid` and `inbound_frame_invalid`. */
  issues?: readonly FrameValidationIssue[];
  /** Truncated SHA-256 of a claim token. Never the token itself; see the note above. */
  claim_token_fingerprint?: string;
}

export type AdapterLogger = (entry: AdapterLog) => void;

export interface HarnessExecutionContext {
  readonly sessionId?: string;
  readonly resume: boolean;
}

export interface ParsedHarnessOutput {
  readonly output: StructuredOutput;
  readonly nativeSessionId?: string;
}

export type SessionStrategy =
  | { readonly kind: 'none' }
  | { readonly kind: 'generated' }
  | { readonly kind: 'observed' };

export interface HarnessDefinition {
  readonly id: HarnessId;
  readonly command: string;
  readonly baseArgs: readonly string[];
  readonly capabilities: AdapterCapabilities;
  readonly sessionStrategy: SessionStrategy;
  /**
   * Qué byte de este harness significa «ya estoy ejecutando». Ausente = no se puede atestiguar,
   * y entonces todo fallo sin salida estructurada sigue siendo ambiguo. Ver `HarnessStartWitness`.
   */
  readonly startWitness?: HarnessStartWitness;
  sessionArgs(context: HarnessExecutionContext): readonly string[];
  parse(stdout: string): ParsedHarnessOutput;
}

export interface HarnessCommandOverride {
  readonly command: string;
  readonly prefixArgs?: readonly string[];
  /** Replaces definition.baseArgs, primarily for a packaged bridge path override. */
  readonly baseArgs?: readonly string[];
}

export interface Clock {
  now(): Date;
  sleep(ms: number, signal: AbortSignal): Promise<void>;
}
