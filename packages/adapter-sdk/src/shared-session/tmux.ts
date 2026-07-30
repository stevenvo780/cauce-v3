import { spawn } from "node:child_process";
import { TMUX_SOCKET } from "./types.js";

export interface TmuxResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * La superficie tmux que usa la sesión compartida, como interfaz para poder sustituirla.
 *
 * Existe separada del runner porque es la ÚNICA parte que necesita un tmux de verdad: con esto
 * detrás de una interfaz, la cosecha del transcript, el arbitraje de la caja de entrada y la
 * degradación se prueban con ficheros reales y sin terminal.
 */
export interface TmuxController {
  run(args: readonly string[], stdin?: string): Promise<TmuxResult>;
}

/**
 * tmux de verdad, sin shell.
 *
 * `shell: false` no es decoración: el prompt de protocolo entra por `load-buffer` desde stdin y
 * nunca por argv, igual que hace `SpawnCommandRunner`. Nada de lo que viene de una entrega se
 * interpola en una línea de comandos.
 */
export class CliTmux implements TmuxController {
  constructor(
    private readonly socket: string = TMUX_SOCKET,
    private readonly environment: NodeJS.ProcessEnv = process.env,
  ) {}

  run(args: readonly string[], stdin?: string): Promise<TmuxResult> {
    return new Promise<TmuxResult>((resolveRun) => {
      const child = spawn("tmux", ["-L", this.socket, ...args], {
        shell: false,
        env: this.environment,
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error: Error) => {
        resolveRun({ exitCode: 127, stdout, stderr: stderr === "" ? error.message : stderr });
      });
      child.once("close", (exitCode) => {
        resolveRun({ exitCode, stdout, stderr });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "", "utf8");
    });
  }
}

export async function hasSession(tmux: TmuxController, session: string): Promise<boolean> {
  const result = await tmux.run(["has-session", "-t", `=${session}`]);
  return result.exitCode === 0;
}

export async function capturePane(tmux: TmuxController, target: string): Promise<string | undefined> {
  const result = await tmux.run(["capture-pane", "-p", "-t", target]);
  return result.exitCode === 0 ? result.stdout : undefined;
}

/**
 * Identidad del proceso que corre en el panel.
 *
 * Es la señal que detecta la trampa medida: `claude` se auto-actualiza y se reinicia solo (visto
 * `Auto-updating…` con la TUI reportando 2.1.179 y el binario en 2.1.220). El nombre de la sesión
 * sobrevive a eso; el PID no. Comparar el PID entre turnos es lo que separa "la misma
 * conversación" de "una TUI nueva que no recuerda nada".
 */
export async function panePid(tmux: TmuxController, target: string): Promise<string | undefined> {
  // El target es `sesión:ventana`. Se comprueba que la ventana EXISTA antes de preguntar el PID,
  // porque preguntar primero devuelve el de otra ventana sin ningún error. Ver `windowExists`.
  const separator = target.lastIndexOf(":");
  if (separator > 0) {
    const session = target.slice(0, separator);
    const window = target.slice(separator + 1);
    if (!await windowExists(tmux, session, window)) return undefined;
  }
  const result = await tmux.run(["display-message", "-p", "-t", target, "#{pane_pid}"]);
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.trim();
  return /^[0-9]+$/u.test(value) ? value : undefined;
}

/**
 * ¿Existe EXACTAMENTE esa ventana en esa sesión?
 *
 * Hace falta porque `display-message` MIENTE. Medido en `ws-prizma` el 2026-07-30, con la sesión
 * `cauce-socrates` teniendo sólo la ventana `servidor`:
 *
 * ```
 * tmux display-message -p -t cauce-socrates:agente  '#{window_name} #{pane_pid}'
 *   -> servidor 14667      (exit 0)
 * tmux display-message -p -t cauce-socrates:=agente '#{window_name} #{pane_pid}'
 *   -> servidor 14667      (exit 0)   <- ni el prefijo '=' lo evita
 * tmux capture-pane -p -t cauce-socrates:agente
 *   -> can't find window: agente      (falla, como corresponde)
 * ```
 *
 * Al no encontrar la ventana, `display-message` cae a la ventana ACTUAL y devuelve 0. Sin esta
 * comprobación `panePid` entregaba el PID del app-server como si fuera el de la TUI, y toda la
 * cadena daba por viva una TUI inexistente: `ensure` decía `ready`, `cauce <alias>` decía
 * COMPARTIDA y el adaptador creía estar compartiendo contexto con una ventana que no existe.
 *
 * `list-windows` sí enumera lo que hay, y la comparación es por igualdad exacta: tmux acepta
 * prefijos y patrones, y "agente" no puede significar otra ventana que "agente".
 */
export async function windowExists(
  tmux: TmuxController,
  session: string,
  window: string,
): Promise<boolean> {
  const result = await tmux.run(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"]);
  if (result.exitCode !== 0) return false;
  return result.stdout.split(/\r?\n/u).some((name) => name.trim() === window);
}

/**
 * Mete el texto en la caja de entrada como UNA sola entrada, sin enviarlo.
 *
 * `load-buffer -` toma el texto por stdin y `paste-buffer -p` lo entrega entre corchetes
 * (bracketed paste). Ese modo es lo que impide que los ~30 saltos de línea del prompt de
 * protocolo se conviertan en ~30 envíos: medido con un prompt real de 12 líneas / 668 bytes, la
 * TUI lo tomó como `[Pasted text #1 +12 lines]` y NO se envió solo.
 */
export async function pastePrompt(
  tmux: TmuxController,
  target: string,
  buffer: string,
  text: string,
): Promise<boolean> {
  const load = await tmux.run(["load-buffer", "-b", buffer, "-"], text);
  if (load.exitCode !== 0) return false;
  const paste = await tmux.run(["paste-buffer", "-b", buffer, "-t", target, "-p", "-d"]);
  return paste.exitCode === 0;
}

export async function sendEnter(tmux: TmuxController, target: string): Promise<boolean> {
  const result = await tmux.run(["send-keys", "-t", target, "Enter"]);
  return result.exitCode === 0;
}

/**
 * El aviso que el dueño ve EN SU PANEL cuando la sesión compartida no sirvió el turno.
 *
 * Son dos superficies porque una sola no alcanza: `display-message` es inmediato pero se va solo, y
 * el ROJO de la barra de estado persiste mientras el cliente siga enganchado. Ninguna de las dos
 * escribe en la caja de entrada — eso corrompería lo que el dueño esté tecleando, que es justamente
 * el defecto que este mecanismo tiene que evitar.
 *
 * Lo que NO se hace nunca es renombrar la ventana. La versión anterior la renombraba a
 * `⚠ CAUCE-DEGRADADO` y eso se auto-enclavaba: `tuiTarget()` busca la ventana por su NOMBRE
 * (`cauce-<alias>:agente`), así que en cuanto salía el primer aviso la ventana dejaba de existir
 * para el propio adaptador y TODAS las entregas siguientes degradaban `tui_absent` en 0,2 s, para
 * siempre, con la TUI viva delante. `clearDegradation` tampoco podía curarlo, porque apuntaba al
 * mismo nombre que ya no existía. Verificado de punta a punta el 2026-07-30. El color dice lo
 * mismo sin tocar la identidad de la ventana.
 *
 * Nunca falla hacia afuera: avisar es importante, pero no puede tumbar un turno que ya se
 * respondió.
 */
export async function announceDegradation(
  tmux: TmuxController,
  session: string,
  window: string,
  summary: string,
): Promise<void> {
  await announceNotice(tmux, session, window, summary);
  await tmux.run([
    "set-option", "-w", "-t", `${session}:${window}`, "window-status-style", "bg=red,fg=white",
  ]).catch(() => undefined);
  await tmux.run(["set-option", "-t", session, "status-style", "bg=red,fg=white"])
    .catch(() => undefined);
}

/**
 * Aviso EFÍMERO, sin rojo.
 *
 * Es para los sucesos que NO son una caída: el turno sí pasó por la terminal, pero su memoria
 * cambió (se vació con `/clear`, se compactó, o la sesión se acababa de crear). Teñir la barra de
 * rojo ahí sería mentir en la otra dirección — el mecanismo funciona— y dejaría el rojo pegado en
 * un panel sano.
 */
export async function announceNotice(
  tmux: TmuxController,
  session: string,
  window: string,
  summary: string,
): Promise<void> {
  const oneLine = summary.replace(/\s+/gu, " ").slice(0, 200);
  await tmux.run(["display-message", "-t", `${session}:${window}`, "-d", "15000", oneLine])
    .catch(() => undefined);
}

/** Quita el rojo cuando un turno vuelve a pasar por la sesión compartida. */
export async function clearDegradation(
  tmux: TmuxController,
  session: string,
  window: string,
): Promise<void> {
  await tmux.run(["set-option", "-w", "-t", `${session}:${window}`, "-u", "window-status-style"])
    .catch(() => undefined);
  await tmux.run(["set-option", "-t", session, "-u", "status-style"]).catch(() => undefined);
}

/**
 * Deshace el enclavamiento que dejó la versión anterior.
 *
 * Una sesión que ya degradó con el build viejo tiene su ventana renombrada a `⚠ CAUCE-DEGRADADO` y
 * está condenada: nunca más volverá a encontrar la TUI. Se repara devolviéndole el nombre, y sólo
 * en el caso exacto —la ventana buena ausente y la renombrada presente— para no tocar jamás una
 * ventana que el dueño haya bautizado él.
 *
 * Devuelve `true` si reparó algo, para poder decirlo en vez de arreglarlo en silencio.
 */
export async function repairLegacyDegradedWindow(
  tmux: TmuxController,
  session: string,
  window: string,
  legacyName: string,
): Promise<boolean> {
  const result = await tmux.run(["list-windows", "-t", `=${session}`, "-F", "#{window_name}"]);
  if (result.exitCode !== 0) return false;
  const names = result.stdout.split(/\r?\n/u).map((name) => name.trim());
  if (names.includes(window) || !names.includes(legacyName)) return false;
  const renamed = await tmux.run([
    "rename-window", "-t", `${session}:${legacyName}`, window,
  ]).catch(() => undefined);
  return renamed?.exitCode === 0;
}
