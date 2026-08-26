import { randomBytes } from "node:crypto";
import {
  CREATION_NONCE_OPTION,
  capturePane,
  exactSessionTarget,
  hasSessionId,
  inspectSolePaneHarness,
  killSessionIdIfNamed,
  paneIdentityStillCurrent,
  panePid,
  repairLegacyDegradedWindow,
  samePaneProcess,
  sessionOption,
  sessionIdStillNamed,
  setSessionOption,
  type CreatedSessionOwnership,
  type PaneHarnessIdentity,
  type TmuxController,
} from "./tmux.js";
import { inputBoxState } from "./pane.js";
import {
  LEGACY_DEGRADED_WINDOW,
  TUI_WINDOW,
  sessionName,
  type ResumeSpec,
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
  /**
   * Cómo se REANUDA la conversación anterior al crear el panel. Ausente = arrancar siempre pelado.
   *
   * Ausente es lo que hacía el código hasta el 2026-08-06, y lo que le costó a kant 38 MB de
   * conversación. Ver `ResumeSpec`.
   */
  readonly resume?: ResumeSpec;
}

export interface EnsureOptions {
  readonly sleep: (ms: number) => Promise<void>;
  /** Cancela el preflight antes de que una entrega toque la caja de entrada. */
  readonly signal?: AbortSignal;
  /** Cuánto se espera a que la TUI esté lista tras crearla. */
  readonly readyTimeoutMs?: number;
  /** Ancho/alto con que nace la sesión sin clientes enganchados. */
  readonly width?: number;
  readonly height?: number;
  /**
   * Dónde se cuenta lo que pasó con la reanudación.
   *
   * No es decorativo: si el `resume` falla, el panel del dueño vuelve en blanco y desde fuera eso
   * es indistinguible de un panel que nunca tuvo contexto. Sin esta línea, la única señal de que
   * la conversación se perdió sería que el agente contesta raro.
   */
  readonly log?: (detail: string) => void;
}

export interface EnsureResult {
  readonly ready: boolean;
  /** True si esta llamada tuvo que crear la sesión (no existía). */
  readonly created: boolean;
  /** PID del proceso del panel de la TUI, cuando se pudo leer. */
  readonly pid?: string;
  /** Id exacto `$N` acreditado. Todo uso posterior de la TUI se dirige a él, nunca al nombre. */
  readonly sessionId?: string;
  /** Generación exacta acreditada (session/pane/PID) y comando observado para esa misma foto. */
  readonly pane?: PaneHarnessIdentity;
  readonly detail: string;
  /** El preflight fue interrumpido; no es una degradación ni autoriza a ejecutar el fallback. */
  readonly cancelled?: boolean;
  /**
   * Qué falló exactamente, para que el aviso que lee el dueño no mienta.
   *
   * "no hay sesión" y "la sesión está pero la TUI no responde" se arreglan de formas distintas, y
   * deducirlo de si hubo que crearla daba la etiqueta equivocada en el caso más frecuente: sesión
   * viva con la TUI muerta dentro.
   */
  readonly failure?: EnsureFailure;
  /**
   * True cuando esta llamada creó el panel REANUDANDO la conversación anterior.
   *
   * Sólo tiene sentido junto a `created: true`. Lo necesita quien avisa al dueño: "hubo que crear
   * la sesión" significa cosas opuestas según si la conversación volvió entera o empezó de cero, y
   * decir lo segundo cuando pasó lo primero es la clase de mentira que ya se pagó dos veces.
   */
  readonly resumed?: boolean;
}

export type EnsureFailure =
  | "session_absent"
  | "tui_absent"
  /** El nombre exacto de la sesion y el alias grabado en ella no coinciden. */
  | "session_alias_mismatch"
  /** La sesion pertenece a otro harness; reutilizarla mezclaria dos conversaciones. */
  | "session_harness_mismatch"
  /** Una sesion legacy no dio evidencia suficiente para poder marcar alias+harness. */
  | "session_identity_unverified";

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;
const SESSION_ALIAS_OPTION = "@cauce_alias";
const SESSION_HARNESS_OPTION = "@cauce_harness";

// Se lee mediante función para que TypeScript no trate `AbortSignal.aborted` como una constante
// refinada a `false` a través de awaits: el valor cambia precisamente desde otro task.
function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

