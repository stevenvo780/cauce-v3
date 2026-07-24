import { AdapterClient } from "../sdk/client.js";
import { DurableStore } from "../sdk/durable-store.js";
import { SpawnCommandRunner } from "../sdk/process-runner.js";
import { WebSocketConsumerConnector } from "../sdk/websocket-transport.js";
import { OpenClawApiRunner } from "../sdk/openclaw-api-runner.js";
import { HarnessAdapter } from "../harnesses/shared.js";
import { harnessDefinition } from "../harnesses/index.js";
import type { HarnessCommandOverride, HarnessDefinition, HarnessId } from "../sdk/types.js";
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
  const client = new AdapterClient({
    config: {
      tenantId,
      alias: runtime.alias,
      instanceId: runtime.instanceId,
      stateDirectory: runtime.stateDirectory,
      heartbeatMs: runtime.heartbeatMs,
      defaultTimeoutMs: runtime.defaultTimeoutMs,
    },
    connector: new WebSocketConsumerConnector(runtime.relayUrl, {
      environment: runtime.environment,
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

export function reportFatal(error: unknown): never {
  const code = error instanceof Error && "code" in error ? String(error.code) : "ADAPTER_FATAL";
  process.stderr.write(`${code}: adapter stopped\n`);
  process.exit(1);
}
