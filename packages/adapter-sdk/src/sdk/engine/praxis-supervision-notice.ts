import type { DurableStore } from "../durable-store.js";
import type { Clock, Delivery, NotifyKind, StructuredOutput } from "../types.js";
import type { EventPublisher } from "./contracts.js";

export const PRAXIS_SUPERVISION_NOTICE_MESSAGE_TYPE = "praxis.supervision.notice";

interface SupervisionNoticeRuntime {
  readonly store: DurableStore;
  readonly clock: Clock;
  readonly publishEvent: EventPublisher;
  readonly isCurrent: () => boolean;
  readonly ownTenantId: string | undefined;
  readonly ownRoom: string | undefined;
}

interface SupervisionNoticeBody {
  readonly type: typeof PRAXIS_SUPERVISION_NOTICE_MESSAGE_TYPE;
  readonly text: string;
  readonly kind: Exclude<NotifyKind, "task_complete">;
}

function authorizedNotice(
  delivery: Delivery,
  runtime: Pick<SupervisionNoticeRuntime, "ownTenantId" | "ownRoom">,
): SupervisionNoticeBody | undefined {
  const context = delivery.authenticated_context;
  if (runtime.ownTenantId !== "Hospital"
    || (runtime.ownRoom !== undefined && runtime.ownRoom !== "grp.hospital")
    || delivery.tenant_id !== "Hospital" || delivery.room_id !== "grp.hospital"
    || delivery.recipient_alias !== "operador" || delivery.actor_alias !== "praxis-supervisor"
    || context?.session_id !== "praxis-supervisor" || context.channel !== "adapter"
    || context.origin !== undefined || delivery.origin !== undefined) return undefined;
  const body = delivery.body;
  if (body.type !== PRAXIS_SUPERVISION_NOTICE_MESSAGE_TYPE
    || Object.keys(body).some((key) => key !== "type" && key !== "text" && key !== "kind")
    || typeof body.text !== "string" || body.text.trim().length === 0 || body.text.length > 800
    || (body.kind !== "alert" && body.kind !== "decision_request" && body.kind !== "digest")) return undefined;
  return { type: PRAXIS_SUPERVISION_NOTICE_MESSAGE_TYPE, text: body.text, kind: body.kind };
}

function ownsNoticeClaim(delivery: Delivery, runtime: SupervisionNoticeRuntime): boolean {
  if (!runtime.isCurrent()) return false;
  const record = runtime.store.getDelivery(delivery.delivery_id);
  return record?.attempt === delivery.attempt && record.claim_token === delivery.claim_token;
}

export async function runPraxisSupervisionNotice(delivery: Delivery, runtime: SupervisionNoticeRuntime): Promise<void> {
  const accepted = await runtime.store.acceptAndEnqueue(delivery, runtime.clock.now().toISOString());
  if (accepted.acceptance === "stale" || accepted.acceptance === "blocked"
    || !ownsNoticeClaim(delivery, runtime)) return;
  if (accepted.acceptance === "duplicate") {
    for (const event of runtime.store.pendingEventsFor(accepted.record)) {
      if (!ownsNoticeClaim(delivery, runtime)) return;
      await runtime.publishEvent(event);
    }
    if (accepted.record.state !== "accepted") return;
  } else if (accepted.event !== undefined) await runtime.publishEvent(accepted.event);
  if (!ownsNoticeClaim(delivery, runtime)) return;
  const notice = authorizedNotice(delivery, runtime);
  const output: StructuredOutput | undefined = notice === undefined ? undefined : {
    reply: "Aviso de supervisión registrado.",
    messages: [], notify: [{ to: "steven_dm", kind: notice.kind, body: notice.text }],
    status: "done", retryable: false, artifacts: [],
  };
  const terminal = await runtime.store.transitionAndEnqueueIfCurrent(
    delivery.delivery_id, notice === undefined ? "failed" : "done", runtime.clock.now().toISOString(), {
      ...(output === undefined ? {
        error: {
          code: "UNAUTHORIZED_SUPERVISION_NOTICE",
          message: "Reserved supervision notice authority or payload is invalid",
          retryable: false,
        },
      } : { output }),
      attempt: delivery.attempt, claimToken: delivery.claim_token, expectedEpoch: delivery.epoch,
      isCurrent: runtime.isCurrent,
    },
  );
  if (terminal !== undefined && ownsNoticeClaim(delivery, runtime)) await runtime.publishEvent(terminal.event);
}
