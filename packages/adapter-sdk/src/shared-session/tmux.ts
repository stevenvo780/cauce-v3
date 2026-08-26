import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { inputBoxState } from "./pane.js";
import { TMUX_SOCKET } from "./types.js";

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

/**
 * Variables con las que el supervisor RECONOCE a los procesos de su propio ciclo de vida.
 *
 * `alias_generation_pids` (cauce-container-runtime.py) barre `/proc` y considera «de esta
 * generación» a todo proceso cuyo entorno traiga `CAUCE_ALIAS`, `CAUCE_CONTAINER_GENERATION` y
 * `CAUCE_STATE_DIR`. Si encuentra uno que no puede atribuir ni al controlador ni al árbol del
 * adaptador, falla cerrado: no manda ninguna señal y sale 78.
 *
 * El servidor de tmux se demoniza —se va del grupo de procesos y del árbol de descendientes del
 * adaptador— pero HEREDA su entorno. Con estas variables puestas queda como «proceso no rastreado»
 * para siempre, y a partir de ahí `systemctl restart` del alias NO funciona nunca más: el stop se
 * niega, el start se niega, la unidad queda `failed` y el adaptador viejo sigue vivo atendiendo. Se
 * ve como un alias sano —el lease late, contesta— con la unidad en `failed` y el bundle viejo.
 * Medido el 2026-08-06 en atlas y dedalo: los dos fallaron con exit 78 y los untracked eran
 * exactamente el `tmux new-session` de la sesión compartida y la TUI colgando de él.
 *
 * Se borran las CINCO de `IDENTITY_ENV_KEYS`, no las tres del barrido: el runtime también compara
 * el entorno completo contra `expected_environment()` para reconocer al adaptador y al
 * controlador, y dejar la mitad de la identidad puesta en un proceso ajeno al ciclo de vida es
 * volver a sembrar el mismo error donde el próximo cambio de criterio lo encuentre.
 *
 * La sesión del dueño no es parte del ciclo de vida del adaptador, así que estas variables no
 * pintan nada ahí. Lo que la TUI sí necesita se le pasa explícito por `paneEnvironmentPrefix`.
 */
const LIFECYCLE_ENV_KEYS = [
  "CAUCE_ALIAS", "CAUCE_STATE_DIR", "CAUCE_CONTROL_DIR", "CAUCE_CONTAINER_ID",
  "CAUCE_CONTAINER_GENERATION",
] as const;

/** El entorno del adaptador sin su identidad de ciclo de vida. */
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

const SESSION_ID_PATTERN = /^\$[0-9]+$/u;
const WINDOW_ID_PATTERN = /^@[0-9]+$/u;
const PANE_ID_PATTERN = /^%[0-9]+$/u;
const SAFE_TMUX_NAME_PATTERN = /^[A-Za-z0-9_.:-]+$/u;

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

const QUARANTINED_PANE_OPTION = "@cauce_quarantined_pane";

function signalIsAborted(signal: AbortSignal | undefined): boolean {
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

function paneGeneration(identity: PaneIdentity): string {
  return `${identity.sessionId}:${identity.windowId}:${identity.paneId}:${identity.panePid}`;
}

/** Clave no sensible y estable con la que disco y tmux identifican la misma generación. */
export function paneGenerationKey(identity: PaneIdentity): string {
  return paneGeneration(identity);
}

/**
 * Ejecuta una mutación sólo si tmux evalúa la generación dentro de la MISMA orden de servidor.
 *
 * Un `display-message` seguido de `send-keys` tiene TOCTOU: `respawn-pane` conserva `%N`. `if-shell
 * -F` evalúa PID/session/pane y encola la mutación como una sola orden del servidor. Cada rama
 * señala un canal `wait-for` criptográfico distinto: `wait-for` no escribe en la UI ni posee un
 * hook `after-*` en tmux 3.4. Esto importa porque tanto `run-shell` fallido como
 * `display-message -p` y `list-panes -F` pueden activar view/copy-mode, inyectar teclas o adulterar
 * stdout mediante sus hooks aun cuando el CAS rechazó la mutación.
 */
export type TmuxMutationState = "applied" | "not_applied" | "ambiguous";

type CasBranch = "accepted" | "rejected";

interface CasWitness {
  readonly acceptedChannel: string;
  readonly rejectedChannel: string;
  readonly acceptedCommand: string;
  readonly rejectedCommand: string;
}

const CAS_WITNESS_SETTLE_MS = 100;

function casWitness(): CasWitness {
  const nonce = randomBytes(32).toString("hex");
  const acceptedChannel = `cauce-cas-v2-${nonce}-accepted`;
  const rejectedChannel = `cauce-cas-v2-${nonce}-rejected`;
  return {
    acceptedChannel,
    rejectedChannel,
    acceptedCommand: `wait-for -S ${acceptedChannel}`,
    rejectedCommand: `wait-for -S ${rejectedChannel}`,
  };
}

function exactWaitForResult(result: TmuxResult): boolean {
  return result.exitCode === 0 && result.stdout === "" && result.stderr === "";
}

interface CasObservation {
  finish(): Promise<CasBranch | undefined>;
}

/**
 * Registra ambos waiters ANTES del CAS. La señal no depende de stdout y sobrevive hasta que su
 * waiter la consume; prearrancar los clientes cubre además `kill-pane`/`kill-session` del último
 * pane, donde el servidor puede desaparecer justo después de la mutación.
 */
function observeCasWitness(tmux: TmuxController, witness: CasWitness): CasObservation {
  const acceptedAbort = new AbortController();
  const rejectedAbort = new AbortController();
  const accepted = tmux.run(
    ["wait-for", witness.acceptedChannel],
    undefined,
    { signal: acceptedAbort.signal, timeoutMs: 1_000 },
  );
  const rejected = tmux.run(
    ["wait-for", witness.rejectedChannel],
    undefined,
    { signal: rejectedAbort.signal, timeoutMs: 1_000 },
  );
  let finished = false;
  return {
    async finish(): Promise<CasBranch | undefined> {
      if (finished) return undefined;
      finished = true;
      const successes = Promise.any([
        accepted.then((result) => {
          if (!exactWaitForResult(result)) throw new Error("accepted witness unavailable");
          return "accepted" as const;
        }),
        rejected.then((result) => {
          if (!exactWaitForResult(result)) throw new Error("rejected witness unavailable");
          return "rejected" as const;
        }),
      ]).catch(() => undefined);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const settleDeadline = new Promise<undefined>((resolveDeadline) => {
        timer = setTimeout(() => {
          resolveDeadline(undefined);
        }, CAS_WITNESS_SETTLE_MS);
      });
      const branch = await Promise.race([successes, settleDeadline]);
      if (timer !== undefined) clearTimeout(timer);
      acceptedAbort.abort();
      rejectedAbort.abort();
      // CliTmux reapea inmediatamente al abort. Un wrapper defectuoso puede no reenviar `control`;
      // no se permite que ese wrapper transforme un testigo ya acreditado en una espera de 10 s.
      // Los promises conservan handler y su timeout propio, por lo que tampoco quedan rejections.
      let reapTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        Promise.allSettled([accepted, rejected]),
        new Promise<void>((resolveReapDeadline) => {
          reapTimer = setTimeout(resolveReapDeadline, CAS_WITNESS_SETTLE_MS);
        }),
      ]);
      if (reapTimer !== undefined) clearTimeout(reapTimer);
      return branch;
    },
  };
}

