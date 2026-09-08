import type { InboxRecord } from "./durable-store.js";

export interface NoticeScope {
  readonly tenant_id: string;
  readonly alias: string;
  readonly adapter: string;
  readonly channel: string;
  readonly conversation_id: string;
  readonly thread_id?: string;
  readonly reply_to_message_id?: string;
}

export interface NoticeReceipt {
  readonly notification_id: string;
  readonly tenant_id: string;
  readonly alias: string;
  readonly delivery_id: string;
  readonly attempt: number;
  readonly notify_index: number;
  readonly kind: string;
  readonly destination: string;
  readonly adapter: string;
  readonly channel: string;
  readonly conversation_id: string;
  readonly thread_id?: string;
  readonly status: "sent" | "partial" | "pending" | "ambiguous" | "dead" | "denied" | "unconfirmed" | "unknown";
  readonly updated_at: string;
  readonly expected_chunks: number | null;
  readonly sent_chunks: number;
  readonly provider_message_ids: readonly string[];
  readonly effect_ids: readonly string[];
}

export interface EgressReceiptSource {
  read(scope: NoticeScope, deliveryIds: readonly string[], signal: AbortSignal): Promise<readonly NoticeReceipt[]>;
}

export interface ContextNotice {
  readonly delivery_id: string;
  readonly attempt: number;
  readonly notify_index: number;
  readonly destination: string;
  readonly body: string;
  readonly kind: string;
  readonly status: NoticeReceipt["status"];
  readonly updated_at: string;
  readonly provider_message_ids: readonly string[];
  readonly chunks: { readonly expected: number | null; readonly sent: number };
}

export interface NoticeSelection {
  readonly source: "available" | "unavailable";
  readonly selection: "recent" | "exact_reply" | "reply_not_found" | "ambiguous_reply";
  readonly unclassified: number;
  readonly records: readonly ContextNotice[];
}

function receiptStatus(rows: readonly NoticeReceipt[]): NoticeReceipt["status"] {
  const signatures = new Set(rows.map(row => JSON.stringify({
    notification: row.notification_id, status: row.status, expected: row.expected_chunks, sent: row.sent_chunks,
    providers: [...row.provider_message_ids].sort(), effects: [...row.effect_ids].sort(),
  })));
  if (signatures.size !== 1) return "ambiguous";
  const row = rows[0];
  if (row === undefined) return "unknown";
  if (new Set(row.provider_message_ids).size !== row.provider_message_ids.length
    || new Set(row.effect_ids).size !== row.effect_ids.length) return "ambiguous";
  if (row.status === "sent") {
    return row.expected_chunks !== null && row.expected_chunks > 0 && row.sent_chunks === row.expected_chunks
      && row.provider_message_ids.length === row.expected_chunks && row.effect_ids.length > 0
      ? "sent" : "ambiguous";
  }
  if ((row.status === "dead" || row.status === "denied") && row.sent_chunks > 0) return "ambiguous";
  return row.status;
}

export function pertinentNotices(
  records: readonly InboxRecord[], scope: NoticeScope, receipts: readonly NoticeReceipt[],
  now = Date.now(), maxAgeMs = 24 * 60 * 60 * 1000,
): NoticeSelection {
  const bindings = new Map<string, Set<string>>();
  const evidenceOwners = new Map<string, Set<string>>();
  for (const row of receipts) {
    if (row.tenant_id !== scope.tenant_id || row.alias !== scope.alias) continue;
    const entries = bindings.get(row.notification_id) ?? new Set<string>();
    entries.add(JSON.stringify([row.delivery_id, row.attempt, row.notify_index, row.destination,
      row.adapter, row.channel, row.conversation_id, row.thread_id, row.kind]));
    bindings.set(row.notification_id, entries);
    const evidence = [...row.effect_ids.map(id => `effect:${id}`),
      ...row.provider_message_ids.map(id => JSON.stringify([row.adapter, row.channel, row.conversation_id, row.thread_id, id]))];
    for (const key of evidence) {
      const owners = evidenceOwners.get(key) ?? new Set<string>();
      owners.add(row.notification_id); evidenceOwners.set(key, owners);
    }
  }
  const conflictingEvidence = new Set([...evidenceOwners.values()].filter(owners => owners.size > 1).flatMap(owners => [...owners]));
  const candidates: ContextNotice[] = [];
  let unclassified = 0;
  for (const record of records) {
    if (record.state !== "done" && record.state !== "failed") continue;
    if (record.request !== undefined && (record.request.tenant_id !== scope.tenant_id
      || record.request.recipient_alias !== scope.alias)) continue;
    for (const [index, notify] of (record.output?.notify ?? []).entries()) {
      const rows = receipts.filter(row => row.tenant_id === scope.tenant_id && row.alias === scope.alias
        && row.delivery_id === record.delivery_id && row.attempt === record.attempt
        && row.notify_index === index && row.destination === notify.to && row.kind === notify.kind);
      if (rows.length === 0) { unclassified += 1; continue; }
      const routes = new Set(rows.map(row => JSON.stringify([row.adapter, row.channel, row.conversation_id, row.thread_id])));
      if (routes.size !== 1) { unclassified += 1; continue; }
      const row = rows[0];
      if (row?.adapter !== scope.adapter || row.channel !== scope.channel
        || row.conversation_id !== scope.conversation_id || row.thread_id !== scope.thread_id) continue;
      const timestamp = Math.max(...rows.map(item => Date.parse(item.updated_at)));
      if (!Number.isFinite(timestamp) || timestamp > now) { unclassified += 1; continue; }
      const status = rows.some(item => (bindings.get(item.notification_id)?.size ?? 0) !== 1 || conflictingEvidence.has(item.notification_id))
        ? "ambiguous" : receiptStatus(rows);
      candidates.push({ delivery_id: record.delivery_id, attempt: record.attempt, notify_index: index,
        destination: notify.to, body: notify.body, kind: notify.kind, status,
        chunks: { expected: row.expected_chunks, sent: row.sent_chunks },
        updated_at: new Date(timestamp).toISOString(),
        provider_message_ids: [...new Set(rows.flatMap(receipt => receipt.provider_message_ids))],
      });
    }
  }
  candidates.sort((a, b) => Date.parse(b.updated_at) - Date.parse(a.updated_at)
    || a.delivery_id.localeCompare(b.delivery_id) || a.notify_index - b.notify_index);
  if (scope.reply_to_message_id !== undefined) {
    const exact = candidates.filter(notice => notice.provider_message_ids.includes(scope.reply_to_message_id ?? ""));
    const unique = exact.length === 1 && (exact[0]?.status === "sent" || exact[0]?.status === "partial");
    return { source: "available", unclassified,
      selection: unique ? "exact_reply" : exact.length === 0 ? "reply_not_found" : "ambiguous_reply",
      records: unique ? exact : [],
    };
  }
  return { source: "available", selection: "recent", unclassified,
    records: candidates.filter(notice => now - Date.parse(notice.updated_at) <= maxAgeMs).slice(0, 8),
  };
}
