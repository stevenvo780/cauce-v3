import type { HarnessAdapterOptions } from "../contracts/harness.js";
import { HttpEgressReceiptSource } from "../sdk/egress-receipt-source.js";
import { readFileSync } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { AdapterClient } from "../sdk/client.js";
import { bootstrapOnStartup } from "../sdk/bootstrap-runner.js";
import { BlobClient, configureDefaultBlobClient } from "../sdk/blob-client.js";
import { ContextIngestClient, configureDefaultContextIngestClient } from "../sdk/context-ingest-client.js";
import { DurableStore } from "../sdk/durable-store.js";
import { ProcessExecutionError } from "../sdk/errors.js";
import { systemClock } from '../sdk/backoff.js';
import { SpawnCommandRunner } from "../sdk/process-runner.js";
import { WebSocketConsumerConnector } from "../sdk/websocket-transport.js";
import { OpenClawApiRunner } from "../sdk/openclaw-api-runner.js";
import { HarnessAdapter, sanitizeProcessOutput } from "../harnesses/shared.js";
import type {
  AdapterLog,
  AdapterLogger,
  HarnessCommandOverride,
  HarnessDefinition,
  HarnessId,
} from "../sdk/types.js";
import { TenantSchema } from "@cauce/protocol";
import { loadCliRuntimeConfig } from "./config.js";
import { CliTmux, type TmuxController } from "../shared-session/tmux.js";
import { ensureSharedSession, waitForAccreditedTui, type SharedSessionSpec } from '../shared-session/session.js';
import { PasteSessionRunner } from "../shared-session/paste-runner.js";
import { correlationTimeoutFromEnvironment } from "../shared-session/paste-runner/runtime.js";
import { claudeTranscript } from "../shared-session/transcript.js";
import { codexTranscript } from "../shared-session/rollout.js";
import { grokTranscript } from "../shared-session/grok.js";
import { museTranscript } from "../shared-session/muse.js";
import { prepareMuseProfile } from '../shared-session/muse-profile.js';
import { prepareGrokWorkspace } from '../shared-session/grok-trust.js';
import type { PasteSessionOptions } from "../shared-session/paste-runner/contracts.js";
import { loadSharedSessionConfig, type SharedSessionConfig } from "../shared-session/config.js";
import { exactConversationIsSecure, sharedSessionResume } from "../shared-session/resume.js";
import { SharedTuiPointerStore } from "../shared-session/native-pointer.js";
import { adoptCreatedCodexConversation, codexConversationTreeIsEmpty, codexSharedPointerKey, seedUnpointedCodexConversation } from '../shared-session/codex-resume.js';
import { NativePointerAttestor } from "../shared-session/native-witness.js";
import type { CommandRunner } from "../sdk/types.js";
import { EmissionRuntime } from "../sdk/mcp-emission/runtime.js";
import { emissionGateway } from "../sdk/mcp-emission/gateway.js";
import { decisionesForwarder } from "../sdk/mcp-emission/decisiones.js";
import { commandPinsFromEnvironment } from '../sdk/command-pins.js';
import { selectionFromEnvironment } from '../sdk/execution-selection.js';
import { definitionFromDescriptor, packagedHarnessDescriptor } from '../context/harness-descriptor.js';
import { prepareSpaceLayout } from '../context/space-layout.js';
import { fallbackServerDefinition, modelFallbackCommand, superviseModelFallback } from '../sdk/model-fallback-server.js';

function commandOverride(
  harnessId: HarnessId,
  definition: HarnessDefinition,
  runtime: Awaited<ReturnType<typeof loadCliRuntimeConfig>>,
): HarnessCommandOverride | undefined {
  const command = runtime.harnessCommand
    ?? (harnessId === "muse" ? runtime.muse?.executable : undefined)
    ?? (harnessId === "hermes" ? runtime.hermesPython : undefined)
    ?? definition.command;
  if (runtime.harnessCommand === undefined && runtime.muse === undefined && runtime.hermesPython === undefined) return undefined;
  return { command };
}

/** Verifies the bridge has the start marker before enabling `stderr-marker`; disables the start witness if it lacks the marker or cannot be read. */
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

