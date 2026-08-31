import { stat } from "node:fs/promises";
import type { CommandRunResult } from "../../sdk/types.js";

export const DEFAULT_ACQUIRE_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_POLL_MS = 750;
export const DEFAULT_CANCEL_DRAIN_TIMEOUT_MS = 30_000;
export const QUARANTINE_OPERATION_TIMEOUT_MS = 2_000;
export const SETTLE_MS = 250;
export const DEFAULT_INJECT_TIMEOUT_MS = 30_000;
export const LIVENESS_EVERY = 8;
/** Un dialogo no se destraba esperando: rendirse pronto es lo que hace seguro el plazo largo. */
export const ACQUIRE_MODAL_TIMEOUT_MS = 15_000;
export const DEFAULT_CORRELATION_TIMEOUT_MS = 25 * 60_000;
export const DEFAULT_QUIET_MS = 5 * 60_000;
export const DEFAULT_MERGED_GRACE_MS = 30 * 60_000;

export function turnBudgetMs(requestTimeoutMs: number, turnTimeoutMs?: number): number {
  return turnTimeoutMs === undefined
    ? requestTimeoutMs
    : Math.min(requestTimeoutMs, turnTimeoutMs);
}

export async function beforeAbort<T>(
  operation: () => Promise<T>,
  signal: AbortSignal,
): Promise<{ readonly aborted: true } | { readonly aborted: false; readonly value: T }> {
  if (signal.aborted) return { aborted: true };
  return new Promise((resolveBeforeAbort, rejectBeforeAbort) => {
    let settled = false;
    const aborted = (): void => {
      if (settled) return;
      settled = true;
      resolveBeforeAbort({ aborted: true });
    };
    signal.addEventListener("abort", aborted, { once: true });
    void operation().then((value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      resolveBeforeAbort({ aborted: false, value });
    }, (error: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", aborted);
      rejectBeforeAbort(error instanceof Error
        ? error
        : new Error("Shared-session operation rejected with a non-Error value", { cause: error }));
    });
  });
}

export async function beforeDeadline<T>(
  operation: Promise<T>,
  deadline: number,
): Promise<{ readonly completed: boolean; readonly value?: T }> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {
    void operation.catch(() => undefined);
    return { completed: false };
  }
  return new Promise((resolveBeforeDeadline) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolveBeforeDeadline({ completed: false });
    }, remaining);
    void operation.then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBeforeDeadline({ completed: true, value });
    }, () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveBeforeDeadline({ completed: true });
    });
  });
}

export async function fileSize(file: string): Promise<number> {
  try {
    return (await stat(file)).size;
  } catch {
    return -1;
  }
}

export function result(overrides: Partial<CommandRunResult>): CommandRunResult {
  return {
    stdout: "",
    stderr: "",
    exitCode: 0,
    signal: null,
    timedOut: false,
    cancelled: false,
    ...overrides,
  };
}

export function postEnterCancelled(detail?: string): CommandRunResult {
  return result({
    cancelled: true,
    ...(detail === undefined ? {} : { stderr: detail }),
  });
}

export function replacedBeforeSubmission(): CommandRunResult {
  return result({
    exitCode: 1,
    harnessStarted: false,
    stderr: "la sesión tmux acreditada fue reemplazada antes de Enter;"
      + " la entrega no se ejecutó y el reemplazo quedó intacto",
  });
}
