import { HttpEgressReceiptSource } from "../sdk/egress-receipt-source.js";
import { readFileSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { join } from "node:path";
import { AdapterClient } from "../sdk/client.js";
import { DurableStore } from "../sdk/durable-store.js";
import { ProcessExecutionError } from "../sdk/errors.js";
import { SpawnCommandRunner } from "../sdk/process-runner.js";
import { WebSocketConsumerConnector } from "../sdk/websocket-transport.js";
import { OpenClawApiRunner } from "../sdk/openclaw-api-runner.js";
import { HarnessAdapter, sanitizeProcessOutput } from "../harnesses/shared.js";
import { harnessDefinition } from "../harnesses/index.js";
import type {
  AdapterLog,
  AdapterLogger,
  HarnessCommandOverride,
  HarnessDefinition,
  HarnessId,
} from "../sdk/types.js";
import { TenantSchema } from "@cauce/protocol";
import { loadCliRuntimeConfig } from "./config.js";
import { CliTmux } from "../shared-session/tmux.js";
import { PasteSessionRunner } from "../shared-session/paste-runner.js";
import { correlationTimeoutFromEnvironment } from "../shared-session/paste-runner/runtime.js";
import { claudeTranscript } from "../shared-session/transcript.js";
import { codexTranscript } from "../shared-session/rollout.js";
import { grokTranscript } from "../shared-session/grok.js";
import type { PasteSessionOptions } from "../shared-session/paste-runner/contracts.js";
import { loadSharedSessionConfig, type SharedSessionConfig } from "../shared-session/config.js";
import { exactConversationIsSecure, sharedSessionResume } from "../shared-session/resume.js";
import { SharedTuiPointerStore } from "../shared-session/native-pointer.js";
import { NativePointerAttestor } from "../shared-session/native-witness.js";
import type { CommandRunner } from "../sdk/types.js";
import { EmissionRuntime } from "../sdk/mcp-emission/runtime.js";
import { emissionGateway } from "../sdk/mcp-emission/gateway.js";

function commandOverride(
  harnessId: HarnessId,
  definition: HarnessDefinition,
  runtime: Awaited<ReturnType<typeof loadCliRuntimeConfig>>,
): HarnessCommandOverride | undefined {
  const command = runtime.harnessCommand
    ?? (harnessId === "hermes" ? runtime.hermesPython : undefined)
    ?? definition.command;
  if (runtime.harnessCommand === undefined && runtime.hermesPython === undefined
    && runtime.harnessBridge === undefined) return undefined;
  return {
    command,
    ...(runtime.harnessBridge === undefined ? {} : { baseArgs: [runtime.harnessBridge] }),
  };
}

/**
 * Verifies that the bridge script contains the start marker before enabling `stderr-marker`.
 * If the bridge does not contain the marker or cannot be read, disables the start witness.
 */
function definitionWithVerifiedBridge(
  definition: HarnessDefinition,
  override: HarnessCommandOverride | undefined,
  logger: AdapterLogger,
): HarnessDefinition {
  const witness = definition.startWitness;
  if (witness?.kind !== "stderr-marker") return definition;
  const bridgePath = override?.baseArgs?.[0] ?? definition.baseArgs[0];
  const contents = bridgePath === undefined
    ? undefined
    : (() => {
      try {
        return readFileSync(bridgePath, "utf8");
      } catch {
        return undefined;
      }
    })();
  if (contents?.includes(witness.marker)) return definition;
  logger({
    event: "harness_start_witness_disabled",
    harness: definition.id,
    reason: contents === undefined ? "bridge_unreadable" : "bridge_without_start_marker",
  });
  const { startWitness: _startWitness, ...withoutWitness } = definition;
  void _startWitness;
  return withoutWitness;
}

/**
 * Narrows the packaged OpenClaw capabilities to the transport that will
 * actually execute this adapter instance. An omitted transport is CLI.
 */
export function runtimeHarnessDefinition(
  harnessId: HarnessId,
  definition: HarnessDefinition,
  openClawTransport: "cli" | "api" | undefined,
): HarnessDefinition {
  if (harnessId !== "openclaw") return definition;
  if (openClawTransport === "api") {
    return {
      ...definition,
      capabilities: {
        ...definition.capabilities,
        loopback_api: true,
        api_cancellation: "abort_signal",
      },
    };
  }

  const {
    loopback_api: _loopbackApi,
    api_cancellation: _apiCancellation,
    ...cliCapabilities
  } = definition.capabilities;
  void _loopbackApi;
  void _apiCancellation;
  return { ...definition, capabilities: cliCapabilities };
}

/**
 * Structured operational log emitting one JSON object per line to stderr.
 */
function operationalLogger(alias: string): AdapterLogger {
  return (entry: AdapterLog): void => {
    const line: Record<string, unknown> = {
      ts: entry.timestamp ?? new Date().toISOString(),
      alias: entry.alias ?? alias,
      ...entry,
    };
    delete line.timestamp;
    try {
      process.stderr.write(`${JSON.stringify(line)}\n`);
    } catch {
      // Observability must never be able to take the delivery loop down.
    }
  };
}

/**
 * Creates the canonical terminal runner without an alternative executor.
 */
export async function sharedSessionRunner(
  configured: SharedSessionConfig,
  logger: AdapterLogger,
): Promise<CommandRunner> {
  let shared = configured;
  if (configured.harness === "claude" || configured.harness === "grok") {
    try {
      shared = { ...configured,
        configDirectory: await realpath(configured.configDirectory),
        workspace: await realpath(configured.workspace) };
    } catch {
      logger({ event: "shared_session_degraded", alias: configured.alias,
        reason: "session_identity_unverified", error_message: "el binding de la TUI no está disponible" });
      throw new ProcessExecutionError("SHARED_TUI_UNAVAILABLE",
        "La terminal canónica no pudo acreditarse; el consumidor no aceptará pedidos hasta recuperar su binding",
        false);
    }
  }
  if (shared.nativeId !== undefined && (shared.harness === "claude" || shared.harness === "grok")) {
    await seedCanonicalConversation(shared, shared.harness, shared.nativeId, logger);
  }
  const tmux = new CliTmux();
  const sleep = (ms: number): Promise<void> =>
    new Promise<void>((resolveSleep) => {
      const timer = setTimeout(resolveSleep, ms);
      timer.unref();
    });
  const onDegradation = (degradation: { reason: string; detail: string }): void => {
    logger({
      event: "shared_session_degraded",
      alias: shared.alias,
      reason: degradation.reason,
      error_message: degradation.detail,
    });
  };
  const comun = {
    alias: shared.alias,
    harness: shared.harness,
    workspace: shared.workspace,
    environment: shared.paneEnvironment,
    harnessArguments: shared.harnessArguments,
    resume: sharedSessionResume(shared.harness, shared.configDirectory, shared.workspace, {
      alias: shared.alias, stateDirectory: shared.stateDirectory,
    }),
    tmux,
    sleep,
    quarantineFile: join(shared.stateDirectory, ".shared-session-quarantine"),
    correlationTimeoutMs: correlationTimeoutFromEnvironment(process.env),
    onDegradation,
    onNotice: (detail: string): void => {
      logger({ event: "shared_session_resume", alias: shared.alias, error_message: detail });
    },
  };
  switch (shared.harness) {
    case "claude":
    case "grok":
      return pointedRunner(shared, shared.harness, comun);
    case "codex":
      return new PasteSessionRunner({ ...comun, transcript: codexTranscript(shared.configDirectory) });
  }
}

async function seedCanonicalConversation( // Only while there is no pointer; logs, never stops the adapter.
  shared: SharedSessionConfig,
  harness: "claude" | "grok",
  nativeId: string,
  logger: AdapterLogger,
): Promise<void> {
  const binding = { alias: shared.alias, harness, configDirectory: shared.configDirectory, workspace: shared.workspace };
  let outcome: string;
  try {
    outcome = await exactConversationIsSecure(harness, binding, nativeId)
      ? await new SharedTuiPointerStore(shared.stateDirectory).seed(binding, nativeId)
      : "unverified";
  } catch {
    outcome = "unverified";
  }
  logger({
    event: "shared_session_resume",
    alias: shared.alias,
    error_message: outcome === "written"
      ? `la conversación canónica ${nativeId} quedó sembrada para la TUI compartida`
      : outcome === "unchanged"
        ? `la conversación canónica ${nativeId} ya era la sembrada`
        : outcome === "conflict"
          ? `no se sembró ${nativeId}: el puntero ya nombra otra conversación y nunca se reemplaza`
          : `no se sembró ${nativeId}: esa conversación no existe o no es segura en ${shared.configDirectory}`,
  });
}

function pointedRunner(
  shared: SharedSessionConfig,
  harness: "claude" | "grok",
  comun: Omit<PasteSessionOptions<unknown>, "transcript">,
): CommandRunner {
  const nativePointer = new NativePointerAttestor(new SharedTuiPointerStore(shared.stateDirectory), {
    alias: shared.alias, harness, configDirectory: shared.configDirectory, workspace: shared.workspace,
  });
  return harness === "grok"
    ? new PasteSessionRunner({ ...comun, transcript: grokTranscript(shared.configDirectory), nativePointer })
    : new PasteSessionRunner({
      ...comun,
      transcript: claudeTranscript(shared.configDirectory, shared.workspace),
      nativePointer,
    });
}

export async function runCli(harnessId: HarnessId): Promise<void> {
  const runtime = await loadCliRuntimeConfig(harnessId);
  const tenantId = TenantSchema.parse(runtime.tenant);
  const definition = runtimeHarnessDefinition(
    harnessId,
    harnessDefinition(harnessId),
    runtime.openClaw?.transport,
  );
  const canonicalOpenClawTerminalSession = harnessId === "openclaw";
  const store = await DurableStore.open(
    runtime.stateDirectory,
    canonicalOpenClawTerminalSession
      ? { deferSessions: true }
      : {},
  );
  let baseRunner: CommandRunner;
  if (harnessId === "openclaw" && runtime.openClaw?.transport === "api") {
    const { apiUrl, tokenFile } = runtime.openClaw;
    if (apiUrl === undefined || tokenFile === undefined) {
      throw new Error("OpenClaw API transport requires CAUCE_OPENCLAW_API_URL and CAUCE_OPENCLAW_TOKEN_FILE");
    }
    baseRunner = new OpenClawApiRunner({
      endpoint: apiUrl,
      tokenFile,
      ...(runtime.openClaw.agentTarget === undefined ? {} : { agentTarget: runtime.openClaw.agentTarget }),
    });
  } else {
    baseRunner = new SpawnCommandRunner();
  }
  const logger = operationalLogger(runtime.alias);
  const shared = loadSharedSessionConfig(harnessId, runtime.alias, runtime.stateDirectory);
  const runner = shared === undefined
    ? baseRunner
    : await sharedSessionRunner(shared, logger);
  const override = commandOverride(harnessId, definition, runtime);
  const harness = new HarnessAdapter({
    definition: definitionWithVerifiedBridge(definition, override, logger),
    runner,
    store,
    sessionNamespace: runtime.alias,
    ...(harnessId === "openclaw" ? { fallbackSessionKey: "alias-default" } : {}),
    ...(override === undefined ? {} : { commandOverride: override }),
    ...(shared === undefined ? {} : {
      sharedSession: {
        alias: shared.alias,
        harness: shared.harness,
        stateDirectory: shared.stateDirectory,
      },
    }),
  });
  const emission = new EmissionRuntime(runtime.stateDirectory, runtime.instanceId, emissionGateway(runtime));
  const client = new AdapterClient({
    emission,
    egressReceipts: new HttpEgressReceiptSource(emissionGateway(runtime), { tenant_id: runtime.tenant, alias: runtime.alias }),
    config: {
      tenantId,
      alias: runtime.alias,
      ownRoom: runtime.room,
      instanceId: runtime.instanceId,
      stateDirectory: runtime.stateDirectory,
      heartbeatMs: runtime.heartbeatMs,
      defaultTimeoutMs: runtime.defaultTimeoutMs,
    },
    connector: new WebSocketConsumerConnector(runtime.relayUrl, {
      environment: runtime.environment,
      alias: runtime.alias,
      logger,
      ...(runtime.bearerTokenFile === undefined ? {} : { bearerTokenFile: runtime.bearerTokenFile }),
      ...(runtime.mutualTls === undefined ? {} : { mutualTls: runtime.mutualTls }),
      ...(runtime.developmentIdentity
        ? { developmentIdentity: { tenant_id: tenantId, alias: runtime.alias } }
        : {}),
    }),
    store,
    harness,
    onLeaseAcquired: async () => {
      await emission.listen();
      if (canonicalOpenClawTerminalSession) {
        await store.reconcileCanonicalOpenClawTerminalSession(runtime.alias);
      }
      if (shared?.harness === "claude" || shared?.harness === "grok") {
        try {
          await new SharedTuiPointerStore(shared.stateDirectory).recover();
        } catch {
          logger({ event: "shared_session_resume", alias: shared.alias,
            error_message: "la recuperación del pointer TUI es ambigua; se conserva el estado" });
        }
      }
    },
    onError: (code) => process.stderr.write(`${code}: adapter retry\n`),
    logger,
  });

  const shutdown = new AbortController();
  const stop = (): void => { shutdown.abort(new Error("shutdown")); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await client.run(shutdown.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    await emission.close();
  }
}

/**
 * Emits the fatal failure cause to stderr (sanitized) and exits the process with code 1.
 */
export function reportFatal(error: unknown): never {
  const code = error instanceof Error && "code" in error ? String(error.code) : "ADAPTER_FATAL";
  const cause = sanitizeProcessOutput(error instanceof Error ? error.message : String(error));
  process.stderr.write(`${code}: adapter stopped${cause.length === 0 ? "" : `: ${cause}`}\n`);
  process.exit(1);
}
