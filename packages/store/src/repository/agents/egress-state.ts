import type { AgentEgressItem, AgentEgressState } from '@cauce/protocol';

/** One row of the egress receipt query: notification + outbox + aggregated telegram effects. */
export interface AgentEgressRow {
  readonly notification_id: string;
  readonly source_delivery_id: string;
  readonly source_attempt: number;
  readonly notify_index: number;
  readonly handle: string;
  readonly kind: string;
  readonly adapter: string;
  readonly conversation_id: string | null;
  readonly decision: string;
  readonly denial_code: string | null;
  readonly produced_outbox_id: string | null;
  readonly created_at: string | Date;
  readonly outbox_status: string | null;
  readonly chunk_count: number | string | null;
  readonly chunks_seen: number | string | null;
  readonly chunks_sent: number | string | null;
  readonly states: readonly string[] | null;
  readonly provider_message_ids: readonly (string | null)[] | null;
  readonly effect_ids: readonly string[] | null;
  readonly last_sent_at: string | Date | null;
}

function count(value: number | string | null | undefined): number {
  const parsed = typeof value === 'string' ? Number(value) : value ?? 0;
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : 0;
}

function iso(value: string | Date | null | undefined): string | undefined {
  if (value === null || value === undefined) return undefined;
  return value instanceof Date ? value.toISOString() : value;
}

/**
 * Derives the explicit receipt state. Only a per-chunk `sent` effect from the bridge confirms
 * reception; the outbox status alone never does. A single sent chunk of a multi-chunk send is
 * `partial`, never `sent`.
 */
export function deriveAgentEgressState(row: AgentEgressRow): AgentEgressState {
  if (row.decision === 'denied') return 'denied';
  if (row.produced_outbox_id === null || row.outbox_status === null) return 'unknown';
  const states = row.states ?? [];
  if (row.outbox_status === 'failed' || states.includes('dead')) return 'dead';
  if (states.includes('ambiguous')) return 'ambiguous';
  const sent = count(row.chunks_sent);
  const expected = row.chunk_count === null ? null : count(row.chunk_count);
  if (states.length === 0) return row.outbox_status === 'sent' ? 'unconfirmed' : 'pending';
  if (sent === 0) return 'pending';
  if (expected !== null && sent >= expected && sent >= count(row.chunks_seen)) return 'sent';
  return 'partial';
}

export function toAgentEgressItem(row: AgentEgressRow): AgentEgressItem {
  const state = deriveAgentEgressState(row);
  const sent = count(row.chunks_sent);
  const providerIds = (row.provider_message_ids ?? []).filter((id): id is string => typeof id === 'string');
  const sentAt = iso(row.last_sent_at);
  return {
    notification_id: row.notification_id,
    source_delivery_id: row.source_delivery_id,
    source_attempt: row.source_attempt,
    notify_index: row.notify_index,
    kind: row.kind,
    destination: {
      adapter: row.adapter, channel: row.adapter, conversation_id: row.conversation_id, handle: row.handle,
    },
    decision: row.decision === 'denied' ? 'denied' : 'allowed',
    denial_code: row.denial_code,
    state,
    chunks: { expected: row.chunk_count === null ? null : count(row.chunk_count), sent },
    ...(sent > 0 && providerIds.length > 0 ? { provider_message_ids: providerIds } : {}),
    ...(state === 'sent' && providerIds[0] !== undefined ? { provider_message_id: providerIds[0] } : {}),
    ...(sent > 0 && sentAt !== undefined ? { sent_at: sentAt } : {}),
    outbox_id: row.produced_outbox_id,
    effect_ids: row.effect_ids ?? [],
    created_at: iso(row.created_at) ?? '',
  };
}
