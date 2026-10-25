import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, normalize } from "node:path";
import type { HarnessId } from "../sdk/types.js";
import type { SharedSessionSpec } from "./session.js";
import { sharedSessionResume } from "./resume.js";
import { museEchoProfile } from './muse-profile.js';
import { isSharedSessionHarness, type SharedSessionHarness } from "./types.js";
import { commandPinsFromEnvironment, type CommandPins } from '../sdk/command-pins.js';
import { executionSelection, projectSelectionArguments, selectionArguments, selectionFromEnvironment } from '../sdk/execution-selection.js';

/** Shared session configuration from environment variables. */
export interface SharedSessionConfig {
  readonly command?: string;
  readonly commandPins?: CommandPins;
  readonly requiredArguments?: readonly string[];
  readonly harness: SharedSessionHarness;
  readonly alias: string;
  readonly workspace: string;
  readonly home: string;
  readonly stateDirectory: string;
  /** Where the harness configuration lives and where its registry hangs from. */
  readonly configDirectory: string;
  /** What the TUI must see in its environment, whoever creates it. */
  readonly paneEnvironment: Readonly<Record<string, string>>;
  readonly unsetEnvironment?: readonly string[];
  readonly harnessArguments: readonly string[];
  readonly nativeId?: string; // CAUCE_SHARED_SESSION_NATIVE_ID: seeded on start while there is no pointer.
}

const SHARED_SESSION_ENV = "CAUCE_SHARED_SESSION";

function sharedCommandPins(harness: SharedSessionHarness, environment: NodeJS.ProcessEnv): CommandPins | undefined {
  const pins = commandPinsFromEnvironment(environment);
  if (harness !== 'muse') return pins;
  const command = environment.CAUCE_MUSE_CLI_COMMAND; const sha256 = environment.CAUCE_MUSE_CLI_SHA256;
  if (command === undefined && sha256 === undefined) return pins;
  if (pins === undefined || command === undefined || sha256 === undefined || pins.files[command] !== sha256) {
    throw new Error('Muse shared session requires an approved native command and matching file pin');
  }
  return commandPinsFromEnvironment({ ...environment, CAUCE_HARNESS_COMMAND: command, CAUCE_HARNESS_COMMAND_SHA256: sha256 });
}

function physicalAlias(alias: string, environment: NodeJS.ProcessEnv): string {
  const key = environment.CAUCE_RUNTIME_KEY;
  if (key === undefined || key === "") return alias;
  if (!/^[a-z][a-z0-9-]{0,63}$/u.test(key)) throw new Error("CAUCE_RUNTIME_KEY must be a stable physical identifier");
  return key;
}


export function claudePermissionArguments(
  harness: SharedSessionHarness,
  _environment: NodeJS.ProcessEnv,
): readonly string[] {
  switch (harness) {
    case "claude": return ["--dangerously-skip-permissions"];
    case "codex": return ["--yolo"];
    case "grok": return ["--always-approve"]; // grok 1.0.41 --help; `--yolo` is only `grok agent`.
    case "muse": return ["--yolo", "--trust-workspace"];
  }
}

export function museReasoningEffort(environment: NodeJS.ProcessEnv): string {
  const durable = environment.CAUCE_REASONING_EFFORT;
  const legacy = environment.MUSE_REASONING_EFFORT;
  if (durable !== undefined && legacy !== undefined && legacy !== '' && durable !== legacy) throw new Error('Muse effort differs from durable selection');
  const declared = durable ?? (legacy === '' ? undefined : legacy) ?? 'max';
  executionSelection('muse', { reasoningEffort: declared });
  return declared;
}

export const MUSE_CREDENTIAL_OVERRIDES = ['META_API_KEY', 'MUSE_AUTH_PATH', 'MUSE_CONFIG_DIR'] as const;