interface AtomicCasResult {
  readonly branch?: CasBranch;
  readonly result?: TmuxResult;
}

/** Ejecuta el compare-and-mutate y acredita la rama sin ningún comando observable por el pane. */
async function atomicCas(
  tmux: TmuxController,
  target: string,
  condition: string,
  command: string,
  control?: TmuxRunControl,
): Promise<AtomicCasResult> {
  const witness = casWitness();
  const observation = observeCasWitness(tmux, witness);
  let result: TmuxResult | undefined;
  try {
    result = await tmux.run([
      "if-shell", "-F", "-t", target, condition,
      command === "" ? witness.acceptedCommand : `${command} ; ${witness.acceptedCommand}`,
      witness.rejectedCommand,
    ], undefined, control);
  } catch {
    const branch = await observation.finish();
    return branch === undefined ? {} : { branch };
  }
  const branch = await observation.finish();
  return branch === undefined ? { result } : { result, branch };
}

/** Evalúa un formato booleano sin `display-message`, `list-*`, salida ni hooks de lectura. */
async function probeTmuxFormat(
  tmux: TmuxController,
  target: string,
  condition: string,
  control?: TmuxRunControl,
): Promise<boolean | undefined> {
  const observed = await atomicCas(tmux, target, condition, "", control);
  if (observed.branch === "accepted") return true;
  if (observed.branch === "rejected") return false;
  return undefined;
}

function exactPaneCondition(
  identity: PaneIdentity,
  logicalIdentity: "process" | "full",
): string | undefined {
  if (!SESSION_ID_PATTERN.test(identity.sessionId)
    || !WINDOW_ID_PATTERN.test(identity.windowId)
    || !PANE_ID_PATTERN.test(identity.paneId)
    || !/^[0-9]+$/u.test(identity.panePid)
    || (logicalIdentity === "full"
    && (!SAFE_TMUX_NAME_PATTERN.test(identity.sessionName)
      || !SAFE_TMUX_NAME_PATTERN.test(identity.windowName)))) return undefined;
  const processCondition = `#{&&:#{==:#{session_id},${identity.sessionId}},`
    + `#{&&:#{==:#{window_id},${identity.windowId}},#{&&:#{==:#{pane_id},${identity.paneId}},`
    + `#{==:#{pane_pid},${identity.panePid}}}}}`;
  return logicalIdentity === "process"
    ? processCondition
    : `#{&&:${processCondition},#{&&:#{==:#{session_name},${identity.sessionName}},`
      + `#{==:#{window_name},${identity.windowName}}}}`;
}

async function mutateExactPane(
  tmux: TmuxController,
  identity: PaneIdentity,
  command: string,
  control?: TmuxRunControl,
  logicalIdentity: "process" | "full" = "process",
  additionalCondition?: string,
  acceptsSessionDisappearance: boolean = false,
): Promise<TmuxMutationState> {
  const paneCondition = exactPaneCondition(identity, logicalIdentity);
  if (paneCondition === undefined) return "ambiguous";
  const condition = additionalCondition === undefined
    ? paneCondition
    : `#{&&:${paneCondition},${additionalCondition}}`;
  const mutation = await atomicCas(tmux, identity.paneId, condition, command, control);
  if (mutation.branch === "accepted") return "applied";
  if (mutation.branch === "rejected") return "not_applied";
  // `kill-pane` del último pane destruye el servidor antes del wait-for final. Sólo esa superficie
  // acepta como evidencia alternativa exit 0 + desaparición exacta del session id.
  if (acceptsSessionDisappearance && mutation.result?.exitCode === 0
    && !await hasSessionId(tmux, identity.sessionId)) return "applied";
  return "ambiguous";
}

const INPUT_BARRIER_OPTION = "@cauce_input_barrier";
const INPUT_BARRIER_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export interface PaneInputBarrier {
  readonly identity: PaneIdentity;
  /** Token no sensible que impide que un finally ajeno desbloquee el pane. */
  readonly token: string;
}

function inputBarrierCondition(barrier: PaneInputBarrier): string | undefined {
  return INPUT_BARRIER_TOKEN_PATTERN.test(barrier.token)
    ? `#{&&:#{==:#{pane_input_off},1},`
      + `#{&&:#{==:#{pane_in_mode},0},`
      + `#{==:#{${INPUT_BARRIER_OPTION}},${barrier.token}}}}`
    : undefined;
}

/**
 * Ejecuta input técnico sin abrir una ventana intercalable a clientes humanos.
 *
 * El pane permanece `input_off` entre operaciones. Dentro de esta única cola se habilita, se
 * ejecuta exactamente una mutación y se vuelve a deshabilitar. Los hooks relevantes se rechazaron
 * antes de adquirir la barrera: sin un hook que espere, tmux procesa la cola completa antes de leer
 * input de otro cliente. Un probe `if-shell` hookless acredita después que no quedó habilitado.
 */
