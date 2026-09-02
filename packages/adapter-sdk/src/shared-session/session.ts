import { randomBytes } from "node:crypto";
import { realpath } from "node:fs/promises";
import { signalAborted } from "../runtime-state.js";
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
  type SharedSessionHarness,
} from "./types.js";
import {
  SESSION_ALIAS_OPTION,
  SESSION_HARNESS_OPTION,
  paneCommandMatches,
  type EnsureFailure as IdentityEnsureFailure,
  type SharedSessionSpec,
  verifyExistingSessionIdentity,
} from "./session/identity.js";

export type { SharedSessionSpec } from "./session/identity.js";

/** Reasons `ensureSharedSession` can decline a usable session; `workspace_mismatch` is detected here, against the freshly created pane, never inside `session/identity.ts`. */
export type EnsureFailure = IdentityEnsureFailure | "workspace_mismatch";

export interface EnsureOptions {
  readonly sleep: (ms: number) => Promise<void>;
  /** Cancels the preflight before a delivery touches the input box. */
  readonly signal?: AbortSignal;
  /** How long to wait for the TUI to be ready after creating it. */
  readonly readyTimeoutMs?: number;
  /** Width/height with which the session is born without attached clients. */
  readonly width?: number;
  readonly height?: number;
  /** Logging function for resume events or incidents. */
  readonly log?: (detail: string) => void;
}

interface EnsureResult {
  readonly ready: boolean;
  /** True if this call had to create the session (it did not exist). */
  readonly created: boolean;
  /** PID of the TUI pane's process, when it could be read. */
  readonly pid?: string;
  /** Exact credited `$N` id. All later TUI use goes through it, never through the name. */
  readonly sessionId?: string;
  /** Exact credited generation (session/pane/PID) and the command observed in that same snapshot. */
  readonly pane?: PaneHarnessIdentity;
  readonly detail: string;
  /** The preflight was interrupted; not a degradation and does not authorize running the fallback. */
  readonly cancelled?: boolean;
  /** Cause of failure during the ensure process. */
  readonly failure?: EnsureFailure;
  /** Whether the session was created by resuming a prior conversation. */
  readonly resumed?: boolean;
}

const DEFAULT_READY_TIMEOUT_MS = 90_000;
const READY_POLL_MS = 1_000;

function tuiTarget(sessionId: string): string {
  return `${sessionId}:${TUI_WINDOW}`;
}

/**
 * The directory where `claude` stores transcripts for a workspace.
 * The rule is fixed by claude: it replaces each `/` in the cwd with `-`, so `/workspace` becomes
 * `-workspace`. Replicated here because the adapter has to read THAT directory and there is no
 * flag that reveals it.
 */
export function transcriptDirectory(home: string, workspace: string): string {
  return transcriptDirectoryIn(`${home}/.claude`, workspace);
}

/**
 * Same, but starting from the EXACT config directory the TUI will run with.
 *
 * Exists because where `claude` writes transcripts and where the adapter reads them MUST be the
 * same by construction. If someone exports `CLAUDE_CONFIG_DIR`, the pane honors it (we pass it
 * on its argv) and the harvest must look there, not in `~/.claude`. Deriving both from the same
 * value makes it impossible to drift them apart.
 */
export function transcriptDirectoryIn(configDirectory: string, workspace: string): string {
  const slug = workspace.replace(/\/+$/u, "").replace(/\//gu, "-");
  const root = configDirectory.replace(/\/+$/u, "");
  return `${root}/projects/${slug === "" ? "-" : slug}`;
}

/**
 * Ensures the shared session is created and ready to receive commands.
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
    // The session was locked in by the rename from a previous version: the window existed but with
    // another name, so the adapter called it dead on every delivery, forever.
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
  if (pane?.windowName !== TUI_WINDOW) {
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
 * Checks whether a resumable prior conversation exists.
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
 * One startup attempt, with what is needed to decide whether it can be retried.
 * `paneGone` is the question that separates "this can be redone" from "this must be left alone":
 * retry only over a pane that is ALREADY gone, never over a live one.
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
    // Total absence is the TUI process that exited while starting: the fallback can be tried. A
    // different `$M` with the same name (or our `$N` still alive under a new name) is a
    // replacement: don't adopt, don't kill, don't recreate anything in this call.
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
    // The `agente` window not being there does NOT mean the session died: it may have been renamed
    // or replaced by a human process. Only the absence of the whole `$N` enables another try.
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
  // Without a PID or if it didn't become ready, report as not ready.
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
 * The `env K=V …` prefix that sets the pane's environment, already escaped for `bash -lc`.
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

/** Single quotes, which on POSIX interpret NOTHING. The value never touches the shell parser. */
function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, "'\\''")}'`;
}

/**
 * Resume arguments, ready to be appended after the binary.
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

/** The pane's OBSERVED workspace when it differs from `workspace`, or `undefined` when they match or the pane could not be read (tmux accepts a bad `-c` and starts elsewhere instead of failing). */
async function mismatchedPaneWorkspace(
  tmux: TmuxController,
  ownership: CreatedSessionOwnership,
  workspace: string,
): Promise<string | undefined> {
  const result = await tmux.run([
    "display-message", "-p", "-t", ownership.paneId, "#{pane_current_path}",
  ]);
  if (result.exitCode !== 0) return undefined;
  const observed = result.stdout.trim();
  if (observed === "") return undefined;
  const resolve = async (value: string): Promise<string> => {
    try {
      return await realpath(value);
    } catch {
      return value;
    }
  };
  const [expectedReal, observedReal] = await Promise.all([resolve(workspace), resolve(observed)]);
  return expectedReal === observedReal ? undefined : observed;
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

  // Launches the harness binary in the main window.
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

  if (ownership !== undefined) {
    const observedWorkspace = await mismatchedPaneWorkspace(tmux, ownership, spec.workspace);
    if (observedWorkspace !== undefined) {
      await killSessionIdIfNamed(tmux, ownership);
      return {
        ok: false,
        created: true,
        sessionId,
        failure: "workspace_mismatch",
        detail: `tmux debía arrancar ${session} en ${spec.workspace} y arrancó el pane en`
          + ` ${observedWorkspace}; esa generación se mató`,
      };
    }
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
 * Waits until the TUI is fully initialized and the input box is available.
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
    // The pane is only asked when the box was NOT free: if it was free there is a live TUI and
    // asking would be redundant. The expensive poll is paid only while the TUI is starting up.
    if (await panePid(tmux, target) === undefined) return "gone";
    if (signalAborted(options.signal)) return "cancelled";
    if (Date.now() >= deadline) return "timeout";
    await options.sleep(READY_POLL_MS);
    if (signalAborted(options.signal)) return "cancelled";
  }
}

interface SharedSessionStatus {
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