export function deliveryHarnesses(options: HarnessAdapterOptions, headlessRunner: CommandRunner): {
  readonly harness: HarnessAdapter; readonly humanHarness?: HarnessAdapter;
} {
  const harness = new HarnessAdapter(options);
  const openClaw = options.definition.id === "openclaw";
  // Muse (`muse-cauce exec`) and grok (`--prompt-file`) run headless unless a shared TUI is configured:
  // a human then gets its own session namespace, exactly as with codex/claude.
  const headlessNative = (options.definition.id === "muse" || options.definition.id === "grok") && options.sharedSession === undefined;
  if (options.definition.id !== "claude" && options.definition.id !== "codex" && !openClaw && !headlessNative) return { harness };
  // An OpenClaw override that keeps the packaged bridge (no baseArgs, or exactly that bridge)
  // is the verified transport the fleet pins by digest; only an override pointing elsewhere
  // is an arbitrary command that must not receive isolated human sessions.
  const openClawVerifiedTransport = !openClaw || options.commandOverride?.baseArgs === undefined
    || (options.commandOverride.baseArgs.length === 1
      && options.commandOverride.baseArgs[0] === options.definition.baseArgs[0]);
  if (openClaw && !openClawVerifiedTransport) return { harness };
  const { sharedSession, fallbackSessionKey, ...headless } = options;
  void sharedSession;
  return { harness, humanHarness: new HarnessAdapter({ ...headless, runner: headlessRunner,
    ...(!openClaw && fallbackSessionKey !== undefined ? { fallbackSessionKey } : {}),
    ...(openClaw ? { canonicalTerminalSession: false } : {}),
    sessionNamespace: openClaw
      ? `human-initiator-v1.${options.sessionNamespace ?? options.definition.id}`
      : `${options.sessionNamespace ?? options.definition.id}:human-initiator-v1` }) };
}

/** The runner that executes this adapter's agent turns: the spawned CLI, a shared TUI, OpenClaw's API or Muse MSP. */
export type AgentTurnRunner = "process" | "shared" | "openclaw-api" | "muse-msp";
const PROCESS_WITNESSES: ReadonlySet<HarnessId> = new Set<HarnessId>(["claude", "codex", "openclaw", "grok"]);
const SHARED_WITNESSES: ReadonlySet<HarnessId> = new Set<HarnessId>(["claude", "codex", "muse"]);

/**
 * Announces `context_adoption_v1` only when the runner of agent turns returns a consumption witness, the evidence an ACK needs
 * to accredit a versioned context: the spawned CLI of claude, codex, OpenClaw and Grok, and the shared TUI of claude, codex and
 * Muse. Muse headless (`muse-cauce exec` or MSP), Grok in a TUI and OpenClaw's API never witness, so the gateway tells the
 * operator so instead of spending dedicated turns that cannot succeed.
 */
