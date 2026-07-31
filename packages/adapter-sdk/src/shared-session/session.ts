import {
  capturePane,
  hasSession,
  panePid,
  repairLegacyDegradedWindow,
  type TmuxController,
} from "./tmux.js";
import { inputBoxState } from "./pane.js";
import {
  LEGACY_DEGRADED_WINDOW,
  TUI_WINDOW,
  sessionName,
  type SharedSessionHarness,
} from "./types.js";

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
  /** Binario del harness. Se separa para poder apuntarlo a un doble en las pruebas. */
  readonly command?: string;
  /**
   * Variables que la TUI tiene que ver SÍ O SÍ, vaya quien vaya a crear la sesión.
   *
   * Se aplican en el ARGV del panel (`env K=V … exec …`) y no por el entorno del proceso que llama
   * a tmux. La diferencia es total y está medida: el servidor tmux se queda con el entorno del
   * PRIMER cliente que lo crea y DESCARTA el de los siguientes. Prueba en `ws-prizma` el
   * 2026-07-30, socket aislado: el cliente A creó el servidor con `MARCA=servidor-A`, el cliente B
   * creó otra sesión con `MARCA=cliente-B`, y los paneles de AMBAS sesiones vieron `servidor-A`.
   *
   * Consecuencia real: cualquier variable que ponga el supervisor es INERTE si el dueño abrió su
   * terminal primero. Ya hay una víctima comprobada: `supervisor.sh` exporta
   * `TERM=xterm-256color` con el comentario «sin él la TUI se dibuja rota para el dueño», y el
   * servidor tmux de socrates no tiene `TERM` en absoluto. Como los dos creadores —el adaptador y
   * `cauce <alias>`— pasan por aquí, el argv es el único punto que tmux no puede descartar.
   */
  readonly environment?: Readonly<Record<string, string>>;
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
  return transcriptDirectoryIn(`${home}/.claude`, workspace);
}

/**
 * Igual, pero a partir del directorio de configuración EXACTO con el que va a correr la TUI.
 *
 * Existe porque el sitio donde `claude` escribe los transcripts y el sitio donde el adaptador los
 * lee TIENEN que ser el mismo por construcción. Si alguien exporta `CLAUDE_CONFIG_DIR`, el panel lo
 * respeta (se lo pasamos en su argv) y la cosecha tiene que mirar allí, no en `~/.claude`. Derivar
 * los dos del mismo valor hace imposible que se separen.
 */
export function transcriptDirectoryIn(configDirectory: string, workspace: string): string {
  const slug = workspace.replace(/\/+$/u, "").replace(/\//gu, "-");
  const root = configDirectory.replace(/\/+$/u, "");
  return `${root}/projects/${slug === "" ? "-" : slug}`;
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
    let pid = await panePid(tmux, target);
    if (pid === undefined
      && await repairLegacyDegradedWindow(tmux, session, TUI_WINDOW, LEGACY_DEGRADED_WINDOW)) {
      // La sesión estaba enclavada por el renombrado de una versión anterior: la ventana existía
      // pero con otro nombre, así que el adaptador la daba por muerta en cada entrega, para
      // siempre. Devolverle el nombre la resucita sin tocar la conversación del dueño.
      pid = await panePid(tmux, target);
    }
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
  // Sin PID no hay panel, y sin panel no hay TUI: nunca "listo".
  //
  // Esto era un éxito silencioso medido, no una hipótesis. Cuando la ventana de la TUI moría al
  // nacer, `waitForTui` llegaba a ver el panel un instante, devolvía `true`, y `ensure` contestaba
  // `ready:true` sobre una sesión sin TUI dentro. El adaptador y `cauce <alias>` daban por buena
  // una sesión compartida inexistente: exactamente el fallo que este trabajo existe para eliminar.
  if (pid === undefined) {
    return {
      ready: false, created: true, failure: "tui_absent",
      detail: `la TUI de ${spec.alias} se creó y desapareció antes de poder usarla`,
    };
  }
  return { ready: true, created: true, pid, detail: `sesión ${session} creada` };
}

/**
 * El prefijo `env K=V …` que fija el entorno del panel, ya escapado para `bash -lc`.
 *
 * Devuelve un error en vez de descartar en silencio una variable con nombre inválido: una TUI que
 * arranca con menos entorno del que se le pidió es exactamente la clase de degradación muda que
 * este mecanismo existe para eliminar.
 */
export function paneEnvironmentPrefix(
  environment: Readonly<Record<string, string>> | undefined,
): { ok: true; prefix: string } | { ok: false; detail: string } {
  const entries = Object.entries(environment ?? {});
  if (entries.length === 0) return { ok: true, prefix: "" };
  const parts: string[] = [];
  for (const [name, value] of entries) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(name)) {
      return { ok: false, detail: `nombre de variable inválido para la sesión compartida: ${name}` };
    }
    parts.push(`${name}=${shellQuote(value)}`);
  }
  return { ok: true, prefix: `env ${parts.join(" ")} ` };
}