export function tuiTarget(sessionId: string): string {
  return `${sessionId}:${TUI_WINDOW}`;
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
 *
 * Y cuando hay que crearla, nace REANUDANDO la conversación anterior si la había. Rehacer el panel
 * no puede costarle al alias su memoria: el 2026-08-06 le costó a kant 38 MB. Las dos redes que
 * protegen eso están comentadas donde ocurren; la regla que las ordena es que un panel sin contexto
 * es malo y uno que no arranca es peor, porque un alias mudo es el fallo más caro de la flota.
 */
export async function ensureSharedSession(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
): Promise<EnsureResult> {
  const session = sessionName(spec.alias);
  if (signalAborted(options.signal)) return cancelledEnsure(false);
  const existingId = await exactSessionTarget(tmux, session);
  if (signalAborted(options.signal)) return cancelledEnsure(false, existingId);
  if (existingId !== undefined) {
    return inspectExistingSession(tmux, spec, options, session, existingId);
  }

  // PRIMERA red: no se intenta reanudar lo que no existe.
  //
  // `codex resume --last` y `claude --continue` fallan de formas distintas cuando no hay nada que
  // reanudar —codex 0.145.0 abre una conversación nueva y sigue vivo; claude 2.1.223 escribe «No
  // conversation found to continue» y sale 1, matando el panel—, así que no se puede confiar en
  // que el harness aguante. Preguntar antes cuesta leer la cabecera de un fichero.
  if (await hasResumableConversation(spec, options)) {
    if (signalAborted(options.signal)) return cancelledEnsure(false);
    const attempt = await startTui(tmux, spec, options, spec.resume?.args);
    if (attempt.ready) {
      return {
        ready: true,
        created: attempt.created,
        ...(attempt.created ? { resumed: true } : {}),
        pid: attempt.pid,
        sessionId: attempt.sessionId,
        pane: attempt.pane,
        detail: `sesión ${session} creada REANUDANDO la conversación anterior`,
      };
    }
    if (attempt.result.cancelled === true) return attempt.result;
    // SEGUNDA red: si el panel no quedó EN PIE, se rehace en blanco.
    //
    // La condición es que el panel esté MUERTO, no que haya tardado: una conversación grande puede
    // tardar en dibujarse —la de kant pesaba 38 MB— y matar un panel que estaba reanudando bien
    // sería cometer con las manos el mismo borrado que esto viene a evitar. Un panel vivo aunque
    // lento se deja en paz y se reporta como siempre.
    if (!attempt.paneGone) return attempt.result;
    options.log?.(
      `la reanudación de ${spec.alias} no dejó la TUI en pie (${attempt.result.detail});`
      + " se rehace el panel EN BLANCO y la conversación anterior no vuelve",
    );
    if (attempt.created && attempt.ownership !== undefined) {
      await killSessionIdIfNamed(tmux, attempt.ownership);
      if (signalAborted(options.signal)) {
        return cancelledEnsure(attempt.created, attempt.result.sessionId);
      }
    }
  }

  const attempt = await startTui(tmux, spec, options, undefined);
  if (!attempt.ready) {
    return attempt.result;
  }
  return {
    ready: true,
    created: attempt.created,
    pid: attempt.pid,
    sessionId: attempt.sessionId,
    pane: attempt.pane,
    detail: attempt.created ? `sesión ${session} creada` : `sesión ${session} creada por otro proceso`,
  };
}

function cancelledEnsure(created: boolean, sessionId?: string): EnsureResult {
  return {
    ready: false,
    created,
    cancelled: true,
    ...(sessionId === undefined ? {} : { sessionId }),
    detail: "preflight cancelado antes de inyectar la entrega",
  };
}

async function inspectExistingSession(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
  session: string,
  sessionId: string,
): Promise<EnsureResult> {
  if (signalAborted(options.signal)) return cancelledEnsure(false, sessionId);
  let identity = await verifyExistingSessionIdentity(tmux, spec, session, sessionId, options.signal);
  if ("cancelled" in identity) return cancelledEnsure(false, sessionId);
  if (!identity.ok) {
    return {
      ready: false,
      created: false,
      sessionId,
      failure: identity.failure,
      detail: identity.detail,
    };
  }
  if (signalAborted(options.signal)) return cancelledEnsure(false, sessionId);
  let pane = identity.pane;
  if (pane?.windowName === LEGACY_DEGRADED_WINDOW
    && await repairLegacyDegradedWindow(tmux, sessionId, TUI_WINDOW, LEGACY_DEGRADED_WINDOW)) {
    const legacyPane = pane;
    if (signalAborted(options.signal)) return cancelledEnsure(false, sessionId);
    // La sesión estaba enclavada por el renombrado de una versión anterior: la ventana existía
    // pero con otro nombre, así que el adaptador la daba por muerta en cada entrega, para siempre.
    identity = await verifyExistingSessionIdentity(tmux, spec, session, sessionId, options.signal);
    if ("cancelled" in identity) return cancelledEnsure(false, sessionId);
    if (!identity.ok) {
      return {
        ready: false,
        created: false,
        sessionId,
        failure: identity.failure,
        detail: identity.detail,
      };
    }
    pane = identity.pane;
    if (pane === undefined || !samePaneProcess(legacyPane, pane)) {
      return {
        ready: false,
        created: false,
        sessionId,
        failure: "session_identity_unverified",
        detail: `el pane de ${session} cambió de generación durante la reparación legacy`,
      };
    }
  }
  if (signalAborted(options.signal)) return cancelledEnsure(false, sessionId);
  const stillNamed = await sessionIdStillNamed(tmux, session, sessionId);
  if (signalAborted(options.signal)) return cancelledEnsure(false, sessionId);
  if (!stillNamed) {
    return {
      ready: false,
      created: false,
      sessionId,
      failure: "session_identity_unverified",
      detail: `la sesión ${session} fue reemplazada durante el preflight; no se toca el reemplazo`,
    };
  }
  if (pane === undefined || pane.windowName !== TUI_WINDOW) {
    return {
      ready: false,
      created: false,
      sessionId,
      failure: "tui_absent",
      detail: `la sesión ${session} existe pero no tiene panel de TUI`,
    };
  }
  if (!await paneIdentityStillCurrent(tmux, pane)) {
    return {
      ready: false,
      created: false,
      sessionId,
      failure: "session_identity_unverified",
      detail: `el pane de ${session} cambió de generación durante el preflight; no se reutiliza`,
    };
  }
  return {
    ready: true,
    created: false,
    pid: pane.panePid,
    sessionId,
    pane,
    detail: `sesión ${session} ya abierta`,
  };
}

type IdentityResult =
  | { readonly ok: true; readonly pane?: PaneHarnessIdentity }
  | { readonly ok: false; readonly failure: EnsureFailure; readonly detail: string }
  | { readonly ok: false; readonly cancelled: true };

/**
 * Acredita que una sesion EXISTENTE corresponde al alias y al harness pedidos.
 *
 * Las opciones privadas son el testigo canonico. Para la flota que ya estaba viva antes de que
 * existieran, el nombre de sesion acredita el alias (se consulto con target exacto `=...`) y el
 * comando original del panel acredita el harness. Solo entonces se escriben ambos marcadores.
 * Nada de este camino mata, renombra ni reinicia una sesion incompatible.
 */
async function verifyExistingSessionIdentity(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  session: string,
  sessionId: string,
  signal?: AbortSignal,
): Promise<IdentityResult> {
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  const stillNamed = await sessionIdStillNamed(tmux, session, sessionId);
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  if (!stillNamed) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `la sesion ${session} ya no corresponde al id acreditado; se conserva el reemplazo`,
    };
  }
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  const aliasMarker = await sessionOption(tmux, sessionId, SESSION_ALIAS_OPTION);
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  const harnessMarker = await sessionOption(tmux, sessionId, SESSION_HARNESS_OPTION);
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  if (!aliasMarker.ok || !harnessMarker.ok) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `no se pudieron leer los marcadores de identidad de ${session}`,
    };
  }
  if (aliasMarker.value !== undefined && aliasMarker.value !== spec.alias) {
    return {
      ok: false,
      failure: "session_alias_mismatch",
      detail: `la sesion ${session} declara otro alias; se conserva intacta`,
    };
  }
  if (harnessMarker.value !== undefined && harnessMarker.value !== spec.harness) {
    return {
      ok: false,
      failure: "session_harness_mismatch",
      detail: `la sesion ${session} pertenece a otro harness; se conserva intacta`,
    };
  }

  const observed = await existingHarnessPane(tmux, sessionId);
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  if (observed.state === "ambiguous" || observed.state === "unreadable") {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `la sesion ${session} no tiene un único pane acreditable; se conserva intacta`,
    };
  }
  const pane = observed.state === "present" ? observed.pane : undefined;
  if (pane !== undefined && pane.sessionName !== session) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `el pane observado ya no pertenece a ${session}; se conserva intacto`,
    };
  }
  // Los marcadores declaran qué DEBERÍA vivir en la sesión; el comando original acredita qué
  // proceso vive realmente en ESTA generación. Se exige siempre, también a sesiones marcadas.
  if (pane !== undefined && !paneCommandMatches(spec, pane.paneStartCommand)) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `el proceso actual de ${session} no corresponde al harness declarado; se conserva intacto`,
    };
  }
  if (harnessMarker.value === undefined && pane === undefined) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `la sesion legacy ${session} no permite acreditar su harness; se conserva intacta`,
    };
  }

  if (aliasMarker.value === undefined
    && !await setSessionOption(tmux, sessionId, SESSION_ALIAS_OPTION, spec.alias)) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `no se pudo marcar el alias de ${session}; se conserva intacta`,
    };
  }
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  if (harnessMarker.value === undefined
    && !await setSessionOption(tmux, sessionId, SESSION_HARNESS_OPTION, spec.harness)) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `no se pudo marcar el harness de ${session}; se conserva intacta`,
    };
  }
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  const finallyStillNamed = await sessionIdStillNamed(tmux, session, sessionId);
  if (signalAborted(signal)) return { ok: false, cancelled: true };
  if (!finallyStillNamed) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `la sesion ${session} fue reemplazada mientras se acreditaba; no se toca el reemplazo`,
    };
  }
  if (pane !== undefined && !await paneIdentityStillCurrent(tmux, pane)) {
    return {
      ok: false,
      failure: "session_identity_unverified",
      detail: `el pane de ${session} cambió de generación mientras se acreditaba; no se reutiliza`,
    };
  }
  return pane === undefined ? { ok: true } : { ok: true, pane };
}

