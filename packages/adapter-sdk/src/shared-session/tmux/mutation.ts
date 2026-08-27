import { randomBytes } from "node:crypto";
import {
  PANE_ID_PATTERN,
  QUARANTINED_PANE_OPTION,
  SAFE_TMUX_NAME_PATTERN,
  SESSION_ID_PATTERN,
  WINDOW_ID_PATTERN,
  hasSessionId,
  paneGeneration,
  type PaneIdentity,
  type TmuxController,
  type TmuxResult,
  type TmuxRunControl,
} from "./identity.js";

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
export async function atomicCas(
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
export async function probeTmuxFormat(
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

export function exactPaneCondition(
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

export async function mutateExactPane(
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
export const INPUT_BARRIER_TOKEN_PATTERN = /^[a-f0-9]{64}$/u;

export interface PaneInputBarrier {
  readonly identity: PaneIdentity;
  /** Token no sensible que impide que un finally ajeno desbloquee el pane. */
  readonly token: string;
}

export function inputBarrierCondition(barrier: PaneInputBarrier): string | undefined {
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
export async function mutateUnderInputBarrier(
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
export async function inputBarrierHooksAreEmpty(
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
