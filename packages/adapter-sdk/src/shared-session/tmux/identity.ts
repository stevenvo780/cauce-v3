import { spawn } from "node:child_process";
import { TMUX_SOCKET } from "../types.js";

export interface TmuxResult {
  readonly exitCode: number | null;
  readonly stdout: string;
  readonly stderr: string;
}

export interface TmuxRunControl {
  /** Cancela y reapea el cliente tmux; nunca significa que el servidor no alcanzó a mutar. */
  readonly signal?: AbortSignal;
  /** Techo del proceso cliente. Al vencer se envía TERM, luego KILL, y se espera `close`. */
  readonly timeoutMs?: number;
}

/**
 * La superficie tmux que usa la sesión compartida, como interfaz para poder sustituirla.
 *
 * Existe separada del runner porque es la ÚNICA parte que necesita un tmux de verdad: con esto
 * detrás de una interfaz, la cosecha del transcript, el arbitraje de la caja de entrada y la
 * degradación se prueban con ficheros reales y sin terminal.
 */
export interface TmuxController {
  run(args: readonly string[], stdin?: string, control?: TmuxRunControl): Promise<TmuxResult>;
}

const LIFECYCLE_ENV_KEYS = [
  "CAUCE_ALIAS", "CAUCE_STATE_DIR", "CAUCE_CONTROL_DIR", "CAUCE_CONTAINER_ID",
  "CAUCE_CONTAINER_GENERATION",
] as const;

export function withoutLifecycleIdentity(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...environment };
  for (const key of LIFECYCLE_ENV_KEYS) delete copy[key];
  return copy;
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
    private readonly defaultTimeoutMs: number = 10_000,
    private readonly executable: string = "tmux",
  ) {}

  run(
    args: readonly string[],
    stdin?: string,
    control: TmuxRunControl = {},
  ): Promise<TmuxResult> {
    if (control.signal?.aborted === true) {
      return Promise.resolve({ exitCode: null, stdout: "", stderr: "tmux client aborted" });
    }
    return new Promise<TmuxResult>((resolveRun) => {
      const child = spawn(this.executable, ["-L", this.socket, ...args], {
        shell: false,
        env: withoutLifecycleIdentity(this.environment),
        stdio: ["pipe", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let spawnError: Error | undefined;
      let termination: "aborted" | "timed_out" | undefined;
      let forceKill: NodeJS.Timeout | undefined;
      const timeoutMs = Math.max(1, control.timeoutMs ?? this.defaultTimeoutMs);
      const stopClient = (reason: "aborted" | "timed_out"): void => {
        if (termination !== undefined) return;
        termination = reason;
        child.stdin.destroy();
        child.kill("SIGTERM");
        forceKill = setTimeout(() => {
          child.kill("SIGKILL");
        }, TMUX_CLIENT_TERM_GRACE_MS);
      };
      const aborted = (): void => {
        stopClient("aborted");
      };
      control.signal?.addEventListener("abort", aborted, { once: true });
      // El signal puede abortar entre la comprobacion previa al spawn y el registro del listener.
      // Releerlo despues de registrar cierra esa ventana sin dejar un cliente huérfano.
      if (control.signal?.aborted === true) aborted();
      const timeout = setTimeout(() => {
        stopClient("timed_out");
      }, timeoutMs);
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString("utf8");
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      child.once("error", (error: Error) => {
        spawnError = error;
      });
      child.once("close", (exitCode) => {
        clearTimeout(timeout);
        if (forceKill !== undefined) clearTimeout(forceKill);
        control.signal?.removeEventListener("abort", aborted);
        if (termination !== undefined) {
          resolveRun({
            exitCode: null,
            stdout,
            stderr: stderr === "" ? `tmux client ${termination}` : stderr,
          });
          return;
        }
        resolveRun({
          exitCode: spawnError === undefined ? exitCode : 127,
          stdout,
          stderr: stderr === "" && spawnError !== undefined ? spawnError.message : stderr,
        });
      });
      child.stdin.on("error", () => undefined);
      child.stdin.end(stdin ?? "", "utf8");
    });
  }
}

const TMUX_CLIENT_TERM_GRACE_MS = 50;

export async function hasSession(tmux: TmuxController, session: string): Promise<boolean> {
  const result = await tmux.run(["has-session", "-t", `=${session}`]);
  return result.exitCode === 0;
}

export const SESSION_ID_PATTERN = /^\$[0-9]+$/u;
export const WINDOW_ID_PATTERN = /^@[0-9]+$/u;
export const PANE_ID_PATTERN = /^%[0-9]+$/u;
export const SAFE_TMUX_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/u;

/**
 * Identidad completa de una generación de panel.
 *
 * Ni el nombre de sesión, ni `$N`, ni `%N` bastan por separado: tmux conserva el pane id tras
 * `respawn-pane`, y vuelve a numerar sesiones/paneles desde cero después de reiniciar el servidor.
 * La tupla completa permite apuntar por `%pane_id` y, a la vez, detectar que ese target ahora
 * pertenece a otra conversación o a otro proceso.
 */
export interface PaneIdentity {
  readonly sessionId: string;
  readonly sessionName: string;
  /** Id estable de ventana; el nombre es metadato mutable y no cerca un respawn/rename. */
  readonly windowId: string;
  readonly windowName: string;
  readonly paneId: string;
  readonly panePid: string;
}

/** Identidad de proceso junto con el comando ORIGINAL observado para esa misma generación. */
export interface PaneHarnessIdentity extends PaneIdentity {
  readonly paneStartCommand: string;
}

/** Identidad intransferible de una sesión creada por UN intento de `ensure`. */
export interface CreatedSessionOwnership extends PaneHarnessIdentity {
  readonly creationNonce: string;
}

export const CREATION_NONCE_OPTION = "@cauce_creation_nonce";

const PANE_IDENTITY_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
].join("\t");

export const QUARANTINED_PANE_OPTION = "@cauce_quarantined_pane";

export function signalIsAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

/** Un id `$N` de tmux es exacto; a diferencia del nombre, nunca admite coincidencia por prefijo. */
export async function hasSessionId(tmux: TmuxController, sessionId: string): Promise<boolean> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return false;
  const result = await tmux.run(["has-session", "-t", sessionId]);
  return result.exitCode === 0;
}