export function museProfileDirectories(home: string, alias: string, environment: NodeJS.ProcessEnv): { config: string; data: string } {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(alias)) throw new Error('invalid Muse shared alias');
  for (const name of [...MUSE_CREDENTIAL_OVERRIDES, 'CAUCE_MUSE_CONFIG_HOME', 'CAUCE_MUSE_DATA_HOME']) {
    if (environment[name] !== undefined && environment[name] !== '') throw new Error('unsupported Muse profile override');
  }
  const declaredConfig = environment.XDG_CONFIG_HOME; const declaredData = environment.XDG_DATA_HOME;
  if ((declaredConfig === undefined) !== (declaredData === undefined)) throw new Error('Muse requires both dedicated XDG directories');
  const root = join(home, '.local', 'share', 'cauce-v3', 'config', alias);
  const config = declaredConfig ?? join(root, 'config'); const data = declaredData ?? join(root, 'data');
  if ([config, data].some(path => !isAbsolute(path) || path === '/' || path.includes('\0') || normalize(path) !== path)
    || dirname(config) === '/' || basename(config) !== 'config' || basename(data) !== 'data' || dirname(config) !== dirname(data)) {
    throw new Error('Muse config and data must belong to the same canonical dedicated profile');
  }
  return { config, data };
}

export function museDataHome(home: string, alias: string, environment: NodeJS.ProcessEnv): string {
  return museProfileDirectories(home, alias, environment).data;
}

function sharedSelection(harness: SharedSessionHarness, home: string, alias: string, environment: NodeJS.ProcessEnv) {
  const selected = selectionFromEnvironment(harness, environment);
  if (harness === 'muse' && environment.CAUCE_REASONING_EFFORT === undefined
    && (environment.MUSE_REASONING_EFFORT === undefined || environment.MUSE_REASONING_EFFORT === '')
    && museEchoProfile(museProfileDirectories(home, alias, environment).config)) return selected;
  return harness === 'muse' ? { ...selected, reasoningEffort: museReasoningEffort(environment) } : selected;
}
const SHARED_SESSION_WORKSPACE_ENV = "CAUCE_SHARED_SESSION_WORKSPACE";
const SHARED_SESSION_NATIVE_ID_ENV = "CAUCE_SHARED_SESSION_NATIVE_ID";
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

const DEFAULT_WORKSPACE = "/workspace";

function configDirectoryVariable(
  harness: Exclude<SharedSessionHarness, "muse">,
): { readonly variable: string; readonly fallback: string } {
  switch (harness) {
    case "claude": return { variable: "CLAUDE_CONFIG_DIR", fallback: ".claude" };
    case "codex": return { variable: "CODEX_HOME", fallback: ".codex" };
    case "grok": return { variable: "GROK_HOME", fallback: ".grok" }; // login, MCP, sessions.
  }
}

function requireAlias(alias: string | undefined): string {
  if (alias === undefined) throw new Error("la sesión compartida de muse necesita el alias");
  return alias;
}

/**
 * Resolves the harness configuration directory (`CLAUDE_CONFIG_DIR`, `CODEX_HOME` or `GROK_HOME`;
 * for muse, where its sessions live: `<museDataHome>/muse`).
 */
export function harnessConfigDirectory(
  harness: SharedSessionHarness,
  home: string,
  environment: NodeJS.ProcessEnv,
  alias?: string,
): string {
  if (harness === "muse") return join(museDataHome(home, requireAlias(alias), environment), "muse");
  const { variable, fallback } = configDirectoryVariable(harness);
  const declared = environment[variable];
  if (declared === undefined || declared === "") {
    return join(home, fallback);
  }
  if (!isAbsolute(declared)) throw new Error(`${variable} debe ser una ruta absoluta`);
  return declared;
}

/** Generates the minimal environment-variable map for the TUI's tmux pane (always the config dir). */
export function sharedSessionPaneEnvironment(
  harness: SharedSessionHarness,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
  alias?: string,
): Readonly<Record<string, string>> {
  if (harness === "muse") {
    const directories = museProfileDirectories(home, requireAlias(alias), environment);
    return { XDG_CONFIG_HOME: directories.config, XDG_DATA_HOME: directories.data, MUSE_NO_AUTO_UPDATE: '1' };
  }
  const directory = harnessConfigDirectory(harness, home, environment);
  return { [configDirectoryVariable(harness).variable]: directory };
}

