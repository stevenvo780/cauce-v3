import type { Tenant } from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-type-conversion: "error", @typescript-eslint/no-unnecessary-condition: "error" */
import {
  agentWorkState, DEFAULT_FLEET_ACTIVITY_THRESHOLDS, FLEET_ACTIVITY_QUERY, FLEET_ACTIVITY_FLAGS,
  FLEET_WORK_STATES, type FleetActivityFlag, type FleetWorkState
} from '../fleet-activity.js';
import { safeAuditSummary } from '../audit-summary.js';
import { postgresBigintString } from '../runtime-values.js';
import { StoreError } from './errors.js';
import type {
  OperationalDlqPage, OperationalDlqResolutionRequest, OperationalDlqResolutionResult
} from './observability/contracts.js';
import { UUID_PATTERN } from './observability/helpers.js';
import { ObservabilityChainSweepRepository } from './observability/chain-sweep.js';

export {
  DEFAULT_DELIVERY_LEASE_CAP_GRACE_MS, DEFAULT_DELIVERY_LEASE_CAP_MS,
  DEFAULT_NO_CONSUMER_PARK_MAX_AGE_MS, DEFAULT_RETENTION_ACK_MS,
  DEFAULT_RETENTION_ACK_RENEWAL_MS, DEFAULT_RETENTION_AUDIT_MS,
  DEFAULT_RETENTION_AUDIT_RENEWAL_MS, DEFAULT_RETENTION_BATCH, DISPOSABLE_AUDIT_ACTIONS,
  deliveryLeaseCapMs, timeoutRetryBackoffSeconds,
  type DeliveryLeaseCap, type ObservabilityRetentionPolicy, type ObservabilityRetentionResult,
  type StaleDeliveryPolicy
} from './observability/policy.js';
export {
  disabledChainPolicy,
  type AgentFaninDisposition, type AgentResponseDisposition, type ChainPolicy,
  type ChainSilenceClosureReason, type ChainSilenceSweepOptions, type ChainSilenceSweepResult,
  type DeliveryRow, type LateRelayDisposition, type OperationalDlqItem, type OperationalDlqPage,
  type OperationalDlqResolutionRequest, type OperationalDlqResolutionResult
} from './observability/contracts.js';
export {
  agentDeploymentStatus, UUID_PATTERN, aliasPattern, originRelayTenant, tenantPattern, truncateUtf8
} from './observability/helpers.js';

export abstract class ObservabilityRepository extends ObservabilityChainSweepRepository {

