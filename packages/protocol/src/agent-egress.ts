import { z } from 'zod';
import { DeliveryIdSchema } from './schemas/core.js';

/** Upper bound of delivery ids one agent may ask about in a single call. */
export const AGENT_EGRESS_MAX_DELIVERY_IDS = 20;

/**
 * Delivery state of one notification as the receipt source reports it.
 * - `sent`: every chunk of the produced outbox has a provider receipt.
 * - `partial`: some chunks have a receipt, others do not yet.
 * - `pending`: the outbox exists but no chunk has a receipt yet.
 * - `ambiguous`: the bridge could not tell whether the provider accepted a chunk.
 * - `dead`: the outbox or a chunk was given up.
 * - `denied`: the notification was refused before any outbox existed (`denial_code`).
 * - `unconfirmed`: the outbox claims sent but no per-chunk receipt exists.
 * - `unknown`: allowed but nothing was produced; nothing to confirm.
 */
export type AgentEgressState =
  | 'sent' | 'partial' | 'pending' | 'ambiguous' | 'dead' | 'denied' | 'unconfirmed' | 'unknown';

export interface AgentEgressDestination {
  readonly adapter: string;
  readonly channel: string;
  readonly conversation_id: string | null;
  readonly handle: string;
}

export interface AgentEgressItem {
  /** Stable reference of the notification row. */
  readonly notification_id: string;
  readonly source_delivery_id: string;
  readonly source_attempt: number;
  readonly notify_index: number;
  readonly kind: string;
  readonly destination: AgentEgressDestination;
  readonly decision: 'allowed' | 'denied';
  readonly denial_code: string | null;
  readonly state: AgentEgressState;
  /** Chunks of the produced outbox: `expected` is null until the bridge declared it. */
  readonly chunks: { readonly expected: number | null; readonly sent: number };
  /** Provider ids per chunk, in chunk order; present only when at least one chunk was sent. */
  readonly provider_message_ids?: readonly string[];
  /** Receipt of the first chunk; present only when every chunk was sent. */
  readonly provider_message_id?: string;
  /** Last chunk receipt time; present only when at least one chunk was sent. */
  readonly sent_at?: string;
  readonly outbox_id: string | null;
  readonly effect_ids: readonly string[];
  readonly created_at: string;
}

export interface AgentEgressResponse {
  readonly requested: readonly string[];
  readonly items: readonly AgentEgressItem[];
}

const DeliveryIdList = z.array(DeliveryIdSchema).min(1).max(AGENT_EGRESS_MAX_DELIVERY_IDS);

/**
 * Parses `?delivery_ids=<uuid>,<uuid>` (repeatable). Rejects any authority field so scope can only
 * come from the authenticated identity. Returns unique ids in request order.
 */
export function parseAgentEgressQuery(query: unknown): readonly string[] {
  if (query === null || typeof query !== 'object' || Array.isArray(query)) {
    throw new AgentEgressQueryError('query must be an object');
  }
  const record = query as Record<string, unknown>;
  for (const forbidden of ['tenant_id', 'alias', 'actor_alias', 'tenant']) {
    if (forbidden in record) throw new AgentEgressQueryError(`${forbidden} is derived from identity`);
  }
  const raw = record.delivery_ids;
  const parts = (Array.isArray(raw) ? raw : [raw])
    .flatMap((value) => (typeof value === 'string' ? value.split(',') : []))
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  const parsed = DeliveryIdList.safeParse(parts);
  if (!parsed.success) {
    throw new AgentEgressQueryError(
      `delivery_ids must be 1..${String(AGENT_EGRESS_MAX_DELIVERY_IDS)} RFC uuids`);
  }
  return Array.from(new Set(parsed.data));
}

export class AgentEgressQueryError extends Error {
  readonly code = 'invalid_input';
  constructor(message: string) { super(message); this.name = 'AgentEgressQueryError'; }
}