async function existingHarnessPane(
  tmux: TmuxController,
  sessionId: string,
): Promise<Awaited<ReturnType<typeof inspectSolePaneHarness>>> {
  const canonical = await inspectSolePaneHarness(tmux, sessionId, TUI_WINDOW);
  return canonical.state === "absent"
    ? inspectSolePaneHarness(tmux, sessionId, LEGACY_DEGRADED_WINDOW)
    : canonical;
}

/**
 * Inferencia estrecha para sesiones anteriores a los marcadores.
 *
 * Se acepta el binario canonico del harness o el `command` explicitamente configurado para ese
 * mismo harness. La presencia ejecutable del harness opuesto vuelve la evidencia ambigua y falla
 * cerrado. El comando observado nunca se incluye en errores: puede contener argumentos privados.
 */
function paneCommandMatches(spec: SharedSessionSpec, command: string): boolean {
  const expected = executableName(spec.command ?? spec.harness);
  const opposite = spec.harness === "claude" ? "codex" : "claude";
  if (mentionsExecutable(command, opposite)) return false;
  return mentionsExecutable(command, spec.harness)
    || (expected !== spec.harness && mentionsExecutable(command, expected));
}

function executableName(command: string): string {
  const withoutSlash = command.slice(command.lastIndexOf("/") + 1);
  return /^[A-Za-z0-9._+-]+$/u.test(withoutSlash) ? withoutSlash : "";
}

