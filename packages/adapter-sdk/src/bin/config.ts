import { readFile } from "node:fs/promises";
import { dirname, isAbsolute, resolve } from "node:path";
import { MAX_MESSAGE_TIMEOUT_MS, messageTimeoutMs } from "@cauce/protocol";
import { DEFAULT_MESSAGE_TIMEOUT_MS, DEFAULT_NO_PROGRESS_TIMEOUT_MS } from "../sdk/message-timeout.js";
import type { HarnessId } from "../sdk/types.js";
import type { MuseReasoningEffort, MuseRunnerConfig } from "../sdk/muse-msp-runner.js";

type RuntimeEnvironment = "production" | "development" | "test";

interface CliRuntimeConfig {
  readonly tenant: string;
  readonly room: string;
  readonly alias: string;
  readonly instanceId: string;
  readonly stateDirectory: string;
  readonly relayUrl: string;
  readonly environment: RuntimeEnvironment;
  readonly heartbeatMs: number;
  readonly defaultTimeoutMs: number;
  readonly bearerTokenFile?: string;
  readonly mutualTls?: { readonly certFile: string; readonly keyFile: string; readonly caFile: string };
  readonly developmentIdentity: boolean;
  /** Origin of the decisions service; reached with this alias's mTLS identity. */
  readonly decisionesUrl?: string;
  readonly harnessCommand?: string;
  readonly hermesPython?: string;
  readonly openClaw?: {
    readonly transport: "cli" | "api";
    readonly apiUrl?: string;
    readonly tokenFile?: string;
    readonly agentTarget?: string;
  };
  readonly muse?: MuseRunnerConfig;
}

type JsonObject = Record<string, unknown>;

function object(value: unknown, context: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${context} must be an object`);
  }
  return value as JsonObject;
}

function string(value: unknown, context: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${context} must be a non-empty string`);
  return value;
}

function onlyKeys(value: JsonObject, allowed: ReadonlySet<string>, context: string): void {
  const unknown = Object.keys(value).find((key) => !allowed.has(key));
  if (unknown !== undefined) throw new Error(`${context} contains unknown field '${unknown}'`);
}

function positiveInteger(value: unknown, context: string, fallback: number): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${context} must be a positive integer`);
  }
  return value;
}

function configuredMessageTimeoutMs(value: unknown, context: string, fallback: number): number {
  const candidate = value === undefined ? fallback : value;
  const parsed = messageTimeoutMs({ timeout_ms: candidate });
  if (parsed === undefined) {
    throw new Error(`${context} must be an integer between 1 and ${String(MAX_MESSAGE_TIMEOUT_MS)}`);
  }
  return parsed;
}

function environment(value: unknown): RuntimeEnvironment {
  if (value === undefined) return "production";
  if (value === "production" || value === "development" || value === "test") return value;
  throw new Error("environment must be production, development or test");
}

const ALLOWED_SECRET_PATH_KEYS = new Set(["token_file", "cert_file", "key_file", "ca_file"]);

function rejectInlineSecrets(value: unknown): void {
  if (Array.isArray(value)) {
    for (const child of value) rejectInlineSecrets(child);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:secret|token|password|passwd|private[_-]?key|authorization|cookie)/iu.test(key)
      && !ALLOWED_SECRET_PATH_KEYS.has(key)) {
      throw new Error("Inline secrets are forbidden; configure an owner-only credential file path");
    }
    rejectInlineSecrets(child);
  }
}

/** An https origin and nothing else: no credentials, path, query or fragment can ride in it. */
function decisionesOrigin(value: unknown, context: string): string | undefined {
  if (value === undefined) return undefined;
  const raw = string(value, context);
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${context} must be an https origin`); }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== ""
    || (url.pathname !== "/" && url.pathname !== "")) {
    throw new Error(`${context} must be an https origin`);
  }
  return url.origin;
}

function optionalPath(base: string, value: unknown, context: string): string | undefined {
  return value === undefined ? undefined : resolve(base, string(value, context));
}

function absolutePath(value: unknown, context: string): string {
  const path = string(value, context);
  if (!isAbsolute(path)) throw new Error(`${context} must be an absolute path`);
  return resolve(path);
}

const MUSE_REASONING_EFFORTS = new Set([
  "none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra",
]);

function museReasoningEffort(value: unknown): MuseReasoningEffort | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !MUSE_REASONING_EFFORTS.has(value)) {
    throw new Error("muse.reasoning_effort must be a supported MSP reasoning tier");
  }
  return value as MuseReasoningEffort;
}