  async listAudit(
    actorTenant: Tenant,
    actorAlias: string,
    options: { limit?: number; before?: string | null } = {},
  ): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const limit = options.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StoreError('invalid_input', 'audit limit must be an integer between 1 and 500');
    }
    const before = options.before ?? null;
    if (before !== null && (
      !/^[1-9][0-9]{0,18}$/u.test(before)
      || BigInt(before) > 9_223_372_036_854_775_807n
    )) {
      throw new StoreError('invalid_input', 'audit cursor is invalid');
    }
    const result = await this.pool.query<{
      event_id: string;
      at: Date | string;
      tenant_id: string | null;
      actor_alias: string | null;
      action: string;
      decision: string;
      request_id: string | null;
      trace_id: string | null;
      metadata: unknown;
    }>(
      `SELECT audit.id AS event_id,audit.created_at AS at,audit.tenant_id,audit.actor_alias,
              audit.action,audit.decision,audit.request_id,audit.trace_id,audit.metadata
       FROM audit_events audit
       LEFT JOIN messages message ON message.id=audit.message_id
       WHERE (
         (audit.tenant_id=$1 AND audit.actor_alias=$2)
         OR (message.id IS NOT NULL AND EXISTS (
           SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
             AND source_member.room_id=message.room_id AND source_member.alias=$2
             AND source_member.enabled AND message.tenant_id=$1
         ))
         OR (audit.delivery_id IS NOT NULL AND EXISTS (
           SELECT 1 FROM deliveries participant WHERE participant.id=audit.delivery_id
             AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2
         ))
       )
         AND ($3::bigint IS NULL OR audit.id < $3::bigint)
       ORDER BY audit.id DESC LIMIT $4`, [actorTenant, actorAlias, before, limit + 1]
    );
    const hasMore = result.rows.length > limit;
    const visible = result.rows.slice(0, limit);
    const lastVisible = visible.at(-1);
    return {
      items: visible.map((row) => ({
        event_id: postgresBigintString(row.event_id),
        at: row.at instanceof Date ? row.at.toISOString() : row.at,
        tenant_id: row.tenant_id,
        actor_alias: row.actor_alias,
        action: row.action,
        decision: row.decision,
        request_id: row.request_id,
        trace_id: row.trace_id,
        summary: safeAuditSummary(row.action, row.metadata),
      })),
      next_cursor: hasMore && lastVisible !== undefined
        ? postgresBigintString(lastVisible.event_id)
        : null,
    };
  }

  /**
   * In-flight activity of the entire fleet visible to the actor, aggregated by alias. It is
   * the "what is each agent working on now" half of the requested panel; the other half (quota
   * consumption) lives in quotaSnapshot() with its own observed_at because the two freshnesses
   * are incomparable -- this one is from milliseconds ago, the quota one is an out-of-band
   * sample from minutes ago.
   *
   * Self-contained like topology()/listAgents(): it validates the permission here itself, so
   * the route only needs the role+permission check on the Principal (requireOperatorPermission).
   *
   * FLEET_ACTIVITY_QUERY is read-only, with no locks and no window functions on purpose
   * (see the comment in fleet-activity.ts): a panel wants a snapshot, not one that freezes
   * dispatch while taking it, and Postgres rejects parsing any combination of FOR SHARE/FOR
   * UPDATE with window functions.
   */
  async fleetActivity(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const thresholds = DEFAULT_FLEET_ACTIVITY_THRESHOLDS;
    const result = await this.pool.query<Record<string, unknown>>(FLEET_ACTIVITY_QUERY, [
      actorTenant, thresholds.ack_recent_seconds, thresholds.ack_lookback_seconds, thresholds.items_per_agent
    ]);

    const agents = result.rows.map((row) => {
      // lease_online comes from `(lease.lease_until > now())`: NULL when the LEFT JOIN found
      // no lease row (never connected), not when the lease is expired.
      const leaseOnline = row.lease_online === null || row.lease_online === undefined
        ? null : row.lease_online === true;
      // NULL here is "no ACK applied within the search window", the MOST serious signal;
      // Number(null) would yield 0 and paint it as just acked, exactly backwards.
      const secondsSinceLastAck = row.seconds_since_last_ack === null || row.seconds_since_last_ack === undefined
        ? null : Number(row.seconds_since_last_ack);
      const inFlight = Number(row.in_flight ?? 0);
      const queued = Number(row.queued ?? 0);
      const overdueInFlight = Number(row.overdue_in_flight ?? 0);
      const claimedNotStarted = Number(row.claimed_not_started ?? 0);
      const oldestInFlightSeconds = row.oldest_in_flight_seconds === null
        || row.oldest_in_flight_seconds === undefined
        ? null : Number(row.oldest_in_flight_seconds);
      const registered = row.registered === true;

      const { work_state, flags } = agentWorkState(
        {
          registered, in_flight: inFlight, queued, overdue_in_flight: overdueInFlight,
          claimed_not_started: claimedNotStarted,
          oldest_in_flight_seconds: oldestInFlightSeconds,
          seconds_since_last_ack: secondsSinceLastAck, lease_online: leaseOnline,
        },
        thresholds
      );

      return {
        tenant_id: row.tenant_id,
        alias: row.alias,
        display_name: row.display_name ?? null,
        harness_id: row.harness_id ?? null,
        registered,
        agent_enabled: row.agent_enabled === true,
        presence: {
          online: leaseOnline,
          instance_id: row.instance_id ?? null,
          // bigint: the pg driver returns it as a string; the rest of this file already
          // converts epoch the same way (see acquireLease/heartbeat above).
          epoch: row.epoch === null || row.epoch === undefined ? null : Number(row.epoch),
          last_heartbeat_at: row.last_heartbeat_at ?? null,
          lease_until: row.lease_until ?? null
        },
        work_state,
        flags,
        in_flight: inFlight,
        started: Number(row.started ?? 0),
        claimed_not_started: Number(row.claimed_not_started ?? 0),
        queued,
        queued_ready: Number(row.queued_ready ?? 0),
        retrying: Number(row.retrying ?? 0),
        overdue_in_flight: overdueInFlight,
        oldest_claimed_at: row.oldest_claimed_at ?? null,
        oldest_in_flight_seconds: row.oldest_in_flight_seconds === null || row.oldest_in_flight_seconds === undefined
          ? null : Number(row.oldest_in_flight_seconds),
        nearest_ack_deadline_at: row.nearest_ack_deadline_at ?? null,
        max_attempt: row.max_attempt === null || row.max_attempt === undefined ? null : Number(row.max_attempt),
        last_ack_at: row.last_ack_at ?? null,
        seconds_since_last_ack: secondsSinceLastAck,
        acks_recent: Number(row.acks_recent ?? 0),
        in_flight_items_truncated: row.in_flight_items_truncated === true,
        in_flight_items: Array.isArray(row.in_flight_items) ? row.in_flight_items : [],
        // The alias's rooms, already resolved by the SQL. `[]` is a legitimate value -- registered
        // and without rooms -- and the console renders it the same; not collapsed to null
        // nor is the field omitted, because "has no rooms" and "the server reports no rooms" render differently.
        rooms: Array.isArray(row.rooms) ? (row.rooms as string[]) : []
      };
    });

    const byState = Object.fromEntries(FLEET_WORK_STATES.map((state) => [state, 0])) as Record<FleetWorkState, number>;
    const flagged = Object.fromEntries(FLEET_ACTIVITY_FLAGS.map((flag) => [flag, 0])) as Record<FleetActivityFlag, number>;
    const totals = agents.reduce((acc, agent) => {
      acc.agents += 1;
      byState[agent.work_state] += 1;
      for (const flag of agent.flags) flagged[flag] += 1;
      acc.in_flight += agent.in_flight;
      acc.queued += agent.queued;
      acc.retrying += agent.retrying;
      acc.overdue_in_flight += agent.overdue_in_flight;
      return acc;
    }, { agents: 0, in_flight: 0, queued: 0, retrying: 0, overdue_in_flight: 0 });

    return {
      observed_at: new Date().toISOString(),
      thresholds,
      totals: { ...totals, by_state: byState, flagged },
      agents
    };
  }

  /**
   * Operational DLQ inventory without payloads or external ids. The database applies multi-tenant
   * control and ties the opaque cursor to the operator's identity; changing actor or reusing a
   * cursor from another scope fails closed. It is not a signature: an authorized actor can only
   * alter navigation within its scope. The keyset order is stable across reopens because it
   * uses the letter's immutable `created_at`, plus target and id as tiebreakers.
   */
  async listOperationalDlq(
    actorTenant: Tenant,
    actorAlias: string,
    limit = 200,
    cursor: string | null = null
  ): Promise<OperationalDlqPage> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) {
      throw new StoreError('invalid_input', 'DLQ list limit must be between 1 and 500');
    }
    if (cursor !== null && (cursor.length < 2 || cursor.length > 1024
      || cursor.length % 2 !== 0 || !/^[a-f0-9]+$/.test(cursor))) {
      throw new StoreError('invalid_input', 'DLQ list cursor is invalid');
    }
    const result = await this.pool.query<{ value: OperationalDlqPage }>(
      `SELECT cauce_list_dlq_030($1,$2,$3,$4) AS value`,
      [actorTenant, actorAlias, limit, cursor]
    );
    const value = result.rows[0]?.value;
    if (!value) throw new StoreError('conflict', 'DLQ list did not return a page');
    return value;
  }

  /** Exact, operator-audited closure of one classified incident without replay or side effects. */
  async resolveOperationalDlqWithoutReplay(
    actorTenant: Tenant,
    actorAlias: string,
    request: OperationalDlqResolutionRequest
  ): Promise<OperationalDlqResolutionResult> {
    const reason = request.reason.trim();
    if ((request.target !== 'delivery' && request.target !== 'outbox') // eslint-disable-line @typescript-eslint/no-unnecessary-condition -- Runtime callers can violate the target union.
      || !UUID_PATTERN.test(request.id)
      || !/^[a-f0-9]{64}$/.test(request.evidenceSha256)
      || reason.length < 1 || reason.length > 1_000
      || Array.from(reason).some((character) => {
        const code = character.charCodeAt(0);
        return code < 0x20 || code === 0x7f;
      })
      || typeof request.possibleDuplicateAcknowledged !== 'boolean'
      || typeof request.possibleNoDeliveryAcknowledged !== 'boolean') {
      throw new StoreError('invalid_input', 'DLQ no-replay resolution request is invalid');
    }
    const result = await this.pool.query<{ value: OperationalDlqResolutionResult }>(
      `SELECT cauce_resolve_dlq_without_replay_030(
         $1,$2::uuid,$3,$4,$5,$6,$7,$8
       ) AS value`,
      [
        request.target, request.id, request.evidenceSha256, reason, actorTenant, actorAlias,
        request.possibleDuplicateAcknowledged, request.possibleNoDeliveryAcknowledged,
      ]
    );
    const value = result.rows[0]?.value;
    if (!value) throw new StoreError('conflict', 'DLQ no-replay resolution returned no receipt');
    return value;
  }

  async queueSnapshot(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT d.id AS delivery_id,d.message_id,d.recipient_tenant AS tenant_id,d.recipient_alias,
              m.tenant_id AS message_tenant_id,m.actor_alias,m.lane,d.status AS state,
              d.attempt AS attempts,d.max_attempts,d.available_at,d.last_error
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE EXISTS (SELECT 1 FROM memberships source_member
                     WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                       AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
          OR (d.recipient_tenant=$1 AND d.recipient_alias=$2
              AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read
              )))
       ORDER BY d.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    // `failed` counts as dead letter because it already has a reproducible row and must appear in the total.
    const counts = result.rows.reduce<{ pending: number; retrying: number; dead: number }>((value, row) => {
      if (row.state === 'retry') value.retrying += 1;
      if (row.state === 'dead' || row.state === 'failed') value.dead += 1;
      if (['pending', 'leased', 'accepted', 'started'].includes(String(row.state))) value.pending += 1;
      return value;
    }, { pending: 0, retrying: 0, dead: 0 });

    // Total aggregate count with the same visibility filters as the listing.
    const totales = await this.pool.query<{ pending: string; retrying: string; dead: string; total: string }>(
      `SELECT count(*) FILTER (WHERE d.status IN ('pending','leased','accepted','started')) AS pending,
              count(*) FILTER (WHERE d.status = 'retry') AS retrying,
              count(*) FILTER (WHERE d.status IN ('dead','failed')) AS dead,
              count(*) AS total
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE EXISTS (SELECT 1 FROM memberships source_member
                     WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                       AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
          OR (d.recipient_tenant=$1 AND d.recipient_alias=$2
              AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read
              )))`, [actorTenant, actorAlias]
    );
    const fila = totales.rows[0];
    const totals = {
      pending: Number(fila?.pending ?? 0),
      retrying: Number(fila?.retrying ?? 0),
      dead: Number(fila?.dead ?? 0),
    };
    // "Truncated" is decided by comparing with the total, not with `items.length === limit`: if there
    // were exactly `limit` deliveries, that check would say something is missing when nothing is.
    const muestra_recortada = Number(fila?.total ?? 0) > result.rows.length;

    return {
      observed_at: new Date().toISOString(),
      ...counts,
      totals,
      muestra_recortada,
      items: result.rows,
    };
  }

}
