import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { HarnessId } from "../sdk/types.js";
import { isSharedSessionHarness, type SharedSessionHarness } from "./types.js";

/**
 * De dónde sale la configuración de la sesión compartida: del entorno, y sólo del entorno.
 *
 * Es un interruptor por alias porque el encendido es gradual y los pilotos los eligió el dueño
 * (`kratos` con claude y `socrates` con codex). Un alias sin `CAUCE_SHARED_SESSION=1` se comporta
 * exactamente como hoy, byte a byte.
 */

export interface SharedSessionConfig {
  readonly harness: SharedSessionHarness;
  readonly alias: string;
  readonly workspace: string;
  readonly home: string;
  readonly stateDirectory: string;
  /** Sólo codex. */
  readonly socketPath: string;
}

export const SHARED_SESSION_ENV = "CAUCE_SHARED_SESSION";
export const SHARED_SESSION_WORKSPACE_ENV = "CAUCE_SHARED_SESSION_WORKSPACE";

const DEFAULT_WORKSPACE = "/workspace";

/**
 * Directorio de runtime de la sesión compartida de un alias.
 *
 * Cuelga del HOME y no de `/run` porque el adaptador corre como el usuario del contenedor, y el
 * socket lo tiene que poder abrir tanto el app-server (lanzado desde tmux) como el adaptador.
 */
export function runtimeDirectory(home: string, alias: string): string {
  return join(home, ".cauce-shared", alias);
}

export function appServerSocketPath(home: string, alias: string): string {
  return join(runtimeDirectory(home, alias), "appserver.sock");
}

/**
 * Lee el interruptor. Devuelve `undefined` cuando el alias no tiene sesión compartida.
 *
 * Falla cerrado ante una configuración inservible en vez de encender a medias: un alias que cree
 * tener sesión compartida y no la tenga es exactamente el estado que el dueño ya rechazó dos
 * veces.
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
    socketPath: appServerSocketPath(home, alias),
  };
}
