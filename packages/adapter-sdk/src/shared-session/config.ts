import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import type { HarnessId } from "../sdk/types.js";
import type { SharedSessionSpec } from "./session.js";
import { sharedSessionResume } from "./resume.js";
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
  /**
   * Dónde vive la configuración del harness, y de dónde cuelga su registro: `projects/` en claude,
   * `sessions/` en codex. Es el valor del que salen a la vez el entorno del panel y la cosecha.
   */
  readonly configDirectory: string;
  /** Lo que la TUI tiene que ver en su entorno, lo cree quien lo cree. */
  readonly paneEnvironment: Readonly<Record<string, string>>;
}

export const SHARED_SESSION_ENV = "CAUCE_SHARED_SESSION";
export const SHARED_SESSION_WORKSPACE_ENV = "CAUCE_SHARED_SESSION_WORKSPACE";

const DEFAULT_WORKSPACE = "/workspace";

/**
 * Dónde vive la identidad del harness, y cómo se dice EN VOZ ALTA.
 *
 * El valor por defecto (`$HOME/.codex`, `$HOME/.claude`) no es una elección nueva: es exactamente
 * lo que ya resuelve el harness cuando la variable está ausente, y en la flota apunta al montaje
 * SEPARADO por contenedor —comprobado por inodo el 2026-07-30: `AGENTS.md`, `config.toml`,
 * `history.jsonl`, `sessions/` y los MCP de `ws-prizma` son los de su propio `prizma-config`, no
 * los compartidos—. Lo que se gana escribiéndolo es determinismo: el panel arranca con el mismo
 * valor lo cree el adaptador o `cauce <alias>`, en vez de heredar lo que trajera el primero que
 * levantó el servidor tmux.
 *
 * Lo que esto NO arregla, y hay que decirlo: `auth.json` / `.credentials.json` siguen montados
 * desde `shared` sobre ese directorio. Ese reparto de licencia es una decisión de despliegue del
 * dueño y no se toca desde el código del adaptador.
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
 * El entorno que se le fija al panel de la TUI. Deliberadamente CORTO.
 *
 * Sólo entra lo que tiene que ser idéntico vengas por donde vengas y cuya ausencia produce dos
 * comportamientos distintos para el mismo alias. En concreto NO entran:
 *
 *  - `TERM`: dentro de un panel lo fija tmux a partir de `default-terminal`; sobreescribirlo desde
 *    el argv es una decisión de dibujado que no está medida y que hoy no le hace falta a nadie.
 *  - `PATH` y `NODE_ENV`: los dos pilotos corren HOY con el `PATH` de la imagen y funcionan;
 *    imponer el del supervisor cambiaría qué binario resuelve el login shell sin ninguna medición
 *    que lo respalde.
 *
 * Ampliarlo es fácil y seguro; lo que no se puede es meter aquí variables a ojo.
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
 * El `SharedSessionSpec` con el que `cauce <alias>` levanta la sesión.
 *
 * Vive acá, junto al del adaptador, para que no puedan divergir: son los DOS creadores posibles y
 * el que gana la carrera le impone su entorno al servidor tmux para siempre. Tenerlo en una función
 * compartida además lo hace comprobable en una prueba, cosa que dentro del `bin` no era posible.
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
    // Este es el camino por el que se perdieron los 38 MB de kant: `cauce <alias> on` rehace el
    // panel, y hasta hoy lo rehacía SIEMPRE en blanco. Reanudar tiene que estar acá y en el
    // adaptador, porque son los dos únicos creadores posibles y cualquiera de los dos puede ganar
    // la carrera.
    resume: sharedSessionResume(harness, configDirectory, workspace),
  };
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
    configDirectory: harnessConfigDirectory(harnessId, home, environment),
    paneEnvironment: sharedSessionPaneEnvironment(harnessId, home, environment),
  };
}
