import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { HarnessId } from "../sdk/types.js";
import type { SharedSessionSpec } from "./session.js";
import { sharedSessionResume } from "./resume.js";
import { isSharedSessionHarness, type SharedSessionHarness } from "./types.js";

/**
 * Shared session configuration from environment variables.
 */

export interface SharedSessionConfig {
  readonly harness: SharedSessionHarness;
  readonly alias: string;
  readonly workspace: string;
  readonly home: string;
  readonly stateDirectory: string;
  /**
   * Where the harness configuration lives and where its registry hangs from.
   */
  readonly configDirectory: string;
  /** What the TUI must see in its environment, whoever creates it. */
  readonly paneEnvironment: Readonly<Record<string, string>>;
  readonly harnessArguments: readonly string[];
}

const SHARED_SESSION_ENV = "CAUCE_SHARED_SESSION";
const CLAUDE_PERMISSION_MODE_ENV = "CAUCE_CLAUDE_PERMISSION_MODE";
const CLAUDE_PERMISSION_MODES = new Set(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]);

export function claudePermissionArguments(
  harness: SharedSessionHarness,
  environment: NodeJS.ProcessEnv,
): readonly string[] {
  const mode = environment[CLAUDE_PERMISSION_MODE_ENV];
  if (harness !== "claude" || mode === undefined || mode === "") return [];
  if (!CLAUDE_PERMISSION_MODES.has(mode)) {
    throw new Error(`${CLAUDE_PERMISSION_MODE_ENV} must be one of ${[...CLAUDE_PERMISSION_MODES].join(", ")}`);
  }
  return mode === "bypassPermissions" ? ["--dangerously-skip-permissions"] : ["--permission-mode", mode];
}
const SHARED_SESSION_WORKSPACE_ENV = "CAUCE_SHARED_SESSION_WORKSPACE";

const DEFAULT_WORKSPACE = "/workspace";

/**
 * Resolves the harness configuration directory (`CODEX_HOME` or `CLAUDE_CONFIG_DIR`).
 */
export function harnessConfigDirectory(
  harness: SharedSessionHarness,
  home: string,
  environment: NodeJS.ProcessEnv,
): string {
  const variable = harness === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  const declared = environment[variable];
  if (declared === undefined || declared === "") {
    return join(home, harness === "codex" ? ".codex" : ".claude");
  }
  if (!isAbsolute(declared)) throw new Error(`${variable} debe ser una ruta absoluta`);
  return declared;
}

/**
 * Generates the minimal environment-variable map for the TUI's tmux pane.
 */
export function sharedSessionPaneEnvironment(
  harness: SharedSessionHarness,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): Readonly<Record<string, string>> {
  const directory = harnessConfigDirectory(harness, home, environment);
  return harness === "codex" ? { CODEX_HOME: directory } : { CLAUDE_CONFIG_DIR: directory };
}

/**
 * Builds the `SharedSessionSpec` for CLI-driven session bootstrap.
 */
export function cliSharedSessionSpec(
  harness: SharedSessionHarness,
  alias: string,
  workspace: string,
  home: string,
  environment: NodeJS.ProcessEnv = process.env,
): SharedSessionSpec {
  const configDirectory = harnessConfigDirectory(harness, home, environment);
  return {
    alias,
    harness,
    workspace,
    environment: sharedSessionPaneEnvironment(harness, home, environment),
    harnessArguments: claudePermissionArguments(harness, environment),
    resume: sharedSessionResume(harness, configDirectory, workspace),
  };
}

/**
 * Loads and validates the shared session configuration from the environment.
 */
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
      `${SHARED_SESSION_ENV} sólo existe para claude y codex; '${harnessId}' no tiene sesión compartida`,
    );
  }
  const workspace = environment[SHARED_SESSION_WORKSPACE_ENV] ?? DEFAULT_WORKSPACE;
  if (!isAbsolute(workspace)) {
    throw new Error(`${SHARED_SESSION_WORKSPACE_ENV} debe ser una ruta absoluta`);
  }
  const home = environment.HOME ?? homedir();
  if (!isAbsolute(home)) throw new Error("HOME debe ser una ruta absoluta para la sesión compartida");
  return {
    harness: harnessId,
    alias,
    workspace,
    home,
    stateDirectory,
    configDirectory: harnessConfigDirectory(harnessId, home, environment),
    paneEnvironment: sharedSessionPaneEnvironment(harnessId, home, environment),
    harnessArguments: claudePermissionArguments(harnessId, environment),
  };
}
