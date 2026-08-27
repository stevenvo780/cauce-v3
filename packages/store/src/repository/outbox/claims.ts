import type { Tenant } from '@cauce/protocol';
import { AliasSchema, TenantSchema } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withAbortableTransaction, withTransaction } from '../../db.js';
import { StoreError } from '../errors.js';
import type {
  ClaimedOutboxEvent, WakeOutboxClaimFence, WakeOutboxRecipient
} from './contracts.js';
import { validConnectionToken } from './contracts.js';
import { OriginRelayRepository } from './origin-relay.js';

function normalizedWakeRecipients(recipients: readonly WakeOutboxRecipient[]): WakeOutboxRecipient[] {
  if (!Array.isArray(recipients)) {
    throw new StoreError('invalid_input', 'wake outbox recipients must be an array');
  }
  const unique = new Map<string, WakeOutboxRecipient>();
  for (const rawRecipient of recipients as readonly unknown[]) {
    const recipient = rawRecipient !== null && typeof rawRecipient === 'object'
      ? rawRecipient as Record<string, unknown>
      : {};
    const tenant = TenantSchema.safeParse(recipient.tenant_id);
    const alias = AliasSchema.safeParse(recipient.alias);
    if (!tenant.success || !alias.success) {
      throw new StoreError('invalid_input', 'wake outbox recipient identity is invalid');
    }
    const hasAnyFence = recipient.instance_id !== undefined
      || recipient.epoch !== undefined || recipient.connection_token !== undefined;
    const fenced = typeof recipient.instance_id === 'string'
      && recipient.instance_id.length >= 1 && recipient.instance_id.length <= 128
      && Number.isSafeInteger(recipient.epoch) && Number(recipient.epoch) >= 1
      && validConnectionToken(recipient.connection_token);
    if (hasAnyFence && !fenced) {
      throw new StoreError('invalid_input', 'wake outbox recipient session fence is incomplete or invalid');
    }
    const parsed: WakeOutboxRecipient = hasAnyFence
      ? {
        tenant_id: tenant.data,
        alias: alias.data,
        instance_id: String(recipient.instance_id),
        epoch: Number(recipient.epoch),
        connection_token: String(recipient.connection_token),
      }
      : { tenant_id: tenant.data, alias: alias.data };
    const key = `${parsed.tenant_id}\u0000${parsed.alias}`;
    const previous = unique.get(key);
    if (previous !== undefined && JSON.stringify(previous) !== JSON.stringify(parsed)) {
      throw new StoreError('invalid_input', 'wake outbox recipient has conflicting session fences');
    }
    // Preserve caller order: the gateway rotates this list once per cycle for durable fairness.
    if (previous === undefined) unique.set(key, parsed);
  }
  const normalized = [...unique.values()];
  const fencedCount = normalized.filter((recipient) => recipient.connection_token !== undefined).length;
  if (fencedCount !== 0 && fencedCount !== normalized.length) {
    throw new StoreError('invalid_input', 'wake outbox recipients cannot mix fenced and legacy identities');
  }
  return normalized;
}

export abstract class OutboxClaimsRepository extends OriginRelayRepository {
  async claimOutbox(
    kind: 'wake' | 'origin_relay',
    worker: string,
    limit = 50,
    leaseMs = 30_000,
    adapter?: string
  ): Promise<ClaimedOutboxEvent[]> {
    return this.claimOutboxMatching(kind, worker, limit, leaseMs, adapter);
  }