/** Resuelve un nombre por igualdad exacta al id estable de tmux (`$0`, `$1`, ...). */
export async function exactSessionTarget(
  tmux: TmuxController,
  session: string,
): Promise<string | undefined> {
  const result = await tmux.run(["list-sessions", "-F", "#{session_name}\t#{session_id}"]);
  if (result.exitCode !== 0) return undefined;
  for (const line of result.stdout.split(/\r?\n/u)) {
    const separator = line.indexOf("\t");
    if (separator < 0 || line.slice(0, separator) !== session) continue;
    const identifier = line.slice(separator + 1);
    return SESSION_ID_PATTERN.test(identifier) ? identifier : undefined;
  }
  return undefined;
}

/**
 * Acredita a la vez vida e identidad: el nombre sigue resolviendo al MISMO `$N`.
 *
 * `has-session -t =nombre` sólo prueba que hay algo con ese nombre. Si la TUI murió y otra sesión
 * tomó el nombre entre dos awaits, operar por nombre pegaría el turno en la conversación nueva.
 */
export async function sessionIdStillNamed(
  tmux: TmuxController,
  session: string,
  sessionId: string,
): Promise<boolean> {
  return SESSION_ID_PATTERN.test(sessionId)
    && await exactSessionTarget(tmux, session) === sessionId;
}

/** Lee una sola vez toda la identidad que tmux atribuye al target exacto. */
export async function paneIdentity(
  tmux: TmuxController,
  target: string,
  control?: TmuxRunControl,
): Promise<PaneIdentity | undefined> {
  const result = await tmux.run(
    ["display-message", "-p", "-t", target, PANE_IDENTITY_FORMAT],
    undefined,
    control,
  );
  if (result.exitCode !== 0) return undefined;
  return parsePaneIdentity(result.stdout);
}

