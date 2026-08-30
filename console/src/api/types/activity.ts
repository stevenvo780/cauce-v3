import type { DeliveryState, JobLane } from './deliveries';

// ---------------------------------------------------------------------------------------------
// GET /v3/console/activity — in-flight fleet activity, aggregated by alias. See
// features/activity for the pure derivation of badges and thresholds, and the reference SQL in
// the contract (fleetActivity()): this view NEVER carries message bodies, `result` or
// `last_error`; that is left to Messages/Chains, which already redact.

export type FleetWorkState = 'idle' | 'queued' | 'working' | 'saturated' | 'stalled';

/** Cumulative and not mutually exclusive: an agent can be saturated AND with stalled ACKs at once. */
export type FleetActivityFlag =
  | 'saturated'
  | 'ack_stalled'
  | 'overdue_acks'
  | 'lease_expired'
  | 'never_connected'
  | 'unregistered'
  | 'queued_without_consumer';

export interface FleetActivityThresholds {
  saturation_in_flight?: number | null;
  stall_after_seconds?: number | null;
  ack_recent_seconds?: number | null;
  ack_lookback_seconds?: number | null;
  items_per_agent?: number | null;
}

/** Subset of PresenceLease relevant to this view; same source (connection_leases). */
interface FleetActivityPresence {
  online?: boolean | null;
  instance_id?: string | null;
  epoch?: number | null;
  last_heartbeat_at?: string | null;
  lease_until?: string | null;
}

export interface FleetActivityItem {
  delivery_id?: string | null;
  message_id?: string | null;
  trace_id?: string | null;
  from_tenant?: string | null;
  from_alias?: string | null;
  lane?: JobLane | null;
  /** Only the origin adapter ('bus', 'telegram'…). Never conversation_id. */
  origin_adapter?: string | null;
  published_at?: string | null;
  status?: DeliveryState | null;
  attempt?: number | null;
  claimed_at?: string | null;
  ack_deadline_at?: string | null;
  seconds_in_flight?: number | null;
  last_ack_at?: string | null;
  last_ack_status?: string | null;
}

export interface FleetActivityAgent {
  tenant_id: string;
  alias: string;
  display_name?: string | null;
  harness_id?: string | null;
  /** false: the alias appeared via deliveries or lease, not via the agent registry. */
  registered?: boolean | null;
  agent_enabled?: boolean | null;
  presence?: FleetActivityPresence | null;
  work_state?: FleetWorkState | null;
  flags?: FleetActivityFlag[] | null;
  in_flight?: number | null;
  started?: number | null;
  claimed_not_started?: number | null;
  queued?: number | null;
  queued_ready?: number | null;
  retrying?: number | null;
  overdue_in_flight?: number | null;
  oldest_claimed_at?: string | null;
  oldest_in_flight_seconds?: number | null;
  nearest_ack_deadline_at?: string | null;
  max_attempt?: number | null;
  last_ack_at?: string | null;
  /**
   * null means "no ACK applied within ack_lookback_seconds" — the MOST severe signal, never
   * "just acked". Do not render as 0; use formatAckAge() from features/activity.
   */
  seconds_since_last_ack?: number | null;
  acks_recent?: number | null;
  in_flight_items_truncated?: boolean | null;
  in_flight_items?: FleetActivityItem[] | null;
  /**
   * Alias rooms. Avoids manually crossing with the topology to know where an agent lives.
   * Optional: today the /activity SQL does not bring it (see the backend phase of the file).
   */
  rooms?: string[] | null;
  /**
   * CLOSED deliveries in the last 24 h. It is the size of the figure on the map.
   *
   * `undefined` (field absent) and `0` are NOT the same and cannot be drawn the same: absent
   * means "the server does not report the 24 h closure" and forces a uniform size plus a legend
   * declaring so; 0 means "closed nothing", which IS data and IS drawn small.
   */
  closed_24h?: number | null;
  failed_24h?: number | null;
}

export interface FleetActivityTotals {
  agents?: number | null;
  /** Mutually exclusive: it adds up to totals.agents. */
  by_state?: Partial<Record<FleetWorkState, number>> | null;
  /** Cumulative: it does NOT add up to totals.agents nor to itself. */
  flagged?: Partial<Record<FleetActivityFlag, number>> | null;
  in_flight?: number | null;
  queued?: number | null;
  retrying?: number | null;
  overdue_in_flight?: number | null;
}

/**
 * Delegation aggregated by pair, as the server would count it over a window.
 *
 * The endpoint the actor cannot see already arrives reduced to an opaque id from the store (same
 * `redacted`/`opaqueNodeId` vocabulary as `agentChain`): the edge is NOT removed, because a map
 * that is missing arrows lies by omission and there is no way to notice it from the screen.
 */
export interface FleetDelegationEdge {
  from_tenant?: string | null;
  from_alias?: string | null;
  to_tenant?: string | null;
  to_alias?: string | null;
  /** Deliveries of that pair in flight NOW. This is what paints the arrow blue. */
  in_flight?: number | null;
  /** Deliveries of that pair over the whole window. This is what gives the thickness. */
  total_window?: number | null;
  last_at?: string | null;
}

export interface FleetActivitySnapshot {
  observed_at?: string | null;
  thresholds?: FleetActivityThresholds | null;
  totals?: FleetActivityTotals | null;
  agents?: FleetActivityAgent[] | null;
  /** Optional: until the backend phase, the thickness comes only from in-flight deliveries. */
  edges?: FleetDelegationEdge[] | null;
}
