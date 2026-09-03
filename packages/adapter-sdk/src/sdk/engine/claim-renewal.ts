import type { InboxRecord } from "../durable-store.js";
import { AdapterError } from "../errors.js";
import type { Clock, TimerHandle } from "../types.js";

export interface ClaimMonitor {
  readonly attempt: number;
  readonly claimToken: string;
  readonly confirm: () => void;
}

export interface ClaimRenewalDeps {
  readonly clock: Clock;
  readonly fenced: Set<string>;
  readonly claimMonitors: Map<string, ClaimMonitor>;
  emitClaimRenewal(record: InboxRecord, phase: "accepted" | "started"): Promise<void>;
}

/**
 * A delivery claim is a short renewable lease, not the agent's wall-clock execution deadline.
 * Renewal events are durable locally before transport; an offline socket can therefore flush
 * them after reconnect.
 *
 * `phase` distinguishes the queue heartbeat ('accepted') from the execution one ('started').
 * The transport maps it as-is to the ACK's `status`; both are values `AckStatusSchema` and the
 * `delivery_acks.status` CHECK already accept, so this requires no schema change.
 *
 * Every timer goes through the clock so a test can drive the cadence without burning wall time;
 * the system clock leaves them unref'd, which is what keeps a stopped adapter from lingering.
 */
export function startClaimRenewal(
  deps: ClaimRenewalDeps,
  record: InboxRecord,
  intervalMs: number,
  watchdogMs: number,
  controller: AbortController,
  phase: "accepted" | "started" = "started",
): () => Promise<void> {
  let stopped = false;
  let tail = Promise.resolve();
  // Armed before the closures that clear it: a clock may fire a non-positive delay inside the very
  // call that arms it, and reading a handle declared further down would throw from its TDZ.
  let timer: TimerHandle = { cancel: () => undefined };
  const abortForUnconfirmedClaim = (): void => {
    if (stopped) return;
    stopped = true;
    deps.clock.clearTimer(timer);
    deps.fenced.add(record.delivery_id);
    controller.abort(new AdapterError(
      "CLAIM_RENEWAL_UNCONFIRMED",
      "Delivery lease renewal was not confirmed before the ownership deadline",
      true,
    ));
  };
  let watchdog = deps.clock.setTimer(abortForUnconfirmedClaim, watchdogMs);
  const confirm = (): void => {
    if (stopped) return;
    deps.clock.clearTimer(watchdog);
    watchdog = deps.clock.setTimer(abortForUnconfirmedClaim, watchdogMs);
  };
  timer = deps.clock.setRepeating(() => {
    if (stopped) return;
    tail = tail
      .catch(() => undefined)
      .then(async () => {
        if (stopped) return;
        try {
          await deps.emitClaimRenewal(record, phase);
        } catch {
          stopped = true;
          deps.clock.clearTimer(timer);
          controller.abort(new AdapterError(
            "CLAIM_RENEWAL_PERSISTENCE_FAILED",
            "Delivery lease renewal could not be persisted locally",
            false,
          ));
        }
      });
  }, intervalMs);
  deps.claimMonitors.set(record.delivery_id, {
    attempt: record.attempt,
    claimToken: record.claim_token,
    confirm,
  });
  return async () => {
    stopped = true;
    deps.clock.clearTimer(timer);
    deps.clock.clearTimer(watchdog);
    const monitor = deps.claimMonitors.get(record.delivery_id);
    if (monitor?.attempt === record.attempt && monitor.claimToken === record.claim_token) {
      deps.claimMonitors.delete(record.delivery_id);
    }
    await tail.catch(() => undefined);
  };
}
