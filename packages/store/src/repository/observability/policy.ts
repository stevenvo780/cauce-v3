import { MAX_MESSAGE_TIMEOUT_MS, messageTimeoutMs } from '@cauce/protocol';
import { StoreError } from '../errors.js';

/** Total lifetime ceiling of a delivery attempt when the message does not declare `body.timeout_ms`. */
export const DEFAULT_DELIVERY_LEASE_CAP_MS = 12 * 60 * 60_000;

/** Additional margin over `body.timeout_ms` to cover session waits and ACK delivery. */
export const DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS = 30 * 60_000;

/** Maximum parking time for deliveries aimed at aliases with no connected adapters. */
export const DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS = 24 * 60 * 60_000;

/** Lifetime ceiling of a delivery. See `DEFAULT_DELIVERY_LEASE_CAP_MS`. */
export interface DeliveryLeaseCap {
  /** Default ceiling, for messages without `body.timeout_ms`. */
  readonly leaseCapMs?: number;
  /** Margin added to the declared `body.timeout_ms`. */
  readonly leaseCapGraceMs?: number;
}

export function positiveMs(value: number | undefined, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new StoreError('conflict', `${name} must be a positive integer`);
  }
  return value;
}

/**
 * Lifetime ceiling of THIS delivery: `body.timeout_ms + grace` if the message declares it, and
 * the configured default otherwise.
 *
 * A declared `timeout_ms` wins in BOTH directions, and that is on purpose. Upward because it
 * is the only way to ask for a turn longer than 12h without touching the whole fleet's config.
 * Downward because a publisher that knows its task lasts 5 minutes can ask for tight
 * supervision, and with `timeout_ms=300000` the ceiling is 35min instead of 12h.
 */
export function deliveryLeaseCapMs(
  body: Record<string, unknown> | undefined,
  cap: DeliveryLeaseCap = {}
): number {
  const fallback = positiveMs(cap.leaseCapMs, DEFAULT_DELIVERY_LEASE_CAP_MS, 'lease cap');
  const grace = positiveMs(cap.leaseCapGraceMs, DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, 'lease cap grace');
  const declared = messageTimeoutMs(body);
  return declared === undefined ? fallback : declared + grace;
}

/**
 * The instant at which a delivery's lease stops being renewable, in SQL.
 *
 * The anchor is `COALESCE(execution_started_at, claimed_at)`, that is, the LATEST of the two
 * we know, because both get cleared on each retry and therefore measure the lifetime of the
 * current ATTEMPT, not the delivery's lifetime since it was born. Choosing the later one is
 * the permissive option: when the adapter reports that the harness really started, the time
 * the delivery spent waiting for the session lock is NOT deducted from its ceiling.
 *
 * With both NULL, the expression yields NULL, and both `LEAST` and the `<= now()` comparison
 * treat that NULL as "no ceiling". That is also deliberate: a row without `claimed_at` is
 * not in flight and is not this guard's concern.
 */
export function leaseCapInstantSql(capMsParameter: string, table = 'd'): string {
  return `(COALESCE(${table}.execution_started_at,${table}.claimed_at)`
    + ` + ${capMsParameter}*interval '1 millisecond')`;
}

/**
 * `deliveryLeaseCapMs` in SQL, for the reaper, which needs the ceiling inside the WHERE and
 * cannot pull the whole fleet into memory to compute it row by row.
 *
 * The two nested CASE statements are not a style choice: `::bigint` only appears inside the
 * THEN of the outer CASE, so PostgreSQL guarantees the shape guard (`jsonb_typeof` + regex)
 * is evaluated BEFORE the cast. With a single CASE and an AND, the operand evaluation order
 * is undefined, and a stale row with `timeout_ms:"soon"` would blow up the entire reaper tick
 * with a conversion error—exactly the failure mode that once left the fleet with agents
 * alive and deliveries dead.
 *
 * The rule must yield the SAME thing as `messageTimeoutMs`, including the 7-day maximum: if
 * they diverged, the WHERE would mark a delivery as expired by the ceiling, and the reason
 * written into `dead_letters` would say a different number.
 */
export function leaseCapMsSql(defaultCapParameter: string, graceParameter: string, table = 'm'): string {
  return `COALESCE(
    CASE WHEN jsonb_typeof(${table}.body->'timeout_ms')='number'
              AND (${table}.body->>'timeout_ms') ~ '^[1-9][0-9]{0,9}$'
         THEN CASE WHEN (${table}.body->>'timeout_ms')::bigint <= ${String(MAX_MESSAGE_TIMEOUT_MS)}
                   THEN (${table}.body->>'timeout_ms')::bigint + ${graceParameter}::bigint END
    END, ${defaultCapParameter}::bigint)`;
}

/**
 * Retention of RENEWAL ACKs: 6h.
 *
 * A renewal ACK says "the harness is still alive". Its operational value lasts as long as the
 * delivery does, and its forensic value is exhausted as soon as the delivery ends: to
 * reconstruct an incident it is enough to know when it started, when it ended, and with
 * what—not to have the 1,041 intermediate liveness proofs. 6h is comfortably more than the
 * typical ceiling of a long in-flight delivery, so no renewal is deleted while its delivery
 * is still alive; and it also covers the shift of an operator arriving to investigate
 * something that happened "this morning".
 */
export const DEFAULT_RETENTION_ACK_RENEWAL_MS = 6 * 60 * 60_000;

