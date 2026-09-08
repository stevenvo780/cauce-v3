import type { InboxRecord } from "../src/sdk/durable-store.js";
import type { NoticeReceipt, NoticeScope } from "../src/sdk/notify-history.js";

export const now = Date.UTC(2026, 8, 8, 21);
export const scope: NoticeScope = { tenant_id: "Steven", alias: "argos", adapter: "telegram",
  channel: "telegram", conversation_id: "6979524541" };
export const incidentId = "c137560e-ca62-46b2-89bb-b59947953547";
export function record(id = incidentId, body = "Generated without human origin"): InboxRecord {
  return { delivery_id: id, fingerprint: "0".repeat(64), epoch: 1, attempt: 1,
    claim_token: "claim", state: "done", origin: undefined, updated_at: new Date(now).toISOString(),
    output: { reply: null, messages: [], notify: [{ to: "steven_dm", kind: "alert", body }],
      artifacts: [], status: "done", retryable: false } };
}
export function receipt(overrides: Partial<NoticeReceipt> = {}): NoticeReceipt {
  return { ...scope, notification_id: `notice:${overrides.delivery_id ?? incidentId}:${String(overrides.notify_index ?? 0)}`,
    delivery_id: incidentId, attempt: 1, notify_index: 0, kind: "alert", destination: "steven_dm",
    status: "sent", updated_at: new Date(now - 1000).toISOString(), expected_chunks: 1, sent_chunks: 1,
    provider_message_ids: ["2703"], effect_ids: ["effect-1"], ...overrides };
}
export function wireReceipt(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { notification_id: "notice-1", source_delivery_id: incidentId, source_attempt: 1, notify_index: 0,
    kind: "alert", destination: { adapter: "telegram", channel: "telegram", conversation_id: "6979524541", handle: "steven_dm" },
    decision: "allow", denial_code: null, state: "sent", chunks: { expected: 1, sent: 1 },
    provider_message_ids: ["2703"], provider_message_id: "2703", sent_at: new Date(now - 1000).toISOString(),
    outbox_id: "outbox-1", effect_ids: ["effect-1"], created_at: new Date(now - 2000).toISOString(), ...overrides };
}
