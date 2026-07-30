import { access } from "node:fs/promises";
import { capturePane, hasSession, panePid, type TmuxController } from "./tmux.js";
import { inputBoxState } from "./pane.js";
import { SERVER_WINDOW, TUI_WINDOW, sessionName, type SharedSessionHarness } from "./types.js";

/**
 * Cómo se levanta y cómo se mira la sesión compartida de un alias. UNA sola implementación.
 *
 * El dueño ya se quejó de tener sistemas compitiendo ("unifica tanto CLI"), así que `cauce <alias>`
 * y el adaptador no tienen dos rutinas parecidas: las dos llaman a lo de acá. El CLI lo alcanza
 * ejecutando `dist/src/bin/shared-session.js` dentro del contenedor, que es el mismo código que el
 * adaptador llama en proceso.
 */

export interface SharedSessionSpec {
  readonly alias: string;
  readonly harness: SharedSessionHarness;
  /** Directorio de trabajo de la TUI. Es también lo que determina el directorio de transcripts. */
  readonly workspace: string;
  /** Ruta del socket del app-server. Sólo codex. */
  readonly socketPath?: string;
  /** Binario del harness. Se separa para poder apuntarlo a un doble en las pruebas. */
  readonly command?: string;
}

export interface EnsureOptions {
  readonly sleep: (ms: number) => Promise<void>;
  /** Cuánto se espera a que la TUI esté lista tras crearla. */
  readonly readyTimeoutMs?: number;
  /** Ancho/alto con que nace la sesión sin clientes enganchados. */
  readonly width?: number;
  readonly height?: number;
}

export interface EnsureResult {
  readonly ready: boolean;
  /** True si esta llamada tuvo que crear la sesión (no existía). */
  readonly created: boolean;
  /** PID del proceso del panel de la TUI, cuando se pudo leer. */
  readonly pid?: string;
  readonly detail: string;
  /**
   * Qué falló exactamente, para que el aviso que lee el dueño no mienta.
   *
   * "no hay sesión" y "la sesión está pero la TUI no responde" se arreglan de formas distintas, y
   * deducirlo de si hubo que crearla daba la etiqueta equivocada en el caso más frecuente: sesión
   * viva con la TUI muerta dentro.
   */
  readonly failure?: "session_absent" | "tui_absent";
}

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;

export function tuiTarget(alias: string): string {
  return `${sessionName(alias)}:${TUI_WINDOW}`;
}

/**
 * El directorio donde `claude` guarda los transcripts de un workspace.
 *
 * La regla la fija claude: sustituye cada `/` del cwd por `-`, así que `/workspace` da
 * `-workspace`. Se replica acá porque el adaptador tiene que leer ESE directorio y no hay ninguna
 * bandera que lo revele.
 */
