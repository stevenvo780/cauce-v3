import type { NotifyKind } from '@cauce/protocol';
import type {
  Ack,
  ChainGateNotice,
  DelegationMaterializationNotice,
  DelegationRejectionNotice,
  DeliveryEnvelope,
  DeliveryState,
  Origin,
  ProfileRuntimeAdoptionEvidence,
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
  /** Declares support for `ack_result.delegation_rejections` and `ack_result.chain_gate`. */
  readonly delegation_feedback_v1?: true;
  /** Accepts `self_role` in the envelope and emits it as the identity preamble. */
  readonly agent_identity_v1?: true;
  /** Declares the adapter receives `hello_ack.agent_profile` and syncs it into the harness files. */
  readonly agent_profile_v1?: true;
  /** Accepts per-delivery runtime profile contract and emits consumption evidence upon completion. */
  readonly agent_profile_adoption_v1?: true;
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

export type { NotifyKind };

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
  /** `messages` outputs that did NOT become a delivery. Only with `delegation_feedback_v1`. */
  readonly delegation_rejections?: readonly DelegationRejectionNotice[];
  /** Exact identity of each output that DID produce a delivery. Only with the same capability. */
  readonly delegation_materializations?: readonly DelegationMaterializationNotice[];
  /** Branch suspended waiting for a person. Only with `delegation_feedback_v1`. */
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
  /** Durable pre-invocation execution fence; only present on its exact `started` ACK. */
  readonly execution_started?: true;
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
   * Execution intent mark emitted after session reservation and before invoking the harness.
   * Travels in the `started` ACK frame to confirm execution effectively began.
   */
  readonly execution_started?: true;
  readonly output?: StructuredOutput;
  /** Adapter-generated proof that this exact turn consumed the contracted runtime profile. */
  readonly profile_adoption?: ProfileRuntimeAdoptionEvidence;
  readonly error?: AdapterErrorPayload;
}

export interface ConsumerConnection {
  readonly mode: 'consumer';
  readonly ephemeral: false;
  /** Resolves after the frame is flushed, or rejects when this connection closes or cannot flush. */
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
 * Mark emitted on stderr by bridges before invoking model execution.
 * Lets us witness the harness began running without contaminating stdout.
 */
export const HARNESS_START_MARKER = '<<cauce:harness-started>>';

/**
 * Strategy for determining whether the harness process started execution:
 *  - `stdout-first-byte`: the CLI emits events during the turn; zero bytes on stdout means it didn't start.
 *  - `stderr-marker`: the bridge writes `HARNESS_START_MARKER` on stderr before invoking execution.
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
  /** Witness declared by the harness. Absent = the transport attests nothing. */
  readonly startWitness?: HarnessStartWitness;
  /**
   * Optional observer invoked once when the witness fires. Not a durability barrier: the engine
   * fsyncs its intent before invoking the harness.
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
   * Start-witness verdict. `true` it fired, `false` it did NOT (positive proof the turn did not
   * start), `undefined` this transport attests nothing —the shared-session runner and the
   * OpenClaw HTTP client don't see the process's bytes—. `undefined` is always treated as
   * ambiguous.
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
  /** Whether this transport can observe the byte stream to verify `startWitness`. */
  readonly witnessesHarnessStart?: boolean;
  run(request: CommandRunRequest): Promise<CommandRunResult>;
}

export interface SafeRunnerLog {
  /** Operational event from the process runner. */
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
    /** Inbound gateway frame rejected by schema and dropped. */
    | 'inbound_frame_invalid'
    /** Turn ran on the fallback path or with the shared session unavailable. */
    | 'shared_session_degraded'
    /** Result of syncing the profile into the harness files on connect. */
    | 'profile_seed'
    | 'fixed_context'
    /** Failure or anomaly while restoring the conversation in the shared-session pane. */
    | 'shared_session_resume'
    /** Start witness disabled because the configured bridge does not emit the mark. */
    | 'harness_start_witness_disabled'
    | 'connection_degraded'; /** Transport is up but something else is not. */
  timestamp?: string; // ISO8601, optional for convenience
  delivery_id?: string;
  phase?: DeliveryPhase;
  alias?: string;
  /** Which harness runs this adapter. Not secret and never carries args or prompt. */
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
  /** Witness for attesting that the process has started execution. */
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
