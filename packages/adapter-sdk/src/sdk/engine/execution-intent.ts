import { randomUUID } from "node:crypto";
import { AdapterError } from "../errors.js";
import type { InboxRecord, DurableStore } from "../durable-store.js";
import type { AdapterLogger, Clock, DeliveryEvent } from "../types.js";
import type { ClaimMonitor } from "./claim-renewal.js";
import type { EventPublisher, ExecutionIntentPublisher } from "./contracts.js";

export interface ExecutionIntentDeps {
  readonly store: DurableStore;
  readonly clock: Clock;
  readonly logger: AdapterLogger;
  readonly publishEvent: EventPublisher;
  readonly publishExecutionIntent: ExecutionIntentPublisher | undefined;
  readonly claimMonitors: ReadonlyMap<string, ClaimMonitor>;
}

export async function commitExecutionIntent(
  deps: ExecutionIntentDeps,
  record: InboxRecord,
  signal: AbortSignal,
  watchdogMs: number,
): Promise<void> {
  let event: DeliveryEvent;
  try {
    event = await persistClaimRenewal(deps, record, "started", { executionStarted: true });
  } catch {
    throw new AdapterError(
      "EXECUTION_INTENT_PERSISTENCE_FAILED",
      "Durable execution intent could not be persisted before harness invocation",
      true,
    );
  }
  if (deps.publishExecutionIntent === undefined) {
    await deps.publishEvent(event).catch(() => undefined);
    return;
  }
  const monitor = deps.claimMonitors.get(record.delivery_id);
  const ownershipLeftMs = monitor?.attempt === record.attempt && monitor.claimToken === record.claim_token
    ? monitor.expiresAt() - deps.clock.now().getTime()
    : Number.POSITIVE_INFINITY;
  const beforeWatchdogFencesMs = ownershipLeftMs - Math.ceil(watchdogMs / 10);
  const budgetMs = Math.min(
    Math.max(100, Math.min(30_000, Math.floor(watchdogMs / 2))),
    beforeWatchdogFencesMs,
  );
  if (budgetMs <= 0) {
    throw new AdapterError(
      "EXECUTION_INTENT_CONFIRMATION_FAILED",
      "Persisting the execution intent consumed the ownership left before the claim watchdog",
      true,
    );
  }
  await deps.publishExecutionIntent(event, signal, budgetMs);
}

export async function persistClaimRenewal(
  deps: ExecutionIntentDeps,
  record: InboxRecord,
  phase: "accepted" | "started",
  options: { readonly executionStarted?: boolean },
): Promise<DeliveryEvent> {
  const event: DeliveryEvent = {
    event_id: randomUUID(),
    delivery_id: record.delivery_id,
    attempt: record.attempt,
    claim_token: record.claim_token,
    epoch: deps.store.epoch,
    phase,
    occurred_at: deps.clock.now().toISOString(),
    claim_renewal: true,
    ...(options.executionStarted === true ? { execution_started: true } : {}),
    ...(record.origin === undefined ? {} : { origin: record.origin }),
  };
  deps.logger({
    event: "claim_renewal_start",
    delivery_id: record.delivery_id,
    attempt: record.attempt,
    phase,
    timestamp: event.occurred_at,
  });
  // A renewal must reach stable local storage before it can be treated as recoverable work.
  await deps.store.enqueue(event);
  return event;
}