/**
 * General retention for `delivery_acks`: 14 days. It covers state transitions (accepted, the
 * first started, done, failed), which are the proof of what the system did with each delivery,
 * and also the rows predating migration 014, which cannot be reclassified.
 */
export const DEFAULT_RETENTION_ACK_MS = 14 * 24 * 60 * 60_000;

/** Retention of the lease-renewal `audit_events`. Same argument as the ACKs. */
export const DEFAULT_RETENTION_AUDIT_RENEWAL_MS = 6 * 60 * 60_000;

/**
 * General retention for `audit_events`: 30 days, MORE than the ACKs, and on purpose. An ACK
 * is transport telemetry; an audit_event answers "who authorized what, and with what
 * decision", which is the question that shows up weeks later.
 */
export const DEFAULT_RETENTION_AUDIT_MS = 30 * 24 * 60 * 60_000;

/**
 * `audit_events` actions that are TELEMETRY and therefore deletable. WHITELIST, not blacklist, and this is the
 * most important decision of the whole sweep.
 *
 * `audit_events` is NOT a log in this system: it is STATE that correctness guards depend on, and deleting by
 * age alone would silently break them, with weeks of delay. The two that would be costly:
 *
 *  - `delivery.replay` (allow) is the idempotency lock of manual replay: `replayDelivery` checks whether one
 *    already exists before cloning. Without that row, a dead letter that a human re-enqueues 31 days later
 *    is cloned TWICE and the run is paid for twice—exactly the waste the rest of this patch exists to cut.
 *    It is also the lineage-cycle detector (`replayed_from_message_id`), so deleting it also reopens the
 *    path the system intentionally closes.
 *  - `agent_output.response` (allow/deny) is the trust mark of the agent-to-agent chain:
 *    `materializeAgentResponse` only trusts the declared correlation if that row exists, and the chain view
 *    and fan-in use it to count responses. Without it, the response to the parent degrades to "not a child"
 *    with no visible error.
 *
 * That is why the list starts with `delivery.ack` and nothing else: it is the only high-volume action (one
 * row per applied ACK) that no query reads to decide anything. `delivery.ack_timeout` and `delivery.lease_cap`
 * are kept out even though no one reads them: they are the evidence of why a delivery died, they are rare,
 * and they weigh nothing.
 *
 * It is NOT exposed as an environment variable on purpose. A configurable action list invites someone to add
 * `delivery.replay` to "save space" and break the idempotency lock without any test noticing. Expanding it
 * is a code change, reviewable.
 */
export const DISPOSABLE_AUDIT_ACTIONS: readonly string[] = ['delivery.ack'];

/** Rows per batch and per table in each sweep. Bounds the DELETE on a live base. */
export const DEFAULT_RETENTION_BATCH = 5_000;

/** Observability retention windows. See `pruneObservability`. */
export interface ObservabilityRetentionPolicy {
  readonly ackRenewalMs?: number;
  readonly ackMs?: number;
  readonly auditRenewalMs?: number;
  readonly auditMs?: number;
  readonly batch?: number;
  /** See `DISPOSABLE_AUDIT_ACTIONS`. Expanding it without reading that comment breaks things. */
  readonly disposableAuditActions?: readonly string[];
}

/** Rows deleted by each rule in a sweep. */
export interface ObservabilityRetentionResult {
  readonly ack_renewals: number;
  readonly acks: number;
  readonly audit_renewals: number;
  readonly audit_events: number;
}

/** Stale-lease reaper policy. See `retryStaleDeliveries`. */
export interface StaleDeliveryPolicy extends DeliveryLeaseCap {
  /**
   * Returns to the old behavior: retry even if the delivery is known to have already started.
   * It exists as an emergency lever, not as a default. Turning it on causes each run to be
   * paid for twice again.
   *
   * It does NOT disable the lifetime ceiling: these are two different guards. This one decides
   * what to do with a stale lease that has ALREADY been paid for; the ceiling decides when a
   * lease stops being renewable. Retrying a delivery that was renewing for 12h is exactly the
   * feedback the ceiling exists to cut, so the ceiling wins even with the lever on.
   */
  readonly retryStartedDeliveries?: boolean;
  /**
   * Turns off the parking of deliveries whose destination has NO connected adapter. Turning
   * it on (i.e. setting `false`) restores the old behavior: spending the three attempts
   * against an alias that does not exist and dying. It exists as a lever, not as a default.
   */
  readonly parkWithoutConsumer?: boolean;
  /**
   * How long a delivery without a consumer is parked. It is not a criterion about effects
   * —that is `execution_started_at`'s job— but a retention horizon: past that time the
   * conversational context no longer exists, and keeping it queued serves no one.
   * Default: 24h.
   */
  readonly noConsumerParkMaxAgeMs?: number;
}

/**
 * Stale-lease retry spacing: 30s, 60s, 120s… with a 5-minute ceiling.
 *
 * It is different (and longer) from the backoff of a retryable 'failed' ACK, which starts at
 * 1s and tops out at 60s. The asymmetry is deliberate: a declared failure means the agent
 * answered and failed, and retrying fast is reasonable. A stale lease means the opposite—the
 * agent said nothing for the entire deadline—and agentic work takes as long as it takes.
 * Re-offering the delivery on the next tick, which is what `available_at=now()` did, stacks
 * a second run on top of the first, which may still be alive, and is exactly the positive
 * feedback the incident describes: every death generated more load, which generated more
 * deaths.
 */
export function timeoutRetryBackoffSeconds(attempt: number): number {
  return Math.min(300, 30 * 2 ** Math.max(0, attempt - 1));
}
