import type { ProfileRuntimeContract } from "@cauce/protocol";
import type { DurableStore, SessionOrigin } from "../sdk/durable-store.js";
import type {
  CommandRunner,
  HarnessAttachment,
  HarnessCommandOverride,
  HarnessDefinition,
  RelayOrigin,
} from "../sdk/types.js";
import type { SelloDeContextoFijo } from "../harnesses/contexto-fijo.js";
import type { SharedSessionHarness } from "../shared-session/types.js";

export type { HarnessAdapter } from "../harnesses/shared/adapter.js";

export interface HarnessRequestContext {
  readonly self_alias: string;
  readonly sender_alias: string;
  readonly tenant_id: string;
  readonly room_id: string;
  readonly channel: string;
  readonly agent_message: boolean;
  readonly message_type: string;
  readonly routing_targets: readonly HarnessRoutingTarget[];
  /**
   * Alias's declared role (`agents.role_brief`). Absent = no role declared.
   */
  readonly self_role?: string;
  /**
   * Summary of the fixed text as it is written TODAY in the harness's instructions file inside
   * the container, measured by whoever can look at it. When it matches the text this adapter
   * would emit, the fixed block is NOT repeated in the envelope.
   *
   * Absent = the usual behavior, whole envelope. See `contexto-fijo.ts` for why this is a
   * summary and not a flag.
   */
  readonly context_seal?: SelloDeContextoFijo;
  /**
   * Managed profile read from live bytes just before the turn. In shared sessions the TUI may
   * have launched hours before the latest edit; injecting it avoids claiming it adopted a file
   * that process never reloaded.
   */
  readonly runtime_profile?: RuntimeProfileMeasurement;
  readonly native_profile_context?: true;
  readonly native_profile_measurement?: RuntimeProfileMeasurement;
  readonly native_profile_contract?: ProfileRuntimeContract;
}

/** Exact live bytes measured by adapter code, never supplied by model output. */
export interface RuntimeProfileMeasurement {
  readonly source: "runtime-files";
  readonly sha256: string;
  readonly documents: readonly { readonly path: string; readonly sha256: string }[];
  readonly text: string;
}

export interface HarnessRoutingTarget {
  readonly tenant_id: string;
  readonly alias: string;
  readonly online: boolean;
}

export interface HarnessAdapterOptions {
  readonly definition: HarnessDefinition;
  readonly runner: CommandRunner;
  readonly store: DurableStore;
  readonly commandOverride?: HarnessCommandOverride;
  /** Stable, non-secret alias namespace used to isolate persisted native sessions. */
  readonly sessionNamespace?: string;
  /** Trusted local fallback used when a harness requires a session selector. */
  readonly fallbackSessionKey?: string;
  /** Exact Kant/OpenCode-only opt-in for the canonical native-session pointer. */
  readonly canonicalOpenCodeSession?: boolean;
  /**
   * Resolves rotating credential environment variables before each execution.
   */
  readonly resolveCredentialEnv?: () => Promise<Readonly<Record<string, string>>>;
  /**
   * Shared session configuration when enabled for the alias.
   */
  readonly sharedSession?: {
    readonly alias: string;
    readonly harness: SharedSessionHarness;
    readonly stateDirectory: string;
  };
  readonly environment?: NodeJS.ProcessEnv;
}

/**
 * Session lanes to separate attention to people from agent-to-agent interaction.
 */
export type SessionLane = "human" | "agent";

export interface HarnessExecuteRequest {
  readonly prompt: string;
  readonly attachments?: readonly HarnessAttachment[];
  readonly context?: HarnessRequestContext;
  readonly sessionKey?: string;
  /** Session lane. Absent = `human`, the usual behavior. */
  readonly sessionLane?: SessionLane;
  /**
   * Clear-text description of the conversation that produced `sessionKey`. Persisted only; does
   * not change which session is chosen or which lock is taken. Absent when the envelope carried
   * no conversation (`fallbackSessionKey`), and then the entry has no `origin`.
   */
  readonly sessionOrigin?: SessionOrigin;
  readonly sessionReservation?: HarnessSessionReservation;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly origin?: RelayOrigin;
  readonly beforeHarnessInvoke?: () => Promise<void>;
  /**
   * Optional witness observer. Never governs durability or retry: the engine crosses that gate
   * before calling `execute`.
   */
  readonly onHarnessStart?: () => void;
  /**
   * Called only after a real harness run returned valid structured output. The engine still has to
   * match this measurement against the delivery's trusted runtime contract before emitting it.
   */
  readonly onRuntimeProfileConsumed?: (profile: RuntimeProfileMeasurement) => void;
}

export interface HarnessSessionReservation {
  readonly key: string;
  wait(signal: AbortSignal): Promise<void>;
  release(): void;
}
