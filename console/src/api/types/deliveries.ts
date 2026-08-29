import type { CapabilityState } from './system';

export type DeliveryState =
  | 'pending'
  | 'leased'
  | 'accepted'
  | 'started'
  | 'done'
  | 'failed'
  | 'retry'
  | 'dead';

export type JobLane = 'interactive' | 'batch';

export interface TimelineEvent {
  status: 'published' | Extract<DeliveryState, 'accepted' | 'started' | 'done' | 'failed'>;
  at?: string | null;
  attempt?: number | null;
  detail?: string | null;
}

export interface DeliveryView {
  delivery_id?: string | null;
  recipient_tenant?: string | null;
  recipient_alias?: string | null;
  status?: DeliveryState | null;
  attempt?: number | null;
  timeline?: TimelineEvent[] | null;
}

export interface MessageView {
  message_id?: string | null;
  request_id?: string | null;
  trace_id?: string | null;
  tenant_id?: string | null;
  room_id?: string | null;
  actor_alias?: string | null;
  body_preview?: string | null;
  lane?: JobLane | null;
  created_at?: string | null;
  deliveries?: DeliveryView[] | null;
}

/**
 * `GET /v3/console/messages/:messageId` — the whole message, body UNTRUNCATED. `body` is `jsonb`
 * whose shape depends on the publisher, so it stays `unknown`: it is interpreted, with its
 * unknown-shape case, in `features/terminal/cuerpo-del-mensaje.ts`.
 */
export interface MessageDetail {
  id?: string | null;
  message_id?: string | null;
  trace_id?: string | null;
  tenant_id?: string | null;
  room_id?: string | null;
  actor_alias?: string | null;
  body?: unknown;
  lane?: JobLane | null;
  created_at?: string | null;
}

export interface MessagePage {
  items?: MessageView[] | null;
  next_cursor?: string | null;
}

export interface PublishMessageInput {
  room_id: string;
  recipients: { tenant_id: string; alias: string }[];
  body: { text: string };
  lane: JobLane;
  priority: number;
  idempotency_key: string;
}

export type PublishIntentSemantics = Omit<PublishMessageInput, 'idempotency_key'>;

export interface PreparePublishIntentInput extends PublishIntentSemantics {
  /** Ephemeral UUIDv4 per deliberate submit; never persisted in the browser. */
  intent_nonce: string;
}

export interface PublishResult {
  message_id?: string | null;
  delivery_ids?: string[] | null;
  duplicate?: boolean | null;
  request_id?: string | null;
  trace_id?: string | null;
  idempotency_key?: string | null;
  tenant_id?: string | null;
  actor_alias?: string | null;
  request_hash?: string | null;
  causal_hash?: string | null;
}

export interface DurablePublishReceipt {
  message_id: string;
  delivery_ids: string[];
  duplicate: boolean;
  request_id: string;
  trace_id: string;
  idempotency_key: string;
  tenant_id: string;
  actor_alias: string;
  request_hash: string;
  causal_hash: string;
}

export interface PreparePublishIntentResult {
  version: 1;
  state: 'prepared' | 'committed';
  idempotency_key: string;
  receipt: PublishResult | null;
}

export interface PreparePublishIntentReconciliation {
  version: 1;
  error: 'publish_intent_reconciliation_required';
  state: 'committed';
  idempotency_key: string;
  receipt: PublishResult;
}

/** The server proved that this reservation closed before any publish effect existed. */
export interface PublishIntentExpired {
  version: 1;
  error: 'publish_intent_expired';
  state: 'expired';
  idempotency_key: string;
  safe_to_resubmit: true;
}

/** A bounded server-side journal admission limit; the same nonce retry remains idempotent. */
export interface PreparePublishIntentRateLimited {
  version: 1;
  error: 'publish_intent_rate_limited';
  retry_after_seconds: number;
  safe_to_retry: true;
}

export interface ConfirmPublishIntentInput {
  idempotency_key: string;
  message_id: string;
  causal_hash: string;
}

export interface ConfirmPublishIntentResult extends ConfirmPublishIntentInput {
  version: 1;
  confirmed: true;
}

export interface QueueItem {
  delivery_id?: string | null;
  message_id?: string | null;
  tenant_id?: string | null;
  recipient_alias?: string | null;
  lane?: JobLane | null;
  state?: DeliveryState | null;
  attempts?: number | null;
  max_attempts?: number | null;
  available_at?: string | null;
  last_error?: string | null;
}

/** `COUNT` over EVERY visible delivery, no `LIMIT`; absent on a gateway older than the field. */
export interface QueueTotals {
  pending?: number | null;
  retrying?: number | null;
  dead?: number | null;
}

export interface QueueSnapshot {
  observed_at?: string | null;
  /** Counted over the rows of THIS page only; `totals` counts the queue. */
  pending?: number | null;
  retrying?: number | null;
  dead?: number | null;
  totals?: QueueTotals | null;
  /** `true` when the server's `LIMIT` left visible deliveries out of `items`. */
  muestra_recortada?: boolean | null;
  items?: QueueItem[] | null;
}

export interface ReplayResult {
  delivery_id?: string | null;
  replayed_from_delivery_id?: string | null;
  state?: DeliveryState | null;
  replayed?: boolean | null;
}

export interface CancelResult {
  delivery_id?: string | null;
  state?: DeliveryState | null;
  cancelled?: boolean | null;
  cancelled_from_state?: DeliveryState | null;
  parent_notice?: 'not_child' | 'returned' | 'denied' | 'deferred' | 'coalesced' | null;
  origin_relayed?: boolean | null;
  /** Always true: cancel leaves the row in `dead_letters`, so it is still replayable. */
  replayable?: boolean | null;
}

export interface AdapterView {
  id?: string | null;
  label?: string | null;
  state?: CapabilityState | null;
  capabilities?: string[] | null;
  protocol_version?: string | null;
  last_seen_at?: string | null;
  detail?: string | null;
}

export interface AdapterPage {
  items?: AdapterView[] | null;
}

export interface AuditEvent {
  event_id?: string | null;
  at?: string | null;
  tenant_id?: string | null;
  actor_alias?: string | null;
  action?: string | null;
  decision?: 'allow' | 'deny' | 'info' | null;
  request_id?: string | null;
  trace_id?: string | null;
  summary?: string | null;
}

export interface AuditPage {
  items?: AuditEvent[] | null;
  next_cursor?: string | null;
}

export type OriginRelayState = 'pending' | 'processing' | 'sent' | 'failed';

export interface OriginRelayView {
  id?: string | null;
  tenant_id?: string | null;
  adapter?: string | null;
  request_id?: string | null;
  message_id?: string | null;
  delivery_id?: string | null;
  trace_id?: string | null;
  status?: OriginRelayState | null;
  attempts?: number | null;
  created_at?: string | null;
  sent_at?: string | null;
}

export interface OriginRelayPage {
  items?: OriginRelayView[] | null;
}
