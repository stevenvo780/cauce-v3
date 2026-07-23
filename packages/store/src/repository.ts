import { createHash } from 'node:crypto';
import type { Ack, ConfigMutation, DeliveryEnvelope, DeliveryState, Origin, PublishMessage, Tenant } from '@cauce/protocol';
import { PROTOCOL_VERSION } from '@cauce/protocol';
import type { DatabaseClient, DatabasePool } from './db.js';
import { withTransaction } from './db.js';
import {
  ConfigurationError, ConfigurationRepository, type ConfigurationChangeResult
} from './configuration.js';

export type StoreErrorCode = 'forbidden' | 'no_route' | 'conflict' | 'fenced' | 'not_found' | 'invalid_actor';

export class StoreError extends Error {
  constructor(public readonly code: StoreErrorCode, message: string) {
    super(message);
    this.name = 'StoreError';
  }
}

export interface PublishResult {
  message_id: string;
  delivery_ids: string[];
  duplicate: boolean;
  request_id: string;
  trace_id: string;
}

export interface LeaseResult {
  acquired: boolean;
  epoch?: number;
  lease_expires_at: string;
  active_instance_id?: string;
}

interface DeliveryRow {
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
  origin: Origin | null;
  auth_session_id: string | null;
  auth_channel: string | null;
  consumer_instance_id: string | null;
  consumer_epoch: string | null;
  claim_token: string | null;
  ack_deadline_at: Date | null;
}

export interface AckResult {
  delivery_id: string;
  status: DeliveryState;
  applied: boolean;
}

/** Store claim record; event_id is the immutable ACK correlation id for this delivery. */
export interface ClaimedDeliveryEnvelope extends DeliveryEnvelope {
  event_id: string;
}

export interface OutboxEvent {
  id: string;
  tenant_id: Tenant;
  adapter: string;
  kind: 'wake' | 'origin_relay';
  request_id: string;
  message_id: string;
  delivery_id: string | null;
  trace_id: string;
  origin: Origin | null;
  payload: Record<string, unknown>;
  attempts: number;
  attempt?: number;
  max_attempts: number;
  claimed_by: string;
  claim_token: string;
  claim_expires_at: Date;
  event_id?: string;
}

export interface ClaimedOutboxEvent extends OutboxEvent {
  max_attempts: number;
  claimed_by: string;
  claim_token: string;
  claim_expires_at: Date;
  event_id: string;
  attempt: number;
}

export interface JobClaim extends Record<string, unknown> {
  id: string;
  tenant_id: Tenant;
  lane: 'interactive' | 'batch';
  status: 'running';
  attempts: number;
  claimed_by: string;
  claim_token: string;
  lease_until: Date;
}

export interface LeaseAcquireOptions {
  /** Explicitly fence a still-live consumer. Omit for the default no-takeover behavior. */
  takeover?: boolean;
}

export type OutboxRetryResult = 'retry' | 'dead' | 'fenced';

export interface OutboxAck {
  event_id: string;
  attempt: number;
  claim_token: string;
  status: 'sent' | 'retry' | 'dead';
  error?: string;
  retry_after_ms?: number;
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, child]) => [key, canonical(child)])
    );
  }
  return value;
}

function requestHash(input: PublishMessage): string {
  const semanticCommand: Record<string, unknown> = { ...input };
  delete semanticCommand.request_id;
  delete semanticCommand.trace_id;
  return createHash('sha256').update(JSON.stringify(canonical(semanticCommand))).digest('hex');
}

function ackRank(status: Ack['status']): number {
  if (status === 'accepted') return 1;
  if (status === 'started') return 2;
  return 3;
}

function terminal(status: string): boolean {
  return status === 'done' || status === 'failed' || status === 'dead';
}

export class CauceRepository {
  constructor(private readonly pool: DatabasePool) {}

  async publish(input: PublishMessage): Promise<PublishResult> {
    if (input.recipients.length === 0) throw new StoreError('no_route', 'message has zero recipients');
    const uniqueRecipients = [...new Map(input.recipients.map((item) => [`${item.tenant_id}:${item.alias}`, item])).values()];
    if (uniqueRecipients.length !== input.recipients.length) {
      throw new StoreError('conflict', 'recipient list contains duplicates');
    }
    return withTransaction(this.pool, async (client) => {
      const actor = await client.query(
        `SELECT 1 FROM memberships m JOIN role_policies p ON p.role=m.role
         JOIN tenants t ON t.id=m.tenant_id JOIN rooms r ON r.id=m.room_id AND r.tenant_id=m.tenant_id
         WHERE m.tenant_id=$1 AND m.room_id=$2 AND m.alias=$3 AND m.enabled
           AND t.enabled AND r.enabled AND p.allow_route`,
        [input.tenant_id, input.room_id, input.actor_alias]
      );
      if (actor.rowCount !== 1) throw new StoreError('invalid_actor', 'actor lacks route permission in the source room');

      for (const recipient of uniqueRecipients) {
        const member = await client.query(
          `SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
           JOIN rooms r ON r.id=m.room_id AND r.tenant_id=m.tenant_id
           WHERE m.tenant_id=$1 AND m.alias=$2 AND m.enabled AND t.enabled AND r.enabled LIMIT 1`,
          [recipient.tenant_id, recipient.alias]
        );
        if (member.rowCount !== 1) throw new StoreError('no_route', `recipient ${recipient.alias} is not routable`);
         if (recipient.tenant_id !== input.tenant_id) {
          const edge = await client.query(
            `SELECT 1 FROM acl_edges edge
             JOIN tenants source ON source.id=edge.from_tenant
             JOIN tenants target ON target.id=edge.to_tenant
             WHERE edge.from_tenant=$1 AND edge.to_tenant=$2
               AND edge.enabled AND edge.allow_route AND (source.is_hub OR target.is_hub)`,
            [input.tenant_id, recipient.tenant_id]
          );
          if (edge.rowCount !== 1) throw new StoreError('forbidden', 'cross-tenant route denied by default');
        }
      }

      const hash = requestHash(input);
      const insertedKey = await client.query(
        `INSERT INTO idempotency_keys(tenant_id,actor_alias,idempotency_key,request_hash)
         VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING idempotency_key`,
        [input.tenant_id, input.actor_alias, input.idempotency_key, hash]
      );
      if (insertedKey.rowCount === 0) {
        const prior = await client.query<{ request_hash: string; response: PublishResult | null }>(
          `SELECT request_hash,response FROM idempotency_keys
           WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3 FOR UPDATE`,
          [input.tenant_id, input.actor_alias, input.idempotency_key]
        );
        const existing = prior.rows[0];
        if (!existing || existing.request_hash !== hash) {
          throw new StoreError('conflict', 'idempotency key reused with a different request');
        }
        if (!existing.response) throw new StoreError('conflict', 'idempotency request is still in progress');
        return { ...existing.response, duplicate: true };
      }

      const authenticated = input.authenticated_context;
      const persistedOrigin = authenticated?.origin ?? input.origin;
      const message = await client.query<{ id: string }>(
        `INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,origin,lane,priority,
                              auth_session_id,auth_channel)
         VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8,$9,$10,$11) RETURNING id`,
        [input.request_id, input.trace_id, input.tenant_id, input.room_id, input.actor_alias,
          JSON.stringify(input.body), persistedOrigin ? JSON.stringify(persistedOrigin) : null, input.lane, input.priority,
          authenticated?.session_id ?? input.session_id ?? null,
          authenticated?.channel ?? input.channel ?? null]
      );
      const messageId = message.rows[0]?.id;
      if (!messageId) throw new Error('message insert returned no id');
      const deliveryIds: string[] = [];
      for (const recipient of uniqueRecipients) {
        const delivery = await client.query<{ id: string }>(
          `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
           VALUES($1,$2,$3) RETURNING id`, [messageId, recipient.tenant_id, recipient.alias]
        );
        const deliveryId = delivery.rows[0]?.id;
        if (!deliveryId) throw new Error('delivery insert returned no id');
        deliveryIds.push(deliveryId);
        await client.query(
          `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
           VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)`,
           [recipient.tenant_id, `wake:${deliveryId}`, input.request_id, messageId, deliveryId, input.trace_id,
             persistedOrigin ? JSON.stringify(persistedOrigin) : null,
            JSON.stringify({ recipient_alias: recipient.alias, reason: 'delivery_available' })]
        );
        await client.query('SELECT pg_notify($1,$2)', [
          'cauce_delivery_wake',
          JSON.stringify({ tenant_id: recipient.tenant_id, alias: recipient.alias })
        ]);
      }
      const response: PublishResult = {
        message_id: messageId,
        delivery_ids: deliveryIds,
        duplicate: false,
        request_id: input.request_id,
        trace_id: input.trace_id
      };
      await client.query(
        `UPDATE idempotency_keys SET message_id=$4,response=$5::jsonb
         WHERE tenant_id=$1 AND actor_alias=$2 AND idempotency_key=$3`,
        [input.tenant_id, input.actor_alias, input.idempotency_key, messageId, JSON.stringify(response)]
      );
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,trace_id,metadata)
         VALUES($1,$2,'message.publish','allow',$3,$4,$5,$6::jsonb)`,
        [input.tenant_id, input.actor_alias, input.request_id, messageId, input.trace_id,
           JSON.stringify({
             recipients: uniqueRecipients,
             authenticated_session_id: authenticated?.session_id ?? input.session_id,
             authenticated_channel: authenticated?.channel ?? input.channel
           })]
      );
      return response;
    });
  }

  async getMessage(messageId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT m.id,m.version,m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,
              m.body,m.origin,m.lane,m.priority,m.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
         'delivery_id',d.id,'tenant_id',d.recipient_tenant,'alias',d.recipient_alias,
         'status',d.status,'attempt',d.attempt,'terminal_at',d.terminal_at
       ) ORDER BY d.created_at) FILTER (WHERE d.id IS NOT NULL), '[]'::jsonb) AS deliveries
       FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$2 AND source_member.room_id=m.room_id
                   AND source_member.alias=$3 AND source_member.enabled)
         OR (d.recipient_tenant=$2 AND d.recipient_alias=$3)
       )
       WHERE m.id=$1 AND EXISTS (
         SELECT 1 FROM memberships own JOIN role_policies role ON role.role=own.role
         WHERE own.tenant_id=$2 AND own.alias=$3 AND own.enabled AND role.allow_read
       ) AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$2 AND source_member.room_id=m.room_id
                   AND source_member.alias=$3 AND source_member.enabled AND m.tenant_id=$2)
         OR (EXISTS (SELECT 1 FROM deliveries participant
                     WHERE participant.message_id=m.id AND participant.recipient_tenant=$2
                       AND participant.recipient_alias=$3)
             AND (m.tenant_id=$2 OR EXISTS (SELECT 1 FROM acl_edges edge
                         WHERE edge.from_tenant=$2 AND edge.to_tenant=m.tenant_id
                           AND edge.enabled AND edge.allow_read)))
       ) GROUP BY m.id`, [messageId, actorTenant, actorAlias]
    );
    const row = result.rows[0];
    if (!row) throw new StoreError('not_found', 'message not found or not visible');
    return row;
  }