  /**
   * Reclama wakes sólo para identidades que el gateway observó conectadas.
   *
   * El filtro vive dentro del mismo CTE que toma el lock y aumenta `attempts`: aplicarlo después
   * de `claimOutbox` ya habría consumido un intento de cada alias offline del lote. Una lista vacía
   * falla cerrada y no toca la cola. Los pares se validan y deduplican antes de llegar a SQL.
   */
  async claimWakeOutbox(
    worker: string,
    recipients: readonly WakeOutboxRecipient[],
    limit = 50,
    leaseMs = 30_000,
    signal?: AbortSignal,
  ): Promise<ClaimedOutboxEvent[]> {
    if (leaseMs <= 0 || limit < 1) {
      throw new StoreError('conflict', 'outbox lease and limit must be positive');
    }
    const selected = normalizedWakeRecipients(recipients);
    if (selected.length === 0) return [];
    const work = async (client: DatabaseClient): Promise<ClaimedOutboxEvent[]> => {
      let activeRecipients = selected;
      if (selected[0]?.connection_token !== undefined) {
        const locked = await client.query<{ tenant_id: Tenant; alias: string }>(
          `SELECT requested.tenant_id,requested.alias
             FROM jsonb_to_recordset($1::jsonb) AS requested(
                    tenant_id text,alias text,instance_id text,epoch bigint,connection_token uuid
                  )
             JOIN connection_leases lease
               ON lease.tenant_id=requested.tenant_id AND lease.alias=requested.alias
              AND lease.instance_id=requested.instance_id AND lease.epoch=requested.epoch
              AND lease.connection_token=requested.connection_token AND lease.lease_until>now()
            FOR UPDATE OF lease`,
          [JSON.stringify(selected)],
        );
        const live = new Set(locked.rows.map((recipient) =>
          `${recipient.tenant_id}\u0000${recipient.alias}`));
        activeRecipients = selected.filter((recipient) =>
          live.has(`${recipient.tenant_id}\u0000${recipient.alias}`));
        if (activeRecipients.length === 0) return [];
      }
      const requested = JSON.stringify(activeRecipients.map((recipient, recipientOrder) => ({
        ...recipient,
        recipient_order: recipientOrder,
      })));
      // Retire exhausted expired claims without letting one identity consume the whole cleanup
      // budget. The requested order is the gateway's rotated fairness order.
      await client.query(
        `WITH requested AS (
           SELECT identity.tenant_id,identity.alias,identity.recipient_order
             FROM jsonb_to_recordset($1::jsonb)
                  AS identity(tenant_id text,alias text,instance_id text,epoch bigint,
                              connection_token uuid,recipient_order integer)
         ), expired AS (
           SELECT candidate.id
             FROM requested
             JOIN LATERAL (
               SELECT outbox.id
                 FROM adapter_outbox outbox
                WHERE outbox.kind='wake' AND outbox.tenant_id=requested.tenant_id
                  AND outbox.payload->>'recipient_alias'=requested.alias
                  AND outbox.status='processing'
                  AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now()
                  AND outbox.attempts>=outbox.max_attempts
                ORDER BY outbox.claim_expires_at,outbox.created_at
                FOR UPDATE OF outbox SKIP LOCKED LIMIT 1
             ) candidate ON true
            ORDER BY requested.recipient_order LIMIT $2
         ), dead AS (
           UPDATE adapter_outbox outbox
              SET status='dead',dead_at=now(),claim_expires_at=NULL,
                  last_error='outbox lease expired: max attempts exhausted'
             FROM expired WHERE outbox.id=expired.id
           RETURNING outbox.id,outbox.tenant_id,outbox.adapter,outbox.kind,
                     outbox.payload,outbox.attempts,outbox.last_error
         )
         INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
         SELECT id,tenant_id,adapter,kind,last_error,payload,attempts FROM dead
         ON CONFLICT(outbox_id) DO NOTHING`,
        [requested, Math.min(limit, activeRecipients.length, 100)],
      );
      const result = await client.query<ClaimedOutboxEvent>(
        `WITH requested AS (
           SELECT identity.tenant_id,identity.alias,identity.recipient_order
             FROM jsonb_to_recordset($1::jsonb)
                  AS identity(tenant_id text,alias text,instance_id text,epoch bigint,
                              connection_token uuid,recipient_order integer)
         ), picked AS (
           SELECT candidate.id
             FROM requested
             JOIN LATERAL (
               SELECT outbox.id
                 FROM adapter_outbox outbox
                WHERE outbox.kind='wake' AND outbox.tenant_id=requested.tenant_id
                  AND outbox.payload->>'recipient_alias'=requested.alias
                  AND (
                    (outbox.status IN ('pending','failed') AND outbox.available_at<=now())
                    OR (outbox.status='processing'
                        AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now())
                  )
                  AND outbox.attempts<outbox.max_attempts
                ORDER BY CASE WHEN outbox.status='processing'
                              THEN outbox.claim_expires_at ELSE outbox.available_at END,
                         outbox.created_at
                FOR UPDATE OF outbox SKIP LOCKED LIMIT 1
             ) candidate ON true
            ORDER BY requested.recipient_order LIMIT $3
         )
         UPDATE adapter_outbox outbox
            SET status='processing',attempts=outbox.attempts+1,claimed_at=now(),
                claimed_by=$2,claim_token=gen_random_uuid(),
                claim_expires_at=now()+$4*interval '1 millisecond',last_error=NULL
           FROM picked WHERE outbox.id=picked.id
         RETURNING outbox.id,outbox.id AS event_id,outbox.tenant_id,outbox.adapter,outbox.kind,
                   outbox.request_id,outbox.message_id,outbox.delivery_id,outbox.trace_id,
                   outbox.origin,outbox.payload,outbox.attempts,outbox.max_attempts,
                   outbox.claimed_by,outbox.claim_token,outbox.claim_expires_at,
                   outbox.attempts AS attempt`,
        [requested, worker, Math.min(limit, activeRecipients.length), leaseMs],
      );
      return result.rows;
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }

  /** Revalidates and renews one exact wake immediately before the gateway emits its frame. */
  async renewWakeOutbox(
    fence: WakeOutboxClaimFence,
    leaseMs = 30_000,
    signal?: AbortSignal,
  ): Promise<boolean> {
    if (!Number.isSafeInteger(fence.attempt) || fence.attempt < 1 || leaseMs <= 0
        || !fence.claim_token || !fence.worker
        || !validConnectionToken(fence.connection.connection_token)) return false;
    const work = async (client: DatabaseClient): Promise<boolean> => {
      const lease = await client.query(
        `SELECT 1 FROM connection_leases
          WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4
            AND connection_token=$5::uuid AND lease_until>now()
          FOR UPDATE`,
        [
          fence.connection.tenant_id,
          fence.connection.alias,
          fence.connection.instance_id,
          fence.connection.epoch,
          fence.connection.connection_token,
        ],
      );
      if (lease.rowCount !== 1) return false;
      const renewed = await client.query(
        `UPDATE adapter_outbox
            SET claim_expires_at=now()+$5*interval '1 millisecond'
          WHERE id=$1 AND kind='wake' AND status='processing' AND attempts=$2
            AND claim_token=$3::uuid AND claimed_by=$4 AND claim_expires_at>now()
            AND tenant_id=$6 AND payload->>'recipient_alias'=$7
          RETURNING 1`,
        [
          fence.event_id,
          fence.attempt,
          fence.claim_token,
          fence.worker,
          leaseMs,
          fence.connection.tenant_id,
          fence.connection.alias,
        ],
      );
      return renewed.rowCount === 1;
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
  }

  private async claimOutboxMatching(
    kind: 'wake' | 'origin_relay',
    worker: string,
    limit: number,
    leaseMs: number,
    adapter?: string,
    wakeRecipients?: readonly WakeOutboxRecipient[]
  ): Promise<ClaimedOutboxEvent[]> {
    if (leaseMs <= 0 || limit < 1) throw new StoreError('conflict', 'outbox lease and limit must be positive');
    if (wakeRecipients !== undefined && kind !== 'wake') {
      throw new StoreError('invalid_input', 'recipient filtering is valid only for wake outbox claims');
    }
    const wakeRecipientFilter = wakeRecipients === undefined ? null : JSON.stringify(wakeRecipients);
    return withTransaction(this.pool, async (client) => {
      // A claimed or terminal final response supersedes an unclaimed ACK, plus
      // any expired ACK claim. Close it durably so it cannot arrive after the final.
      if (kind === 'origin_relay' && (adapter === undefined || adapter === 'telegram')) {
        await client.query(
          `WITH superseded AS (
           SELECT acknowledgement.id
           FROM adapter_outbox acknowledgement
           WHERE acknowledgement.kind='origin_relay'
             AND acknowledgement.adapter='telegram'
             AND acknowledgement.payload->>'relay_kind'='ack'
             AND (
               acknowledgement.status IN ('pending','failed')
               OR (
                 acknowledgement.status='processing'
                 AND COALESCE(
                   acknowledgement.claim_expires_at,
                   acknowledgement.claimed_at,
                   acknowledgement.created_at
                 )<=now()
               )
             )
             AND EXISTS (
               SELECT 1
               FROM adapter_outbox final
               WHERE final.tenant_id=acknowledgement.tenant_id
                 AND final.adapter=acknowledgement.adapter
                 AND final.kind=acknowledgement.kind
                 AND final.id<>acknowledgement.id
                 AND final.payload->>'relay_kind' IS DISTINCT FROM 'ack'
                 AND final.status IN ('processing','sent','dead')
                 AND COALESCE(
                   final.payload#>>'{correlation,root_message_id}',
                   final.payload#>>'{correlation,message_id}'
                 )=COALESCE(
                   acknowledgement.payload#>>'{correlation,root_message_id}',
                   acknowledgement.payload#>>'{correlation,message_id}'
                 )
             )
           ORDER BY acknowledgement.created_at
           FOR UPDATE OF acknowledgement SKIP LOCKED
           LIMIT $1
         ), dead AS (
           UPDATE adapter_outbox acknowledgement SET
             status='dead',dead_at=now(),claim_expires_at=NULL,
             last_error='Telegram acceptance ACK was superseded by a claimed or terminal final relay'
           FROM superseded
           WHERE acknowledgement.id=superseded.id
           RETURNING acknowledgement.id,acknowledgement.tenant_id,
                     acknowledgement.adapter,acknowledgement.kind,
                     acknowledgement.payload,acknowledgement.attempts,
                     acknowledgement.last_error
         )
         INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
         SELECT id,tenant_id,adapter,kind,last_error,payload,attempts FROM dead
           ON CONFLICT(outbox_id) DO NOTHING`,
          [Math.min(limit, 100)]
        );
      }
      // Expired final attempts cannot be claimed again, but they must not remain processing
      // forever. Move them to the durable DLQ in the same transaction as the next claim.
      await client.query(
        `WITH expired AS (
           SELECT outbox.id FROM adapter_outbox outbox
           WHERE outbox.kind=$1 AND outbox.status='processing'
             AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now()
             AND outbox.attempts>=outbox.max_attempts
             AND ($3::text IS NULL OR outbox.adapter=$3)
             AND ($4::jsonb IS NULL OR EXISTS (
               SELECT 1
               FROM jsonb_to_recordset($4::jsonb) AS recipient(tenant_id text, alias text)
               WHERE recipient.tenant_id=outbox.tenant_id
                 AND recipient.alias=outbox.payload->>'recipient_alias'
             ))
           ORDER BY outbox.claim_expires_at FOR UPDATE OF outbox SKIP LOCKED LIMIT $2
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
        [kind, Math.min(limit, 100), adapter ?? null, wakeRecipientFilter]
      );
      const result = await client.query<ClaimedOutboxEvent>(
        `WITH picked AS (
           SELECT outbox.id
           FROM adapter_outbox outbox
           CROSS JOIN LATERAL (
             SELECT CASE
               WHEN outbox.adapter='telegram'
                 AND outbox.kind='origin_relay'
                 AND COALESCE(
                   outbox.payload#>>'{correlation,root_message_id}',
                   outbox.payload#>>'{correlation,message_id}'
                 ) IS NOT NULL
               THEN pg_try_advisory_xact_lock(hashtextextended(
                 'telegram-origin-relay:'
                 || COALESCE(
                   outbox.payload#>>'{correlation,root_message_id}',
                   outbox.payload#>>'{correlation,message_id}'
                 ),
                 0
               ))
               ELSE true
             END AS acquired
           ) relay_fence
           LEFT JOIN LATERAL (
             SELECT acknowledgement.status
             FROM adapter_outbox acknowledgement
             WHERE outbox.adapter='telegram'
               AND outbox.kind='origin_relay'
               AND outbox.payload->>'relay_kind' IS DISTINCT FROM 'ack'
               AND acknowledgement.tenant_id=outbox.tenant_id
               AND acknowledgement.adapter=outbox.adapter
               AND acknowledgement.kind=outbox.kind
               AND acknowledgement.id<>outbox.id
               AND acknowledgement.payload->>'relay_kind'='ack'
               AND COALESCE(
                 acknowledgement.payload#>>'{correlation,root_message_id}',
                 acknowledgement.payload#>>'{correlation,message_id}'
               )=COALESCE(
                 outbox.payload#>>'{correlation,root_message_id}',
                 outbox.payload#>>'{correlation,message_id}'
               )
             ORDER BY acknowledgement.created_at
             LIMIT 1
             FOR UPDATE OF acknowledgement
           ) acknowledgement_fence ON true
            WHERE outbox.kind=$1 AND (
                (outbox.status IN ('pending','failed') AND outbox.available_at<=now())
                OR (outbox.status='processing'
                    AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now())
              )
              AND outbox.attempts<outbox.max_attempts
              AND ($5::text IS NULL OR outbox.adapter=$5)
              AND ($6::jsonb IS NULL OR EXISTS (
                SELECT 1
                FROM jsonb_to_recordset($6::jsonb) AS recipient(tenant_id text, alias text)
                WHERE recipient.tenant_id=outbox.tenant_id
                  AND recipient.alias=outbox.payload->>'recipient_alias'
              ))
              AND relay_fence.acquired
              AND (
                outbox.adapter<>'telegram'
                OR outbox.kind<>'origin_relay'
                OR (
                  outbox.payload->>'relay_kind'='ack'
                  AND NOT EXISTS (
                    SELECT 1
                    FROM adapter_outbox final
                    WHERE final.tenant_id=outbox.tenant_id
                      AND final.adapter=outbox.adapter
                      AND final.kind=outbox.kind
                      AND final.id<>outbox.id
                      AND final.payload->>'relay_kind' IS DISTINCT FROM 'ack'
                      AND final.status IN ('processing','sent','dead')
                      AND COALESCE(
                        final.payload#>>'{correlation,root_message_id}',
                        final.payload#>>'{correlation,message_id}'
                      )=COALESCE(
                        outbox.payload#>>'{correlation,root_message_id}',
                        outbox.payload#>>'{correlation,message_id}'
                      )
                  )
                )
                OR (
                  outbox.payload->>'relay_kind' IS DISTINCT FROM 'ack'
                  AND (
                    acknowledgement_fence.status IS NULL
                    OR acknowledgement_fence.status IN ('sent','dead')
                  )
                )
              )
            ORDER BY CASE WHEN outbox.status='processing'
                          THEN outbox.claim_expires_at ELSE outbox.available_at END,
                     outbox.created_at
            FOR UPDATE OF outbox SKIP LOCKED LIMIT $3
           )
           UPDATE adapter_outbox o SET status='processing',attempts=o.attempts+1,claimed_at=now(),
            claimed_by=$2,claim_token=gen_random_uuid(),
            claim_expires_at=now()+$4*interval '1 millisecond',last_error=NULL
          FROM picked p WHERE o.id=p.id
          RETURNING o.id,o.id AS event_id,o.tenant_id,o.adapter,o.kind,o.request_id,o.message_id,o.delivery_id,
                    o.trace_id,o.origin,o.payload,o.attempts,o.max_attempts,o.claimed_by,
                    o.claim_token,o.claim_expires_at,o.attempts AS attempt`,
        [kind, worker, limit, leaseMs, adapter ?? null, wakeRecipientFilter]
      );
      return result.rows;
    });
  }

}
