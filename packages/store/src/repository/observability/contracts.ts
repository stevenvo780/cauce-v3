import type { DeliveryState, Lane, Origin, Tenant } from '@cauce/protocol';
import { DISABLED_DELEGATION_CAPS, type DelegationCaps } from '../../delegation-guard.js';

export interface DeliveryRow {
  id: string;
  message_id: string;
  recipient_tenant: Tenant;
  recipient_alias: string;
  status: DeliveryState;
  attempt: number;
  max_attempts: number;
  last_ack_rank: number;
  request_id: string;
  trace_id: string;
  tenant_id: Tenant;
  room_id: string;
  actor_alias: string;
  body: Record<string, unknown>;
  lane: Lane;
  priority: number;
  origin: Origin | null;
  auth_session_id: string | null;
  auth_channel: string | null;
  consumer_instance_id: string | null;
  consumer_epoch: string | null;
  claim_token: string | null;
  ack_deadline_at: Date | null;
}

/** What happened with the notice to the origin when a late result was rescued. */
export type LateRelayDisposition = 'skipped' | 'inserted' | 'rewritten' | 'corrected';

/** Privacy-bounded operational DLQ row.  No message, delivery, outbox or provider id is exposed. */
export interface OperationalDlqItem {
  readonly target: 'delivery' | 'outbox';
  readonly id: string;
  readonly tenantId: Tenant;
  readonly kind: string;
  readonly adapter: string | null;
  readonly disposition: 'ambiguous' | 'safe_retry' | 'missing_final' | 'auth'
    | 'expected_offline' | 'unclassified';
  readonly open: boolean;
  readonly actionable: boolean;
  readonly evidenceSha256: string | null;
  readonly attempts: number;
  readonly resolutionRule: string | null;
  readonly createdAt: string;
  readonly dispositionAt: string | null;
  readonly resolvedAt: string | null;
  readonly reopenCount: number;
  readonly lastReopenedAt: string | null;
}

/** One deterministic keyset page.  `nextCursor` is opaque and bound to the actor scope in SQL. */
export interface OperationalDlqPage {
  readonly schemaVersion: 1;
  readonly items: OperationalDlqItem[];
  readonly total: number;
  readonly truncated: boolean;
  readonly nextCursor: string | null;
}

export interface OperationalDlqResolutionRequest {
  readonly target: 'delivery' | 'outbox';
  readonly id: string;
  readonly evidenceSha256: string;
  readonly reason: string;
  readonly possibleDuplicateAcknowledged: boolean;
  readonly possibleNoDeliveryAcknowledged: boolean;
}

export interface OperationalDlqResolutionResult {
  readonly schemaVersion: 1;
  readonly suite: 'cauce-v3-dlq-no-replay-resolution';
  readonly phase: 'resolved';
  readonly appliedCount: number;
  readonly alreadyApplied: boolean;
  readonly evidenceSha256: string;
  readonly reasonSha256: string;
  readonly possibleDuplicateAcknowledged: boolean;
  readonly possibleNoDeliveryAcknowledged: boolean;
}

export interface ChainPolicy {
  progressRelayEnabled: boolean;
  progressRelayMaxEvents: number;
  cycleCutEnabled: boolean;
  /** False until migration 008 lands, which keeps ACKs working during a partial deploy. */
  visitedPathAvailable: boolean;
  failureCoalesceEnabled: boolean;
  failureCoalesceWindowSeconds: number;
  /** False until migration 014 lands; same partial-deploy contract as visitedPathAvailable. */
  failureCoalesceAvailable: boolean;
  /** Caps for delegation discipline (019). `enabled:false` = behavior prior to 019. */
  delegationCaps: DelegationCaps;
  /** False until migration 019 lands; same partial-deploy contract as visitedPathAvailable. */
  delegationCapsAvailable: boolean;
  humanGateEnabled: boolean;
  /** False until migration 019 lands: without the table there are no gates and `@human` becomes unroutable again. */
  humanGateAvailable: boolean;
}

export const disabledChainPolicy: ChainPolicy = {
  progressRelayEnabled: false,
  progressRelayMaxEvents: 0,
  cycleCutEnabled: false,
  visitedPathAvailable: false,
  failureCoalesceEnabled: false,
  failureCoalesceWindowSeconds: 0,
  failureCoalesceAvailable: false,
  delegationCaps: DISABLED_DELEGATION_CAPS,
  delegationCapsAvailable: false,
  humanGateEnabled: false,
  humanGateAvailable: false
};

/**
 * 'coalesced' is a LEGITIMATE return, not an error: the failure was recorded and the parent had
 * already been notified of the same cause within the window. It is distinguished from 'not_child'
 * because it remains a branch with a parent, and from 'returned' because it produced no delivery.
 * Both consumers of this type only ask about 'not_child' (to decide the relay to the origin),
 * so a folded failure never leaks out to Telegram as if nobody were waiting on it.
 */
export type AgentResponseDisposition = 'not_child' | 'returned' | 'denied' | 'deferred' | 'coalesced';

export interface AgentFaninDisposition {
  hasFanout: boolean;
  scheduled: boolean;
}

/** Migration 016_chain_silence_sweep constrains agent_chain_closures.reason to exactly these values. */
export type ChainSilenceClosureReason = 'settled_without_fanin' | 'idle_timeout';

export interface ChainSilenceSweepOptions {
  /** No progress during this window AND still-open work: closed by timeout. */
  idleMs?: number;
  /** Chain already idle (nothing can move it again): a short grace before closing. */
  settledGraceMs?: number;
  /** Tracking window. A root older than this is never notified. */
  maxAgeMs?: number;
  /** Hard ceiling of roots touched per sweep. */
  limit?: number;
}

export interface ChainSilenceSweepResult {
  /** Candidate roots read in this sweep. */
  scanned: number;
  /** Roots unblocked: the real fan-in got scheduled and the human will receive the synthesis. */
  faninRecovered: number;
  /** Roots closed with an aggregated notice to the origin. Never more than one per root. */
  notified: number;
  /** Roots skipped (another process held them, or their close failed and will be retried). */
  skipped: number;
}
