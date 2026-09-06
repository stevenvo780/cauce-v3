import { realpath } from "node:fs/promises";
import type { PaneHarnessIdentity, TmuxController } from "./tmux.js";
import type { EnsureResult } from "./session.js";
import type { ResumeSpec } from "./types.js";

type ExactStartAttempt =
  | {
    readonly ready: true;
    readonly created: boolean;
    readonly pid: string;
    readonly sessionId: string;
    readonly pane: PaneHarnessIdentity;
  }
  | { readonly ready: false; readonly result: EnsureResult };

export async function ensureExactSessionLaunch(
  resume: ResumeSpec | undefined,
  alias: string,
  isAborted: () => boolean,
  start: (args: readonly string[]) => Promise<ExactStartAttempt>,
): Promise<EnsureResult | undefined> {
  if (resume?.resolveLaunch === undefined) return undefined;
  let plan;
  try {
    plan = await resume.resolveLaunch();
  } catch {
    return {
      ready: false,
      created: false,
      failure: "session_identity_unverified",
      detail: `no se pudo resolver la identidad exacta de la conversación de ${alias}`,
    };
  }
  if (plan.state === "blocked") {
    return {
      ready: false,
      created: false,
      failure: "session_identity_unverified",
      detail: plan.detail,
    };
  }
  if (isAborted()) {
    return {
      ready: false,
      created: false,
      cancelled: true,
      detail: "preflight cancelado antes de inyectar la entrega",
    };
  }
  const attempt = await start(plan.args);
  if (!attempt.ready) return attempt.result;
  return {
    ready: true,
    created: attempt.created,
    ...(attempt.created && plan.resumed ? { resumed: true } : {}),
    pid: attempt.pid,
    sessionId: attempt.sessionId,
    pane: attempt.pane,
    detail: plan.resumed
      ? `sesión cauce-${alias} creada REANUDANDO la conversación exacta`
      : `sesión cauce-${alias} creada con identidad nativa nueva`,
  };
}

export async function paneWorkspaceState(
  tmux: TmuxController,
  pane: Pick<PaneHarnessIdentity, "paneId">,
  workspace: string,
): Promise<"match" | "mismatch" | "unreadable"> {
  const result = await tmux.run([
    "display-message", "-p", "-t", pane.paneId, "#{pane_current_path}",
  ]);
  if (result.exitCode !== 0) return "unreadable";
  const observed = result.stdout.trim();
  if (observed === "") return "unreadable";
  try {
    const [expectedReal, observedReal] = await Promise.all([realpath(workspace), realpath(observed)]);
    return expectedReal === observedReal ? "match" : "mismatch";
  } catch {
    return "unreadable";
  }
}