function museApprovalMode(value: unknown): MuseRunnerConfig["approvalMode"] {
  if (value === undefined || value === "denyUnmatched") return "denyUnmatched";
  if (value === "onRequest") return "onRequest";
  if (value === "allowAll") return "allowAll";
  throw new Error("Muse approval mode must be denyUnmatched, onRequest or allowAll");
}

function museFromConfig(value: unknown, harnessId: HarnessId): MuseRunnerConfig | undefined {
  if (value === undefined) return undefined;
  if (harnessId !== "muse") throw new Error("muse configuration is only valid for the Muse adapter");
  const entry = object(value, "muse");
  onlyKeys(entry, new Set([
    "executable", "config_home", "data_home", "workspace", "model", "reasoning_effort", "approval_mode", "yolo",
  ]), "muse");
  const reasoningEffort = museReasoningEffort(entry.reasoning_effort);
  const approvalMode = museApprovalMode(entry.approval_mode);
  if (entry.yolo !== undefined && typeof entry.yolo !== "boolean") throw new Error("muse.yolo must be a boolean");
  if ((approvalMode === "allowAll") !== (entry.yolo === true)) {
    throw new Error("muse.yolo and allowAll must be configured together");
  }
  return {
    executable: absolutePath(entry.executable, "muse.executable"),
    configHome: absolutePath(entry.config_home, "muse.config_home"),
    dataHome: absolutePath(entry.data_home, "muse.data_home"),
    workspace: absolutePath(entry.workspace, "muse.workspace"),
    approvalMode,
    ...(entry.yolo === true ? { yolo: true } : {}),
    ...(entry.model === undefined ? {} : { model: string(entry.model, "muse.model") }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

/** Variables that only mean something to the MSP runner; one of them without the executable is a half-configured MSP alias. */
const MUSE_MSP_ONLY_ENVIRONMENT = [
  "CAUCE_MUSE_CONFIG_HOME", "CAUCE_MUSE_APPROVAL_MODE", "CAUCE_MUSE_YOLO",
  "CAUCE_MUSE_MODEL", "CAUCE_MUSE_REASONING_EFFORT",
] as const;

/**
 * Muse over MSP is opt-in: `CAUCE_MUSE_EXECUTABLE` selects it. Without it the muse alias keeps the
 * production `muse-cauce exec` path (and its shared TUI), exactly as before MSP existed. An
 * MSP-only variable without the executable fails closed instead of silently falling back to
 * `exec --yolo` (an alias asking for onRequest approval must never run YOLO). CAUCE_MUSE_DATA_HOME
 * and CAUCE_MUSE_WORKSPACE are not selectors: the shared TUI and the context measurement read them too.
 */
function museFromEnvironment(harnessId: HarnessId): MuseRunnerConfig | undefined {
  if (harnessId !== "muse") return undefined;
  if (process.env.CAUCE_MUSE_EXECUTABLE === undefined) {
    const orphan = MUSE_MSP_ONLY_ENVIRONMENT.find((name) => process.env[name] !== undefined);
    if (orphan !== undefined) throw new Error(`${orphan} requires CAUCE_MUSE_EXECUTABLE (Muse MSP)`);
    return undefined;
  }
  const reasoningEffort = museReasoningEffort(process.env.CAUCE_MUSE_REASONING_EFFORT);
  const approvalMode = museApprovalMode(process.env.CAUCE_MUSE_APPROVAL_MODE);
  const yolo = process.env.CAUCE_MUSE_YOLO;
  if (yolo !== undefined && yolo !== "1") throw new Error("CAUCE_MUSE_YOLO must be 1 when set");
  if ((approvalMode === "allowAll") !== (yolo === "1")) {
    throw new Error("CAUCE_MUSE_YOLO and allowAll must be configured together");
  }
  return {
    executable: absolutePath(requiredEnvironment("CAUCE_MUSE_EXECUTABLE"), "CAUCE_MUSE_EXECUTABLE"),
    configHome: absolutePath(requiredEnvironment("CAUCE_MUSE_CONFIG_HOME"), "CAUCE_MUSE_CONFIG_HOME"),
    dataHome: absolutePath(requiredEnvironment("CAUCE_MUSE_DATA_HOME"), "CAUCE_MUSE_DATA_HOME"),
    workspace: absolutePath(requiredEnvironment("CAUCE_MUSE_WORKSPACE"), "CAUCE_MUSE_WORKSPACE"),
    approvalMode,
    ...(yolo === "1" ? { yolo: true } : {}),
    ...(process.env.CAUCE_MUSE_MODEL === undefined
      ? {} : { model: string(process.env.CAUCE_MUSE_MODEL, "CAUCE_MUSE_MODEL") }),
    ...(reasoningEffort === undefined ? {} : { reasoningEffort }),
  };
}

function mtls(base: string, value: unknown): CliRuntimeConfig["mutualTls"] {
  if (value === undefined) return undefined;
  const entry = object(value, "mtls");
  onlyKeys(entry, new Set(["cert_file", "key_file", "ca_file"]), "mtls");
  return {
    certFile: resolve(base, string(entry.cert_file, "mtls.cert_file")),
    keyFile: resolve(base, string(entry.key_file, "mtls.key_file")),
    caFile: resolve(base, string(entry.ca_file, "mtls.ca_file")),
  };
}

function openClaw(base: string, value: unknown, harnessId: HarnessId): CliRuntimeConfig["openClaw"] {
  if (value === undefined) return undefined;
  if (harnessId !== "openclaw") throw new Error("openclaw configuration is only valid for the OpenClaw adapter");
  const entry = object(value, "openclaw");
  onlyKeys(entry, new Set(["transport", "api_url", "token_file", "agent_target"]), "openclaw");
  const transport = entry.transport ?? "cli";
  if (transport !== "cli" && transport !== "api") throw new Error("openclaw.transport must be cli or api");
  const apiUrl = entry.api_url === undefined ? undefined : string(entry.api_url, "openclaw.api_url");
  const tokenFile = optionalPath(base, entry.token_file, "openclaw.token_file");
  if (transport === "api" && (apiUrl === undefined || tokenFile === undefined)) {
    throw new Error("OpenClaw API transport requires api_url and token_file paths");
  }
  return {
    transport,
    ...(apiUrl === undefined ? {} : { apiUrl }),
    ...(tokenFile === undefined ? {} : { tokenFile }),
    ...(entry.agent_target === undefined ? {} : { agentTarget: string(entry.agent_target, "openclaw.agent_target") }),
  };
}

async function fromConfigFile(path: string, alias: string, harnessId: HarnessId): Promise<CliRuntimeConfig> {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(alias)) throw new Error("Alias must be a stable lowercase identifier");
  const absolute = resolve(path);
  let decoded: unknown;
  try {
    decoded = JSON.parse(await readFile(absolute, "utf8")) as unknown;
  } catch (error) {
    throw new Error("Adapter configuration file could not be loaded", { cause: error });
  }
  const root = object(decoded, "configuration");
  onlyKeys(root, new Set(["aliases"]), "configuration");
  const aliases = object(root.aliases, "configuration.aliases");
  const entry = object(aliases[alias], `configuration alias '${alias}'`);
  rejectInlineSecrets(entry);
  onlyKeys(entry, new Set([
    "tenant",
    "room",
    "instance_id",
    "state_directory",
    "relay_url",
    "environment",
    "heartbeat_ms",
    "default_timeout_ms",
    "no_progress_timeout_ms",
    "token_file",
    "mtls",
    "dev_headers",
    "harness_command",
    "openclaw",
    "decisiones_url",
    "muse",
  ]), `configuration alias '${alias}'`);
  const base = dirname(absolute);
  const runtimeEnvironment = environment(entry.environment);
  const developmentIdentity = entry.dev_headers === true;
  if (entry.dev_headers !== undefined && typeof entry.dev_headers !== "boolean") {
    throw new Error("dev_headers must be a boolean");
  }
  if (runtimeEnvironment === "production" && developmentIdentity) {
    throw new Error("Development identity headers are forbidden in production");
  }
  const bearerTokenFile = optionalPath(base, entry.token_file, "token_file");
  const mutualTls = mtls(base, entry.mtls);
  const openClawSettings = openClaw(base, entry.openclaw, harnessId);
  const decisionesUrl = decisionesOrigin(entry.decisiones_url, "decisiones_url");
  // Optional: without a `muse` block a muse alias keeps the `muse exec` path (see museFromEnvironment).
  const museSettings = museFromConfig(entry.muse, harnessId);
  return {
    tenant: string(entry.tenant, "tenant"),
    room: entry.room === undefined ? string(entry.tenant, "tenant") : string(entry.room, "room"),
    alias,
    instanceId: string(entry.instance_id, "instance_id"),
    stateDirectory: resolve(base, string(entry.state_directory, "state_directory")),
    relayUrl: string(entry.relay_url, "relay_url"),
    environment: runtimeEnvironment,
    heartbeatMs: positiveInteger(entry.heartbeat_ms, "heartbeat_ms", 15_000),
    defaultTimeoutMs: configuredMessageTimeoutMs(
      entry.no_progress_timeout_ms ?? entry.default_timeout_ms,
      entry.no_progress_timeout_ms === undefined ? "default_timeout_ms" : "no_progress_timeout_ms",
      DEFAULT_NO_PROGRESS_TIMEOUT_MS,
    ),
    ...(bearerTokenFile === undefined ? {} : { bearerTokenFile }),
    ...(mutualTls === undefined ? {} : { mutualTls }),
    developmentIdentity,
    ...(decisionesUrl === undefined ? {} : { decisionesUrl }),
    ...(entry.harness_command === undefined ? {} : { harnessCommand: string(entry.harness_command, "harness_command") }),
    ...(openClawSettings === undefined ? {} : { openClaw: openClawSettings }),
    ...(museSettings === undefined ? {} : { muse: museSettings }),
  };
}

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`Required configuration '${name}' is missing`);
  return value;
}

function environmentInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`'${name}' must be a positive integer`);
  return parsed;
}

function environmentMessageTimeoutMs(name: string, fallback = DEFAULT_MESSAGE_TIMEOUT_MS): number {
  const value = process.env[name];
  return configuredMessageTimeoutMs(
    value === undefined ? undefined : Number(value),
    `'${name}'`,
    fallback,
  );
}

function bridgeEnvironment(harnessId: HarnessId): Pick<CliRuntimeConfig, "hermesPython"> {
  const hermesPython = harnessId === "hermes" ? process.env.CAUCE_HERMES_PYTHON : undefined;
  if (hermesPython?.length === 0) {
    throw new Error("CAUCE_HERMES_PYTHON must be non-empty");
  }
  return {
    ...(hermesPython === undefined ? {} : { hermesPython }),
  };
}

function credentialEnvironment(primary: string, fleet: string): string | undefined {
  const first = process.env[primary]; const second = process.env[fleet];
  if (first !== undefined && second !== undefined && resolve(first) !== resolve(second)) throw new Error("credential paths conflict");
  return first ?? second;
}

function fromEnvironment(aliasOverride: string | undefined, harnessId: HarnessId): CliRuntimeConfig {
  for (const forbidden of ["CAUCE_TOKEN", "CAUCE_BEARER_TOKEN", "CAUCE_TLS_KEY", "CAUCE_OPENCLAW_TOKEN"]) {
    if (forbidden in process.env) {
      throw new Error("Inline secret environment variables are forbidden; use a *_FILE path");
    }
  }
  const runtimeEnvironment = environment(process.env.CAUCE_ENVIRONMENT);
  const developmentIdentity = process.env.CAUCE_DEV_AUTH === "1";
  if (runtimeEnvironment === "production" && developmentIdentity) {
    throw new Error("CAUCE_DEV_AUTH is forbidden in production");
  }
  const tlsValues = [credentialEnvironment("CAUCE_TLS_CERT_FILE", "CAUCE_CERT_PATH"), credentialEnvironment("CAUCE_TLS_KEY_FILE", "CAUCE_KEY_PATH"), credentialEnvironment("CAUCE_TLS_CA_FILE", "CAUCE_CA_PATH")];
  let mutualTls: NonNullable<CliRuntimeConfig["mutualTls"]> | undefined;
  if (tlsValues.some((value) => value !== undefined)) {
    const [certFile, keyFile, caFile] = tlsValues;
    if (certFile === undefined || keyFile === undefined || caFile === undefined) {
      throw new Error("CAUCE_TLS_CERT_FILE, CAUCE_TLS_KEY_FILE and CAUCE_TLS_CA_FILE must be configured together");
    }
    mutualTls = {
      certFile: resolve(certFile),
      keyFile: resolve(keyFile),
      caFile: resolve(caFile),
    };
  }
  const transport = process.env.CAUCE_OPENCLAW_TRANSPORT ?? "cli";
  if (transport !== "cli" && transport !== "api") throw new Error("CAUCE_OPENCLAW_TRANSPORT must be cli or api");
  const openClawConfig = harnessId === "openclaw" ? {
    transport,
    ...(process.env.CAUCE_OPENCLAW_API_URL === undefined ? {} : { apiUrl: process.env.CAUCE_OPENCLAW_API_URL }),
    ...(process.env.CAUCE_OPENCLAW_TOKEN_FILE === undefined
      ? {}
      : { tokenFile: resolve(process.env.CAUCE_OPENCLAW_TOKEN_FILE) }),
    ...(process.env.CAUCE_OPENCLAW_AGENT_TARGET === undefined
      ? {}
      : { agentTarget: process.env.CAUCE_OPENCLAW_AGENT_TARGET }),
  } satisfies NonNullable<CliRuntimeConfig["openClaw"]> : undefined;
  if (openClawConfig?.transport === "api"
    && (openClawConfig.apiUrl === undefined || openClawConfig.tokenFile === undefined)) {
    throw new Error("OpenClaw API transport requires CAUCE_OPENCLAW_API_URL and CAUCE_OPENCLAW_TOKEN_FILE");
  }
  const decisionesUrl = decisionesOrigin(process.env.CAUCE_DECISIONES_URL, "CAUCE_DECISIONES_URL");
  const museConfig = museFromEnvironment(harnessId);
  const bearerTokenFile = credentialEnvironment("CAUCE_TOKEN_FILE", "CAUCE_TOKEN_PATH");
  return {
    tenant: requiredEnvironment("CAUCE_TENANT"),
    room: requiredEnvironment("CAUCE_ROOM"),
    alias: aliasOverride ?? requiredEnvironment("CAUCE_ALIAS"),
    instanceId: requiredEnvironment("CAUCE_INSTANCE_ID"),
    stateDirectory: resolve(requiredEnvironment("CAUCE_STATE_DIR")),
    relayUrl: requiredEnvironment("CAUCE_RELAY_URL"),
    environment: runtimeEnvironment,
    heartbeatMs: environmentInteger("CAUCE_HEARTBEAT_MS", 15_000),
    // CAUCE_DEFAULT_TIMEOUT_MS (a 24 h duration cap) no longer applies: turns have no duration cap.
    defaultTimeoutMs: environmentMessageTimeoutMs("CAUCE_NO_PROGRESS_TIMEOUT_MS", DEFAULT_NO_PROGRESS_TIMEOUT_MS),
    ...(bearerTokenFile === undefined ? {} : { bearerTokenFile: resolve(bearerTokenFile) }),
    ...(mutualTls === undefined ? {} : { mutualTls }),
    developmentIdentity,
    ...(decisionesUrl === undefined ? {} : { decisionesUrl }),
    ...(process.env.CAUCE_HARNESS_COMMAND === undefined ? {} : { harnessCommand: process.env.CAUCE_HARNESS_COMMAND }),
    ...bridgeEnvironment(harnessId),
    ...(openClawConfig === undefined ? {} : { openClaw: openClawConfig }),
    ...(museConfig === undefined ? {} : { muse: museConfig }),
  };
}