async function mutateUnderInputBarrier(
  tmux: TmuxController,
  barrier: PaneInputBarrier,
  command: string,
  control?: TmuxRunControl,
  logicalIdentity: "process" | "full" = "process",
): Promise<TmuxMutationState> {
  const { identity } = barrier;
  // Releer justo antes de cada mutación también cubre hooks añadidos durante el settle. tmux no
  // ofrece un lock transaccional contra un administrador que ejecute `set-hook` en el mismo socket
  // DESPUÉS de esta lectura y ANTES del if-shell; ese acceso privilegiado al control plane es el
  // límite real del protocolo. Ante hooks ya observables se falla cerrado sin abrir input.
  if (!await inputBarrierHooksAreEmpty(tmux, identity.paneId, control)) return "not_applied";
  const paneCondition = exactPaneCondition(identity, logicalIdentity);
  const barrierCondition = inputBarrierCondition(barrier);
  if (paneCondition === undefined || barrierCondition === undefined) return "ambiguous";
  const condition = `#{&&:${paneCondition},${barrierCondition}}`;
  const mutation = await atomicCas(
    tmux,
    identity.paneId,
    condition,
    `select-pane -e -t ${identity.paneId} ; ${command}`
      + ` ; select-pane -d -t ${identity.paneId}`,
    control,
  );
  // El testigo accepted se encola DESPUÉS de volver a `input_off`; si paste/send/select falla, tmux
  // corta la lista antes de señalarlo. La postcondición se acredita con otro formato atómico, no
  // con una lectura que pueda disparar un hook.
  if (mutation.branch === "accepted") {
    // Los nombres son metadato humano y pueden cambiar apenas termina el paste. La precondición
    // `full` impidió pegar en otra conversación; la postcondición debe seguir el MISMO proceso,
    // igual que release, para no declarar ambiguo un rename posterior a una mutación ya aplicada.
    const processCondition = exactPaneCondition(identity, "process");
    if (processCondition === undefined) return "ambiguous";
    const postcondition = `#{&&:${processCondition},${barrierCondition}}`;
    return await probeTmuxFormat(tmux, identity.paneId, postcondition, control) === true
      ? "applied"
      : "ambiguous";
  }
  if (mutation.branch === "rejected") return "not_applied";
  return "ambiguous";
}

export type PaneInputBarrierAcquireResult =
  | { readonly state: "acquired"; readonly barrier: PaneInputBarrier }
  | { readonly state: "busy" }
  | { readonly state: "not_applied" }
  | { readonly state: "unsafe_hooks" }
  | { readonly state: "ambiguous" };

const EMPTY_TMUX_HOOK_NAME_PATTERN = /^[a-z][a-z0-9-]*$/u;

/**
 * Una cola de tmux sólo excluye a otros clientes si no existe NINGÚN hook efectivo que pueda
 * ejecutar comandos mientras vive la barrera. No basta con enumerar los comandos obvios:
 * `after-load-buffer` puede pegar y enviar el prompt antes de nuestro paste, `after-capture-pane`
 * puede mutar la caja durante su verificación y eventos asíncronos como `client-focus-in` pueden
 * dispararse sin que Cauce invoque el comando que les da nombre.
 *
 * Por eso se inspecciona el catálogo completo que el propio tmux publica en los cuatro scopes. Una
 * línea desnuda es sólo el nombre de un hook vacío; cualquier índice/comando, continuación o forma
 * desconocida significa configuración ejecutable y falla cerrado. El catálogo se descubre en
 * runtime para que un hook agregado por una versión futura de tmux no quede fuera de una lista
 * estática otra vez. Cauce nunca desinstala ni restaura hooks: son estado ajeno del administrador.
 */
async function inputBarrierHooksAreEmpty(
  tmux: TmuxController,
  paneId: string,
  control?: TmuxRunControl,
): Promise<boolean> {
  const scopes = [
    ["-g"],
    [],
    ["-w"],
    ["-p"],
  ] as const;
  try {
    for (const scope of scopes) {
      const result = await tmux.run(
        ["show-hooks", ...scope, "-t", paneId],
        undefined,
        control,
      );
      if (result.exitCode !== 0) return false;
      const lines = result.stdout.split(/\r?\n/u).filter((line) => line !== "");
      // El scope global enumera el catálogo incorporado incluso cuando está vacío. Un 0 sin ese
      // catálogo no acredita que la lectura haya sido completa.
      if (scope[0] === "-g" && lines.length === 0) return false;
      if (lines.some((line) => !EMPTY_TMUX_HOOK_NAME_PATTERN.test(line))) return false;
    }
    return true;
  } catch {
    return false;
  }
}

