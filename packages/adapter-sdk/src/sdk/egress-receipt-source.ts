import { objectRecord } from "@cauce/protocol";
import type { EmissionGateway } from "./mcp-emission/tools.js";
import type { EgressReceiptSource, NoticeReceipt, NoticeScope } from "./notify-history.js";

const states = new Set(["sent", "partial", "pending", "ambiguous", "dead", "denied", "unconfirmed", "unknown"]);
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
type Identity = Pick<NoticeScope, "tenant_id" | "alias">;
function text(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
function ids(value: unknown): value is string[] {
  return Array.isArray(value) && value.length <= 512 && value.every(text);
}

function decodeReceipt(value: unknown, identity: Identity, requested: readonly string[]): NoticeReceipt | undefined {
  const row = objectRecord(value);
  const destination = objectRecord(row?.destination);
  const chunks = objectRecord(row?.chunks);
  if (row === undefined || chunks === undefined
    || ![row.notification_id, row.source_delivery_id, row.kind, row.created_at].every(text)
    || !integer(row.source_attempt) || row.source_attempt < 1 || !integer(row.notify_index)
    || (chunks.expected !== null && !integer(chunks.expected)) || !integer(chunks.sent)
    || typeof row.state !== "string" || !states.has(row.state)
    || !ids(row.effect_ids) || (row.provider_message_ids !== undefined && !ids(row.provider_message_ids))
    || (row.provider_message_id !== undefined && !text(row.provider_message_id))
    || (row.sent_at !== undefined && !text(row.sent_at))
    || !requested.includes(String(row.source_delivery_id))) throw new Error("Invalid agent egress item");
  if (destination === undefined || ![destination.handle, destination.adapter, destination.channel,
    destination.conversation_id].every(text)) return undefined;
  const providerIds = row.provider_message_ids
    ?? (row.state === "sent" && typeof row.provider_message_id === "string" ? [row.provider_message_id] : []);
  if (row.provider_message_id !== undefined && !providerIds.includes(row.provider_message_id)) {
    throw new Error("Inconsistent agent egress provider id");
  }
  return { ...identity, notification_id: String(row.notification_id), delivery_id: String(row.source_delivery_id),
    attempt: row.source_attempt, notify_index: row.notify_index, kind: String(row.kind),
    destination: String(destination.handle), adapter: String(destination.adapter), channel: String(destination.channel),
    conversation_id: String(destination.conversation_id), status: row.state as NoticeReceipt["status"],
    updated_at: String(row.sent_at ?? row.created_at), expected_chunks: chunks.expected,
    sent_chunks: chunks.sent, provider_message_ids: providerIds, effect_ids: row.effect_ids,
  };
}

/** Reads the authenticated agent endpoint into the SDK's selection projection. */
export class HttpEgressReceiptSource implements EgressReceiptSource {
  constructor(private readonly gateway: EmissionGateway, private readonly identity: Identity) {}

  async read(scope: NoticeScope, deliveryIds: readonly string[], signal: AbortSignal): Promise<readonly NoticeReceipt[]> {
    if (scope.tenant_id !== this.identity.tenant_id || scope.alias !== this.identity.alias) {
      throw new Error("Egress reader identity mismatch");
    }
    const requested = [...new Set(deliveryIds)];
    if (requested.some(id => !uuid.test(id))) throw new Error("Egress delivery ids must be UUIDs");
    const receipts: NoticeReceipt[] = [];
    const lookupSignal = AbortSignal.any([signal, AbortSignal.timeout(1500)]);
    for (let offset = 0; offset < requested.length; offset += 20) {
      lookupSignal.throwIfAborted();
      const batch = requested.slice(offset, offset + 20);
      const query = new URLSearchParams({ delivery_ids: batch.join(",") });
      const value = objectRecord(await this.gateway("GET", `/v3/agent/egress?${query.toString()}`,
        undefined, { signal: lookupSignal, timeoutMs: 1500 }));
      if (value === undefined || !Array.isArray(value.items) || value.items.length > 512) {
        throw new Error("Invalid agent egress response");
      }
      for (const row of value.items as unknown[]) {
        const receipt = decodeReceipt(row, this.identity, batch);
        if (receipt !== undefined) receipts.push(receipt);
      }
    }
    return receipts;
  }
}
