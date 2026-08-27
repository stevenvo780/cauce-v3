import { inputBoxState } from "../pane.js";
import {
  CREATION_NONCE_OPTION,
  PANE_ID_PATTERN,
  SAFE_TMUX_NAME_PATTERN,
  SESSION_ID_PATTERN,
  WINDOW_ID_PATTERN,
  exactSessionTarget,
  hasSessionId,
  paneIdentity,
  samePaneIdentity,
  signalIsAborted,
  type CreatedSessionOwnership,
  type PaneHarnessIdentity,
  type PaneIdentity,
  type TmuxController,
  type TmuxRunControl,
} from "./identity.js";
import {
  INPUT_BARRIER_TOKEN_PATTERN,
  atomicCas,
  exactPaneCondition,
  inputBarrierCondition,
  inputBarrierHooksAreEmpty,
  mutateExactPane,
  mutateUnderInputBarrier,
  probeTmuxFormat,
  type PaneInputBarrier,
  type TmuxMutationState,
} from "./mutation.js";

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
  // `-e` conserva los códigos SGR para distinguir atributos de estilo en el panel.
  const args = options?.styled === true
    ? ["capture-pane", "-e", "-p", "-t", target]
    : ["capture-pane", "-p", "-t", target];
  const result = await tmux.run(args, undefined, options?.control);
  return result.exitCode === 0 ? result.stdout : undefined;
}

export async function panePid(tmux: TmuxController, target: string): Promise<string | undefined> {
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
 * Anuncia una degradación en la sesión tmux aplicando estilos visuales de advertencia.
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
