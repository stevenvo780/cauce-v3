import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { HarnessId } from "../sdk/types.js";
import type { SharedSessionSpec } from "./session.js";
import { sharedSessionResume } from "./resume.js";
import { isSharedSessionHarness, type SharedSessionHarness } from "./types.js";

/**
 * Configuración de la sesión compartida a partir de variables de entorno.
 */

export interface SharedSessionConfig {
  readonly harness: SharedSessionHarness;
  readonly alias: string;
  readonly workspace: string;
  readonly home: string;
  readonly stateDirectory: string;
  /**
   * Dónde vive la configuración del harness y de donde cuelga su registro.
   */
  readonly configDirectory: string;
  /** Lo que la TUI tiene que ver en su entorno, lo cree quien lo cree. */
  readonly paneEnvironment: Readonly<Record<string, string>>;
}

export const SHARED_SESSION_ENV = "CAUCE_SHARED_SESSION";
export const SHARED_SESSION_WORKSPACE_ENV = "CAUCE_SHARED_SESSION_WORKSPACE";

const DEFAULT_WORKSPACE = "/workspace";

/**
 * Resuelve el directorio de configuración del harness (`CODEX_HOME` o `CLAUDE_CONFIG_DIR`).
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
 * Genera el mapa de variables de entorno mínimas para el panel tmux de la TUI.
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
 * Construye la especificación `SharedSessionSpec` para el arranque de la sesión por CLI.
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
    resume: sharedSessionResume(harness, configDirectory, workspace),
  };
}

/**
 * Carga y valida la configuración de sesión compartida desde el entorno.
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
  };
}