export function withContextAdoption(definition: HarnessDefinition, runner: AgentTurnRunner): HarnessDefinition {
  const witnesses = runner === "process" ? PROCESS_WITNESSES.has(definition.id)
    : runner === "shared" && SHARED_WITNESSES.has(definition.id);
  if (!witnesses || definition.capabilities.versioned_context_v1 !== true) return definition;
  return { ...definition, capabilities: { ...definition.capabilities, context_adoption_v1: true } };
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

async function checkedSharedSessionConfig(
  configured: SharedSessionConfig,
  logger: AdapterLogger,
  signal?: AbortSignal,
): Promise<SharedSessionConfig> {
  let shared = configured;
  if (configured.harness !== "codex") {
    try {
      if (configured.harness === "muse") await prepareMuseProfile(configured.paneEnvironment);
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
  if (shared.harness === 'grok') {
    await prepareGrokWorkspace(sharedSessionSpec(shared), signal);
    logger({ event: 'shared_session_resume', alias: shared.alias, reason: 'workspace_trusted',
      error_message: 'Confianza nativa preparada para el workspace aprobado de Grok.' });
  }
  return shared;
}

function sharedSessionSpec(shared: SharedSessionConfig): SharedSessionSpec {
  return {
    alias: shared.alias, harness: shared.harness, workspace: shared.workspace, environment: shared.paneEnvironment,
    ...(shared.unsetEnvironment === undefined ? {} : { unsetEnvironment: shared.unsetEnvironment }),
    harnessArguments: shared.harnessArguments,
    ...(shared.command === undefined ? {} : { command: shared.command }),
    ...(shared.commandPins === undefined ? {} : { commandPins: shared.commandPins }),
    ...(shared.requiredArguments === undefined ? {} : { requiredArguments: shared.requiredArguments }),
    resume: sharedSessionResume(shared.harness, shared.configDirectory, shared.workspace, {
      alias: shared.alias, stateDirectory: shared.stateDirectory,
      ...(shared.namespace === undefined ? {} : { namespace: shared.namespace }),
      ...(shared.requireResume === undefined ? {} : { requireResume: shared.requireResume }),
    }),
  };
}

export async function ensureSharedSessionStartup(
  configured: SharedSessionConfig, logger: AdapterLogger, tmux: TmuxController = new CliTmux(), parentSignal?: AbortSignal,
  publishCodexConversation?: (nativeId: string) => Promise<boolean>,
): Promise<void> {
  const signal = parentSignal ?? new AbortController().signal;
  signal.throwIfAborted();
  const shared = await checkedSharedSessionConfig(configured, logger, signal);
  signal.throwIfAborted();
  const boundedTmux: TmuxController = { run: (args, stdin, control) => tmux.run(args, stdin, {
    ...control, timeoutMs: Math.min(control?.timeoutMs ?? 1000, 1000),
    signal: control?.signal === undefined ? signal : AbortSignal.any([signal, control.signal]),
  }) };
  const spec = sharedSessionSpec(shared);
  const options = { signal, sleep: (ms: number) => systemClock.sleep(ms, signal).catch((error: unknown) => {
    if (!signal.aborted) throw error;
  }) };
  const codex = shared.harness === 'codex' && shared.namespace !== undefined && publishCodexConversation !== undefined
    ? { stateDirectory: shared.stateDirectory, configDirectory: shared.configDirectory, namespace: shared.namespace, workspace: shared.workspace }
    : undefined;
  const emptyCodexTree = codex !== undefined && await codexConversationTreeIsEmpty(codex);
  if (codex !== undefined && !emptyCodexTree && publishCodexConversation !== undefined) {
    const seeded = await seedUnpointedCodexConversation(codex, publishCodexConversation);
    if (seeded !== undefined) logger({ event: 'shared_session_resume', alias: shared.alias,
      error_message: `la conversación previa ${seeded} de Codex quedó como puntero canónico antes de crear la TUI` });
  }
  const result = await ensureSharedSession(boundedTmux, spec, { ...options, readyTimeoutMs: 0 });
  const readiness = result.pane !== undefined && (result.ready || result.failure === 'tui_absent' || result.failure === 'provider_login_required')
    ? await waitForAccreditedTui(boundedTmux, spec, result.pane, { ...options,
      log: () => { logger({ event: 'shared_session_pending', alias: shared.alias, reason: 'tui_starting' }); } })
    : undefined;
  if ((readiness !== 'ready' && readiness !== 'login_required') || signal.aborted) {
    logger({ event: 'shared_session_degraded', alias: shared.alias,
      reason: signal.aborted ? 'startup_cancelled' : readiness === 'changed'
        ? 'session_identity_unverified' : result.failure ?? 'tui_absent',
      detail: `ensure: ${result.detail}; readiness: ${readiness ?? 'none'}`,
      error_message: 'La TUI canónica no quedó acreditada al adquirir el lease.' });
    throw new ProcessExecutionError('SHARED_TUI_UNAVAILABLE',
      `La terminal canónica no está disponible para iniciar el consumidor: ${result.detail}`, false);
  }
  if (readiness === 'ready' && codex !== undefined && emptyCodexTree && result.created && result.resumed !== true && publishCodexConversation !== undefined) {
    const adopted = await adoptCreatedCodexConversation(codex, publishCodexConversation, options.sleep, signal);
    logger({ event: 'shared_session_resume', alias: shared.alias, error_message: adopted === undefined
      ? 'la conversación nueva de Codex no quedó acreditada al crearse; la publicará su primer turno'
      : `la conversación nueva ${adopted} de Codex quedó como puntero canónico al crearse` });
  }
}

/** Creates the canonical terminal runner without an alternative executor. */
export async function sharedSessionRunner(
  configured: SharedSessionConfig,
  logger: AdapterLogger,
): Promise<CommandRunner> {
  const shared = await checkedSharedSessionConfig(configured, logger);
  if (shared.nativeId !== undefined && shared.harness !== "codex") {
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
    ...sharedSessionSpec(shared),
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
    case "muse":
      return pointedRunner(shared, shared.harness, comun);
    case "codex":
      return new PasteSessionRunner({ ...comun, transcript: codexTranscript(shared.configDirectory) });
  }
}

async function seedCanonicalConversation( // Only while there is no pointer; logs, never stops the adapter.
  shared: SharedSessionConfig,
  harness: "claude" | "grok" | "muse",
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
  harness: "claude" | "grok" | "muse",
  comun: Omit<PasteSessionOptions<unknown>, "transcript">,
): CommandRunner {
  const nativePointer = new NativePointerAttestor(new SharedTuiPointerStore(shared.stateDirectory), {
    alias: shared.alias, harness, configDirectory: shared.configDirectory, workspace: shared.workspace,
  });
  if (harness === "muse") {
    return new PasteSessionRunner({ ...comun, transcript: museTranscript(shared.configDirectory), nativePointer });
  }
  return harness === "grok"
    ? new PasteSessionRunner({ ...comun, transcript: grokTranscript(shared.configDirectory), nativePointer })
    : new PasteSessionRunner({
      ...comun,
      transcript: claudeTranscript(shared.configDirectory, shared.workspace),
      nativePointer,
    });
}

export function configureGatewayHttpClients(
  runtime: { readonly relayUrl: string; readonly bearerTokenFile?: string;
    readonly mutualTls?: { readonly certFile: string; readonly keyFile: string; readonly caFile: string };
    readonly developmentIdentity: boolean; readonly alias: string },
  tenantId: string,
): void {
  const options = {
    ...(runtime.bearerTokenFile === undefined ? {} : { bearerTokenFile: runtime.bearerTokenFile }),
    ...(runtime.mutualTls === undefined ? {} : { mutualTls: runtime.mutualTls }),
    ...(runtime.developmentIdentity ? { developmentIdentity: { tenant_id: tenantId, alias: runtime.alias } } : {}),
  };
  configureDefaultBlobClient(BlobClient.fromRelayUrl(runtime.relayUrl, options));
  configureDefaultContextIngestClient(ContextIngestClient.fromRelayUrl(runtime.relayUrl, options));
}

export async function runCli(harnessId: HarnessId): Promise<void> {
  const descriptor = await packagedHarnessDescriptor(harnessId);
  const spaceRoot = process.env.CAUCE_SPACE_ROOT;
  if (spaceRoot !== undefined) await prepareSpaceLayout(spaceRoot);
  const runtime = await loadCliRuntimeConfig(harnessId);
  const commandPins = commandPinsFromEnvironment(); let selected = selectionFromEnvironment(harnessId);
  if (commandPins !== undefined && runtime.harnessCommand !== undefined && runtime.harnessCommand !== commandPins.command) throw new Error('configured harness command differs from its pinned binding');
  const tenantId = TenantSchema.parse(runtime.tenant);
  const fallbackServer = harnessId === "muse" ? modelFallbackCommand() : undefined;
  if (harnessId === "muse" && runtime.muse !== undefined && !(await stat(runtime.muse.workspace).then((entry) => entry.isDirectory(), () => false))) {
    throw new Error("Muse workspace must be an existing directory");
  }
  // Muse: default `muse-cauce exec` (hegel); MSP only with explicit config, loaded lazily.
  const museMsp = harnessId === "muse" && runtime.muse !== undefined;
  if (museMsp && runtime.harnessCommand !== undefined
    && runtime.harnessCommand !== runtime.muse.executable) {
    throw new Error("CAUCE_HARNESS_COMMAND conflicts with CAUCE_MUSE_EXECUTABLE");
  }
  if (fallbackServer !== undefined && museMsp) throw new Error("a model fallback server runs Muse only through muse-cauce exec");
  const packaged = runtimeHarnessDefinition(
    harnessId,
    museMsp ? (await import("../harnesses/muse-msp.js")).museMspDefinition : definitionFromDescriptor(descriptor),
    runtime.openClaw?.transport,
  );
  const definition = fallbackServer === undefined ? packaged : fallbackServerDefinition(packaged);
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
  } else if (museMsp) {
    const { MuseMspRunner } = await import("../sdk/muse-msp-runner.js");
    baseRunner = new MuseMspRunner(runtime.muse);
  } else {
    // `muse exec --json` emits ~0.5 KB per text fragment and ~25 KB of lifecycle events per tool call.
    baseRunner = new SpawnCommandRunner(harnessId === "muse" ? { maxOutputBytes: 32 * 1024 * 1024 } : {});
  }
  const logger = operationalLogger(runtime.alias);
  const override = commandOverride(harnessId, definition, commandPins === undefined ? runtime : { ...runtime, harnessCommand: commandPins.command });
  if (!await bootstrapOnStartup({ tenant_id: runtime.tenant, alias: runtime.alias,
    definition: definitionWithVerifiedBridge(definition, override, logger), runner: baseRunner, executionSelection: selected,
    onSelection: value => { selected = value; },
    ...(commandPins === undefined ? {} : { commandPins }),
    ...(runtime.mutualTls === undefined ? {} : { tls: runtime.mutualTls }),
    ...(override === undefined ? {} : { commandOverride: override }),
  })) return;
  const shared = loadSharedSessionConfig(harnessId, runtime.alias, runtime.stateDirectory, { ...process.env,
    ...(selected.modelId === undefined ? {} : { CAUCE_MODEL_ID: selected.modelId }),
    ...(selected.reasoningEffort === undefined ? {} : { CAUCE_REASONING_EFFORT: selected.reasoningEffort }) });
  if (fallbackServer !== undefined && shared !== undefined) {
    throw new Error("a model fallback server cannot run a shared Muse TUI: its own turns must stay without shell or write tools");
  }
  if (museMsp && shared !== undefined) {
    // The shared TUI replaces the runner: MSP would be configured and silently never used.
    throw new Error("Muse MSP (CAUCE_MUSE_EXECUTABLE) and SHARED_SESSION=1 are mutually exclusive");
  }
  const codexNamespace = shared?.harness === 'codex' ? shared.namespace : undefined;
  const runner = shared === undefined
    ? baseRunner
    : await sharedSessionRunner(shared, logger);
  const agentTurns: AgentTurnRunner = shared !== undefined ? "shared" : museMsp ? "muse-msp"
    : harnessId === "openclaw" && runtime.openClaw?.transport === "api" ? "openclaw-api" : "process";
  const { harness, humanHarness } = deliveryHarnesses({
    definition: definitionWithVerifiedBridge(withContextAdoption(definition, agentTurns), override, logger),
    runner,
    store,
    executionSelection: selected,
    ...(commandPins === undefined ? {} : { commandPins }),
    sessionNamespace: runtime.alias,
    ...(harnessId === "openclaw" || museMsp ? { fallbackSessionKey: "alias-default" } : {}),
    ...(override === undefined ? {} : { commandOverride: override }),
    ...(shared === undefined ? {} : {
      sharedSession: {
        alias: shared.alias,
        harness: shared.harness,
        stateDirectory: shared.stateDirectory,
      },
    }),
  }, baseRunner);
  const emission = new EmissionRuntime(
    runtime.stateDirectory, runtime.instanceId, emissionGateway(runtime),
    decisionesForwarder(runtime.decisionesUrl, runtime.mutualTls),
    { tenant: runtime.tenant, room: runtime.room, alias: runtime.alias },
  );
  if (runner instanceof PasteSessionRunner && shared?.harness === "grok") emission.trackPromptOrigin(() => runner.lastUserPromptOrigin()); // Only grok's shapes are measured.
  else if (shared !== undefined) emission.refuseOutsideDelivery(`fuera de una entrega todavía no se envía desde una TUI de ${shared.harness}`);
  try {
    configureGatewayHttpClients(runtime, tenantId);
  } catch (error) {
    process.stderr.write(`blob client disabled: ${String(error instanceof Error ? error.message : error)}\n`);
  }
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
    ...(humanHarness === undefined ? {} : { humanHarness }),
    onLeaseAcquired: async () => {
      await emission.listen();
      if (canonicalOpenClawTerminalSession) {
        await store.reconcileCanonicalOpenClawTerminalSession(runtime.alias);
      }
      if (shared !== undefined && shared.harness !== "codex") {
        try {
          await new SharedTuiPointerStore(shared.stateDirectory).recover();
        } catch {
          logger({ event: "shared_session_resume", alias: shared.alias,
            error_message: "la recuperación del pointer TUI es ambigua; se conserva el estado" });
        }
      }
      if (shared !== undefined) {
        await ensureSharedSessionStartup(shared, logger, undefined, shutdown.signal, codexNamespace === undefined ? undefined
          : async (nativeId) => {
            const key = codexSharedPointerKey(codexNamespace);
            if (store.getSession(key) !== undefined) return false;
            await store.setSession(key, { native_id: nativeId, initialized: true });
            return true;
          });
      }
    },
    onError: (code) => process.stderr.write(`${code}: adapter retry\n`),
    logger,
  });

  const shutdown = new AbortController();
  const stop = (): void => { shutdown.abort(new Error("shutdown")); };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const fallback = fallbackServer === undefined ? undefined : superviseModelFallback(fallbackServer, logger, shutdown.signal);
  try {
    await client.run(shutdown.signal);
  } finally {
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
    if (fallback !== undefined) { stop(); await fallback; }
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
