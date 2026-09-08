import { objectRecord } from "@cauce/protocol";
import type { Delivery } from "./types.js";
import type { DurableStore } from "./durable-store.js";
import { pertinentNotices, type EgressReceiptSource, type NoticeSelection } from "./notify-history.js";

export async function noticeHistoryFor(
  delivery: Delivery, store: DurableStore, source: EgressReceiptSource | undefined,
  tenant: string | undefined, signal: AbortSignal, now: number,
): Promise<NoticeSelection | undefined> {
  const origin = delivery.authenticated_context?.origin;
  if (source === undefined || tenant === undefined || origin === undefined
    || delivery.body.type === "agent.message" || delivery.body.type === "agent.response"
    || delivery.body.type === "agent.fanin") return undefined;
  const reply = objectRecord(origin.metadata.reply_to);
  const records = store.notificationHistory();
  try {
    const scope = { tenant_id: tenant, alias: delivery.recipient_alias, adapter: origin.adapter,
      channel: origin.channel, conversation_id: origin.conversation_id,
      ...(typeof reply?.message_id === "string" ? { reply_to_message_id: reply.message_id } : {}),
      ...(typeof origin.metadata.thread_id === "string" ? { thread_id: origin.metadata.thread_id } : {}),
    };
    const receipts = await source.read(scope, records.map(record => record.delivery_id), signal);
    return pertinentNotices(records, scope, receipts, now);
  } catch {
    return { source: "unavailable", selection: "recent", records: [],
      unclassified: records.reduce((count, record) => count + (record.output?.notify.length ?? 0), 0) };
  }
}
