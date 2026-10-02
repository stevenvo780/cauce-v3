import { DelegationRejectionSchema, type DelegationRejectionNotice } from "@cauce/protocol";
import type { InboxRecord } from "./contracts.js";

export function terminalDelegationRejections(
  record: InboxRecord,
): readonly DelegationRejectionNotice["code"][] | undefined {
  const messages = record.output?.messages;
  if (messages === undefined) return undefined;
  const rejected = record.delegation_rejections;
  const materialized = record.delegation_materializations;
  if (messages.length === 0) {
    return (rejected?.length ?? 0) === 0 && (materialized?.length ?? 0) === 0 ? [] : undefined;
  }
  if (!Array.isArray(materialized) || materialized.length !== 0
    || !Array.isArray(rejected) || rejected.length !== messages.length) {
    return undefined;
  }
  const indexed = new Map<number, DelegationRejectionNotice["code"]>();
  for (const entry of rejected) {
    const parsed = DelegationRejectionSchema.safeParse(entry);
    if (!parsed.success) return undefined;
    const outcome = parsed.data;
    if (outcome.output_index >= messages.length || indexed.has(outcome.output_index)) {
      return undefined;
    }
    indexed.set(outcome.output_index, outcome.code);
  }
  return messages.map((_, index) => {
    const code = indexed.get(index);
    if (code === undefined) throw new Error("Terminal delegation outcome is incomplete");
    return code;
  });
}
