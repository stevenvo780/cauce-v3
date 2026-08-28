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
  readonly rejectStale: (delivery: Delivery) => Promise<void>;
}

/**
 * Reserved transport probe. Closes the real claim without session, prompt, harness, model,
 * reply, delegation, or egress. The request disappears from the durable inbox on the terminal
 * transition (`retainRequest=false`); only the minimum result needed for the ACK remains.
 */
export async function runSystemGateProbe(
  delivery: Delivery,
  runtime: SystemGateProbeContext,
): Promise<void> {
  const occurredAt = runtime.clock.now().toISOString();
  const accepted = await runtime.store.acceptAndEnqueue(delivery, occurredAt);
  if (accepted.acceptance === "stale" || accepted.acceptance === "blocked") return;
  if (accepted.acceptance === "duplicate") {
    await runtime.replayPending(accepted.record);
    if (accepted.record.state !== "accepted") return;
  } else if (accepted.event !== undefined) await runtime.publishEvent(accepted.event);

  if (delivery.epoch !== runtime.store.epoch) {
    await runtime.rejectStale(delivery);
    return;
  }

  const context = delivery.authenticated_context;
  const authorized = isSystemGateProbeBody(delivery.body)
    && delivery.tenant_id === "Steven"
    && delivery.room_id === "grp.steven"
    && delivery.actor_alias === "kant"
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
    const failed = await runtime.store.transitionAndEnqueue(
      delivery.delivery_id,
      "failed",
      runtime.clock.now().toISOString(),
      { error, attempt: delivery.attempt, claimToken: delivery.claim_token },
    );
    await runtime.publishEvent(failed.event);
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
  const done = await runtime.store.transitionAndEnqueue(
    delivery.delivery_id,
    "done",
    runtime.clock.now().toISOString(),
    { output, attempt: delivery.attempt, claimToken: delivery.claim_token },
  );
  await runtime.publishEvent(done.event);
}
