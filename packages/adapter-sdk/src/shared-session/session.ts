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
} from "./types.js";
import type {
  EnsureFailure,
  EnsureOptions,
  EnsureResult,
  SharedSessionSpec,
  SharedSessionStatus,
} from "./session/contracts.js";
import {
  SESSION_ALIAS_OPTION,
  SESSION_HARNESS_OPTION,
  paneCommandMatches,
  signalAborted,
  verifyExistingSessionIdentity,
} from "./session/identity.js";

export type {
  EnsureFailure,
  EnsureOptions,
  EnsureResult,
  SharedSessionSpec,
} from "./session/contracts.js";

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;

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
 * Garantiza que la sesión compartida esté creada y lista para recibir comandos.
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

/**
 * Comprueba si existe una conversación previa reanudable.
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
  // Sin PID o si no llegó a estar lista, se reporta como no lista.
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
  const resume = resumeArgumentSuffix(resumeArguments);
  if (!resume.ok) {
    return { ok: false, created: false, failure: "session_absent", detail: resume.detail };
  }

  // Lanza el binario del harness en la ventana principal.
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

  const sessionTarget = await exactSessionTarget(tmux, session);
  if (sessionTarget !== sessionId) {
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
 * Espera a que la TUI esté completamente inicializada y la caja de entrada disponible.
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

export type { SharedSessionStatus } from "./session/contracts.js";

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