/** `show-hooks` no tiene hook `after-show-hooks`; es el preflight sin efectos del control plane. */
async function tmuxHooksAreEmpty(
  tmux: TmuxController,
  paneId: string,
  hooks: readonly string[],
  control?: TmuxRunControl,
): Promise<boolean> {
  const scopes = [
    ["-g"],
    [],
    ["-w"],
    ["-p"],
  ] as const;
  try {
    for (const hook of hooks) {
      for (const scope of scopes) {
        const result = await tmux.run(
          ["show-hooks", ...scope, "-t", paneId, hook],
          undefined,
          control,
        );
        if (result.exitCode !== 0) return false;
        const lines = result.stdout.split(/\r?\n/u).filter((line) => line !== "");
        if (lines.some((line) => line !== hook)) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Excluye el teclado de TODOS los clientes humanos antes de la captura final.
 *
 * `select-pane -d` descarta tanto el teclado humano como `paste-buffer`/`send-keys`. Eso significa
 * que, si ambos llegan a la vez, Cauce gana la exclusión y el byte humano se descarta (no se guarda
 * para después); nunca se concatena ni produce una segunda ejecución. Por eso cada
 * mutación técnica habilita, muta y vuelve a deshabilitar dentro de UNA cola sin hooks. La
 * transición 0→1 y el token viven
 * en el mismo `if-shell` cercado por sesión/ventana/pane/PID; dos runners no pueden adquirirla a la
 * vez. Un pane que ya estaba `input_off` se trata como ocupado: nunca se adopta una barrera ajena.
 */
export async function acquirePaneInputBarrier(
  tmux: TmuxController,
  identity: PaneIdentity,
  token: string,
  control?: TmuxRunControl,
): Promise<PaneInputBarrierAcquireResult> {
  const barrier = { identity, token } as const;
  const paneCondition = exactPaneCondition(identity, "full");
  if (paneCondition === undefined || !INPUT_BARRIER_TOKEN_PATTERN.test(token)) {
    return { state: "ambiguous" };
  }

  // Una barrera ajena/copy-mode es una negativa acreditable aun si el administrador tiene hooks.
  // Clasificarla antes del inventario conserva la garantía R6: no se ejecuta ningún comando
  // hookeable y tampoco se confunde un pane humano ocupado con una configuración insegura que
  // Cauce sólo tendría que evaluar si realmente fuera candidato a adquirir.
  const sameIdentity = await probeTmuxFormat(
    tmux,
    identity.paneId,
    paneCondition,
    control,
  );
  if (sameIdentity === false) return { state: "not_applied" };
  if (sameIdentity !== true) return { state: "ambiguous" };
  const busyCondition = `#{||:#{!=:#{pane_input_off},0},`
    + `#{||:#{!=:#{pane_in_mode},0},#{!=:#{${INPUT_BARRIER_OPTION}},}}}`;
  const busyBeforeHooks = await probeTmuxFormat(
    tmux,
    identity.paneId,
    busyCondition,
    control,
  );
  if (busyBeforeHooks === true) return { state: "busy" };
  if (busyBeforeHooks !== false) return { state: "ambiguous" };

  if (!await inputBarrierHooksAreEmpty(tmux, identity.paneId, control)) {
    return { state: "unsafe_hooks" };
  }
  const condition = `#{&&:${paneCondition},#{&&:#{==:#{pane_input_off},0},`
    + `#{&&:#{==:#{pane_in_mode},0},#{==:#{${INPUT_BARRIER_OPTION}},}}}}`;
  const mutation = await atomicCas(
    tmux,
    identity.paneId,
    condition,
    `set-option -p -t ${identity.paneId} ${INPUT_BARRIER_OPTION} ${token}`
      + ` ; select-pane -d -t ${identity.paneId}`,
    control,
  );
  // `accepted` sólo puede señalarse después de que AMBAS mutaciones terminaron. Los hooks que
  // podrían alterar esa postcondición se comprobaron vacíos justo antes del CAS. Aun si se perdió
  // el exit status del cliente principal, el waiter independiente + este formato exacto acreditan
  // ownership sin invocar `display-message`.
  if (mutation.branch === "accepted") {
    const postcondition = `#{&&:${paneCondition},${inputBarrierCondition(barrier)}}`;
    return await probeTmuxFormat(tmux, identity.paneId, postcondition, control) === true
      ? { state: "acquired", barrier }
      : { state: "ambiguous" };
  }
  if (mutation.branch !== "rejected") return { state: "ambiguous" };

  // La rama rechazada no ejecutó ningún comando de pane. Clasificar el motivo también se hace con
  // `if-shell`+`wait-for`: ni `display-message` ni `list-panes` pueden disparar hooks adversarios.
  const sameIdentityAfterRejection = await probeTmuxFormat(
    tmux,
    identity.paneId,
    paneCondition,
    control,
  );
  if (sameIdentityAfterRejection === false) return { state: "not_applied" };
  if (sameIdentityAfterRejection !== true) return { state: "ambiguous" };
  const busyAfterRejection = await probeTmuxFormat(
    tmux,
    identity.paneId,
    busyCondition,
    control,
  );
  return busyAfterRejection === true ? { state: "busy" } : { state: "ambiguous" };
}

/**
 * Restaura input únicamente si siguen vivos la generación Y el token que esta llamada adquirió.
 *
 * Un rename/respawn selecciona el testigo negativo; no se habilita ni se borra ninguna opción de
 * la generación nueva. El testigo positivo queda después de habilitar y retirar el token: acredita
 * la postcondición sin ejecutar un comando de lectura hookeable.
 */
export async function releasePaneInputBarrier(
  tmux: TmuxController,
  barrier: PaneInputBarrier,
  control?: TmuxRunControl,
): Promise<TmuxMutationState> {
  const { identity, token } = barrier;
  // Liberar también dispara `after-select-pane` y `after-set-option`. Si apareció cualquier hook
  // desde la última mutación, no se lo ejecuta ni se lo desinstala: la barrera queda durable y el
  // llamador entra a cuarentena/terminación exacta. Eso preserva tanto la TUI como el estado ajeno.
  if (!await inputBarrierHooksAreEmpty(tmux, identity.paneId, control)) return "not_applied";
  // Nombres de sesión/ventana son metadato mutable. Ids estables + PID + token acreditan que es la
  // misma generación aunque un humano la haya renombrado mientras estuvo cercada.
  const paneCondition = exactPaneCondition(identity, "process");
  if (paneCondition === undefined || !INPUT_BARRIER_TOKEN_PATTERN.test(token)) return "ambiguous";
  const condition = `#{&&:${paneCondition},#{==:#{${INPUT_BARRIER_OPTION}},${token}}}`;
  const mutation = await atomicCas(
    tmux,
    identity.paneId,
    condition,
    `select-pane -e -t ${identity.paneId}`
      + ` ; set-option -pu -t ${identity.paneId} ${INPUT_BARRIER_OPTION}`,
    control,
  );
  if (mutation.branch === "accepted") {
    const postcondition = `#{&&:${paneCondition},#{&&:#{==:#{pane_input_off},0},`
      + `#{&&:#{==:#{pane_in_mode},0},#{==:#{${INPUT_BARRIER_OPTION}},}}}}`;
    return await probeTmuxFormat(tmux, identity.paneId, postcondition, control) === true
      ? "applied"
      : "ambiguous";
  }
  if (mutation.branch === "rejected") return "not_applied";
  return "ambiguous";
}

/**
 * Impide reutilizar una TUI cuyo turno cancelado no alcanzó un límite terminal observable.
 *
 * La marca vive en la sesión tmux y por eso sobrevive al reinicio del adaptador. No contiene texto
 * de la entrega. Al cambiar pane/PID queda obsoleta y el runner puede retirarla con seguridad.
 */
export async function markPaneQuarantined(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<boolean> {
  return setSessionOption(
    tmux,
    identity.sessionId,
    QUARANTINED_PANE_OPTION,
    paneGeneration(identity),
    control,
  );
}

export type PaneQuarantineState = "current" | "stale" | "absent" | "unreadable";

/** Distingue ausencia real de una lectura fallida: ante duda el runner no puede reutilizar el pane. */
export async function paneQuarantineState(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<PaneQuarantineState> {
  const option = await sessionOption(
    tmux,
    identity.sessionId,
    QUARANTINED_PANE_OPTION,
    control,
  );
  if (!option.ok) return "unreadable";
  if (option.value === undefined) return "absent";
  return option.value === paneGeneration(identity) ? "current" : "stale";
}

/** Retira una marca vieja o una generación ya observada como terminal. */
export async function clearPaneQuarantine(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<boolean> {
  if (!SESSION_ID_PATTERN.test(identity.sessionId)) return false;
  // Hace falta el valor exacto para que una marca stale NUEVA, escrita tras la lectura, no sea
  // borrada como si fuera la observada. `after-show-options` se rechaza antes: el read ya no puede
  // ser convertido por configuración existente en copy/view-mode, teclas u otra mutación.
  if (!await tmuxHooksAreEmpty(tmux, identity.paneId, ["after-show-options"], control)) return false;
  const option = await sessionOption(
    tmux,
    identity.sessionId,
    QUARANTINED_PANE_OPTION,
    control,
  );
  if (!option.ok || option.value === undefined) return option.ok;
  if (option.value === paneGeneration(identity)
    || !/^\$[0-9]+:@[0-9]+:%[0-9]+:[0-9]+$/u.test(option.value)) return false;
  const condition = `#{==:#{${QUARANTINED_PANE_OPTION}},${option.value}}`;
  const mutation = await atomicCas(
    tmux,
    identity.sessionId,
    condition,
    `set-option -u -t ${identity.sessionId} ${QUARANTINED_PANE_OPTION}`,
    control,
  );
  if (mutation.branch === "accepted") {
    return await probeTmuxFormat(
      tmux,
      identity.sessionId,
      `#{==:#{${QUARANTINED_PANE_OPTION}},}`,
      control,
    ) === true;
  }
  if (mutation.branch !== "rejected") return false;
  // Ausencia previa ya cumple la postcondición; una marca actual, inválida o cambiada se conserva.
  return await probeTmuxFormat(
    tmux,
    identity.sessionId,
    `#{==:#{${QUARANTINED_PANE_OPTION}},}`,
    control,
  ) === true;
}

/** Retira sólo la marca de ESTA generación después de un límite terminal correlacionado. */
export async function clearCurrentPaneQuarantine(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<boolean> {
  if (!SESSION_ID_PATTERN.test(identity.sessionId)) return false;
  const generation = paneGeneration(identity);
  const condition = `#{==:#{${QUARANTINED_PANE_OPTION}},${generation}}`;
  const mutation = await atomicCas(
    tmux,
    identity.sessionId,
    condition,
    `set-option -u -t ${identity.sessionId} ${QUARANTINED_PANE_OPTION}`,
    control,
  );
  if (mutation.branch !== "accepted" && mutation.branch !== "rejected") return false;
  // accepted exige que el unset haya terminado antes del testigo; rejected sólo es éxito si la
  // marca ya estaba ausente. Una marca ajena se conserva y devuelve false.
  return await probeTmuxFormat(
    tmux,
    identity.sessionId,
    `#{==:#{${QUARANTINED_PANE_OPTION}},}`,
    control,
  ) === true;
}

/**
 * Lee una opcion PRIVADA de la sesion, sin confundir "no estaba" con un valor vacio valido.
 *
 * `-q` evita que tmux escriba el nombre de una opcion ausente. Los marcadores de identidad nunca
 * admiten el valor vacio, de modo que stdout vacio significa legacy/no marcado. Un error real
 * (socket caido, sesion desaparecida) se conserva separado: acreditar una identidad no puede
 * convertirse en "legacy" por un fallo de lectura.
 */
export async function sessionOption(
  tmux: TmuxController,
  sessionTarget: string,
  option: string,
  control?: TmuxRunControl,
): Promise<{ readonly ok: true; readonly value?: string } | { readonly ok: false }> {
  // `show-options`/`set-option` NO aceptan el prefijo `=` que sí aceptan `has-session`,
  // `list-windows` y `kill-session` (verificado contra tmux 3.4). El llamador pasa el id `$N`
  // resuelto por `exactSessionTarget`, que es exacto y no admite colisiones por prefijo.
  const result = await tmux.run(
    ["show-options", "-qv", "-t", sessionTarget, option],
    undefined,
    control,
  );
  if (result.exitCode !== 0) return { ok: false };
  const value = result.stdout.replace(/\r?\n$/u, "");
  return value === "" ? { ok: true } : { ok: true, value };
}

/** Fija una opcion privada de sesion sin shell ni expansion de su valor. */
export async function setSessionOption(
  tmux: TmuxController,
  sessionTarget: string,
  option: string,
  value: string,
  control?: TmuxRunControl,
): Promise<boolean> {
  const result = await tmux.run(
    ["set-option", "-t", sessionTarget, option, value],
    undefined,
    control,
  );
  return result.exitCode === 0;
}

/**
 * Comando ORIGINAL con el que nacio el panel.
 *
 * Para una sesion legacy es una evidencia mas fuerte que `pane_current_command`: la TUI suele
 * lanzar procesos hijos y ese ultimo campo puede cambiar durante un turno. Antes se enumera la
 * ventana exacta porque `display-message` cae silenciosamente a otra cuando el nombre no existe.
 */
export async function paneStartCommand(
  tmux: TmuxController,
  session: string,
  window: string,
): Promise<string | undefined> {
  if (!await windowExists(tmux, session, window)) return undefined;
  const result = await tmux.run([
    "display-message", "-p", "-t", `${session}:${window}`, "#{pane_start_command}",
  ]);
  if (result.exitCode !== 0) return undefined;
  const value = result.stdout.replace(/\r?\n$/u, "");
  return value === "" ? undefined : value;
}

const PANE_HARNESS_FORMAT = [
  "#{session_id}",
  "#{session_name}",
  "#{window_id}",
  "#{window_name}",
  "#{pane_id}",
  "#{pane_pid}",
  "#{pane_dead}",
  "#{pane_start_command}",
].join("\t");

export type PaneHarnessInspection =
  | { readonly state: "present"; readonly pane: PaneHarnessIdentity }
  | { readonly state: "absent" }
  | { readonly state: "ambiguous" }
  | { readonly state: "unreadable" };

/**
 * Observa el UNICO pane de una ventana sin usar `session:window` como target ambiguo.
 *
 * `list-panes -s -t $N` enumera todos los panes del id exacto; se filtra el nombre de ventana en
 * memoria y se exige cardinalidad uno. La fila incluye PID y comando original en la misma foto y,
 * después, `%pane_id` se vuelve a leer: si hubo `respawn-pane` entre ambas lecturas, la generación
 * ya no coincide y falla cerrado.
 */
export async function inspectSolePaneHarness(
  tmux: TmuxController,
  sessionId: string,
  windowName: string,
): Promise<PaneHarnessInspection> {
  if (!SESSION_ID_PATTERN.test(sessionId)) return { state: "unreadable" };
  const listed = await tmux.run([
    "list-panes", "-s", "-t", sessionId, "-F", PANE_HARNESS_FORMAT,
  ]);
  if (listed.exitCode !== 0) return { state: "unreadable" };
  const matching = listed.stdout.split(/\r?\n/u).filter((line) => {
    if (line === "") return false;
    const first = line.indexOf("\t");
    const second = first < 0 ? -1 : line.indexOf("\t", first + 1);
    const third = second < 0 ? -1 : line.indexOf("\t", second + 1);
    const fourth = third < 0 ? -1 : line.indexOf("\t", third + 1);
    return third >= 0 && fourth >= 0 && line.slice(third + 1, fourth) === windowName;
  });
  if (matching.length === 0) return { state: "absent" };
  if (matching.length !== 1) return { state: "ambiguous" };

  const fields = matching[0]?.split("\t") ?? [];
  if (fields.length < 8) return { state: "unreadable" };
  const [
    observedSessionId, sessionName, windowId, observedWindow, paneId, processId, dead,
    ...commandFields
  ]
    = fields;
  const command = commandFields.join("\t");
  if (observedSessionId !== sessionId
    || sessionName === undefined || sessionName === ""
    || windowId === undefined || !WINDOW_ID_PATTERN.test(windowId)
    || observedWindow !== windowName
    || paneId === undefined || !PANE_ID_PATTERN.test(paneId)
    || processId === undefined || !/^[0-9]+$/u.test(processId)
    || dead !== "0" || command === "") return { state: "unreadable" };
  const pane: PaneHarnessIdentity = {
    sessionId,
    sessionName,
    windowId,
    windowName,
    paneId,
    panePid: processId,
    paneStartCommand: command,
  };
  const current = await paneIdentity(tmux, paneId);
  return current !== undefined && samePaneIdentity(current, pane)
    ? { state: "present", pane }
    : { state: "unreadable" };
}

/** Sin testigo de creación sólo puede acreditarse ausencia; nunca se mata por nombre. */
export async function killSession(tmux: TmuxController, session: string): Promise<boolean> {
  return await exactSessionTarget(tmux, session) === undefined;
}

/**
 * Deshace sólo la sesión/pane exactos que esta llamada creó y marcó con su nonce.
 *
 * La tupla de ids/nombres/PID se cerca dentro del `if-shell` junto con el nonce criptográfico de
 * creación. Un `respawn-pane` cambia PID y un rename cambia la identidad lógica; ambos seleccionan
 * la rama rechazada sin ejecutar antes list/display/show ni otro comando con hooks. El comando
 * original sigue formando parte del ownership persistido, pero no hace falta interpolarlo (podría
 * contener cualquier sintaxis de shell) porque PID + nonce ya distinguen la generación creada.
 */
export async function killSessionIdIfNamed(
  tmux: TmuxController,
  ownership: CreatedSessionOwnership,
  control?: TmuxRunControl,
): Promise<boolean> {
  if (!INPUT_BARRIER_TOKEN_PATTERN.test(ownership.creationNonce)) return false;
  const paneCondition = exactPaneCondition(ownership, "full");
  if (paneCondition === undefined) return false;
  const condition = `#{&&:${paneCondition},`
    + `#{==:#{${CREATION_NONCE_OPTION}},${ownership.creationNonce}}}`;
  // Nonce criptográfico + ids/PID + nombres completos acreditan el intento de creación. Releer
  // previamente list-panes/display/show-options no agregaba identidad: sólo abría tres hooks antes
  // del CAS y permitía efectos sobre una sesión que luego se rechazaba.
  const mutation = await atomicCas(
    tmux,
    ownership.paneId,
    condition,
    `kill-session -t ${ownership.sessionId}`,
    control,
  );
  if (mutation.branch === "accepted") return true;
  if (mutation.branch === "rejected") return false;
  // Si era la última sesión, el servidor puede desaparecer antes de ejecutar el wait-for final.
  // Resultado 0 + ausencia del id estable es la postcondición exacta; cualquier otra combinación
  // falla cerrada.
  return mutation.result?.exitCode === 0
    && !await hasSessionId(tmux, ownership.sessionId);
}

export async function capturePane(
  tmux: TmuxController,
  target: string,
  options?: { readonly styled?: boolean; readonly control?: TmuxRunControl },
): Promise<string | undefined> {
  // `-e` conserva los SGR. Hace falta para distinguir el texto FANTASMA de codex (que se dibuja
  // atenuado, SGR 2) del texto que el dueno tecleo de verdad, que nunca lo esta. Medido el
  // 2026-07-31 en el panel vivo de socrates: la linea del cursor trae ['1','0','2','0'].
  const args = options?.styled === true
    ? ["capture-pane", "-e", "-p", "-t", target]
    : ["capture-pane", "-p", "-t", target];
  const result = await tmux.run(args, undefined, options?.control);
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
  const target = SESSION_ID_PATTERN.test(session) ? session : `=${session}`;
  const result = await tmux.run(["list-windows", "-t", target, "-F", "#{window_name}"]);
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
export interface PastePromptResult {
  /** `ambiguous` sólo aparece si el transporte perdió el resultado de la mutación atómica. */
  readonly state: "not_pasted" | "pasted" | "ambiguous";
  readonly reason?: "cancelled" | "identity_changed" | "input_busy" | "mutation_rejected";
  /** Postcondición comprobada: el buffer ya no existe o contiene únicamente el marcador inocuo. */
  readonly bufferScrubbed: boolean;
}

export interface PastePromptOptions extends TmuxRunControl {
  /** Verifica dos veces la caja: antes de load-buffer y justo antes de la mutación del pane. */
  readonly verifyInputEmpty?: boolean;
  /** Exclusión ya adquirida; es obligatoria cuando se verifica la caja. */
  readonly inputBarrier?: PaneInputBarrier;
}

const SCRUBBED_BUFFER_CONTENT = "CAUCE_BUFFER_SCRUBBED";

async function namedBufferState(
  tmux: TmuxController,
  buffer: string,
  control?: TmuxRunControl,
): Promise<"absent" | "present" | "unreadable"> {
  try {
    const listed = await tmux.run(
      ["list-buffers", "-F", "#{buffer_name}"],
      undefined,
      control,
    );
    if (listed.exitCode !== 0) return "unreadable";
    return listed.stdout.split(/\r?\n/u).some((name) => name === buffer)
      ? "present"
      : "absent";
  } catch {
    return "unreadable";
  }
}

/**
 * Borra el buffer global o, si tmux se niega a borrarlo, reemplaza su contenido por un marcador.
 *
 * Nunca devuelve el contenido leído: el prompt puede contener datos privados. El `show-buffer`
 * sólo acredita localmente que el overwrite inocuo ocurrió y cualquier otro valor se descarta.
 */
async function scrubNamedBuffer(
  tmux: TmuxController,
  buffer: string,
  control?: TmuxRunControl,
): Promise<boolean> {
  try {
    await tmux.run(["delete-buffer", "-b", buffer], undefined, control);
    const afterDelete = await namedBufferState(tmux, buffer, control);
    if (afterDelete === "absent") return true;

    const overwritten = await tmux.run(
      ["load-buffer", "-b", buffer, "-"],
      SCRUBBED_BUFFER_CONTENT,
      control,
    );
    if (overwritten.exitCode !== 0) return false;
    const verified = await tmux.run(["show-buffer", "-b", buffer], undefined, control);
    if (verified.exitCode !== 0 || verified.stdout !== SCRUBBED_BUFFER_CONTENT) return false;

    // El marcador ya es seguro, pero se intenta además cumplir la postcondición más fuerte.
    await tmux.run(["delete-buffer", "-b", buffer], undefined, control);
    const finalState = await namedBufferState(tmux, buffer, control);
    if (finalState === "absent") return true;
    if (finalState !== "present") return false;
    const finalVerification = await tmux.run(
      ["show-buffer", "-b", buffer],
      undefined,
      control,
    );
    return finalVerification.exitCode === 0
      && finalVerification.stdout === SCRUBBED_BUFFER_CONTENT;
  } catch {
    return false;
  }
}

export async function pastePrompt(
  tmux: TmuxController,
  identity: PaneIdentity,
  buffer: string,
  text: string,
  options: PastePromptOptions = {},
): Promise<PastePromptResult> {
  if (!SAFE_TMUX_NAME_PATTERN.test(buffer)) {
    return { state: "not_pasted", bufferScrubbed: false };
  }
  let state: PastePromptResult["state"] = "not_pasted";
  let reason: PastePromptResult["reason"];
  const mutationControl: TmuxRunControl = {
    ...(options.signal === undefined ? {} : { signal: options.signal }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
  };
  // El cleanup ignora la cancelación de la entrega: debe borrar o neutralizar el buffer igualmente.
  const cleanupControl: TmuxRunControl = options.timeoutMs === undefined
    ? {}
    : { timeoutMs: options.timeoutMs };
  try {
    if (signalIsAborted(options.signal)) {
      reason = "cancelled";
    } else {
      const firstGuard = options.verifyInputEmpty === false
        ? "ready"
        : await pastePrecondition(tmux, identity, options.inputBarrier, mutationControl);
      if (firstGuard !== "ready") {
        state = firstGuard === "unreadable" ? "ambiguous" : "not_pasted";
        reason = firstGuard === "unreadable" ? undefined : pasteGuardReason(firstGuard);
      } else {
        // `capture-pane` de la guarda anterior tiene su propio hook. Se relee el catálogo después
        // de capturar y justo antes de `load-buffer`, la superficie que originó R11.
        const hooksSafeBeforeLoad = options.inputBarrier === undefined
          || await inputBarrierHooksAreEmpty(tmux, identity.paneId, mutationControl);
        const load = hooksSafeBeforeLoad
          ? await tmux.run(
            ["load-buffer", "-b", buffer, "-"],
            text,
            mutationControl,
          )
          : { exitCode: 78, stdout: "", stderr: "unsafe_hooks" };
        if (load.exitCode !== 0) {
          // Sólo 78 es una negativa explícita. null, excepción y cualquier otro resultado podrían
          // haber alcanzado al servidor y se tratan como ambiguos.
          state = load.exitCode === 78 ? "not_pasted" : "ambiguous";
          reason = load.exitCode === 78 ? "mutation_rejected" : undefined;
        } else if (signalIsAborted(options.signal)) {
          // load-buffer terminó, pero paste-buffer todavía no se invocó: no hubo input al pane.
          state = "not_pasted";
          reason = "cancelled";
        } else {
          const finalGuard = options.verifyInputEmpty === false
            ? "ready"
            : await pastePrecondition(tmux, identity, options.inputBarrier, mutationControl);
          if (finalGuard !== "ready") {
            state = finalGuard === "unreadable" ? "ambiguous" : "not_pasted";
            reason = finalGuard === "unreadable" ? undefined : pasteGuardReason(finalGuard);
          } else {
            const mutation = options.inputBarrier === undefined
              ? await mutateExactPane(
                tmux,
                identity,
                `paste-buffer -b ${buffer} -t ${identity.paneId} -p -d`,
                mutationControl,
                "full",
              )
              : await mutateUnderInputBarrier(
                tmux,
                options.inputBarrier,
                `paste-buffer -b ${buffer} -t ${identity.paneId} -p -d`,
                mutationControl,
                "full",
              );
            state = mutation === "applied"
              ? "pasted"
              : mutation === "not_applied" ? "not_pasted" : "ambiguous";
            if (mutation === "not_applied") reason = "mutation_rejected";
          }
        }
      }
    }
  } catch {
    state = "ambiguous";
  }
  // El scrub es parte del resultado, incluso con abort, target reemplazado o excepción.
  return {
    state,
    ...(reason === undefined ? {} : { reason }),
    bufferScrubbed: await scrubNamedBuffer(tmux, buffer, cleanupControl),
  };
}

type PastePrecondition = "ready" | "identity_changed" | "input_busy" | "unreadable";

/**
 * Foto inmediatamente anterior al paste, ya bajo exclusión de teclado humano.
 *
 * `select-pane -d` ya impide que un cliente entregue keystrokes. Luego se comparan generación,
 * token, modo y flag antes de capturar; el propio `paste-buffer` vuelve a cercar esos valores y
 * habilita→pega→deshabilita dentro de su `if-shell`. Si alguien libera/reemplaza la barrera entre
 * captura y paste, el testigo negativo acredita el rechazo y no pega.
 */
async function pastePrecondition(
  tmux: TmuxController,
  identity: PaneIdentity,
  barrier: PaneInputBarrier | undefined,
  control: TmuxRunControl,
): Promise<PastePrecondition> {
  if (barrier === undefined || !samePaneIdentity(barrier.identity, identity)) return "unreadable";
  // `capture-pane` dispara `after-capture-pane`; toda configuración efectiva debe rechazarse antes
  // de leer la caja, no sólo antes del paste final.
  if (!await inputBarrierHooksAreEmpty(tmux, identity.paneId, control)) return "unreadable";
  const paneCondition = exactPaneCondition(identity, "full");
  const barrierCondition = inputBarrierCondition(barrier);
  if (paneCondition === undefined || barrierCondition === undefined) return "unreadable";
  const ready = await probeTmuxFormat(
    tmux,
    identity.paneId,
    `#{&&:${paneCondition},${barrierCondition}}`,
    control,
  );
  if (ready !== true) {
    // La negativa exacta no usa display/list/show: distingue un replacement de una barrera que
    // cambió sin ofrecerle a `after-display-message` una superficie para mutar la TUI.
    if (ready === false
      && await probeTmuxFormat(tmux, identity.paneId, paneCondition, control) === false) {
      return "identity_changed";
    }
    return "unreadable";
  }
  const pane = await capturePane(tmux, identity.paneId, { styled: true, control });
  if (pane === undefined) return "unreadable";
  return inputBoxState(pane).occupied ? "input_busy" : "ready";
}

function pasteGuardReason(
  guard: Exclude<PastePrecondition, "ready" | "unreadable">,
): PastePromptResult["reason"] {
  return guard === "input_busy" ? "input_busy" : "identity_changed";
}

export async function sendEnter(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
  barrier?: PaneInputBarrier,
): Promise<TmuxMutationState> {
  return barrier === undefined
    ? mutateExactPane(
      tmux,
      identity,
      `send-keys -t ${identity.paneId} Enter`,
      control,
      "process",
    )
    : mutateUnderInputBarrier(
      tmux,
      barrier,
      `send-keys -t ${identity.paneId} Enter`,
      control,
      "process",
    );
}

/** Interrumpe la TUI por su pane id exacto; nunca por nombre de sesión o ventana. */
export async function interruptPane(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<TmuxMutationState> {
  return mutateExactPane(
    tmux,
    identity,
    `send-keys -t ${identity.paneId} Escape`,
    control,
  );
}

/** Último recurso: descarta una caja pegada que tmux no pudo enviar. */
export async function clearPaneInput(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<TmuxMutationState> {
  return mutateExactPane(
    tmux,
    identity,
    `send-keys -t ${identity.paneId} C-u`,
    control,
  );
}

/** Mata sólo la generación acreditada; se usa si ni tmux ni disco pueden persistir cuarentena. */
export async function killPaneGeneration(
  tmux: TmuxController,
  identity: PaneIdentity,
  control?: TmuxRunControl,
): Promise<TmuxMutationState> {
  return mutateExactPane(
    tmux,
    identity,
    `kill-pane -t ${identity.paneId}`,
    control,
    "process",
    undefined,
    true,
  );
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
  control?: TmuxRunControl,
): Promise<void> {
  await announceNotice(tmux, session, window, summary, control);
  await tmux.run([
    "set-option", "-w", "-t", `${session}:${window}`, "window-status-style", "bg=red,fg=white",
  ], undefined, control).catch(() => undefined);
  await tmux.run(
    ["set-option", "-t", session, "status-style", "bg=red,fg=white"],
    undefined,
    control,
  )
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
  control?: TmuxRunControl,
): Promise<void> {
  const oneLine = summary.replace(/\s+/gu, " ").slice(0, 200);
  await tmux.run(
    ["display-message", "-t", `${session}:${window}`, "-d", "15000", oneLine],
    undefined,
    control,
  )
    .catch(() => undefined);
}

/** Quita el rojo cuando un turno vuelve a pasar por la sesión compartida. */
export async function clearDegradation(
  tmux: TmuxController,
  session: string,
  window: string,
  control?: TmuxRunControl,
): Promise<void> {
  await tmux.run(
    ["set-option", "-w", "-t", `${session}:${window}`, "-u", "window-status-style"],
    undefined,
    control,
  )
    .catch(() => undefined);
  await tmux.run(
    ["set-option", "-t", session, "-u", "status-style"],
    undefined,
    control,
  ).catch(() => undefined);
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
  const target = SESSION_ID_PATTERN.test(session) ? session : `=${session}`;
  const result = await tmux.run(["list-windows", "-t", target, "-F", "#{window_name}"]);
  if (result.exitCode !== 0) return false;
  const names = result.stdout.split(/\r?\n/u).map((name) => name.trim());
  if (names.includes(window) || !names.includes(legacyName)) return false;
  const renamed = await tmux.run([
    "rename-window", "-t", `${session}:${legacyName}`, window,
  ]).catch(() => undefined);
  return renamed?.exitCode === 0;
}
