import {
  inspectSolePaneHarness,
  paneIdentityStillCurrent,
  sessionIdStillNamed,
  sessionOption,
  setSessionOption,
  type PaneHarnessIdentity,
  type TmuxController,
} from "../tmux.js";
import {
  LEGACY_DEGRADED_WINDOW,
  TUI_WINDOW,
  type ResumeSpec,
  type SharedSessionHarness,
} from "../types.js";
import { signalAborted } from "../../runtime-state.js";

export interface SharedSessionSpec {
  readonly alias: string;
  readonly harness: SharedSessionHarness;
  /** Working directory of the TUI. It is also what determines the transcripts directory. */
  readonly workspace: string;
  /** Harness binary. Split out so tests can point it at a double. */
  readonly command?: string;
  /**
   * Environment variables applied to the panel startup command (`env K=V ...`).
   */
  readonly environment?: Readonly<Record<string, string>>;
  readonly harnessArguments?: readonly string[];
  /** Resume specification for a previous conversation if any. See `ResumeSpec`. */
  readonly resume?: ResumeSpec;
}

export type EnsureFailure =
  | "session_absent"
  | "tui_absent"
  /** The session's exact name and the alias recorded inside it do not match. */
  | "session_alias_mismatch"
  /** The session belongs to another harness; reusing it would mix two conversations. */
  | "session_harness_mismatch"
  /** A legacy session did not give enough evidence to mark alias+harness. */
  | "session_identity_unverified";

export const SESSION_ALIAS_OPTION = "@cauce_alias";
export const SESSION_HARNESS_OPTION = "@cauce_harness";

type IdentityResult =
  | { readonly ok: true; readonly pane?: PaneHarnessIdentity }
  | { readonly ok: false; readonly failure: EnsureFailure; readonly detail: string }
  | { readonly ok: false; readonly cancelled: true };

/**
 * Vouches that an EXISTING session corresponds to the alias and harness requested.
 *
 * Private options are the canonical witness. For the fleet that was already alive before
 * they existed, the session name vouches for the alias (queried with the exact `=...` target)
 * and the original pane command vouches for the harness. Only then are both markers written.
 * None of this path kills, renames or restarts an incompatible session.
 */
export async function verifyExistingSessionIdentity(
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
  // Markers declare what SHOULD live in the session; the original command accredits what
  // process actually lives in THIS generation. Always required, even for marked sessions.
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
 * Narrow inference for sessions predating the markers.
 *
 * Either the canonical harness binary or the explicitly configured `command` for that harness
 * is accepted. A runnable opposite harness makes the evidence ambiguous and fails closed. The
 * observed command is never included in errors: it may contain private arguments.
 */
export function paneCommandMatches(spec: SharedSessionSpec, command: string): boolean {
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
