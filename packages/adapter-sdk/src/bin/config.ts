import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { HarnessId } from "../sdk/types.js";

type RuntimeEnvironment = "production" | "development" | "test";
const DEFAULT_AGENTIC_TIMEOUT_MS = 24 * 60 * 60_000;

export interface CliRuntimeConfig {
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
  readonly harnessCommand?: string;
  readonly harnessBridge?: string;
  readonly hermesPython?: string;
  readonly openClaw?: {
    readonly transport: "cli" | "api";
    readonly apiUrl?: string;
    readonly tokenFile?: string;
    readonly agentTarget?: string;
  };
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

function defaultTimeoutMs(): number {
  return DEFAULT_AGENTIC_TIMEOUT_MS;
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

function optionalPath(base: string, value: unknown, context: string): string | undefined {
  return value === undefined ? undefined : resolve(base, string(value, context));
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
    "instance_id",
    "state_directory",
    "relay_url",
    "environment",
    "heartbeat_ms",
    "default_timeout_ms",
    "token_file",
    "mtls",
    "dev_headers",
    "harness_command",
    "openclaw",
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
  return {
    tenant: string(entry.tenant, "tenant"),
    room: entry.room === undefined ? string(entry.tenant, "tenant") : string(entry.room, "room"),
    alias,
    instanceId: string(entry.instance_id, "instance_id"),
    stateDirectory: resolve(base, string(entry.state_directory, "state_directory")),
    relayUrl: string(entry.relay_url, "relay_url"),
    environment: runtimeEnvironment,
    heartbeatMs: positiveInteger(entry.heartbeat_ms, "heartbeat_ms", 15_000),
    defaultTimeoutMs: positiveInteger(
      entry.default_timeout_ms,
      "default_timeout_ms",
      defaultTimeoutMs(),
    ),
    ...(bearerTokenFile === undefined ? {} : { bearerTokenFile }),
    ...(mutualTls === undefined ? {} : { mutualTls }),
    developmentIdentity,
    ...(entry.harness_command === undefined ? {} : { harnessCommand: string(entry.harness_command, "harness_command") }),
    ...(openClawSettings === undefined ? {} : { openClaw: openClawSettings }),
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

function bridgeEnvironment(harnessId: HarnessId): Pick<CliRuntimeConfig, "harnessBridge" | "hermesPython"> {
  const bridge = harnessId === "hermes"
    ? process.env.CAUCE_HERMES_BRIDGE
    : harnessId === "openclaw"
      ? process.env.CAUCE_OPENCLAW_BRIDGE
      : undefined;
  if (bridge !== undefined && bridge.length === 0) throw new Error("Harness bridge path must be non-empty");
  const hermesPython = harnessId === "hermes" ? process.env.CAUCE_HERMES_PYTHON : undefined;
  if (hermesPython !== undefined && hermesPython.length === 0) {
    throw new Error("CAUCE_HERMES_PYTHON must be non-empty");
  }
  return {
    ...(bridge === undefined ? {} : { harnessBridge: resolve(bridge) }),
    ...(hermesPython === undefined ? {} : { hermesPython }),
  };
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
  const tlsValues = [process.env.CAUCE_TLS_CERT_FILE, process.env.CAUCE_TLS_KEY_FILE, process.env.CAUCE_TLS_CA_FILE];
  if (tlsValues.some((value) => value !== undefined) && tlsValues.some((value) => value === undefined)) {
    throw new Error("CAUCE_TLS_CERT_FILE, CAUCE_TLS_KEY_FILE and CAUCE_TLS_CA_FILE must be configured together");
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
  return {
    tenant: requiredEnvironment("CAUCE_TENANT"),
    room: requiredEnvironment("CAUCE_ROOM"),
    alias: aliasOverride ?? requiredEnvironment("CAUCE_ALIAS"),
    instanceId: requiredEnvironment("CAUCE_INSTANCE_ID"),
    stateDirectory: resolve(requiredEnvironment("CAUCE_STATE_DIR")),
    relayUrl: requiredEnvironment("CAUCE_RELAY_URL"),
    environment: runtimeEnvironment,
    heartbeatMs: environmentInteger("CAUCE_HEARTBEAT_MS", 15_000),
    defaultTimeoutMs: environmentInteger(
      "CAUCE_DEFAULT_TIMEOUT_MS",
      defaultTimeoutMs(),
    ),
    ...(process.env.CAUCE_TOKEN_FILE === undefined ? {} : { bearerTokenFile: resolve(process.env.CAUCE_TOKEN_FILE) }),
    ...(tlsValues[0] === undefined ? {} : {
      mutualTls: {
        certFile: resolve(tlsValues[0]),
        keyFile: resolve(tlsValues[1]!),
        caFile: resolve(tlsValues[2]!),
      },
    }),
    developmentIdentity,
    ...(process.env.CAUCE_HARNESS_COMMAND === undefined ? {} : { harnessCommand: process.env.CAUCE_HARNESS_COMMAND }),
    ...bridgeEnvironment(harnessId),
    ...(openClawConfig === undefined ? {} : { openClaw: openClawConfig }),
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
  if (configFile !== undefined) {
    const alias = options.alias ?? process.env.CAUCE_ALIAS;
    if (alias === undefined || alias.length === 0) throw new Error("--alias or CAUCE_ALIAS selects a configured alias");
    return { ...await fromConfigFile(configFile, alias, harnessId), ...bridgeEnvironment(harnessId) };
  }
  return fromEnvironment(options.alias, harnessId);
}