export function transcriptDirectory(home: string, workspace: string): string {
  const slug = workspace.replace(/\/+$/u, "").replace(/\//gu, "-");
  return `${home}/.claude/projects/${slug === "" ? "-" : slug}`;
}

/**
 * Levanta la sesión si no está, y no toca nada si ya está.
 *
 * La TUI se lanza con `bash -lc` a propósito: tiene que arrancar con el MISMO entorno que cuando
 * el dueño la abre a mano (perfil, `$CODEX_HOME`, `PATH` del contenedor). El adaptador corre bajo
 * `env -i` con una lista corta de variables, y heredar eso a pelo daría una TUI distinta de la que
 * el dueño conoce.
 */
export async function ensureSharedSession(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
): Promise<EnsureResult> {
  const session = sessionName(spec.alias);
  const target = tuiTarget(spec.alias);
  if (await hasSession(tmux, session)) {
    const pid = await panePid(tmux, target);
    if (pid === undefined) {
      return {
        ready: false, created: false, failure: "tui_absent",
        detail: `la sesión ${session} existe pero no tiene panel de TUI`,
      };
    }
    return { ready: true, created: false, pid, detail: `sesión ${session} ya abierta` };
  }

  const created = await createSession(tmux, spec, options);
  if (!created.ok) {
    return { ready: false, created: false, failure: "session_absent", detail: created.detail };
  }

  const ready = await waitForTui(tmux, target, options);
  const pid = await panePid(tmux, target);
  if (!ready) {
    const detail = `la TUI de ${spec.alias} no llegó a estar lista`;
    return pid === undefined
      ? { ready: false, created: true, failure: "tui_absent", detail }
      : { ready: false, created: true, pid, failure: "tui_absent", detail };
  }
  return pid === undefined
    ? { ready: true, created: true, detail: `sesión ${session} creada` }
    : { ready: true, created: true, pid, detail: `sesión ${session} creada` };
}

async function createSession(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const session = sessionName(spec.alias);
  const command = spec.command ?? spec.harness;
  const width = String(options.width ?? 200);
  const height = String(options.height ?? 50);

  if (spec.harness === "claude") {
    const result = await tmux.run([
      "new-session", "-d", "-s", session, "-n", TUI_WINDOW,
      "-c", spec.workspace, "-x", width, "-y", height,
      "bash", "-lc", `exec ${command}`,
    ]);
    return result.exitCode === 0 ? { ok: true } : { ok: false, detail: tmuxError(result.stderr) };
  }

  const socketPath = spec.socketPath;
  if (socketPath === undefined) {
    return { ok: false, detail: "codex necesita la ruta del socket del app-server" };
  }
  // Ventana 0: el app-server. `daemon start` no sirve acá —exige el managed standalone install en
  // $CODEX_HOME/packages/standalone/current/codex, que no existe: el binario es un paquete npm
  // global— pero `--listen unix://` arranca igual y crea el socket.
  const server = await tmux.run([
    "new-session", "-d", "-s", session, "-n", SERVER_WINDOW,
    "-c", spec.workspace, "-x", width, "-y", height,
    "bash", "-lc", `exec ${command} app-server --listen unix://${socketPath}`,
  ]);
  if (server.exitCode !== 0) return { ok: false, detail: tmuxError(server.stderr) };

  if (!await waitForSocket(socketPath, options)) {
    return { ok: false, detail: `el app-server no creó el socket ${socketPath}` };
  }

  const tui = await tmux.run([
    "new-window", "-d", "-t", `${session}:`, "-n", TUI_WINDOW,
    "-c", spec.workspace,
    "bash", "-lc", `exec ${command} --remote unix://${socketPath}`,
  ]);
  if (tui.exitCode !== 0) return { ok: false, detail: tmuxError(tui.stderr) };
  await tmux.run(["select-window", "-t", `${session}:${TUI_WINDOW}`]);
  return { ok: true };
}

function tmuxError(stderr: string): string {
  const detail = stderr.trim().split(/\r?\n/u)[0] ?? "";
  return detail === "" ? "tmux rechazó la creación de la sesión" : detail;
}

async function waitForSocket(path: string, options: EnsureOptions): Promise<boolean> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    try {
      await access(path);
      return true;
    } catch {
      if (Date.now() >= deadline) return false;
      await options.sleep(READY_POLL_MS);
    }
  }
}

/**
 * Espera a que la caja de entrada exista y esté vacía.
 *
 * No es un `sleep` fijo porque el arranque medido de claude va de 15 a 30 s y varía con la carga
 * del contenedor: un pegado que llega antes de que el lector de entrada esté listo se PIERDE sin
 * error —comprobado— y el turno se quedaría esperando una respuesta que nunca se pidió.
 */
async function waitForTui(
  tmux: TmuxController,
  target: string,
  options: EnsureOptions,
): Promise<boolean> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    const pane = await capturePane(tmux, target);
    if (!inputBoxState(pane).occupied) return true;
    if (Date.now() >= deadline) return false;
    await options.sleep(READY_POLL_MS);
  }
}

export interface SharedSessionStatus {
  readonly alias: string;
  readonly harness: SharedSessionHarness;
  readonly session: string;
  readonly present: boolean;
  readonly pid?: string;
  readonly socketPresent?: boolean;
}

export async function sharedSessionStatus(
  tmux: TmuxController,
  spec: SharedSessionSpec,
): Promise<SharedSessionStatus> {
  const session = sessionName(spec.alias);
  const present = await hasSession(tmux, session);
  const pid = present ? await panePid(tmux, tuiTarget(spec.alias)) : undefined;
  let socketPresent: boolean | undefined;
  if (spec.harness === "codex" && spec.socketPath !== undefined) {
    socketPresent = await access(spec.socketPath).then(() => true, () => false);
  }
  return {
    alias: spec.alias,
    harness: spec.harness,
    session,
    present,
    ...(pid === undefined ? {} : { pid }),
    ...(socketPresent === undefined ? {} : { socketPresent }),
  };
}
