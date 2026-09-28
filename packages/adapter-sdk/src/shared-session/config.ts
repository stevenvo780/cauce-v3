import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { HarnessId } from "../sdk/types.js";
import type { SharedSessionSpec } from "./session.js";
import { sharedSessionResume } from "./resume.js";
import { isSharedSessionHarness, type SharedSessionHarness } from "./types.js";

/** Shared session configuration from environment variables. */
export interface SharedSessionConfig {
  readonly harness: SharedSessionHarness;
  readonly alias: string;
  readonly workspace: string;
  readonly home: string;
  readonly stateDirectory: string;
  /** Where the harness configuration lives and where its registry hangs from. */
  readonly configDirectory: string;
  /** What the TUI must see in its environment, whoever creates it. */
  readonly paneEnvironment: Readonly<Record<string, string>>;
  readonly harnessArguments: readonly string[];
  readonly nativeId?: string; // CAUCE_SHARED_SESSION_NATIVE_ID: seeded on start while there is no pointer.
}

const SHARED_SESSION_ENV = "CAUCE_SHARED_SESSION";

export function claudePermissionArguments(
  harness: SharedSessionHarness,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  switch (harness) {
    case "claude": return ["--dangerously-skip-permissions"];
    case "codex": return ["--yolo"];
    case "grok": return ["--always-approve"]; // grok 1.0.41 --help; `--yolo` is only `grok agent`.
    // Same flags as the headless bridge (muse-cauce), so the TUI and `muse exec` load the same rules.
    case "muse": return ["--yolo", "--trust-workspace", "--reasoning-effort", museReasoningEffort(environment)];
  }
}

/** Muse's effort levels (`muse --help`, 1.4.0). The alias runs at max by Steven's decision. */
const MUSE_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"]);

export function museReasoningEffort(environment: NodeJS.ProcessEnv): string {
  const declared = environment.MUSE_REASONING_EFFORT;
  if (declared === undefined || declared === "") return "max";
  if (!MUSE_REASONING_EFFORTS.has(declared)) throw new Error("MUSE_REASONING_EFFORT no es un nivel de Muse");
  return declared;
}

/**
 * Muse's data directory for a shared alias: `$XDG_DATA_HOME/muse`, with an XDG_DATA_HOME of its own.
 * Muse has no variable for its sessions but XDG_DATA_HOME, and the default (`~/.local/share/muse`)
 * is shared with every Muse in the container (e.g. the owner's own TUI writes an 80 MB log there);
 * this gives the shared TUI its own folder next to its login. `CAUCE_MUSE_DATA_HOME` overrides it.
 */
export function museDataHome(home: string, alias: string, environment: NodeJS.ProcessEnv): string {
  const declared = environment.CAUCE_MUSE_DATA_HOME;
  if (declared !== undefined && declared !== "") {
    if (!isAbsolute(declared)) throw new Error("CAUCE_MUSE_DATA_HOME debe ser una ruta absoluta");
    return declared;
  }
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(alias)) throw new Error("alias inválido para la sesión compartida de muse");
  return join(home, ".local", "share", "cauce-v3", "config", alias, ".local", "share");
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
  if (harness === "muse") return { XDG_DATA_HOME: museDataHome(home, requireAlias(alias), environment) };
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
  const configDirectory = harnessConfigDirectory(harness, home, environment, alias);
  return {
    alias,
    harness,
    workspace,
    environment: sharedSessionPaneEnvironment(harness, home, environment, alias),
    harnessArguments: claudePermissionArguments(harness, environment),
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
  const workspace = environment[SHARED_SESSION_WORKSPACE_ENV] ?? DEFAULT_WORKSPACE;
  if (!isAbsolute(workspace)) {
    throw new Error(`${SHARED_SESSION_WORKSPACE_ENV} debe ser una ruta absoluta`);
  }
  const home = environment.HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error("HOME debe ser una ruta absoluta para la sesión compartida");
  const nativeId = environment[SHARED_SESSION_NATIVE_ID_ENV];
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
    harnessArguments: claudePermissionArguments(harnessId, environment),
  };
}
