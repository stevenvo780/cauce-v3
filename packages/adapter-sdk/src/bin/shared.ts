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
 * Structured operational log, one JSON object per line on stderr, which is where the
 * unit journal already collects the adapter's `onError` retry lines.
 *
 * This exists wired rather than optional on purpose. An adapter whose harness has a bad
 * credential still holds its lease and still answers `auth status`, so the only signal
 * that separates a working alias from a dead one is the cadence of its `started` ACKs —
 * the `claim_renewal_start` entries below. Leaving the logger defaulted to a no-op in
 * production is what made that cadence invisible.
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

export async function runCli(harnessId: HarnessId): Promise<void> {
  const runtime = await loadCliRuntimeConfig(harnessId);
  const tenantId = TenantSchema.parse(runtime.tenant);
  const definition = runtimeHarnessDefinition(
    harnessId,
    harnessDefinition(harnessId),
    runtime.openClaw?.transport,
  );
  const canonicalOpenCodeSession = harnessId === "opencode" && runtime.alias === "kant";
  const store = await DurableStore.open(
    runtime.stateDirectory,
    canonicalOpenCodeSession ? { deferSessions: true } : {},
  );
  const runner = harnessId === "openclaw" && runtime.openClaw?.transport === "api"
    ? new OpenClawApiRunner({
      endpoint: runtime.openClaw.apiUrl!,
      tokenFile: runtime.openClaw.tokenFile!,
      ...(runtime.openClaw.agentTarget === undefined ? {} : { agentTarget: runtime.openClaw.agentTarget }),
    })
    : new SpawnCommandRunner();
  const override = commandOverride(harnessId, definition, runtime);
  const harness = new HarnessAdapter({
    definition,
    runner,
    store,
    sessionNamespace: runtime.alias,
    ...(canonicalOpenCodeSession ? { canonicalOpenCodeSession: true } : {}),
    ...(harnessId === "openclaw" ? { fallbackSessionKey: "alias-default" } : {}),
    ...(override === undefined ? {} : { commandOverride: override }),
  });
  const logger = operationalLogger(runtime.alias);
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
    ...(canonicalOpenCodeSession
      ? { onLeaseAcquired: () => store.reconcileCanonicalOpenCodeSession().then(() => undefined) }
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
 * Un adaptador que muere tiene que decir POR QUE.
 *
 * La version anterior escribia solo `ADAPTER_FATAL: adapter stopped`. Con eso, una variable de
 * entorno faltante, un certificado vencido y un relay inalcanzable son la MISMA linea, y quien
 * lee el journal no puede distinguirlas. Asi es como la suite e2e paso cuatro dias muerta por un
 * `Required configuration 'CAUCE_ROOM' is missing` que nadie llego a leer nunca: el arranque
 * conocia la causa exacta y la tiraba a la basura.
 *
 * La causa pasa por el mismo redactor que el stderr de los harnesses, porque este texto termina
 * en journals y en `last_error`, que leen los agentes.
 */
export function reportFatal(error: unknown): never {
  const code = error instanceof Error && "code" in error ? String(error.code) : "ADAPTER_FATAL";
  const cause = sanitizeProcessOutput(error instanceof Error ? error.message : String(error));
  process.stderr.write(`${code}: adapter stopped${cause.length === 0 ? "" : `: ${cause}`}\n`);
  process.exit(1);
}
