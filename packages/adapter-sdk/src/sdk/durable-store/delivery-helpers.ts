import { createHash, randomUUID } from "node:crypto"; /* eslint @typescript-eslint/no-unnecessary-condition: "error" */
import type { Delivery, DeliveryEvent } from "../types.js";
import type {
  InboxRecord,
  InboxState,
  LifecycleEventSlot,
} from "./contracts.js";

export function lifecycleSlot(event: DeliveryEvent): LifecycleEventSlot | undefined {
  if (event.execution_started === true) return "execution_started";
  if (event.claim_renewal === true) return undefined;
  if (event.phase === "accepted") return "accepted";
  if (event.phase === "started") return "started"; // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Outbox JSON is loaded without runtime validation.
  if (event.phase === "done" || event.phase === "failed") return "terminal";
  return undefined;
}

export function lifecycleEventFor(
  record: InboxRecord,
  phase: InboxState,
  occurredAt: string,
  epoch = record.epoch,
): DeliveryEvent {
  return {
    event_id: randomUUID(),
    delivery_id: record.delivery_id,
    attempt: record.attempt,
    claim_token: record.claim_token,
    epoch,
    phase,
    occurred_at: occurredAt,
    ...(record.origin === undefined ? {} : { origin: record.origin }),
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(record.profile_adoption === undefined ? {} : { profile_adoption: record.profile_adoption }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

export function withLifecycleEvent(record: InboxRecord, event: DeliveryEvent): InboxRecord {
  const slot = lifecycleSlot(event);
  if (slot === undefined || record.lifecycle_event_ids?.[slot] !== undefined) return record;
  return {
    ...record,
    lifecycle_event_ids: {
      ...record.lifecycle_event_ids,
      [slot]: event.event_id,
    },
  };
}

export function deliveryFingerprint(delivery: Delivery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        delivery_id: delivery.delivery_id,
        message_id: delivery.message_id,
        request_id: delivery.request_id,
        trace_id: delivery.trace_id,
        tenant_id: delivery.tenant_id,
        room_id: delivery.room_id,
        actor_alias: delivery.actor_alias,
        recipient_alias: delivery.recipient_alias,
        origin: delivery.origin,
        authenticated_context: delivery.authenticated_context,
        body: delivery.body,
      }),
    )
    .digest("hex");
}

export function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

export function visibleText(value: unknown): value is string {
  return typeof value === "string" && /[\p{L}\p{N}\p{P}\p{S}]/u.test(value);
}
