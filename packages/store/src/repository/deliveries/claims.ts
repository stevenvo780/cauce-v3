import type { ProfileRuntimeContract, Tenant } from '@cauce/protocol'; /* eslint @typescript-eslint/no-unnecessary-boolean-literal-compare: "error" */
import { HUMAN_PRIORITY_FLOOR, PROTOCOL_VERSION } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withAbortableTransaction, withTransaction } from '../../db.js';
import { StoreError } from '../errors.js';
import { MessagesRepository } from '../messages.js';
import { validConnectionToken } from '../outbox.js';
import type { DeliveryRow } from '../observability.js';
import type {
  ClaimedDeliveryEnvelope,
  DeliveryAdmission,
  LeaseAcquireOptions,
  LeaseResult,
  LiveDeliveryClaim,
  RoutingTarget,
} from './contracts.js';

export abstract class DeliveryClaimsRepository extends MessagesRepository {
  protected abstract profileRuntimeExpectation(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<ProfileRuntimeContract | undefined>;
  protected abstract selfRoleFromProfile(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<string | undefined>;
  protected abstract routingTargets(client: DatabaseClient, sourceTenant: Tenant, sourceAlias: string): Promise<RoutingTarget[]>;
  async acquireLease(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    capabilities: string[],
    ttlMs: number,
    options: LeaseAcquireOptions = {}
  ): Promise<LeaseResult> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new StoreError('conflict', 'lease TTL must be positive');
    const resumeWindowMs = options.resumeWindowMs ?? ttlMs;
    if (!Number.isSafeInteger(resumeWindowMs) || resumeWindowMs <= 0) {
      throw new StoreError('conflict', 'lease resume window must be a positive integer');
    }
    if (options.requireDeclaredCapacity !== undefined
        && typeof options.requireDeclaredCapacity !== 'boolean') {
      throw new StoreError('conflict', 'lease capacity requirement must be boolean');
    }
    if (options.requireEnabledAgent !== undefined
        && typeof options.requireEnabledAgent !== 'boolean') {
      throw new StoreError('conflict', 'lease agent-enabled requirement must be boolean');
    }
    if (options.requireEnabledAgent === true && options.requireDeclaredCapacity !== true) {
      throw new StoreError('conflict', 'requireEnabledAgent requires requireDeclaredCapacity');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      if (options.requireDeclaredCapacity === true) {
        const capacity = await client.query<{ cap: number | null; enabled: boolean }>(
          `SELECT max_concurrent_deliveries AS cap, enabled
             FROM agents WHERE tenant_id=$1 AND alias=$2 FOR SHARE`,
          [tenantId, alias],
        );
        const row = capacity.rows[0];
        if (row === undefined) {
          throw new StoreError('conflict', 'delivery consumer is missing its durable agent capacity');
        }
        if (options.requireEnabledAgent === true && !row.enabled) {
          throw new StoreError('forbidden', 'delivery consumer is disabled');
        }
        if (row.cap !== null
            && (!Number.isSafeInteger(row.cap) || row.cap < 1 || row.cap > 100)) {
          throw new StoreError('conflict', 'delivery consumer capacity is invalid');
        }
      }
      // A missing row cannot be protected by SELECT ... FOR UPDATE. The keyed transaction
      // lock serializes the initial insert as well as all later takeovers.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `connection-lease:${tenantId}:${alias}`
      ]);
      const current = await client.query<{
        instance_id: string;
        epoch: string;
        lease_until: Date;
        live: boolean;
        resumable: boolean;
      }>(
        `SELECT instance_id,epoch,lease_until,(lease_until > now()) AS live,
                (instance_id=$3 AND lease_until > now()-$4*interval '1 millisecond') AS resumable
         FROM connection_leases WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`,
        [tenantId, alias, instanceId, resumeWindowMs]
      );
      const active = current.rows[0];
      if (options.resume === true && active?.resumable) {
        const resumed = await client.query<{ lease_until: Date; connection_token: string }>(
          `UPDATE connection_leases
           SET capabilities=$5::jsonb,lease_until=now()+$6*interval '1 millisecond',
               last_heartbeat_at=now(),connection_token=gen_random_uuid()
           WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4
           RETURNING lease_until,connection_token::text`,
          [tenantId, alias, instanceId, Number(active.epoch), JSON.stringify(capabilities), ttlMs]
        );
        const resumedLease = resumed.rows[0];
        if (resumedLease === undefined) {
          throw new StoreError('conflict', 'resumed connection lease is unavailable');
        }
        return {
          acquired: true,
          epoch: Number(active.epoch),
          connection_token: resumedLease.connection_token,
          lease_expires_at: resumedLease.lease_until.toISOString()
        };
      }
      if (active?.live && options.takeover !== true) {
        return {
          acquired: false,
          active_instance_id: active.instance_id,
          lease_expires_at: active.lease_until.toISOString()
        };
      }
      const nextEpoch = active ? Number(active.epoch) + 1 : 1;
      const lease = await client.query<{ lease_until: Date; connection_token: string }>(
        `INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at)
         VALUES($1,$2,$3,$4,$5::jsonb,now()+$6*interval '1 millisecond',now(),now())
         ON CONFLICT(tenant_id,alias) DO UPDATE SET
           instance_id=EXCLUDED.instance_id,epoch=EXCLUDED.epoch,capabilities=EXCLUDED.capabilities,
           lease_until=EXCLUDED.lease_until,last_heartbeat_at=now(),connected_at=now(),
           connection_token=gen_random_uuid()
         RETURNING lease_until,connection_token::text`, [tenantId, alias, instanceId, nextEpoch, JSON.stringify(capabilities), ttlMs]
      );
      const acquiredLease = lease.rows[0];
      if (acquiredLease === undefined) {
        throw new StoreError('conflict', 'acquired connection lease is unavailable');
      }
      return {
        acquired: true,
        epoch: nextEpoch,
        connection_token: acquiredLease.connection_token,
        lease_expires_at: acquiredLease.lease_until.toISOString(),
      };
    });
  }


  async heartbeat(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    ttlMs: number,
    connectionToken?: string,
    signal?: AbortSignal,
  ): Promise<string> {
    if (connectionToken !== undefined && !validConnectionToken(connectionToken)) {
      throw new StoreError('fenced', 'heartbeat requires a valid connection token');
    }
    const work = async (client: DatabaseClient): Promise<string> => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const result = await client.query<{ lease_until: Date }>(
        `UPDATE connection_leases SET lease_until=now()+$5*interval '1 millisecond',last_heartbeat_at=now()
         WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4 AND lease_until > now()
           AND ($6::uuid IS NULL OR connection_token=$6::uuid)
         RETURNING lease_until`, [tenantId, alias, instanceId, epoch, ttlMs, connectionToken ?? null]
      );
      const lease = result.rows[0];
      if (!lease) throw new StoreError('fenced', 'heartbeat rejected by lease fencing');
      return lease.lease_until.toISOString();
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }


  async releaseLease(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    connectionToken?: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (connectionToken !== undefined && !validConnectionToken(connectionToken)) return false;
    const work = async (client: DatabaseClient): Promise<boolean> => {
      const result = await client.query<{ released: boolean }>(
        `WITH released AS (
           UPDATE connection_leases SET lease_until=now()
            WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4
              AND ($5::uuid IS NULL OR connection_token=$5::uuid)
            RETURNING 1
         ), released_deliveries AS (
           UPDATE deliveries
         SET ack_deadline_at=LEAST(COALESCE(ack_deadline_at,now()),now()),
             claim_expires_at=now(),updated_at=now()
         WHERE recipient_tenant=$1 AND recipient_alias=$2 AND consumer_instance_id=$3
             AND consumer_epoch=$4 AND status IN ('leased','accepted','started')
             AND EXISTS(SELECT 1 FROM released)
           RETURNING 1
         )
         SELECT EXISTS(SELECT 1 FROM released) AS released`,
        [tenantId, alias, instanceId, epoch, connectionToken ?? null]
      );
      return result.rows[0]?.released === true;
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }


  /**
   * Capacities are durable and deduct live claws under lock; `maxClaims` only limits the batch.
   * The human class is born from authenticated priority, never from the body.
   * `delivery_lane_fairness` caps human streaks and yields after `humanBurst`.
   * The yield waits for a claim, never for another task's duration.
   */
  async claimDeliveries(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    limit = 20,
    ackDeadlineMs = 30_000,
    interactiveBurst = 3,
    admission: DeliveryAdmission = {},
    connectionToken?: string,
    signal?: AbortSignal,
  ): Promise<ClaimedDeliveryEnvelope[]> {
    const generalCapacity = admission.generalCapacity;
    const humanReservedCapacity = admission.humanReservedCapacity ?? 0;
    const maxClaims = admission.maxClaims ?? Math.min(100, limit + humanReservedCapacity);
    const humanBurst = admission.humanBurst ?? interactiveBurst;
    if (!Number.isSafeInteger(limit) || limit < 0
      || (generalCapacity !== undefined
        && (!Number.isSafeInteger(generalCapacity) || generalCapacity < 0))
      || !Number.isSafeInteger(humanReservedCapacity) || humanReservedCapacity < 0
      || !Number.isSafeInteger(maxClaims) || maxClaims < 1 || maxClaims > 100
      || (admission.requireDeclaredCapacity !== undefined
        && typeof admission.requireDeclaredCapacity !== 'boolean')
      || !Number.isSafeInteger(ackDeadlineMs) || ackDeadlineMs <= 0
      || !Number.isSafeInteger(interactiveBurst) || interactiveBurst < 1
      || !Number.isSafeInteger(humanBurst) || humanBurst < 1) {
      throw new StoreError('conflict', 'claim limits and deadlines must be positive');
    }
    if (connectionToken !== undefined && !validConnectionToken(connectionToken)) {
      throw new StoreError('fenced', 'delivery claim requires a valid connection token');
    }
    const work = async (client: DatabaseClient): Promise<ClaimedDeliveryEnvelope[]> => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const lease = await client.query<{ capabilities: unknown }>(
        `SELECT capabilities FROM connection_leases
         WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4 AND lease_until>now()
           AND ($5::uuid IS NULL OR connection_token=$5::uuid)
         FOR UPDATE`,
        [tenantId, alias, instanceId, epoch, connectionToken ?? null]
      );
      if (lease.rowCount !== 1) throw new StoreError('fenced', 'delivery claim rejected by lease fencing');
      const capabilities = lease.rows[0]?.capabilities;
      const includeRoutingTargets = Array.isArray(capabilities)
        && capabilities.includes('routing_targets_v1');
// Same compatibility criterion as routing_targets: DeliveryEnvelopeSchema is .strict(), so an
// adapter from an older image would reject the whole envelope when seeing a field it does not
// know and stop consuming ANY delivery. It is only sent to whoever declared it.
      const includeSelfRole = Array.isArray(capabilities)
        && capabilities.includes('agent_identity_v1');
      const includeProfileRuntimeContract = Array.isArray(capabilities)
        && capabilities.includes('agent_profile_adoption_v1');

      await client.query(
        `INSERT INTO delivery_lane_fairness(tenant_id,alias) VALUES($1,$2)
         ON CONFLICT(tenant_id,alias) DO NOTHING`, [tenantId, alias]
      );
      const fairness = await client.query<{ interactive_streak: number }>(
        `SELECT interactive_streak FROM delivery_lane_fairness
         WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenantId, alias]
      );
// The durable column counts human streaks; the lane is inherited at every hop and does not
// split agent chains.
      let humanStreak = fairness.rows[0]?.interactive_streak ?? 0;
      const claimedRows: DeliveryRow[] = [];

      /*
       * Hold the durable capacity row through the claim commit. Configuration mutations take
       * `FOR UPDATE` on this same row, so a concurrent reduction either commits before we read
       * the new cap or waits until this claim has committed under the old cap. Lock order here is
       * lease -> fairness -> agent; configuration never takes either of the first two locks.
       */
      const configuredCapacity = await client.query<{ cap: number | null }>(
        `SELECT max_concurrent_deliveries AS cap FROM agents
          WHERE tenant_id=$1 AND alias=$2 FOR SHARE`,
        [tenantId, alias],
      );
      const capacity = await client.query<{
        in_flight: string; human_in_flight: string;
      }>(
        `SELECT
           (SELECT count(*) FROM deliveries d
             WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
               AND d.status IN ('leased','accepted','started')
               AND d.claim_token IS NOT NULL
               AND d.ack_deadline_at IS NOT NULL AND d.ack_deadline_at>now()) AS in_flight,
           (SELECT count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id
             WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
               AND d.status IN ('leased','accepted','started')
               AND d.claim_token IS NOT NULL
               AND d.ack_deadline_at IS NOT NULL AND d.ack_deadline_at>now()
               AND m.priority >= $3) AS human_in_flight`,
        [tenantId, alias, HUMAN_PRIORITY_FLOOR]
      );
      const capacityRow = capacity.rows[0];
      if (capacityRow === undefined) {
        throw new StoreError('conflict', 'delivery consumer capacity could not be evaluated');
      }
      const configuredCapacityRow = configuredCapacity.rows[0];
      const configured = configuredCapacityRow !== undefined;
      if (!configured && admission.requireDeclaredCapacity === true) {
        throw new StoreError('conflict', 'delivery consumer is missing its durable agent capacity');
      }
      const concurrencyCap = configuredCapacityRow?.cap ?? null;
      const inFlight = Number(capacityRow.in_flight);
      const humanInFlight = Number(capacityRow.human_in_flight);
      if (!Number.isSafeInteger(inFlight) || inFlight < 0
        || !Number.isSafeInteger(humanInFlight) || humanInFlight < 0
        || humanInFlight > inFlight
        || (concurrencyCap !== null
          && (!Number.isSafeInteger(concurrencyCap) || concurrencyCap < 1))) {
        throw new StoreError('conflict', 'delivery consumer capacity is invalid');
      }

// A person occupies the reservation first. Only the human surplus consumes general capacity.
// The fairness row serialises this count with every concurrent claim of the alias, so HTTP,
// WebSocket, reconnections and multiple gateways share the same budget.
      const reservedInFlight = Math.min(humanInFlight, humanReservedCapacity);
      const generalInFlight = inFlight - reservedInFlight;
      const effectiveGeneralCapacity = generalCapacity === undefined
        ? configured
          ? concurrencyCap ?? Number.POSITIVE_INFINITY
          : limit
        : concurrencyCap === null ? generalCapacity : Math.min(generalCapacity, concurrencyCap);
      let generalRemaining = Math.min(
        maxClaims,
        Math.max(0, effectiveGeneralCapacity - generalInFlight),
      );
      let humanReservedRemaining = Math.min(
        maxClaims,
        Math.max(0, humanReservedCapacity - reservedInFlight),
      );

      /**
       * Claims one delivery by trusted-at-ingress priority with SKIP LOCKED.
       * The direct attempt uses `deliveries_claim_idx` and avoids repeated `EXISTS` probes.
       * Returns `undefined` when no row of that class remains available.
       */
      const claimOne = async (humanOriginated: boolean): Promise<DeliveryRow | undefined> => {
        const claimed = await client.query<DeliveryRow>(
          `WITH picked AS (
             SELECT d.id FROM deliveries d JOIN messages m ON m.id=d.message_id
             WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
               AND d.status IN ('pending','retry') AND d.available_at<=now()
               AND (m.priority >= $5)=$7::boolean
             ORDER BY (m.lane='interactive') DESC,m.priority DESC,d.available_at,d.created_at
             FOR UPDATE OF d SKIP LOCKED LIMIT 1
           ), updated AS (
             UPDATE deliveries d SET status='leased',attempt=d.attempt+1,claimed_at=now(),
               claim_token=gen_random_uuid(),ack_deadline_at=now()+$6*interval '1 millisecond',
               claim_expires_at=now()+$6*interval '1 millisecond',consumer_instance_id=$4,
               consumer_epoch=$3,execution_started_at=NULL,updated_at=now()
             FROM picked p WHERE d.id=p.id RETURNING d.*
           )
           SELECT u.id,u.message_id,u.recipient_tenant,u.recipient_alias,u.status,u.attempt,u.max_attempts,
                  u.last_ack_rank,u.consumer_instance_id,u.consumer_epoch,u.claim_token,u.ack_deadline_at,
                   m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.lane,m.priority,m.origin,
                   m.auth_session_id,m.auth_channel
           FROM updated u JOIN messages m ON m.id=u.message_id`,
          [tenantId, alias, epoch, instanceId, HUMAN_PRIORITY_FLOOR, ackDeadlineMs, humanOriginated]
        );
        return claimed.rows[0];
      };

      for (let index = 0; index < maxClaims; index += 1) {
        const humanSlotFree = humanReservedRemaining > 0 || generalRemaining > 0;
        const agentSlotFree = generalRemaining > 0;
        if (!humanSlotFree && !agentSlotFree) break;
        // After `humanBurst` human wins, one turn is yielded to non-human work.
        const yieldTurn = humanSlotFree && agentSlotFree && humanStreak >= humanBurst;
        // `true` is human; machines never occupy the reservation.
        const order: boolean[] = !agentSlotFree
          ? [true]
          : yieldTurn ? [false, true] : [true, false];

        let row: DeliveryRow | undefined;
        let claimedHuman = false;
        let yieldedToNobody = false;
        for (const humanOriginated of order) {
          row = await claimOne(humanOriginated);
          if (row !== undefined) {
            claimedHuman = humanOriginated;
            break;
          }
          // A yield with no work resets the streak so the empty attempt is not repeated.
          if (!humanOriginated && yieldTurn) yieldedToNobody = true;
        }
        // Without a row of either class, the queue is empty or locked by another worker.
        if (row === undefined) break;

        claimedRows.push(row);
        if (claimedHuman) {
          if (humanReservedRemaining > 0) humanReservedRemaining -= 1;
          else generalRemaining -= 1;
// The durable counter saturates at the threshold when no machine contests the turn. So it
// does not grow unbounded during a human burst.
          humanStreak = yieldedToNobody ? 1 : Math.min(humanBurst, humanStreak + 1);
        } else {
          generalRemaining -= 1;
          humanStreak = 0;
        }
      }
      await client.query(
        `UPDATE delivery_lane_fairness SET interactive_streak=$3,updated_at=now()
         WHERE tenant_id=$1 AND alias=$2`, [tenantId, alias, humanStreak]
      );
      const routingTargets = includeRoutingTargets
        ? await this.routingTargets(client, tenantId, alias)
        : undefined;
// The role belongs to the alias that claims it: a transactional read serves the whole batch
// and prevents attaching another alias's role.
      const selfRole = includeSelfRole && claimedRows.length > 0
        ? await this.selfRoleFromProfile(client, tenantId, alias)
        : undefined;
      const profileRuntimeContract = includeProfileRuntimeContract && claimedRows.length > 0
        ? await this.profileRuntimeExpectation(client, tenantId, alias)
        : undefined;

      return claimedRows.map((row) => {
        if (row.claim_token === null || row.ack_deadline_at === null) {
          throw new StoreError('conflict', 'claimed delivery is missing its fencing fields');
        }
        return {
          type: 'delivery',
          version: PROTOCOL_VERSION,
          delivery_id: row.id,
          event_id: row.id,
          message_id: row.message_id,
          request_id: row.request_id,
          trace_id: row.trace_id,
          epoch,
          attempt: row.attempt,
          claim_token: row.claim_token,
          ack_deadline_at: row.ack_deadline_at.toISOString(),
          tenant_id: row.tenant_id,
          room_id: row.room_id,
          actor_alias: row.actor_alias,
          recipient_alias: row.recipient_alias,
          body: row.body,
          ...(routingTargets === undefined ? {} : { routing_targets: routingTargets }),
          ...(selfRole === undefined ? {} : { self_role: selfRole }),
          ...(profileRuntimeContract === undefined
            ? {}
            : { profile_runtime_contract: profileRuntimeContract }),
          ...(row.origin ? { origin: row.origin } : {}),
          ...(row.auth_session_id && row.auth_channel ? {
            authenticated_context: {
              session_id: row.auth_session_id,
              channel: row.auth_channel,
              ...(row.origin ? { origin: row.origin } : {})
            }
          } : {})
        };
      });
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }


  /**
   * Claws still occupying an alias's ACK window.
   * Counted by `(tenant, alias)`, not by instance or epoch: a live older claw consumes budget.
   * So a reconnection does not reset durable capacity.
   * It is a snapshot without locks; the real claim re-validates under lock and avoids contention
   * with the reaper. The caller only uses the snapshot to decide how much to ask for.
   */
  async liveDeliveryClaims(
    tenantId: Tenant,
    alias: string,
    limit = 256
  ): Promise<LiveDeliveryClaim[]> {
    if (!Number.isSafeInteger(limit) || limit < 1) {
      throw new StoreError('conflict', 'live claim limit must be a positive integer');
    }
    const rows = await this.pool.query<{
      id: string;
      attempt: number;
      claim_token: string | null;
      ack_deadline_at: Date | null;
      human_originated: boolean;
    }>(
      `SELECT d.id,d.attempt,d.claim_token,d.ack_deadline_at,
              m.priority >= $3 AS human_originated
       FROM deliveries d JOIN messages m ON m.id=d.message_id
       WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
         AND d.status IN ('leased','accepted','started')
         AND d.ack_deadline_at IS NOT NULL AND d.ack_deadline_at>now()
       ORDER BY d.ack_deadline_at LIMIT $4`,
      [tenantId, alias, HUMAN_PRIORITY_FLOOR, limit]
    );
    return rows.rows
      .filter((row): row is typeof row & { claim_token: string; ack_deadline_at: Date } =>
        row.claim_token !== null && row.ack_deadline_at !== null)
      .map((row) => ({
        delivery_id: row.id,
        attempt: row.attempt,
        claim_token: row.claim_token,
        ack_deadline_at: row.ack_deadline_at.toISOString(),
        human_originated: row.human_originated === true // eslint-disable-line @typescript-eslint/no-unnecessary-boolean-literal-compare -- Malformed PostgreSQL flags fail closed.
      }));
  }


}
