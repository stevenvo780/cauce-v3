import {
  inspectSolePaneHarness,
  paneIdentityStillCurrent,
  sessionIdStillNamed,
  sessionOption,
  setSessionOption,
  type PaneHarnessIdentity,
  type TmuxController,
} from "../tmux.js";
import { LEGACY_DEGRADED_WINDOW, TUI_WINDOW } from "../types.js";
import type { EnsureFailure, SharedSessionSpec } from "./contracts.js";

export const SESSION_ALIAS_OPTION = "@cauce_alias";
export const SESSION_HARNESS_OPTION = "@cauce_harness";

// Se lee mediante función para que TypeScript no trate `AbortSignal.aborted` como una constante
// refinada a `false` a través de awaits: el valor cambia precisamente desde otro task.
export function signalAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
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