  async acquireLease(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    capabilities: string[],
    ttlMs: number,
    options: LeaseAcquireOptions = {}
  ): Promise<LeaseResult> {
    if (!Number.isFinite(ttlMs) || ttlMs <= 0) throw new StoreError('conflict', 'lease TTL must be positive');
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      // A missing row cannot be protected by SELECT ... FOR UPDATE. The keyed transaction
      // lock serializes the initial insert as well as all later takeovers.
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1,0))`, [
        `connection-lease:${tenantId}:${alias}`
      ]);
      const current = await client.query<{ instance_id: string; epoch: string; lease_until: Date; live: boolean }>(
        `SELECT instance_id,epoch,lease_until,(lease_until > now()) AS live
         FROM connection_leases WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenantId, alias]
      );
      const active = current.rows[0];
      if (active?.live && options.takeover !== true) {
        return {
          acquired: false,
          active_instance_id: active.instance_id,
          lease_expires_at: active.lease_until.toISOString()
        };
      }
      const nextEpoch = active ? Number(active.epoch) + 1 : 1;
      const lease = await client.query<{ lease_until: Date }>(
        `INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at)
         VALUES($1,$2,$3,$4,$5::jsonb,now()+$6*interval '1 millisecond',now(),now())
         ON CONFLICT(tenant_id,alias) DO UPDATE SET
           instance_id=EXCLUDED.instance_id,epoch=EXCLUDED.epoch,capabilities=EXCLUDED.capabilities,
           lease_until=EXCLUDED.lease_until,last_heartbeat_at=now(),connected_at=now()
         RETURNING lease_until`, [tenantId, alias, instanceId, nextEpoch, JSON.stringify(capabilities), ttlMs]
      );
      return { acquired: true, epoch: nextEpoch, lease_expires_at: lease.rows[0]!.lease_until.toISOString() };
    });
  }

  async heartbeat(tenantId: Tenant, alias: string, instanceId: string, epoch: number, ttlMs: number): Promise<string> {
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const result = await client.query<{ lease_until: Date }>(
        `UPDATE connection_leases SET lease_until=now()+$5*interval '1 millisecond',last_heartbeat_at=now()
         WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4 AND lease_until > now()
         RETURNING lease_until`, [tenantId, alias, instanceId, epoch, ttlMs]
      );
      const lease = result.rows[0];
      if (!lease) throw new StoreError('fenced', 'heartbeat rejected by lease fencing');
      return lease.lease_until.toISOString();
    });
  }

  async releaseLease(tenantId: Tenant, alias: string, instanceId: string, epoch: number): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE connection_leases SET lease_until=now()
         WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4`,
        [tenantId, alias, instanceId, epoch]
      );
      await client.query(
        `UPDATE deliveries
         SET ack_deadline_at=LEAST(COALESCE(ack_deadline_at,now()),now()),
             claim_expires_at=now(),updated_at=now()
         WHERE recipient_tenant=$1 AND recipient_alias=$2 AND consumer_instance_id=$3
           AND consumer_epoch=$4 AND status IN ('leased','accepted','started')`,
        [tenantId, alias, instanceId, epoch]
      );
    });
  }

  async listPresence(actorTenant?: Tenant, actorAlias?: string): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT tenant_id,alias,instance_id,epoch,capabilities,last_heartbeat_at,lease_until,
               (lease_until > now()) AS online
        FROM connection_leases l
        WHERE ($1::text IS NULL OR EXISTS (
          SELECT 1 FROM memberships own JOIN role_policies role ON role.role=own.role
          WHERE own.tenant_id=$1 AND own.alias=$2 AND own.enabled AND role.allow_read
        ) AND (l.tenant_id=$1 OR EXISTS (
          SELECT 1 FROM acl_edges a WHERE a.from_tenant=$1 AND a.to_tenant=l.tenant_id
            AND a.enabled AND a.allow_read
        )))
       ORDER BY tenant_id,alias`, [actorTenant ?? null, actorAlias ?? null]
    );
    return result.rows.map((row) => ({ ...row, epoch: Number(row.epoch) }));
  }

  async claimDeliveries(
    tenantId: Tenant,
    alias: string,
    instanceId: string,
    epoch: number,
    limit = 20,
    ackDeadlineMs = 30_000,
    interactiveBurst = 3
  ): Promise<ClaimedDeliveryEnvelope[]> {
    if (limit < 1 || ackDeadlineMs <= 0 || interactiveBurst < 1) {
      throw new StoreError('conflict', 'claim limits and deadlines must be positive');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const lease = await client.query(
        `SELECT 1 FROM connection_leases
         WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4 AND lease_until>now()
         FOR UPDATE`,
        [tenantId, alias, instanceId, epoch]
      );
      if (lease.rowCount !== 1) throw new StoreError('fenced', 'delivery claim rejected by lease fencing');

      await client.query(
        `INSERT INTO delivery_lane_fairness(tenant_id,alias) VALUES($1,$2)
         ON CONFLICT(tenant_id,alias) DO NOTHING`, [tenantId, alias]
      );
      const fairness = await client.query<{ interactive_streak: number }>(
        `SELECT interactive_streak FROM delivery_lane_fairness
         WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenantId, alias]
      );
      let interactiveStreak = fairness.rows[0]?.interactive_streak ?? 0;
      const claimedRows: DeliveryRow[] = [];

      for (let index = 0; index < Math.min(limit, 100); index += 1) {
        const availability = await client.query<{ interactive: boolean; batch: boolean }>(
          `SELECT
             EXISTS(SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
                    WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
                      AND d.status IN ('pending','retry') AND d.available_at<=now()
                      AND m.lane='interactive') AS interactive,
             EXISTS(SELECT 1 FROM deliveries d JOIN messages m ON m.id=d.message_id
                    WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
                      AND d.status IN ('pending','retry') AND d.available_at<=now()
                      AND m.lane='batch') AS batch`, [tenantId, alias]
        );
        const available = availability.rows[0];
        if (!available || (!available.interactive && !available.batch)) break;
        const lane: 'interactive' | 'batch' = available.batch
          && (!available.interactive || interactiveStreak >= interactiveBurst) ? 'batch' : 'interactive';
        const claimed = await client.query<DeliveryRow>(
          `WITH picked AS (
             SELECT d.id FROM deliveries d JOIN messages m ON m.id=d.message_id
             WHERE d.recipient_tenant=$1 AND d.recipient_alias=$2
               AND d.status IN ('pending','retry') AND d.available_at<=now() AND m.lane=$5
             ORDER BY m.priority DESC,d.available_at,d.created_at
             FOR UPDATE OF d SKIP LOCKED LIMIT 1
           ), updated AS (
             UPDATE deliveries d SET status='leased',attempt=d.attempt+1,claimed_at=now(),
               claim_token=gen_random_uuid(),ack_deadline_at=now()+$6*interval '1 millisecond',
               claim_expires_at=now()+$6*interval '1 millisecond',consumer_instance_id=$4,
               consumer_epoch=$3,updated_at=now()
             FROM picked p WHERE d.id=p.id RETURNING d.*
           )
           SELECT u.id,u.message_id,u.recipient_tenant,u.recipient_alias,u.status,u.attempt,u.max_attempts,
                  u.last_ack_rank,u.consumer_instance_id,u.consumer_epoch,u.claim_token,u.ack_deadline_at,
                   m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.origin,
                   m.auth_session_id,m.auth_channel
           FROM updated u JOIN messages m ON m.id=u.message_id`,
          [tenantId, alias, epoch, instanceId, lane, ackDeadlineMs]
        );
        const row = claimed.rows[0];
        if (!row) continue;
        claimedRows.push(row);
        interactiveStreak = lane === 'interactive' ? interactiveStreak + 1 : 0;
      }
      await client.query(
        `UPDATE delivery_lane_fairness SET interactive_streak=$3,updated_at=now()
         WHERE tenant_id=$1 AND alias=$2`, [tenantId, alias, interactiveStreak]
      );

      return claimedRows.map((row) => ({
        type: 'delivery',
        version: PROTOCOL_VERSION,
        delivery_id: row.id,
        event_id: row.id,
        message_id: row.message_id,
        request_id: row.request_id,
        trace_id: row.trace_id,
        epoch,
        attempt: row.attempt,
        claim_token: row.claim_token!,
        ack_deadline_at: row.ack_deadline_at!.toISOString(),
        tenant_id: row.tenant_id,
        room_id: row.room_id,
        actor_alias: row.actor_alias,
        recipient_alias: row.recipient_alias,
        body: row.body,
        ...(row.origin ? { origin: row.origin } : {}),
        ...(row.auth_session_id && row.auth_channel ? {
          authenticated_context: {
            session_id: row.auth_session_id,
            channel: row.auth_channel,
            ...(row.origin ? { origin: row.origin } : {})
          }
        } : {})
      }));
    });
  }

  async ackDelivery(deliveryId: string, tenantId: Tenant, alias: string, ack: Ack): Promise<AckResult> {
    if (!ack.claim_token || !ack.attempt) {
      throw new StoreError('fenced', 'ACK requires claim_token and positive attempt');
    }
    return withTransaction(this.pool, async (client) => {
      await this.assertRuntimeRoute(client, tenantId, alias);
      const selected = await client.query<DeliveryRow & { claim_live: boolean }>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                (d.ack_deadline_at>now()) AS claim_live,
                 m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.origin,
                 m.auth_session_id,m.auth_channel
         FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.id=$1 AND d.recipient_tenant=$2 AND d.recipient_alias=$3 FOR UPDATE OF d`,
        [deliveryId, tenantId, alias]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'delivery not found for consumer');
      const repeated = await client.query(
        `SELECT 1 FROM delivery_acks WHERE event_id=$1 LIMIT 1`, [ack.event_id]
      );
      if (repeated.rowCount) {
        return { delivery_id: deliveryId, status: row.status, applied: false };
      }
      if (row.claim_token === ack.claim_token && row.attempt === ack.attempt &&
          (row.consumer_instance_id !== ack.instance_id || Number(row.consumer_epoch) !== ack.epoch)) {
        throw new StoreError('fenced', 'ACK identity does not own this delivery claim');
      }
      const exactClaim = row.claim_token === ack.claim_token
        && row.attempt === ack.attempt
        && row.claim_live
        && ['leased', 'accepted', 'started'].includes(row.status);
      if (!exactClaim) {
        await this.insertAck(client, row, ack, false);
        return { delivery_id: deliveryId, status: row.status, applied: false };
      }
      const lease = await client.query(
        `SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3
         AND epoch=$4 AND lease_until>now()`, [tenantId, alias, ack.instance_id, ack.epoch]
      );
      if (lease.rowCount !== 1
        || row.consumer_instance_id !== ack.instance_id
        || Number(row.consumer_epoch) !== ack.epoch) {
        await this.insertAck(client, row, ack, false);
        return { delivery_id: deliveryId, status: row.status, applied: false };
      }
      const rank = ackRank(ack.status);
      if (terminal(row.status) || rank <= row.last_ack_rank) {
        await this.insertAck(client, row, ack, false);
        return { delivery_id: deliveryId, status: row.status, applied: false };
      }

      let nextStatus: DeliveryState = ack.status;
      let nextRank = rank;
      let terminalAt = rank === 3 ? 'now()' : 'NULL';
      if (ack.status === 'failed' && ack.retryable) {
        if (row.attempt < row.max_attempts) {
          nextStatus = 'retry';
          nextRank = 0;
          terminalAt = 'NULL';
        } else {
          nextStatus = 'dead';
          terminalAt = 'now()';
        }
      }
      const backoffSeconds = Math.min(60, 2 ** Math.max(0, row.attempt - 1));
      await client.query(
         `UPDATE deliveries SET status=$2,last_ack_rank=$3,last_error=$4,result=$5::jsonb,
            available_at=CASE WHEN $2='retry' THEN now()+$6*interval '1 second' ELSE available_at END,
             claimed_at=CASE WHEN $2='retry' THEN NULL ELSE claimed_at END,
             claim_expires_at=CASE WHEN $2='retry' THEN NULL ELSE claim_expires_at END,
             ack_deadline_at=CASE WHEN $2='retry' THEN NULL ELSE ack_deadline_at END,
             claim_token=CASE WHEN $2='retry' THEN NULL ELSE claim_token END,
             consumer_instance_id=CASE WHEN $2='retry' THEN NULL ELSE consumer_instance_id END,
            consumer_epoch=CASE WHEN $2='retry' THEN NULL ELSE consumer_epoch END,
            terminal_at=${terminalAt},updated_at=now() WHERE id=$1`,
        [deliveryId, nextStatus, nextRank, ack.error ?? null,
          ack.result ? JSON.stringify(ack.result) : null, backoffSeconds]
      );
      if (nextStatus === 'retry') {
        await client.query(
          `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload,available_at)
           VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb,now()+$9*interval '1 second')
           ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
          [tenantId, `wake-retry:${deliveryId}:${row.attempt}`, row.request_id, row.message_id, deliveryId,
            row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
            JSON.stringify({ recipient_alias: alias, reason: 'delivery_available' }), backoffSeconds]
        );
      }
      if (nextStatus === 'dead') {
        await client.query(
          `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
           VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(delivery_id) DO NOTHING`,
          [deliveryId, tenantId, ack.error ?? 'max attempts exhausted', JSON.stringify(row.body), row.attempt]
        );
      }
      await this.insertAck(client, row, ack, true);
      if (terminal(nextStatus)) await this.insertOriginRelay(client, row, nextStatus, ack);
      await client.query(
        `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata)
         VALUES($1,$2,'delivery.ack','allow',$3,$4,$5,$6,$7::jsonb)`,
        [tenantId, alias, row.request_id, row.message_id, deliveryId, row.trace_id,
           JSON.stringify({ ack: ack.status, resulting_status: nextStatus, epoch: ack.epoch, attempt: ack.attempt })]
      );
      return { delivery_id: deliveryId, status: nextStatus, applied: true };
    });
  }

  private async insertAck(client: DatabaseClient, row: DeliveryRow, ack: Ack, applied: boolean): Promise<void> {
    await client.query(
      `INSERT INTO delivery_acks(event_id,delivery_id,status,instance_id,epoch,claim_token,attempt,applied,payload)
       VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb) ON CONFLICT(event_id) DO NOTHING`,
      [ack.event_id, row.id, ack.status, ack.instance_id, ack.epoch, ack.claim_token, ack.attempt, applied,
        JSON.stringify({ retryable: ack.retryable, error: ack.error, result: ack.result })]
    );
  }

  private async insertOriginRelay(
    client: DatabaseClient,
    row: DeliveryRow,
    outcome: string,
    ack: { result?: Record<string, unknown> | undefined; error?: string | undefined }
  ): Promise<void> {
    if (!row.origin) return;
    await client.query(
      `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
       VALUES($1,$2,'origin_relay',$3,$4,$5,$6,$7,$8::jsonb,$9::jsonb)
       ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
      [row.tenant_id, row.origin.adapter, `relay:${row.id}`, row.request_id, row.message_id, row.id,
        row.trace_id, JSON.stringify(row.origin), JSON.stringify({
          outcome, result: ack.result, error: ack.error,
          correlation: { request_id: row.request_id, message_id: row.message_id, delivery_id: row.id, trace_id: row.trace_id }
        })]
    );
  }

  async retryStaleDeliveries(staleMs: number, limit = 100): Promise<{ retried: number; dead: number }> {
    return withTransaction(this.pool, async (client) => {
      const rows = await client.query<DeliveryRow>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,d.status,d.attempt,d.max_attempts,
                d.last_ack_rank,d.consumer_instance_id,d.consumer_epoch,d.claim_token,d.ack_deadline_at,
                 m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,m.body,m.origin,
                 m.auth_session_id,m.auth_channel
          FROM deliveries d JOIN messages m ON m.id=d.message_id
          WHERE d.status IN ('leased','accepted','started')
            AND ($1=0 OR COALESCE(d.ack_deadline_at,d.claim_expires_at,
                                  d.claimed_at+$1*interval '1 millisecond') <= now())
         ORDER BY d.claimed_at FOR UPDATE OF d SKIP LOCKED LIMIT $2`, [staleMs, limit]
      );
      let retried = 0;
      let dead = 0;
      for (const row of rows.rows) {
        if (row.attempt >= row.max_attempts) {
          await client.query(
            `UPDATE deliveries SET status='dead',terminal_at=now(),last_error='ACK timeout: max attempts exhausted',updated_at=now()
             WHERE id=$1`, [row.id]
          );
          await client.query(
            `INSERT INTO dead_letters(delivery_id,tenant_id,reason,payload,attempts)
             VALUES($1,$2,'ACK timeout: max attempts exhausted',$3::jsonb,$4)
             ON CONFLICT(delivery_id) DO NOTHING`, [row.id, row.recipient_tenant, JSON.stringify(row.body), row.attempt]
          );
          await this.insertOriginRelay(client, row, 'dead', {
            error: 'ACK timeout: max attempts exhausted'
          });
          dead += 1;
        } else {
          await client.query(
            `UPDATE deliveries SET status='retry',last_ack_rank=0,claimed_at=NULL,claim_expires_at=NULL,
              ack_deadline_at=NULL,claim_token=NULL,consumer_instance_id=NULL,consumer_epoch=NULL,
              available_at=now(),last_error='ACK timeout',updated_at=now() WHERE id=$1`, [row.id]
          );
          await client.query(
            `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
             VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
             ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
            [row.recipient_tenant, `wake-timeout:${row.id}:${row.attempt}`, row.request_id, row.message_id,
              row.id, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
              JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' })]
          );
          retried += 1;
        }
      }
      return { retried, dead };
    });
  }

  async claimOutbox(
    kind: 'wake' | 'origin_relay',
    worker: string,
    limit = 50,
    leaseMs = 30_000,
    adapter?: string
  ): Promise<ClaimedOutboxEvent[]> {
    if (leaseMs <= 0 || limit < 1) throw new StoreError('conflict', 'outbox lease and limit must be positive');
    return withTransaction(this.pool, async (client) => {
      // Expired final attempts cannot be claimed again, but they must not remain processing
      // forever. Move them to the durable DLQ in the same transaction as the next claim.
      await client.query(
        `WITH expired AS (
           SELECT id FROM adapter_outbox
           WHERE kind=$1 AND status='processing'
             AND COALESCE(claim_expires_at,claimed_at,created_at)<=now()
             AND attempts>=max_attempts AND ($3::text IS NULL OR adapter=$3)
           ORDER BY claim_expires_at FOR UPDATE SKIP LOCKED LIMIT $2
         ), dead AS (
           UPDATE adapter_outbox outbox SET status='dead',dead_at=now(),claim_expires_at=NULL,
             last_error='outbox lease expired: max attempts exhausted'
           FROM expired WHERE outbox.id=expired.id
           RETURNING outbox.id,outbox.tenant_id,outbox.adapter,outbox.kind,
                     outbox.payload,outbox.attempts,outbox.last_error
         )
         INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
         SELECT id,tenant_id,adapter,kind,last_error,payload,attempts FROM dead
         ON CONFLICT(outbox_id) DO NOTHING`,
        [kind, Math.min(limit, 100), adapter ?? null]
      );
      const result = await client.query<ClaimedOutboxEvent>(
        `WITH picked AS (
           SELECT id FROM adapter_outbox
            WHERE kind=$1 AND (
                (status IN ('pending','failed') AND available_at<=now())
                OR (status='processing' AND COALESCE(claim_expires_at,claimed_at,created_at)<=now())
              )
              AND attempts<max_attempts AND ($5::text IS NULL OR adapter=$5)
            ORDER BY CASE WHEN status='processing' THEN claim_expires_at ELSE available_at END,created_at
            FOR UPDATE SKIP LOCKED LIMIT $3
           )
           UPDATE adapter_outbox o SET status='processing',attempts=o.attempts+1,claimed_at=now(),
            claimed_by=$2,claim_token=gen_random_uuid(),
            claim_expires_at=now()+$4*interval '1 millisecond',last_error=NULL
          FROM picked p WHERE o.id=p.id
          RETURNING o.id,o.id AS event_id,o.tenant_id,o.adapter,o.kind,o.request_id,o.message_id,o.delivery_id,
                    o.trace_id,o.origin,o.payload,o.attempts,o.max_attempts,o.claimed_by,
                    o.claim_token,o.claim_expires_at,o.attempts AS attempt`,
        [kind, worker, limit, leaseMs, adapter ?? null]
      );
      return result.rows;
    });
  }

  async ackOutbox(ack: OutboxAck): Promise<{ status: 'sent' | 'failed' | 'dead'; applied: boolean }> {
    if (!Number.isInteger(ack.attempt) || ack.attempt < 1 || !ack.claim_token) {
      throw new StoreError('fenced', 'outbox ACK requires claim token and positive attempt');
    }
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string; tenant_id: Tenant; adapter: string; kind: string; payload: Record<string, unknown>;
        attempts: number; max_attempts: number;
      }>(
        `SELECT id,tenant_id,adapter,kind,payload,attempts,max_attempts
         FROM adapter_outbox WHERE id=$1 AND status='processing' AND claim_token=$2
           AND attempts=$3 AND claim_expires_at>now() FOR UPDATE`,
        [ack.event_id, ack.claim_token, ack.attempt]
      );
      const event = selected.rows[0];
      if (!event) return { status: 'failed', applied: false };
      if (ack.status === 'sent') {
        await client.query(
          `UPDATE adapter_outbox SET status='sent',sent_at=now(),claim_expires_at=NULL WHERE id=$1`,
          [event.id]
        );
        return { status: 'sent', applied: true };
      }
      const reason = (ack.error ?? (ack.status === 'dead' ? 'worker rejected outbox event' : 'outbox retry')).slice(0, 2_000);
      if (ack.status === 'dead' || event.attempts >= event.max_attempts) {
        await client.query(
          `UPDATE adapter_outbox SET status='dead',dead_at=now(),claim_expires_at=NULL,last_error=$2
           WHERE id=$1`, [event.id, reason]
        );
        await client.query(
          `INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(outbox_id) DO NOTHING`,
          [event.id, event.tenant_id, event.adapter, event.kind, reason,
            JSON.stringify(event.payload), event.attempts]
        );
        return { status: 'dead', applied: true };
      }
      await client.query(
        `UPDATE adapter_outbox SET status='failed',available_at=now()+$2*interval '1 millisecond',
           claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,last_error=$3 WHERE id=$1`,
        [event.id, Math.max(0, ack.retry_after_ms ?? 250), reason]
      );
      return { status: 'failed', applied: true };
    });
  }

  async completeOutbox(id: string, worker?: string, claimToken?: string): Promise<boolean> {
    if (!worker || !claimToken) return false;
    const result = await this.pool.query(
      `UPDATE adapter_outbox SET status='sent',sent_at=now(),claim_expires_at=NULL
       WHERE id=$1 AND status='processing' AND claimed_by=$2 AND claim_token=$3
         AND claim_expires_at>now()`, [id, worker, claimToken]
    );
    return result.rowCount === 1;
  }

  async retryOutbox(
    id: string,
    worker?: string,
    claimToken?: string,
    delayMs = 250,
    error = 'outbox delivery failed'
  ): Promise<OutboxRetryResult> {
    if (!worker || !claimToken) return 'fenced';
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string; tenant_id: Tenant; adapter: string; kind: string;
        payload: Record<string, unknown>; attempts: number; max_attempts: number;
      }>(
        `SELECT id,tenant_id,adapter,kind,payload,attempts,max_attempts
         FROM adapter_outbox WHERE id=$1 AND status='processing' AND claimed_by=$2
           AND claim_token=$3 AND claim_expires_at>now() FOR UPDATE`,
        [id, worker, claimToken]
      );
      const event = selected.rows[0];
      if (!event) return 'fenced';
      const reason = error.slice(0, 2_000);
      if (event.attempts >= event.max_attempts) {
        await client.query(
          `UPDATE adapter_outbox SET status='dead',dead_at=now(),claim_expires_at=NULL,
             last_error=$2 WHERE id=$1`, [id, reason]
        );
        await client.query(
          `INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
           VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(outbox_id) DO NOTHING`,
          [id, event.tenant_id, event.adapter, event.kind, reason, JSON.stringify(event.payload), event.attempts]
        );
        return 'dead';
      }
      await client.query(
        `UPDATE adapter_outbox SET status='failed',available_at=now()+$2*interval '1 millisecond',
           claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,last_error=$3
         WHERE id=$1`, [id, Math.max(0, delayMs), reason]
      );
      return 'retry';
    });
  }

  async retryExpiredOutbox(limit = 100): Promise<{ retried: number; dead: number }> {
    return withTransaction(this.pool, async (client) => {
      const expired = await client.query<{
        id: string; tenant_id: Tenant; adapter: string; kind: string;
        payload: Record<string, unknown>; attempts: number; max_attempts: number;
      }>(
        `SELECT id,tenant_id,adapter,kind,payload,attempts,max_attempts
          FROM adapter_outbox WHERE status='processing'
            AND COALESCE(claim_expires_at,claimed_at,created_at)<=now()
          ORDER BY COALESCE(claim_expires_at,claimed_at,created_at)
          FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]
      );
      let retried = 0;
      let dead = 0;
      for (const event of expired.rows) {
        if (event.attempts >= event.max_attempts) {
          const reason = 'outbox lease expired: max attempts exhausted';
          await client.query(
            `UPDATE adapter_outbox SET status='dead',dead_at=now(),claim_expires_at=NULL,
               last_error=$2 WHERE id=$1`, [event.id, reason]
          );
          await client.query(
            `INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
             VALUES($1,$2,$3,$4,$5,$6::jsonb,$7) ON CONFLICT(outbox_id) DO NOTHING`,
            [event.id, event.tenant_id, event.adapter, event.kind, reason,
              JSON.stringify(event.payload), event.attempts]
          );
          dead += 1;
        } else {
          await client.query(
            `UPDATE adapter_outbox SET status='failed',available_at=now(),claimed_by=NULL,
               claim_token=NULL,claim_expires_at=NULL,last_error='outbox lease expired'
             WHERE id=$1`, [event.id]
          );
          retried += 1;
        }
      }
      return { retried, dead };
    });
  }

  async listOutbox(kind?: 'wake' | 'origin_relay'): Promise<Array<Record<string, unknown>>> {
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id,tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,
              origin,payload,status,attempts,max_attempts,available_at,claimed_by,claimed_at,
              claim_expires_at,last_error,created_at,sent_at,dead_at
       FROM adapter_outbox WHERE ($1::text IS NULL OR kind=$1) ORDER BY created_at`, [kind ?? null]
    );
    return result.rows;
  }

  async status(actorTenant?: Tenant, actorAlias?: string, outboxStuckAfterMs = 60_000): Promise<Record<string, number>> {
    if (!Number.isFinite(outboxStuckAfterMs) || outboxStuckAfterMs < 0) {
      throw new StoreError('conflict', 'outbox stuck threshold must be non-negative');
    }
    if (actorTenant !== undefined && actorAlias !== undefined) {
      await this.assertPermission(actorTenant, actorAlias, 'read');
    }
    const result = await this.pool.query<{
      online: string; queued: string; dead: string; outbox: string;
      outbox_stuck_wake: string; outbox_stuck_origin_relay: string;
    }>(
      `SELECT
        (SELECT count(*) FROM connection_leases l WHERE lease_until>now() AND ($1::text IS NULL OR l.tenant_id=$1 OR EXISTS (
           SELECT 1 FROM acl_edges a WHERE a.from_tenant=$1 AND a.to_tenant=l.tenant_id
             AND a.enabled AND a.allow_read))) AS online,
        (SELECT count(*) FROM deliveries d JOIN messages m ON m.id=d.message_id
         WHERE d.status IN ('pending','retry','leased','accepted','started') AND ($1::text IS NULL
           OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                AND source_member.room_id=m.room_id AND source_member.alias=$2
                AND source_member.enabled AND m.tenant_id=$1)
           OR (d.recipient_tenant=$1 AND d.recipient_alias=$2 AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read))))) AS queued,
        (SELECT count(*) FROM dead_letters dl
         LEFT JOIN deliveries d ON d.id=dl.delivery_id LEFT JOIN messages m ON m.id=d.message_id
         LEFT JOIN jobs j ON j.id=dl.job_id
         WHERE dl.resolved_at IS NULL AND ($1::text IS NULL OR j.tenant_id=$1
           OR (d.recipient_tenant=$1 AND d.recipient_alias=$2)
           OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                AND source_member.room_id=m.room_id AND source_member.alias=$2
                AND source_member.enabled AND m.tenant_id=$1))) AS dead,
        (SELECT count(*) FROM adapter_outbox o JOIN messages m ON m.id=o.message_id
         WHERE o.status IN ('pending','failed','processing') AND ($1::text IS NULL
            OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                 AND source_member.room_id=m.room_id AND source_member.alias=$2
                 AND source_member.enabled AND m.tenant_id=$1)
            OR EXISTS (SELECT 1 FROM deliveries participant WHERE participant.id=o.delivery_id
                 AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2))) AS outbox,
        (SELECT count(*) FROM adapter_outbox o JOIN messages m ON m.id=o.message_id
         WHERE o.kind='wake' AND (
             (o.status='processing' AND COALESCE(o.claim_expires_at,o.claimed_at,o.created_at)<=now())
             OR (o.status IN ('pending','failed')
                 AND o.available_at<=now()-$3*interval '1 millisecond')
           ) AND ($1::text IS NULL
            OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                 AND source_member.room_id=m.room_id AND source_member.alias=$2
                 AND source_member.enabled AND m.tenant_id=$1)
            OR EXISTS (SELECT 1 FROM deliveries participant WHERE participant.id=o.delivery_id
                 AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2))) AS outbox_stuck_wake,
        (SELECT count(*) FROM adapter_outbox o JOIN messages m ON m.id=o.message_id
         WHERE o.kind='origin_relay' AND (
             (o.status='processing' AND COALESCE(o.claim_expires_at,o.claimed_at,o.created_at)<=now())
             OR (o.status IN ('pending','failed')
                 AND o.available_at<=now()-$3*interval '1 millisecond')
           ) AND ($1::text IS NULL
            OR EXISTS (SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
                 AND source_member.room_id=m.room_id AND source_member.alias=$2
                 AND source_member.enabled AND m.tenant_id=$1)
            OR EXISTS (SELECT 1 FROM deliveries participant WHERE participant.id=o.delivery_id
                 AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2))) AS outbox_stuck_origin_relay`,
      [actorTenant ?? null, actorAlias ?? null, outboxStuckAfterMs]
    );
    const row = result.rows[0]!;
    return {
      online: Number(row.online),
      queued: Number(row.queued),
      dead_letters: Number(row.dead),
      outbox_pending: Number(row.outbox),
      outbox_stuck_wake: Number(row.outbox_stuck_wake),
      outbox_stuck_origin_relay: Number(row.outbox_stuck_origin_relay)
    };
  }

  async enqueueJob(tenantId: Tenant, lane: 'interactive' | 'batch', priority: number, kind: string, payload: Record<string, unknown>): Promise<string> {
    const result = await this.pool.query<{ id: string }>(
      `INSERT INTO jobs(tenant_id,lane,priority,kind,payload) VALUES($1,$2,$3,$4,$5::jsonb) RETURNING id`,
      [tenantId, lane, priority, kind, JSON.stringify(payload)]
    );
    return result.rows[0]!.id;
  }

  async claimJobs(lane: 'interactive' | 'batch', worker: string, limit = 1, leaseMs = 30_000): Promise<JobClaim[]> {
    if (limit < 1 || leaseMs <= 0) throw new StoreError('conflict', 'job lease and limit must be positive');
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<JobClaim>(
        `WITH picked AS (
           SELECT id FROM jobs WHERE lane=$1 AND status='queued' AND available_at<=now()
            ORDER BY priority DESC,created_at FOR UPDATE SKIP LOCKED LIMIT $3
          ) UPDATE jobs j SET status='running',attempts=j.attempts+1,claimed_by=$2,claimed_at=now(),
              claim_token=gen_random_uuid(),lease_until=now()+$4*interval '1 millisecond',updated_at=now()
            FROM picked p WHERE j.id=p.id RETURNING j.*`, [lane, worker, limit, leaseMs]
      );
      return result.rows;
    });
  }

  async claimFairJobs(
    worker: string,
    limit = 1,
    leaseMs = 30_000,
    interactiveBurst = 3,
    scope = 'global'
  ): Promise<JobClaim[]> {
    if (limit < 1 || leaseMs <= 0 || interactiveBurst < 1) {
      throw new StoreError('conflict', 'fair job claim limits must be positive');
    }
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO job_lane_fairness(scope) VALUES($1) ON CONFLICT(scope) DO NOTHING`, [scope]
      );
      const fairness = await client.query<{ interactive_streak: number }>(
        `SELECT interactive_streak FROM job_lane_fairness WHERE scope=$1 FOR UPDATE`, [scope]
      );
      let interactiveStreak = fairness.rows[0]?.interactive_streak ?? 0;
      const jobs: JobClaim[] = [];
      for (let index = 0; index < Math.min(limit, 100); index += 1) {
        const availability = await client.query<{ interactive: boolean; batch: boolean }>(
          `SELECT
             EXISTS(SELECT 1 FROM jobs WHERE lane='interactive' AND status='queued' AND available_at<=now()) AS interactive,
             EXISTS(SELECT 1 FROM jobs WHERE lane='batch' AND status='queued' AND available_at<=now()) AS batch`
        );
        const available = availability.rows[0];
        if (!available || (!available.interactive && !available.batch)) break;
        const lane: 'interactive' | 'batch' = available.batch
          && (!available.interactive || interactiveStreak >= interactiveBurst) ? 'batch' : 'interactive';
        const claimed = await client.query<JobClaim>(
          `WITH picked AS (
             SELECT id FROM jobs WHERE lane=$1 AND status='queued' AND available_at<=now()
             ORDER BY priority DESC,created_at FOR UPDATE SKIP LOCKED LIMIT 1
           ) UPDATE jobs j SET status='running',attempts=j.attempts+1,claimed_by=$2,
               claimed_at=now(),claim_token=gen_random_uuid(),
               lease_until=now()+$3*interval '1 millisecond',updated_at=now()
             FROM picked p WHERE j.id=p.id RETURNING j.*`, [lane, worker, leaseMs]
        );
        const job = claimed.rows[0];
        if (!job) continue;
        jobs.push(job);
        interactiveStreak = lane === 'interactive' ? interactiveStreak + 1 : 0;
      }
      await client.query(
        `UPDATE job_lane_fairness SET interactive_streak=$2,updated_at=now() WHERE scope=$1`,
        [scope, interactiveStreak]
      );
      return jobs;
    });
  }

  async completeJob(id: string, worker: string, claimToken?: string): Promise<boolean> {
    if (!claimToken) return false;
    const result = await this.pool.query(
      `UPDATE jobs SET status='done',lease_until=NULL,updated_at=now()
       WHERE id=$1 AND claimed_by=$2 AND claim_token=$3 AND status='running' AND lease_until>now()`,
      [id, worker, claimToken]
    );
    return result.rowCount === 1;
  }

  async failJob(id: string, worker: string, error: string, claimToken?: string): Promise<'retry' | 'dead' | 'fenced'> {
    if (!claimToken) return 'fenced';
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<{
        id: string; tenant_id: Tenant; payload: Record<string, unknown>; attempts: number; max_attempts: number;
      }>(
        `SELECT id,tenant_id,payload,attempts,max_attempts FROM jobs
         WHERE id=$1 AND claimed_by=$2 AND claim_token=$3 AND status='running'
           AND lease_until>now() FOR UPDATE`, [id, worker, claimToken]
      );
      const job = result.rows[0];
      if (!job) return 'fenced';
      if (job.attempts >= job.max_attempts) {
        await client.query(
          `UPDATE jobs SET status='dead',lease_until=NULL,claim_token=NULL,last_error=$2,updated_at=now()
           WHERE id=$1`,
          [id, error.slice(0, 2_000)]
        );
        await client.query(
          `INSERT INTO dead_letters(job_id,tenant_id,reason,payload,attempts)
           VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(job_id) DO NOTHING`,
          [id, job.tenant_id, error.slice(0, 2_000), JSON.stringify(job.payload), job.attempts]
        );
        return 'dead';
      }
      const backoffSeconds = Math.min(300, 2 ** Math.max(0, job.attempts - 1));
      await client.query(
         `UPDATE jobs SET status='queued',available_at=now()+$2*interval '1 second',last_error=$3,
            claimed_by=NULL,claimed_at=NULL,claim_token=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`,
        [id, backoffSeconds, error.slice(0, 2_000)]
      );
      return 'retry';
    });
  }

  async retryExpiredJobs(limit = 100): Promise<number> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query<{ id: string; attempts: number; max_attempts: number; tenant_id: Tenant; payload: Record<string, unknown> }>(
        `SELECT id,attempts,max_attempts,tenant_id,payload FROM jobs
         WHERE status='running' AND lease_until<now()
         ORDER BY lease_until FOR UPDATE SKIP LOCKED LIMIT $1`, [limit]
      );
      for (const job of result.rows) {
        if (job.attempts >= job.max_attempts) {
          await client.query(
            `UPDATE jobs SET status='dead',lease_until=NULL,claim_token=NULL,
             last_error='job lease expired: max attempts exhausted',
             updated_at=now() WHERE id=$1`, [job.id]
          );
          await client.query(
            `INSERT INTO dead_letters(job_id,tenant_id,reason,payload,attempts)
             VALUES($1,$2,'job lease expired: max attempts exhausted',$3::jsonb,$4)
             ON CONFLICT(job_id) DO NOTHING`, [job.id, job.tenant_id, JSON.stringify(job.payload), job.attempts]
          );
        } else {
          const delay = Math.min(300, 2 ** Math.max(0, job.attempts - 1));
          await client.query(
            `UPDATE jobs SET status='queued',available_at=now()+$2*interval '1 second',
              last_error='job lease expired',claimed_by=NULL,claim_token=NULL,
             claimed_at=NULL,lease_until=NULL,updated_at=now() WHERE id=$1`, [job.id, delay]
          );
        }
      }
      return result.rows.length;
    });
  }

  private async assertRuntimeRoute(client: DatabaseClient, tenantId: Tenant, alias: string): Promise<void> {
    const memberships = await client.query<{ allow_route: boolean }>(
      `SELECT policy.allow_route FROM memberships membership
       JOIN role_policies policy ON policy.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled
       FOR SHARE OF membership,policy,tenant,room`,
      [tenantId, alias]
    );
    if (memberships.rowCount === 0) {
      throw new StoreError('invalid_actor', 'consumer alias is not an enabled member');
    }
    if (!memberships.rows.some((membership) => membership.allow_route)) {
      throw new StoreError('forbidden', 'consumer route permission has been revoked');
    }
  }

  async assertPrincipal(tenantId: Tenant, alias: string): Promise<void> {
    const result = await this.pool.query(
      `SELECT 1 FROM memberships m JOIN tenants t ON t.id=m.tenant_id
       JOIN rooms r ON r.id=m.room_id AND r.tenant_id=m.tenant_id
       WHERE m.tenant_id=$1 AND m.alias=$2 AND m.enabled AND t.enabled AND r.enabled LIMIT 1`,
      [tenantId, alias]
    );
    if (result.rowCount !== 1) throw new StoreError('invalid_actor', 'authenticated principal is not enabled');
  }

  async assertPermission(tenantId: Tenant, alias: string, permission: 'route' | 'read' | 'control'): Promise<void> {
    const column = permission === 'route' ? 'allow_route' : permission === 'read' ? 'allow_read' : 'allow_control';
    const result = await this.pool.query(
      `SELECT 1 FROM memberships membership
       JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled AND role.${column} LIMIT 1`, [tenantId, alias]
    );
    if (result.rowCount !== 1) throw new StoreError('forbidden', `principal lacks ${permission} permission`);
  }

  async principalAccess(tenantId: Tenant, alias: string): Promise<{
    roles: string[]; permissions: Array<'route' | 'read' | 'control'>;
  }> {
    const result = await this.pool.query<{
      roles: string[]; allow_route: boolean; allow_read: boolean; allow_control: boolean;
    }>(
      `SELECT array_agg(DISTINCT membership.role ORDER BY membership.role) AS roles,
              bool_or(role.allow_route) AS allow_route,bool_or(role.allow_read) AS allow_read,
              bool_or(role.allow_control) AS allow_control
       FROM memberships membership JOIN role_policies role ON role.role=membership.role
       JOIN tenants tenant ON tenant.id=membership.tenant_id
       JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
       WHERE membership.tenant_id=$1 AND membership.alias=$2 AND membership.enabled
         AND tenant.enabled AND room.enabled`, [tenantId, alias]
    );
    const row = result.rows[0];
    if (!row?.roles?.length) throw new StoreError('invalid_actor', 'authenticated principal is not enabled');
    return {
      roles: row.roles,
      permissions: [
        ...(row.allow_route ? ['route' as const] : []),
        ...(row.allow_read ? ['read' as const] : []),
        ...(row.allow_control ? ['control' as const] : [])
      ]
    };
  }

  async getConfiguration(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    try {
      return await new ConfigurationRepository(this.pool).get(actorTenant, actorAlias);
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

  async applyConfigurationChange(
    actorTenant: Tenant,
    actorAlias: string,
    mutation: ConfigMutation,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    try {
      return await new ConfigurationRepository(this.pool).apply(
        actorTenant, actorAlias, mutation, dryRun, expectedRevision
      );
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

  async rollbackConfiguration(
    actorTenant: Tenant,
    actorAlias: string,
    revisionId: number,
    dryRun: boolean,
    expectedRevision?: number
  ): Promise<ConfigurationChangeResult> {
    try {
      return await new ConfigurationRepository(this.pool).rollback(
        actorTenant, actorAlias, revisionId, dryRun, expectedRevision
      );
    } catch (error) {
      this.rethrowConfigurationError(error);
    }
  }

  private rethrowConfigurationError(error: unknown): never {
    if (error instanceof ConfigurationError) {
      throw new StoreError(error.code, error.message);
    }
    throw error;
  }

  async topology(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const [tenants, edges] = await Promise.all([
      this.pool.query<Record<string, unknown>>(
        `SELECT t.id,COALESCE(t.display_name,t.id) AS label,t.is_hub,t.enabled,COALESCE((
           SELECT jsonb_agg(jsonb_build_object(
              'id',r.id,'label',COALESCE(r.display_name,r.id),'enabled',r.enabled,'members',COALESCE((
                SELECT jsonb_agg(jsonb_build_object('alias',m.alias,'role',m.role,'enabled',m.enabled) ORDER BY m.alias)
               FROM memberships m WHERE m.tenant_id=t.id AND m.room_id=r.id
             ),'[]'::jsonb)
           ) ORDER BY r.id) FROM rooms r WHERE r.tenant_id=t.id
         ),'[]'::jsonb) AS rooms
          FROM tenants t WHERE t.id=$1 OR EXISTS (
            SELECT 1 FROM acl_edges a WHERE a.from_tenant=$1 AND a.to_tenant=t.id
              AND a.enabled AND a.allow_read
          ) ORDER BY t.id`, [actorTenant]
      ),
      this.pool.query<Record<string, unknown>>(
        `SELECT from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control,
                'explicit'::text AS policy FROM acl_edges
         WHERE (from_tenant=$1 OR to_tenant=$1) AND allow_read
         ORDER BY from_tenant,to_tenant`, [actorTenant]
      )
    ]);
    return { observed_at: new Date().toISOString(), tenants: tenants.rows, acl_edges: edges.rows };
  }

  async listMessages(actorTenant: Tenant, actorAlias: string, limit = 100): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT m.id AS message_id,m.request_id,m.trace_id,m.tenant_id,m.room_id,m.actor_alias,
              left(COALESCE(m.body->>'text',m.body->>'prompt',m.body::text),240) AS body_preview,
              m.lane,m.created_at,
              COALESCE(jsonb_agg(jsonb_build_object(
                'delivery_id',d.id,'recipient_tenant',d.recipient_tenant,'recipient_alias',d.recipient_alias,
                'status',d.status,'attempt',d.attempt,
                'timeline',(SELECT COALESCE(jsonb_agg(event ORDER BY at),'[]'::jsonb) FROM (
                  SELECT jsonb_build_object('status','published','at',m.created_at,'attempt',0) AS event,m.created_at AS at
                  UNION ALL
                  SELECT jsonb_build_object('status',a.status,'at',a.created_at,'attempt',d.attempt,
                    'detail',CASE WHEN a.applied THEN NULL ELSE 'duplicate_or_out_of_order' END),a.created_at
                  FROM delivery_acks a WHERE a.delivery_id=d.id
                ) timeline_events)
              ) ORDER BY d.created_at) FILTER (WHERE d.id IS NOT NULL),'[]'::jsonb) AS deliveries
       FROM messages m LEFT JOIN deliveries d ON d.message_id=m.id AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                   AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
         OR (d.recipient_tenant=$1 AND d.recipient_alias=$2)
       )
       WHERE EXISTS (SELECT 1 FROM memberships source_member
                     WHERE source_member.tenant_id=$1 AND source_member.room_id=m.room_id
                       AND source_member.alias=$2 AND source_member.enabled AND m.tenant_id=$1)
          OR (EXISTS (SELECT 1 FROM deliveries participant
                      WHERE participant.message_id=m.id AND participant.recipient_tenant=$1
                        AND participant.recipient_alias=$2)
              AND (m.tenant_id=$1 OR EXISTS (
                SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1 AND edge.to_tenant=m.tenant_id
                  AND edge.enabled AND edge.allow_read
              )))
       GROUP BY m.id ORDER BY m.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    return { items: result.rows, next_cursor: null };
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
    const counts = result.rows.reduce<{ pending: number; retrying: number; dead: number }>((value, row) => {
      if (row.state === 'retry') value.retrying += 1;
      if (row.state === 'dead') value.dead += 1;
      if (['pending', 'leased', 'accepted', 'started'].includes(String(row.state))) value.pending += 1;
      return value;
    }, { pending: 0, retrying: 0, dead: 0 });
    return { observed_at: new Date().toISOString(), ...counts, items: result.rows };
  }

  async replayDelivery(deliveryId: string, actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'control');
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<{
        id: string; message_id: string; recipient_tenant: Tenant; recipient_alias: string;
        request_id: string; trace_id: string; origin: Origin | null;
      }>(
        `SELECT d.id,d.message_id,d.recipient_tenant,d.recipient_alias,m.request_id,m.trace_id,m.origin
         FROM deliveries d JOIN messages m ON m.id=d.message_id
          WHERE d.id=$1 AND d.status='dead' AND (
            d.recipient_tenant=$2
            OR (m.tenant_id=$2 AND EXISTS (
              SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$2
                AND source_member.room_id=m.room_id AND source_member.alias=$3 AND source_member.enabled
            ))
            OR EXISTS (SELECT 1 FROM acl_edges edge
                       WHERE edge.from_tenant=$2 AND edge.to_tenant=d.recipient_tenant
                         AND edge.enabled AND edge.allow_control)
          ) FOR UPDATE OF d`, [deliveryId, actorTenant, actorAlias]
      );
      const row = selected.rows[0];
      if (!row) throw new StoreError('not_found', 'dead delivery not found or not visible');
      await client.query(
         `UPDATE deliveries SET status='retry',attempt=0,last_ack_rank=0,available_at=now(),claimed_at=NULL,
            claim_expires_at=NULL,ack_deadline_at=NULL,claim_token=NULL,
            consumer_instance_id=NULL,consumer_epoch=NULL,terminal_at=NULL,updated_at=now()
         WHERE id=$1`, [deliveryId]
      );
      await client.query(`UPDATE dead_letters SET resolved_at=now() WHERE delivery_id=$1 AND resolved_at IS NULL`, [deliveryId]);
      await client.query(
        `INSERT INTO adapter_outbox(tenant_id,adapter,kind,idempotency_key,request_id,message_id,delivery_id,trace_id,origin,payload)
         VALUES($1,'gateway','wake',$2,$3,$4,$5,$6,$7::jsonb,$8::jsonb)
         ON CONFLICT(tenant_id,adapter,idempotency_key) DO NOTHING`,
        [row.recipient_tenant, `wake-replay:${deliveryId}:${Date.now()}`, row.request_id, row.message_id,
          deliveryId, row.trace_id, row.origin ? JSON.stringify(row.origin) : null,
          JSON.stringify({ recipient_alias: row.recipient_alias, reason: 'delivery_available' })]
      );
      await client.query('SELECT pg_notify($1,$2)', [
        'cauce_delivery_wake', JSON.stringify({ tenant_id: row.recipient_tenant, alias: row.recipient_alias })
      ]);
      return { delivery_id: deliveryId, state: 'retry', replayed: true };
    });
  }

  async listJobs(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT id AS job_id,tenant_id,lane,kind,status,priority,attempts,claimed_by,claimed_at,created_at,updated_at
       FROM jobs WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT $2`, [actorTenant, limit]
    );
    return { items: result.rows };
  }

  async listAdapters(actorTenant: Tenant, actorAlias: string): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const [rows, definitions] = await Promise.all([
      this.listPresence(actorTenant, actorAlias),
      this.pool.query<{
        id: string; display_name: string; capabilities: string[]; enabled: boolean; updated_at: Date;
      }>(`SELECT id,display_name,capabilities,enabled,updated_at FROM harness_definitions ORDER BY id`)
    ]);
    const configured = definitions.rows.map((definition) => {
      const observed = rows.find((row) => Array.isArray(row.capabilities) &&
        row.capabilities.includes(`harness.${definition.id}`));
      return {
        id: definition.id,
        label: definition.display_name,
        state: observed?.online === true && definition.enabled ? 'available'
          : observed ? 'unavailable' : 'unknown',
        capabilities: definition.capabilities,
        protocol_version: PROTOCOL_VERSION,
        last_seen_at: observed?.last_heartbeat_at ?? null,
        detail: observed ? (observed.online === true ? 'active lease' : 'expired lease') : 'no matching runtime capability observed'
      };
    });
    const unregistered = rows.filter((row) => !definitions.rows.some((definition) =>
      Array.isArray(row.capabilities) && row.capabilities.includes(`harness.${definition.id}`)
    ));
    return {
      items: [...configured, ...unregistered.map((row) => ({
        id: `${String(row.tenant_id)}:${String(row.alias)}`,
        label: row.alias,
        state: row.online === true ? 'available' : 'unavailable',
        capabilities: row.capabilities,
        protocol_version: PROTOCOL_VERSION,
        last_seen_at: row.last_heartbeat_at,
        detail: row.online === true ? 'active lease' : 'expired lease'
      }))]
    };
  }

  async listOriginRelays(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT outbox.id,outbox.tenant_id,outbox.adapter,outbox.request_id,outbox.message_id,
              outbox.delivery_id,outbox.trace_id,outbox.origin,outbox.payload,outbox.status,
              outbox.attempts,outbox.created_at,outbox.sent_at,message.actor_alias,
              message.tenant_id AS message_tenant_id,delivery.recipient_tenant,delivery.recipient_alias
       FROM adapter_outbox outbox JOIN messages message ON message.id=outbox.message_id
       LEFT JOIN deliveries delivery ON delivery.id=outbox.delivery_id
       WHERE outbox.kind='origin_relay' AND (
         EXISTS (SELECT 1 FROM memberships source_member
                 WHERE source_member.tenant_id=$1 AND source_member.room_id=message.room_id
                   AND source_member.alias=$2 AND source_member.enabled AND message.tenant_id=$1)
         OR (EXISTS (SELECT 1 FROM deliveries participant
                     WHERE participant.id=outbox.delivery_id AND participant.recipient_tenant=$1
                       AND participant.recipient_alias=$2)
             AND (message.tenant_id=$1 OR EXISTS (
               SELECT 1 FROM acl_edges edge WHERE edge.from_tenant=$1
                 AND edge.to_tenant=message.tenant_id AND edge.enabled AND edge.allow_read
             )))
       ) ORDER BY outbox.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    return { items: result.rows };
  }

  async listAudit(actorTenant: Tenant, actorAlias: string, limit = 200): Promise<Record<string, unknown>> {
    await this.assertPermission(actorTenant, actorAlias, 'read');
    const result = await this.pool.query<Record<string, unknown>>(
      `SELECT audit.id AS event_id,audit.created_at AS at,audit.tenant_id,audit.actor_alias,
              audit.action,audit.decision,audit.request_id,audit.trace_id,left(audit.metadata::text,500) AS summary
       FROM audit_events audit
       LEFT JOIN messages message ON message.id=audit.message_id
       WHERE (audit.tenant_id=$1 AND audit.actor_alias=$2)
          OR (message.id IS NOT NULL AND EXISTS (
            SELECT 1 FROM memberships source_member WHERE source_member.tenant_id=$1
              AND source_member.room_id=message.room_id AND source_member.alias=$2
              AND source_member.enabled AND message.tenant_id=$1
          ))
          OR (audit.delivery_id IS NOT NULL AND EXISTS (
            SELECT 1 FROM deliveries participant WHERE participant.id=audit.delivery_id
              AND participant.recipient_tenant=$1 AND participant.recipient_alias=$2
          ))
       ORDER BY audit.created_at DESC LIMIT $3`, [actorTenant, actorAlias, limit]
    );
    return { items: result.rows };
  }
}
