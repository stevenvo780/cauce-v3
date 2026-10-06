import { isSystemGateProbeBody } from "@cauce/protocol";
import type { InboxRecord } from "../durable-store.js";
import type { DurableStore } from "../durable-store.js";
import type { Clock, Delivery, StructuredOutput } from "../types.js";
import type { EventPublisher } from "./contracts.js";

interface SystemGateProbeContext {
  readonly store: DurableStore;
  readonly clock: Clock;
  readonly publishEvent: EventPublisher;
  readonly replayPending: (record: InboxRecord) => Promise<void>;
  readonly ownAlias: string | undefined;
  readonly isCurrent: () => boolean;
}

function ownsClaim(delivery: Delivery, runtime: SystemGateProbeContext): boolean {
  const record = runtime.store.getDelivery(delivery.delivery_id);
  return runtime.isCurrent() && record?.attempt === delivery.attempt && record.claim_token === delivery.claim_token;
}

export async function runSystemGateProbe(
  delivery: Delivery,
  runtime: SystemGateProbeContext,
): Promise<void> {
  const occurredAt = runtime.clock.now().toISOString();
  const accepted = await runtime.store.acceptAndEnqueue(delivery, occurredAt);
  if (accepted.acceptance === "stale" || accepted.acceptance === "blocked" || !ownsClaim(delivery, runtime)) return;
  if (accepted.acceptance === "duplicate") {
    await runtime.replayPending(accepted.record);
    if (accepted.record.state !== "accepted") return;
  } else if (accepted.event !== undefined) await runtime.publishEvent(accepted.event);

  if (!ownsClaim(delivery, runtime)) return;
  const context = delivery.authenticated_context;
  const authorized = isSystemGateProbeBody(delivery.body)
    && runtime.ownAlias !== undefined && delivery.recipient_alias === runtime.ownAlias
    && delivery.origin === undefined
    && context?.session_id === "gate-probe"
    && context.channel === "gate"
    && context.origin === undefined;
  if (!authorized) {
    const error = {
      code: "UNAUTHORIZED_GATE_PROBE",
      message: "Reserved system gate probe authority is invalid",
      retryable: false,
    };
    const failed = await runtime.store.transitionAndEnqueueIfCurrent(
      delivery.delivery_id,
      "failed",
      runtime.clock.now().toISOString(),
      { error, attempt: delivery.attempt, claimToken: delivery.claim_token,
        expectedEpoch: delivery.epoch, isCurrent: runtime.isCurrent },
    );
    if (failed !== undefined && ownsClaim(delivery, runtime)) await runtime.publishEvent(failed.event);
    return;
  }

  const output: StructuredOutput = {
    reply: null,
    messages: [],
    notify: [],
    status: "done",
    retryable: false,
    artifacts: [],
  };
  const done = await runtime.store.transitionAndEnqueueIfCurrent(
    delivery.delivery_id,
    "done",
    runtime.clock.now().toISOString(),
    { output, attempt: delivery.attempt, claimToken: delivery.claim_token,
      expectedEpoch: delivery.epoch, isCurrent: runtime.isCurrent },
  );
  if (done !== undefined && ownsClaim(delivery, runtime)) await runtime.publishEvent(done.event);
}