function cliOptions(argv: readonly string[]): { configFile?: string; alias?: string } {
  const parsed: { configFile?: string; alias?: string } = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`CLI option '${option ?? ""}' requires a value`);
    if (option === "--config" && parsed.configFile === undefined) parsed.configFile = value;
    else if (option === "--alias" && parsed.alias === undefined) parsed.alias = value;
    else throw new Error(`Unknown or duplicate CLI option '${option ?? ""}'`);
  }
  return parsed;
}

export async function loadCliRuntimeConfig(
  harnessId: HarnessId,
  argv: readonly string[] = process.argv.slice(2),
): Promise<CliRuntimeConfig> {
  const options = cliOptions(argv);
  const configFile = options.configFile ?? process.env.CAUCE_CONFIG_FILE;
  if (configFile !== undefined && process.env.CAUCE_FLEET_OPERATION_ID !== undefined) throw new Error('fleet runtime cannot inherit a configuration file');
  if (configFile !== undefined) {
    const alias = options.alias ?? process.env.CAUCE_ALIAS;
    if (alias === undefined || alias.length === 0) throw new Error("--alias or CAUCE_ALIAS selects a configured alias");
    return { ...await fromConfigFile(configFile, alias, harnessId), ...bridgeEnvironment(harnessId) };
  }
  return fromEnvironment(options.alias, harnessId);
}
