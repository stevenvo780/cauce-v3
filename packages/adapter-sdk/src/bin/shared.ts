import { readFileSync } from "node:fs";
import { join } from "node:path";
import { AdapterClient } from "../sdk/client.js";
import { DurableStore } from "../sdk/durable-store.js";
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
import { claudeTranscript } from "../shared-session/transcript.js";
import { codexTranscript } from "../shared-session/rollout.js";
import { loadSharedSessionConfig, type SharedSessionConfig } from "../shared-session/config.js";
import { sharedSessionResume } from "../shared-session/resume.js";
import type { CommandRunner } from "../sdk/types.js";

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
 * Verifica que el script del puente contenga la marca de inicio antes de habilitar `stderr-marker`.
 * Si el puente no contiene la marca o no se puede leer, desactiva el testigo de inicio.
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
  if (contents !== undefined && contents.includes(witness.marker)) return definition;
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
 * Envuelve el runner base con el runner de sesión compartida cuando está configurada.
 */
function sharedSessionRunner(
  shared: SharedSessionConfig,
  fallback: CommandRunner,
  logger: AdapterLogger,
): CommandRunner {
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
    resume: sharedSessionResume(shared.harness, shared.configDirectory, shared.workspace),
    tmux,
    fallback,
    sleep,
    quarantineFile: join(shared.stateDirectory, ".shared-session-quarantine"),
    onDegradation,
    onNotice: (detail: string): void => {
      logger({ event: "shared_session_resume", alias: shared.alias, error_message: detail });
    },
  };
  return shared.harness === "claude"
    ? new PasteSessionRunner({
      ...comun,
      transcript: claudeTranscript(shared.configDirectory, shared.workspace),
    })
    : new PasteSessionRunner({
      ...comun,
      transcript: codexTranscript(shared.configDirectory),
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
  const canonicalOpenCodeSession = harnessId === "opencode" && runtime.alias === "kant";
  const canonicalOpenClawTerminalSession = harnessId === "openclaw";
  const store = await DurableStore.open(
    runtime.stateDirectory,
    canonicalOpenCodeSession || canonicalOpenClawTerminalSession
      ? { deferSessions: true }
      : {},
  );
  const baseRunner = harnessId === "openclaw" && runtime.openClaw?.transport === "api"
    ? new OpenClawApiRunner({
      endpoint: runtime.openClaw.apiUrl!,
      tokenFile: runtime.openClaw.tokenFile!,
      ...(runtime.openClaw.agentTarget === undefined ? {} : { agentTarget: runtime.openClaw.agentTarget }),
    })
    : new SpawnCommandRunner();
  const logger = operationalLogger(runtime.alias);
  const shared = loadSharedSessionConfig(harnessId, runtime.alias, runtime.stateDirectory);
  const runner = shared === undefined
    ? baseRunner
    : sharedSessionRunner(shared, baseRunner, logger);
  const override = commandOverride(harnessId, definition, runtime);
  const harness = new HarnessAdapter({
    definition: definitionWithVerifiedBridge(definition, override, logger),
    runner,
    store,
    sessionNamespace: runtime.alias,
    ...(canonicalOpenCodeSession ? { canonicalOpenCodeSession: true } : {}),
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
  const client = new AdapterClient({
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
    ...(canonicalOpenCodeSession || canonicalOpenClawTerminalSession
      ? {
          onLeaseAcquired: async () => {
            if (canonicalOpenCodeSession) {
              await store.reconcileCanonicalOpenCodeSession();
            }
            if (canonicalOpenClawTerminalSession) {
              await store.reconcileCanonicalOpenClawTerminalSession(runtime.alias);
            }
          },
        }
      : {}),
    onError: (code) => process.stderr.write(`${code}: adapter retry\n`),
    logger,
  });

  const shutdown = new AbortController();
  const stop = (): void => shutdown.abort(new Error("shutdown"));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  try {
    await client.run(shutdown.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

/**
 * Emite la causa de fallo fatal a stderr (sanitizada) y finaliza el proceso con código 1.
 */
export function reportFatal(error: unknown): never {
  const code = error instanceof Error && "code" in error ? String(error.code) : "ADAPTER_FATAL";
  const cause = sanitizeProcessOutput(error instanceof Error ? error.message : String(error));
  process.stderr.write(`${code}: adapter stopped${cause.length === 0 ? "" : `: ${cause}`}\n`);
  process.exit(1);
}