function mentionsExecutable(command: string, executable: string): boolean {
  if (executable === "") return false;
  const escaped = executable.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const before = "(?:^|[\\s;&|()'\"`])";
  const path = "(?:[^\\s;&|()'\"`]+/)?";
  const after = "(?=$|[\\s;&|()'\"`])";
  return new RegExp(`${before}${path}${escaped}${after}`, "u").test(command);
}

/**
 * ¿Hay conversación previa Y forma de pedirla?
 *
 * Falla cerrado hacia el comportamiento de siempre: si el detector revienta —directorio ilegible,
 * permisos, un rollout corrupto— se arranca en blanco, que es exactamente lo que hacía el código
 * antes de esto. Lo que NO puede pasar es que una excepción de un detector se lleve por delante el
 * arranque del panel entero y deje al alias mudo.
 */
async function hasResumableConversation(
  spec: SharedSessionSpec,
  options: EnsureOptions,
): Promise<boolean> {
  const resume = spec.resume;
  if (resume === undefined || resume.args.length === 0) return false;
  try {
    return await resume.hasPreviousConversation();
  } catch (error: unknown) {
    options.log?.(
      `no se pudo comprobar si ${spec.alias} tenía conversación previa`
      + ` (${error instanceof Error ? error.message : String(error)}); se arranca en blanco`,
    );
    return false;
  }
}