/** Comillas simples, que en POSIX no interpretan NADA. El valor nunca toca el parser del shell. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
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
  const environment = paneEnvironmentPrefix(spec.environment);
  if (!environment.ok) return { ok: false, detail: environment.detail };
  const env = environment.prefix;

  // Una ventana, un proceso: el binario del harness tal cual, igual que si lo abriera el dueño.
  //
  // codex tenía además una ventana `servidor` con `app-server --listen unix://` y arrancaba la TUI
  // con `--remote`. Se retiró entera: el turno ya no entra por ese protocolo sino por la caja de
  // entrada, así que el servidor, el socket, la espera a que aceptara y la ventana extra eran
  // cuatro piezas que sólo podían fallar. Y fallaron: el 2026-07-31 `turn/start` se quedó colgado
  // sin que el log del servidor registrara nada.
  const result = await tmux.run([
    "new-session", "-d", "-s", session, "-n", TUI_WINDOW,
    "-c", spec.workspace, "-x", width, "-y", height,
    "bash", "-lc", `exec ${env}${command}`,
  ]);
  return result.exitCode === 0 ? { ok: true } : { ok: false, detail: tmuxError(result.stderr) };
}

function tmuxError(stderr: string): string {
  const detail = stderr.trim().split(/\r?\n/u)[0] ?? "";
  return detail === "" ? "tmux rechazó la creación de la sesión" : detail;
}

/**
 * Espera a que la caja de entrada exista y esté vacía.
 *
 * No es un `sleep` fijo porque el arranque medido de claude va de 15 a 30 s y varía con la carga
 * del contenedor: un pegado que llega antes de que el lector de entrada esté listo se PIERDE sin
 * error —comprobado— y el turno se quedaría esperando una respuesta que nunca se pidió.
 *
 * Vale igual para codex desde que `inputBoxState` reconoce su cursor `›` y trata como VACÍO el
 * texto fantasma atenuado que dibuja cuando la caja está libre. Antes de eso, la caja de codex
 * parecía ocupada para siempre y todo turno degradaba a los 90 s.
 */
async function waitForTui(
  tmux: TmuxController,
  target: string,
  options: EnsureOptions,
): Promise<boolean> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    const pane = await capturePane(tmux, target, { styled: true });
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
}

export async function sharedSessionStatus(
  tmux: TmuxController,
  spec: SharedSessionSpec,
): Promise<SharedSessionStatus> {
  const session = sessionName(spec.alias);
  const present = await hasSession(tmux, session);
  const pid = present ? await panePid(tmux, tuiTarget(spec.alias)) : undefined;
  return {
    alias: spec.alias,
    harness: spec.harness,
    session,
    present,
    ...(pid === undefined ? {} : { pid }),
  };
}