/** Builds the `SharedSessionSpec` for CLI-driven session bootstrap. */
export function cliSharedSessionSpec(
  harness: SharedSessionHarness,
  alias: string,
  workspace: string,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
  stateDirectory?: string,
): SharedSessionSpec {
  alias = physicalAlias(alias, environment);
  const configDirectory = harnessConfigDirectory(harness, home, environment, alias);
  const selection = sharedSelection(harness, home, alias, environment); const pins = sharedCommandPins(harness, environment);
  return {
    alias,
    harness,
    workspace,
    environment: sharedSessionPaneEnvironment(harness, home, environment, alias),
    ...(harness === 'muse' ? { unsetEnvironment: MUSE_CREDENTIAL_OVERRIDES } : {}),
    harnessArguments: projectSelectionArguments(harness, claudePermissionArguments(harness, environment), selection),
    requiredArguments: selectionArguments(harness, selection),
    ...(pins === undefined ? {} : { command: pins.command, commandPins: pins }),
    resume: sharedSessionResume(
      harness,
      configDirectory,
      workspace,
      stateDirectory === undefined ? undefined : { alias, stateDirectory },
    ),
  };
}

/** Loads and validates the shared session configuration from the environment. */
export function loadSharedSessionConfig(
  harnessId: HarnessId,
  alias: string,
  stateDirectory: string,
  environment: NodeJS.ProcessEnv = process.env,
): SharedSessionConfig | undefined {
  const flag = environment[SHARED_SESSION_ENV];
  if (flag === undefined || flag === "" || flag === "0") return undefined;
  if (flag !== "1") {
    throw new Error(`${SHARED_SESSION_ENV} debe ser 1 o estar ausente`);
  }
  if (!isSharedSessionHarness(harnessId)) {
    throw new Error(
      `${SHARED_SESSION_ENV} sólo existe para claude, codex, grok y muse; '${harnessId}' no tiene sesión compartida`,
    );
  }
  alias = physicalAlias(alias, environment);
  const workspace = environment[SHARED_SESSION_WORKSPACE_ENV] ?? DEFAULT_WORKSPACE;
  if (!isAbsolute(workspace)) {
    throw new Error(`${SHARED_SESSION_WORKSPACE_ENV} debe ser una ruta absoluta`);
  }
  const home = environment.HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error("HOME debe ser una ruta absoluta para la sesión compartida");
  const nativeId = environment[SHARED_SESSION_NATIVE_ID_ENV];
  const selection = sharedSelection(harnessId, home, alias, environment); const pins = sharedCommandPins(harnessId, environment);
  if (nativeId !== undefined && nativeId !== "") {
    if (harnessId === "codex") {
      throw new Error(`${SHARED_SESSION_NATIVE_ID_ENV} no existe para codex: reanuda con resume --last`);
    }
    if (!CANONICAL_UUID.test(nativeId)) throw new Error(`${SHARED_SESSION_NATIVE_ID_ENV} debe ser un UUID canónico`);
  }
  return {
    ...(nativeId === undefined || nativeId === "" ? {} : { nativeId }),
    harness: harnessId,
    alias,
    workspace,
    home,
    stateDirectory,
    configDirectory: harnessConfigDirectory(harnessId, home, environment, alias),
    paneEnvironment: sharedSessionPaneEnvironment(harnessId, home, environment, alias),
    ...(harnessId === 'muse' ? { unsetEnvironment: MUSE_CREDENTIAL_OVERRIDES } : {}),
    harnessArguments: projectSelectionArguments(harnessId, claudePermissionArguments(harnessId, environment), selection),
    requiredArguments: selectionArguments(harnessId, selection),
    ...(pins === undefined ? {} : { command: pins.command, commandPins: pins }),
  };
}
