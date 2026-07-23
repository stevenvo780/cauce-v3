import { randomUUID } from "node:crypto";
import { AdapterError, ProcessExecutionError } from "../sdk/errors.js";
import type { DurableStore } from "../sdk/durable-store.js";
import type {
  AdapterCapabilities,
  CommandRunner,
  HarnessCommandOverride,
  HarnessDefinition,
  HarnessExecutionContext,
  HarnessId,
  RelayOrigin,
  StructuredOutput,
} from "../sdk/types.js";
import { PROTOCOL_VERSION } from "../sdk/types.js";

export function capabilities(
  harness: HarnessId,
  persistentSessions: boolean,
  additions: Pick<AdapterCapabilities, "loopback_api" | "stable_alias_sessions" | "api_cancellation"> = {},
): AdapterCapabilities {
  return {
    protocol_version: PROTOCOL_VERSION,
    harness,
    structured_output: true,
    stdin_prompt: true,
    durable_inbox: true,
    durable_outbox: true,
    idempotent_delivery: true,
    heartbeat: true,
    cancellation: "process_group",
    fencing_epoch: true,
    origin_relay: true,
    attempt_scoped_delivery: true,
    event_id_correlation: true,
    claim_token_correlation: true,
    authenticated_session_scope: true,
    persistent_sessions: persistentSessions,
    ...additions,
  };
}

function protocolPrompt(prompt: string, origin: RelayOrigin | undefined): string {
  return [
    "Return exactly one structured result with this JSON shape:",
    '{"reply":string|null,"messages":[{"to":string,"body":string}],"status":"done"|"failed","retryable":boolean,"artifacts":[{"name":string,"uri":string,"media_type"?:string,"sha256"?:string}]}',
    "Do not wrap the result in Markdown.",
    "--- BEGIN TRUSTED ORIGIN CONTEXT ---",
    JSON.stringify(origin ?? null),
    "--- END TRUSTED ORIGIN CONTEXT ---",
    "--- BEGIN REQUEST ---",
    prompt,
    "--- END REQUEST ---",
    "",
  ].join("\n");
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
}

export interface HarnessExecuteRequest {
  readonly prompt: string;
  readonly sessionKey?: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
  readonly origin?: RelayOrigin;
}

export class HarnessAdapter {
  readonly definition: HarnessDefinition;
  private readonly runner: CommandRunner;
  private readonly store: DurableStore;
  private readonly commandOverride: HarnessCommandOverride | undefined;
  private readonly sessionNamespace: string | undefined;
  private readonly fallbackSessionKey: string | undefined;

  constructor(options: HarnessAdapterOptions) {
    this.definition = options.definition;
    this.runner = options.runner;
    this.store = options.store;
    this.commandOverride = options.commandOverride;
    this.sessionNamespace = options.sessionNamespace;
    this.fallbackSessionKey = options.fallbackSessionKey;
  }

  async execute(request: HarnessExecuteRequest): Promise<StructuredOutput> {
    const effectiveSessionKey = request.sessionKey ?? this.fallbackSessionKey;
    const session = await this.resolveSession(effectiveSessionKey);
    const sessionContext: HarnessExecutionContext = session.context;
    const invocation = this.invocation(sessionContext);
    const result = await this.runner.run({
      ...invocation,
      stdin: protocolPrompt(request.prompt, request.origin),
      timeoutMs: request.timeoutMs,
      signal: request.signal,
      ...(session.context.sessionId === undefined ? {} : { sessionId: session.context.sessionId }),
    });

    if (result.timedOut) {
      throw new ProcessExecutionError("TIMEOUT", "Harness exceeded its execution deadline", true);
    }
    if (result.cancelled) {
      throw new ProcessExecutionError("CANCELLED", "Harness execution was cancelled", false);
    }

    let parsed;
    try {
      parsed = this.definition.parse(result.stdout);
    } catch (error) {
      if (result.exitCode !== 0) {
        throw new ProcessExecutionError("PROCESS_EXIT", "Harness exited without structured output", true);
      }
      throw error;
    }

    if (effectiveSessionKey !== undefined) {
      if (this.definition.sessionStrategy.kind === "generated" && session.nativeId !== undefined) {
        await this.store.setSession(this.sessionStoreKey(effectiveSessionKey), {
          native_id: session.nativeId,
          initialized: true,
        });
      }
      if (this.definition.sessionStrategy.kind === "observed" && parsed.nativeSessionId !== undefined) {
        await this.store.setSession(this.sessionStoreKey(effectiveSessionKey), {
          native_id: parsed.nativeSessionId,
          initialized: true,
        });
      }
    }

    if (result.exitCode !== 0 && parsed.output.status !== "failed") {
      throw new ProcessExecutionError("PROCESS_EXIT", "Harness exited with a non-zero status", true);
    }
    return parsed.output;
  }

  private invocation(context: HarnessExecutionContext): {
    command: string;
    args: readonly string[];
    harness: HarnessId;
  } {
    const prefix = this.commandOverride?.prefixArgs ?? [];
    const baseArgs = this.commandOverride?.baseArgs ?? this.definition.baseArgs;
    return {
      command: this.commandOverride?.command ?? this.definition.command,
      args: [...prefix, ...baseArgs, ...this.definition.sessionArgs(context)],
      harness: this.definition.id,
    };
  }

  private sessionStoreKey(sessionKey: string): string {
    const namespace = this.sessionNamespace === undefined ? "" : `${this.sessionNamespace}:`;
    return `${this.definition.id}:${namespace}${sessionKey}`;
  }

  private async resolveSession(sessionKey: string | undefined): Promise<{
    context: HarnessExecutionContext;
    nativeId?: string;
  }> {
    if (sessionKey === undefined || this.definition.sessionStrategy.kind === "none") {
      return { context: { resume: false } };
    }
    const existing = this.store.getSession(this.sessionStoreKey(sessionKey));
    if (existing !== undefined) {
      return {
        context: { sessionId: existing.native_id, resume: existing.initialized },
        nativeId: existing.native_id,
      };
    }
    if (this.definition.sessionStrategy.kind === "generated") {
      const nativeId = randomUUID();
      await this.store.setSession(this.sessionStoreKey(sessionKey), {
        native_id: nativeId,
        initialized: false,
      });
      return { context: { sessionId: nativeId, resume: false }, nativeId };
    }
    return { context: { resume: false } };
  }
}

export function executionError(error: unknown): AdapterError {
  if (error instanceof AdapterError) return error;
  return new AdapterError("EXECUTION_FAILED", "Harness execution failed", true);
}
