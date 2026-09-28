import { z } from 'zod';
import { DeliveryIdSchema } from './schemas/core.js';

/** Upper bound of delivery ids one agent may ask about in a single call. */
export const AGENT_EGRESS_MAX_DELIVERY_IDS = 20;

/** Receipt state. Only `sent` (every chunk has a provider receipt) confirms reception. */
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
  readonly provider_message_ids?: readonly string[];
  readonly provider_message_id?: string;
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

/** Parses `?delivery_ids=` (repeatable), rejecting authority fields; scope comes from identity. */
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
