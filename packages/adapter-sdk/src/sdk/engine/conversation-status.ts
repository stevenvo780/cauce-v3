import { ConversationWorkStateSchema, OriginSchema } from "@cauce/protocol";
import type { InboxRecord, DurableStore } from "../durable-store.js";
import type { Clock, Delivery, StructuredOutput } from "../types.js";
import type { EventPublisher } from "./contracts.js";

const STATUS_QUERIES = new Set([
  "como vas", "como vamos", "como va", "como van", "como va el trabajo",
  "como va todo", "que avance hay", "que avances hay", "estado del trabajo",
  "cual es el estado del trabajo", "en que estado esta el trabajo", "/estado", "cuanto falta",
]);

export function isConversationStatusRequest(
  delivery: Delivery,
  ownTenantId?: string,
  ownRoom?: string,
): boolean {
  if (delivery.body.type !== "telegram.message"
    || (ownTenantId !== undefined && delivery.tenant_id !== ownTenantId)
    || (ownRoom !== undefined && delivery.room_id !== ownRoom)) return false;
  const context = delivery.authenticated_context;
  if (context?.channel !== "telegram" || context.session_id.trim().length === 0
    || /^(?:delivery|fanin):/u.test(context.session_id)) return false;
  const authenticated = OriginSchema.safeParse(context.origin);
  const declared = OriginSchema.safeParse(delivery.origin);
  if (!authenticated.success || !declared.success) return false;
  const origin = authenticated.data;
  if (origin.adapter !== "telegram" || origin.channel !== "telegram"
    || origin.relay.length !== 0 || declared.data.relay.length !== 0
    || declared.data.adapter !== origin.adapter || declared.data.channel !== origin.channel
    || declared.data.conversation_id !== origin.conversation_id
    || declared.data.external_message_id !== origin.external_message_id) return false;
  if (["attachments_v1", "media", "secrets_v1", "voice_v1", "attachment_errors"]
    .some((key) => delivery.body[key] !== undefined)) return false;
  if (typeof delivery.body.caption === "string" && delivery.body.caption.trim().length > 0) return false;
  const text = delivery.body.text;
  if (typeof text !== "string" || text.length > 128) return false;
  const normalized = text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase()
    .trim().replace(/^[¿¡!?.,;:\s]+|[¿¡!?.,;:\s]+$/gu, "").replace(/\s+/gu, " ");
  return normalized.split(/(?:[¿¡!?.,;:]+\s*(?:y\b\s*)?)+|\s+y\s+/u)
    .every((clause) => STATUS_QUERIES.has(clause.trim()));
}

export function conversationStatusOutput(delivery: Delivery): StructuredOutput {
  const parsed = ConversationWorkStateSchema.safeParse(delivery.conversation_work_state);
  let reply = "No tengo un estado durable del trabajo disponible para esta conversación. "
    + "No puedo confirmar avances ni integración.";
  if (parsed.success && parsed.data.branches.length > 0) {
    const state = parsed.data;
    const count = (statuses: readonly string[]) => state.branches.filter(
      (branch) => statuses.includes(branch.status),
    ).length;
    const timestamp = new Date(state.as_of).toISOString();
    const executing = count(["started"]);
    const closed = count(["done"]);
    const failed = count(["failed", "dead"]);
    reply = `Hay ${String(executing)} ${executing === 1 ? "tarea" : "tareas"} en ejecución y `
      + `${String(count(["pending", "leased", "accepted", "retry"]))} en cola; `
      + `${String(closed)} ${closed === 1 ? "turno cerrado" : "turnos cerrados"} y `
      + `${String(failed)} ${failed === 1 ? "fallido" : "fallidos"}. `
      + `Registro del ${timestamp.slice(0, 10)} a las ${timestamp.slice(11, 19)} UTC. `
      + (state.has_more ? "El registro es parcial. " : "")
      + "Los turnos cerrados no acreditan que la app esté integrada. No tengo un resumen propio verificado.";
  }
  reply += " No tengo una estimación de tiempo verificada.";
  return { reply, messages: [], notify: [], status: "done", retryable: false, artifacts: [] };
}

interface ConversationStatusRuntime {
  readonly store: DurableStore;
  readonly clock: Clock;
  readonly publishEvent: EventPublisher;
  readonly isCurrent: () => boolean;
}

function ownsStatusClaim(delivery: Delivery, runtime: ConversationStatusRuntime): boolean {
  if (!runtime.isCurrent()) return false;
  const record = runtime.store.getDelivery(delivery.delivery_id);
  return record?.attempt === delivery.attempt && record.claim_token === delivery.claim_token;
}

async function replayStatus(record: InboxRecord, delivery: Delivery, runtime: ConversationStatusRuntime) {
  for (const event of runtime.store.pendingEventsFor(record)) {
    if (!ownsStatusClaim(delivery, runtime)) return;
    await runtime.publishEvent(event);
  }
}

export async function runConversationStatus(delivery: Delivery, runtime: ConversationStatusRuntime): Promise<void> {
  const accepted = await runtime.store.acceptAndEnqueue(delivery, runtime.clock.now().toISOString());
  if (accepted.acceptance === "stale" || accepted.acceptance === "blocked"
    || !ownsStatusClaim(delivery, runtime)) return;
  if (accepted.acceptance === "duplicate") {
    await replayStatus(accepted.record, delivery, runtime);
    if (accepted.record.state !== "accepted") return;
  } else if (accepted.event !== undefined) await runtime.publishEvent(accepted.event);
  if (!ownsStatusClaim(delivery, runtime)) return;
  const done = await runtime.store.transitionAndEnqueueIfCurrent(
    delivery.delivery_id, "done", runtime.clock.now().toISOString(),
    {
      output: conversationStatusOutput(delivery), attempt: delivery.attempt, claimToken: delivery.claim_token,
      expectedEpoch: delivery.epoch, isCurrent: runtime.isCurrent,
    },
  );
  if (done !== undefined && ownsStatusClaim(delivery, runtime)) await runtime.publishEvent(done.event);
}