function parsePaneIdentity(stdout: string): PaneIdentity | undefined {
  const fields = stdout.replace(/\r?\n$/u, "").split("\t");
  if (fields.length !== 7) return undefined;
  const [sessionId, sessionName, windowId, windowName, paneId, processId, dead] = fields;
  if (sessionId === undefined || !SESSION_ID_PATTERN.test(sessionId)
    || sessionName === undefined || sessionName === ""
    || windowId === undefined || !WINDOW_ID_PATTERN.test(windowId)
    || windowName === undefined || windowName === ""
    || paneId === undefined || !PANE_ID_PATTERN.test(paneId)
    || processId === undefined || !/^[0-9]+$/u.test(processId)
    || dead !== "0") return undefined;
  return { sessionId, sessionName, windowId, windowName, paneId, panePid: processId };
}

export type ExactPaneInspection =
  | { readonly state: "present"; readonly identity: PaneIdentity }
  | { readonly state: "absent" }
  | { readonly state: "unreadable" };

/**
 * Distingue una desaparición acreditada de un fallo de lectura.
 *
 * `display-message` usa el target exacto `%N`; si falla, `list-panes -a` prueba si el servidor aún
 * puede enumerar paneles. Sólo esa enumeración exitosa y sin `%N` permite afirmar `absent`.
 */
export async function inspectExactPane(
  tmux: TmuxController,
  paneId: string,
  control?: TmuxRunControl,
): Promise<ExactPaneInspection> {
  if (!PANE_ID_PATTERN.test(paneId)) return { state: "unreadable" };
  try {
    const displayed = await tmux.run([
      "display-message", "-p", "-t", paneId, PANE_IDENTITY_FORMAT,
    ], undefined, control);
    if (displayed.exitCode === 0) {
      const identity = parsePaneIdentity(displayed.stdout);
      return identity === undefined
        ? { state: "unreadable" }
        : { state: "present", identity };
    }
    const listed = await tmux.run(
      ["list-panes", "-a", "-F", "#{pane_id}"],
      undefined,
      control,
    );
    if (listed.exitCode !== 0) return { state: "unreadable" };
    return listed.stdout.split(/\r?\n/u).some((candidate) => candidate === paneId)
      ? { state: "unreadable" }
      : { state: "absent" };
  } catch {
    return { state: "unreadable" };
  }
}

/** Compara también PID: `respawn-pane` conserva `%N` pero ya no conserva la conversación. */
export function samePaneIdentity(left: PaneIdentity, right: PaneIdentity): boolean {
  return left.sessionId === right.sessionId
    && left.sessionName === right.sessionName
    && left.windowId === right.windowId
    && left.windowName === right.windowName
    && left.paneId === right.paneId
    && left.panePid === right.panePid;
}

/** Mismo proceso/pane aunque un humano haya renombrado la sesión o la ventana. */
export function samePaneProcess(left: PaneIdentity, right: PaneIdentity): boolean {
  return left.sessionId === right.sessionId
    && left.windowId === right.windowId
    && left.paneId === right.paneId
    && left.panePid === right.panePid;
}

/** Revalida la generación usando `%pane_id`, que no admite fallback por nombre/prefijo. */
export async function paneIdentityStillCurrent(
  tmux: TmuxController,
  expected: PaneIdentity,
  control?: TmuxRunControl,
): Promise<boolean> {
  const current = await paneIdentity(tmux, expected.paneId, control);
  return current !== undefined && samePaneIdentity(current, expected);
}

export function paneGeneration(identity: PaneIdentity): string {
  return `${identity.sessionId}:${identity.windowId}:${identity.paneId}:${identity.panePid}`;
}

/** Clave no sensible y estable con la que disco y tmux identifican la misma generación. */
export function paneGenerationKey(identity: PaneIdentity): string {
  return paneGeneration(identity);
}
