import { stat } from "node:fs/promises";
import type { CommandRunResult } from "../../sdk/types.js";

export const DEFAULT_ACQUIRE_TIMEOUT_MS = 20 * 60_000;
export const DEFAULT_GENERATING_WAIT_MS = 2 * 60 * 60_000;
export const DEFAULT_BACKGROUND_WAIT_MS = 10 * 60_000;
export const DEFAULT_POLL_MS = 750;
export const DEFAULT_CANCEL_DRAIN_TIMEOUT_MS = 30_000;
export const QUARANTINE_OPERATION_TIMEOUT_MS = 2_000;
export const SETTLE_MS = 250;
export const DEFAULT_INJECT_TIMEOUT_MS = 30_000;
export const DEFAULT_DISPATCH_GRACE_MS = 60_000; // grok drains an accepted paste in milliseconds; a minute idle and still queued is not a turn.
export const LIVENESS_EVERY = 8;
/**
 * How long the in-turn liveness probe may keep failing to READ the pane before the turn is fenced as
 * ambiguous. Each probe has a 2 s tmux budget; on a host saturated by I/O (perseo/teseo 2026-11-04,
 * world-backup verification plus a fleet setup) one probe missed it while the TUI kept working and
 * the same generation was still there half an hour later. Absence or a replaced process still ends
 * the turn at once; only an unreadable answer waits, re-probing every poll.
 */
export const LIVENESS_UNREADABLE_GRACE_MS = 90_000;
/**
 * How long an input-barrier acquisition whose result tmux lost is re-probed before the generation
 * is quarantined. perseo 13:09Z / operador 16:52Z (9-nov): the hourly backup verification
 * saturated server2's disk, tmux answered late, and each alias was quarantined until an operator
 * removed the pending by hand although its composer was empty and no model had seen the prompt.
 */
export const BARRIER_RESOLUTION_BUDGET_MS = 75_000;
/** tmux deadline of each re-probe in that budget; the ordinary 2 s is what the starved host missed. */
export const BARRIER_RESOLUTION_PROBE_TIMEOUT_MS = 10_000;
export const BARRIER_RESOLUTION_INTERVAL_MS = 2_500;
/** Acquisitions recovered in-process per delivery before handing the retry to the store. */
export const MAX_RECOVERED_BARRIER_ACQUISITIONS = 2;
/** Un dialogo no se destraba esperando: rendirse pronto es lo que hace seguro el plazo largo. */
export const ACQUIRE_MODAL_TIMEOUT_MS = 15_000;
export const DEFAULT_CORRELATION_TIMEOUT_MS = 120 * 60_000;
const CORRELATION_TIMEOUT_ENV = "CAUCE_SHARED_SESSION_CORRELATION_TIMEOUT_MS";
const MIN_CORRELATION_TIMEOUT_MS = 60_000;
const MAX_CORRELATION_TIMEOUT_MS = 24 * 60 * 60_000;

export function correlationTimeoutFromEnvironment(environment: NodeJS.ProcessEnv): number {
  const raw = environment[CORRELATION_TIMEOUT_ENV];
  if (raw === undefined || raw === "") return DEFAULT_CORRELATION_TIMEOUT_MS;
  const value = /^[0-9]{1,9}$/u.test(raw) ? Number(raw) : Number.NaN;
  if (!Number.isInteger(value) || value < MIN_CORRELATION_TIMEOUT_MS || value > MAX_CORRELATION_TIMEOUT_MS) {
    throw new Error(`${CORRELATION_TIMEOUT_ENV} must be an integer between ${String(MIN_CORRELATION_TIMEOUT_MS)} and ${String(MAX_CORRELATION_TIMEOUT_MS)} milliseconds`);
  }
  return value;
}
export const DEFAULT_QUIET_MS = 5 * 60_000;

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

/**
 * Same contract as `replacedBeforeSubmission`: `harnessStarted: false` with no output is what the
 * adapter turns into the retryable PROCESS_EXIT_PREFLIGHT, so the store redelivers the turn.
 */
export function barrierLostBeforePaste(attempts: number): CommandRunResult {
  return result({
    exitCode: 1,
    harnessStarted: false,
    stderr: `tmux perdió ${String(attempts)} veces seguidas el resultado al adquirir la exclusión de input;`
      + " cada vez se acreditó que la caja quedó intacta y no se pegó nada: la entrega no se ejecutó",
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