/**
 * Un intento de arranque, con lo que hace falta para decidir si se puede reintentar.
 *
 * `paneGone` es la pregunta que separa "esto se puede rehacer" de "esto hay que dejarlo quieto":
 * sólo se vuelve a intentar sobre un panel que YA no existe, nunca sobre uno vivo.
 */
type StartAttempt =
  | {
    readonly ready: true;
    readonly created: boolean;
    readonly pid: string;
    readonly sessionId: string;
    readonly pane: PaneHarnessIdentity;
  }
  | {
    readonly ready: false;
    readonly created: boolean;
    readonly paneGone: boolean;
    readonly ownership?: CreatedSessionOwnership;
    readonly result: EnsureResult;
  };

async function startTui(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
  resumeArguments: readonly string[] | undefined,
): Promise<StartAttempt> {
  const created = await createSession(tmux, spec, options, resumeArguments);
  if (!created.ok) {
    const failure = "cancelled" in created
      ? { cancelled: true as const }
      : { failure: created.failure };
    return {
      ready: false,
      created: created.created,
      paneGone: created.sessionId === undefined,
      ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
      result: {
        ready: false,
        created: created.created,
        ...(created.sessionId === undefined ? {} : { sessionId: created.sessionId }),
        ...failure,
        detail: created.detail,
      },
    };
  }

  const target = tuiTarget(created.sessionId);
  if (signalAborted(options.signal)) {
    return {
      ready: false,
      created: created.created,
      paneGone: false,
      ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
      result: cancelledEnsure(created.created, created.sessionId),
    };
  }
  const waited = await waitForTui(tmux, target, options);
  if (waited === "cancelled" || signalAborted(options.signal)) {
    return {
      ready: false,
      created: created.created,
      paneGone: false,
      ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
      result: cancelledEnsure(created.created, created.sessionId),
    };
  }
  const expectedName = sessionName(spec.alias);
  const currentId = await exactSessionTarget(tmux, expectedName);
  if (signalAborted(options.signal)) {
    return {
      ready: false,
      created: created.created,
      paneGone: false,
      result: cancelledEnsure(created.created, created.sessionId),
    };
  }
  if (currentId !== created.sessionId) {
    const ownIdStillAlive = await hasSessionId(tmux, created.sessionId);
    if (signalAborted(options.signal)) {
      return {
        ready: false,
        created: created.created,
        paneGone: false,
        ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
        result: cancelledEnsure(created.created, created.sessionId),
      };
    }
    // Ausencia total es el proceso de la TUI que salió al arrancar: se puede intentar el fallback.
    // Un `$M` distinto con el mismo nombre (o nuestro `$N` renombrado aún vivo) es reemplazo: no se
    // adopta, no se mata y no se vuelve a crear nada en esta llamada.
    if (currentId === undefined && !ownIdStillAlive) {
      return {
        ready: false,
        created: created.created,
        paneGone: true,
        ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
        result: {
          ready: false,
          created: created.created,
          sessionId: created.sessionId,
          failure: "tui_absent",
          detail: `la TUI de ${spec.alias} se creó y desapareció antes de poder usarla`,
        },
      };
    }
    return {
      ready: false,
      created: created.created,
      paneGone: false,
      ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
      result: {
        ready: false,
        created: created.created,
        sessionId: created.sessionId,
        failure: "session_identity_unverified",
        detail: `la sesión de ${spec.alias} fue reemplazada durante el arranque; no se toca el reemplazo`,
      },
    };
  }
  const inspection = await inspectSolePaneHarness(tmux, created.sessionId, TUI_WINDOW);
  if (signalAborted(options.signal)) {
    return {
      ready: false,
      created: created.created,
      paneGone: false,
      result: cancelledEnsure(created.created, created.sessionId),
    };
  }
  if (inspection.state !== "present") {
    // Que la ventana `agente` no esté NO significa que la sesión murió: pudo ser renombrada o
    // reemplazada por un proceso humano. Sólo la ausencia del `$N` entero habilita otro intento.
    const paneGone = !await hasSessionId(tmux, created.sessionId);
    return {
      ready: false,
      created: created.created,
      paneGone,
      ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
      result: {
        ready: false,
        created: created.created,
        sessionId: created.sessionId,
        failure: inspection.state === "absent" ? "tui_absent" : "session_identity_unverified",
        detail: inspection.state === "absent"
          ? `la TUI de ${spec.alias} se creó y desapareció antes de poder usarla`
          : `la TUI de ${spec.alias} no tiene un único pane/proceso acreditable`,
      },
    };
  }
  const pane = inspection.pane;
  if ((created.created && (created.ownership === undefined
      || !samePaneProcess(created.ownership, pane)
      || created.ownership.windowName !== pane.windowName
      || created.ownership.paneStartCommand !== pane.paneStartCommand))
    || pane.sessionName !== expectedName || !paneCommandMatches(spec, pane.paneStartCommand)
    || !await paneIdentityStillCurrent(tmux, pane)) {
    return {
      ready: false,
      created: created.created,
      paneGone: false,
      ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
      result: {
        ready: false,
        created: created.created,
        sessionId: created.sessionId,
        failure: "session_identity_unverified",
        detail: `la TUI de ${spec.alias} cambió de generación o comando durante el arranque`,
      },
    };
  }
  // Sin PID no hay panel, y sin panel no hay TUI: nunca "listo".
  //
  // Esto era un éxito silencioso medido, no una hipótesis. Cuando la ventana de la TUI moría al
  // nacer, `waitForTui` llegaba a ver el panel un instante, devolvía `true`, y `ensure` contestaba
  // `ready:true` sobre una sesión sin TUI dentro. El adaptador y `cauce <alias>` daban por buena
  // una sesión compartida inexistente: exactamente el fallo que este trabajo existe para eliminar.
  if (waited !== "ready") {
    return {
      ready: false, created: created.created, paneGone: false,
      ...(created.ownership === undefined ? {} : { ownership: created.ownership }),
      result: {
        ready: false,
        created: created.created,
        sessionId: created.sessionId,
        pid: pane.panePid,
        pane,
        failure: "tui_absent",
        detail: `la TUI de ${spec.alias} no llegó a estar lista`,
      },
    };
  }
  return {
    ready: true,
    created: created.created,
    pid: pane.panePid,
    sessionId: created.sessionId,
    pane,
  };
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

/**
 * Los argumentos de reanudación, ya listos para pegarlos detrás del binario.
 *
 * Van SIN comillas y con una lista blanca estrecha, no por miedo al shell sino porque un argumento
 * raro acá sólo puede venir de un error de programación: los únicos valores legítimos son
 * `resume --last` y `--continue`. Falla cerrado —se arranca en blanco— en vez de mandarle al shell
 * algo que nadie escribió a propósito.
 */
export function resumeArgumentSuffix(
  args: readonly string[] | undefined,
): { ok: true; suffix: string } | { ok: false; detail: string } {
  if (args === undefined || args.length === 0) return { ok: true, suffix: "" };
  for (const argument of args) {
    if (!/^[A-Za-z0-9-][A-Za-z0-9_.:@=+-]*$/u.test(argument)) {
      return { ok: false, detail: `argumento de reanudación inválido: ${argument}` };
    }
  }
  return { ok: true, suffix: ` ${args.join(" ")}` };
}

async function createSession(
  tmux: TmuxController,
  spec: SharedSessionSpec,
  options: EnsureOptions,
  resumeArguments?: readonly string[],
): Promise<
  | {
    readonly ok: true;
    readonly created: boolean;
    readonly sessionId: string;
    readonly ownership?: CreatedSessionOwnership;
  }
  | {
    readonly ok: false;
    readonly created: boolean;
    readonly sessionId?: string;
    readonly ownership?: CreatedSessionOwnership;
    readonly cancelled: true;
    readonly detail: string;
  }
  | {
    readonly ok: false;
    readonly created: boolean;
    readonly sessionId?: string;
    readonly ownership?: CreatedSessionOwnership;
    readonly failure: EnsureFailure;
    readonly detail: string;
  }
> {
  const session = sessionName(spec.alias);
  const command = spec.command ?? spec.harness;
  const width = String(options.width ?? 200);
  const height = String(options.height ?? 50);
  if (signalAborted(options.signal)) {
    return { ok: false, created: false, cancelled: true, detail: "preflight cancelado" };
  }
  const environment = paneEnvironmentPrefix(spec.environment);
  if (!environment.ok) {
    return {
      ok: false, created: false, failure: "session_absent", detail: environment.detail,
    };
  }
  const env = environment.prefix;
  const creationNonce = randomBytes(32).toString("hex");
  // La reanudación es un subcomando del HARNESS, así que va pegada al binario y NO al prefijo
  // `env K=V`: `env` se comería `--continue` como si fuera suyo.
  const resume = resumeArgumentSuffix(resumeArguments);
  if (!resume.ok) {
    return { ok: false, created: false, failure: "session_absent", detail: resume.detail };
  }

  // Una ventana, un proceso: el binario del harness tal cual, igual que si lo abriera el dueño.
  //
  // codex tenía además una ventana `servidor` con `app-server --listen unix://` y arrancaba la TUI
  // con `--remote`. Se retiró entera: el turno ya no entra por ese protocolo sino por la caja de
  // entrada, así que el servidor, el socket, la espera a que aceptara y la ventana extra eran
  // cuatro piezas que sólo podían fallar. Y fallaron: el 2026-07-31 `turn/start` se quedó colgado
  // sin que el log del servidor registrara nada.
  const result = await tmux.run([
    "new-session", "-d", "-P", "-F", "#{session_id}", "-s", session, "-n", TUI_WINDOW,
    "-c", spec.workspace, "-x", width, "-y", height,
    "bash", "-lc", `exec ${env}${command}${resume.suffix}`,
    ";", "set-option", "-t", session, CREATION_NONCE_OPTION, creationNonce,
  ]);
  if (result.exitCode !== 0) {
    if (signalAborted(options.signal)) {
      return { ok: false, created: false, cancelled: true, detail: "preflight cancelado" };
    }
    // Dos `ensure` pueden observar ausencia a la vez. `new-session -s` serializa la creación: el
    // perdedor recibe duplicate session. No se interpreta el stderr (cambia por versión); se
    // resuelve el nombre de nuevo y se acredita lo que ganó.
    const winnerId = await exactSessionTarget(tmux, session);
    if (signalAborted(options.signal)) {
      return {
        ok: false,
        created: false,
        ...(winnerId === undefined ? {} : { sessionId: winnerId }),
        cancelled: true,
        detail: "preflight cancelado",
      };
    }
    if (winnerId !== undefined) {
      const identity = await verifyExistingSessionIdentity(
        tmux,
        spec,
        session,
        winnerId,
        options.signal,
      );
      if ("cancelled" in identity) {
        return {
          ok: false,
          created: false,
          sessionId: winnerId,
          cancelled: true,
          detail: "preflight cancelado",
        };
      }
      if (!identity.ok) {
        return {
          ok: false,
          created: false,
          sessionId: winnerId,
          failure: identity.failure,
          detail: identity.detail,
        };
      }
      return { ok: true, created: false, sessionId: winnerId };
    }
    return {
      ok: false, created: false, failure: "session_absent", detail: tmuxError(result.stderr),
    };
  }

  const sessionId = result.stdout.trim();
  if (!/^\$[0-9]+$/u.test(sessionId)) {
    return {
      ok: false,
      created: true,
      failure: "session_identity_unverified",
      detail: `tmux creó ${session} pero no devolvió un session_id acreditable; se conserva intacta`,
    };
  }

  // El nonce se fija en la MISMA cola de comandos que `new-session`. Después se captura la
  // generación completa; cualquier rename/respawn entre ambos pasos hace fallar cerrado y nunca
  // produce un testigo con el que el cleanup pueda matar otra conversación.
  const creationMarker = await sessionOption(tmux, sessionId, CREATION_NONCE_OPTION);
  const createdPane = await inspectSolePaneHarness(tmux, sessionId, TUI_WINDOW);
  const ownership: CreatedSessionOwnership | undefined = creationMarker.ok
    && creationMarker.value === creationNonce
    && createdPane.state === "present"
    && createdPane.pane.sessionName === session
    && paneCommandMatches(spec, createdPane.pane.paneStartCommand)
    ? { ...createdPane.pane, creationNonce }
    : undefined;
  if (ownership === undefined && await hasSessionId(tmux, sessionId)) {
    return {
      ok: false,
      created: true,
      sessionId,
      failure: "session_identity_unverified",
      detail: `la sesión ${session} cambió antes de acreditar su nonce/pane de creación; se conserva intacta`,
    };
  }

  // El nombre no basta: una sesion sobrevive a cambios de configuracion y antes podia hacer que
  // Salva siguiera atendiendo con claude aunque el inventario ya exigiera codex. La identidad se
  // graba en la sesion que acabamos de crear, antes de declararla lista.
  const sessionTarget = await exactSessionTarget(tmux, session);
  if (sessionTarget !== sessionId) {
    // Si nuestro `$N` ya murió, `startTui` tiene que observarlo para poder rehacer en blanco. Si
    // otro `$M` tomó el nombre, jamás se marca ni se mata ese reemplazo.
    if (sessionTarget === undefined) {
      return {
        ok: true,
        created: true,
        sessionId,
        ...(ownership === undefined ? {} : { ownership }),
      };
    }
    return {
      ok: false,
      created: true,
      sessionId,
      failure: "session_identity_unverified",
      detail: `la sesion ${session} fue reemplazada antes de acreditarla; se conserva el reemplazo`,
    };
  }
  const aliasMarked = await setSessionOption(tmux, sessionId, SESSION_ALIAS_OPTION, spec.alias);
  const harnessMarked = aliasMarked
    && await setSessionOption(tmux, sessionId, SESSION_HARNESS_OPTION, spec.harness);
  if (!harnessMarked) {
    // Si el panel ya murio (caso `claude --continue` sin conversacion), se deja que `startTui`
    // observe la desaparicion y aplique su fallback seguro. Si sigue vivo, no se mata: queda
    // reportado como no acreditado para que una falla de metadatos nunca borre una conversacion.
    if (!await sessionIdStillNamed(tmux, session, sessionId)) {
      return {
        ok: true,
        created: true,
        sessionId,
        ...(ownership === undefined ? {} : { ownership }),
      };
    }
    return {
      ok: false,
      created: true,
      sessionId,
      failure: "session_identity_unverified",
      detail: `la sesion ${session} se creo pero no pudo grabar su identidad; se conserva intacta`,
    };
  }
  if (!await sessionIdStillNamed(tmux, session, sessionId)) {
    return {
      ok: false,
      created: true,
      sessionId,
      failure: "session_identity_unverified",
      detail: `la sesion ${session} fue reemplazada al grabar su identidad; no se toca el reemplazo`,
    };
  }
  return {
    ok: true,
    created: true,
    sessionId,
    ...(ownership === undefined ? {} : { ownership }),
  };
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
 *
 * Distingue TRES desenlaces, y el del medio es nuevo: un panel MUERTO no se puede esperar. Antes
 * sólo se miraba la caja, y un panel que salía al instante —lo que hace `claude --continue` cuando
 * no hay nada que continuar— dejaba a `capturePane` devolviendo `undefined`, que `inputBoxState`
 * llama «ocupado». El resultado era esperar el plazo ENTERO (90 s por defecto) delante de una
 * sesión que ya no existía, y sólo después declararla ausente. Con la reanudación eso además
 * retrasaría 90 s el arranque en blanco de un alias que se quedó sin panel.
 */
async function waitForTui(
  tmux: TmuxController,
  target: string,
  options: EnsureOptions,
): Promise<"ready" | "gone" | "timeout" | "cancelled"> {
  const deadline = Date.now() + (options.readyTimeoutMs ?? DEFAULT_READY_TIMEOUT_MS);
  for (;;) {
    if (signalAborted(options.signal)) return "cancelled";
    const pane = await capturePane(tmux, target, { styled: true });
    if (signalAborted(options.signal)) return "cancelled";
    if (!inputBoxState(pane).occupied) return "ready";
    // Se pregunta por el panel sólo cuando la caja NO estaba libre: si estaba libre hay TUI viva y
    // preguntar sobraría. Así el sondeo caro se paga únicamente mientras la TUI arranca.
    if (await panePid(tmux, target) === undefined) return "gone";
    if (signalAborted(options.signal)) return "cancelled";
    if (Date.now() >= deadline) return "timeout";
    await options.sleep(READY_POLL_MS);
    if (signalAborted(options.signal)) return "cancelled";
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
  const sessionId = await exactSessionTarget(tmux, session);
  const present = sessionId !== undefined;
  const pid = sessionId === undefined ? undefined : await panePid(tmux, tuiTarget(sessionId));
  return {
    alias: spec.alias,
    harness: spec.harness,
    session,
    present,
    ...(pid === undefined ? {} : { pid }),
  };
}
