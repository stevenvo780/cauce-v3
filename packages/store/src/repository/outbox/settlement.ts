import type { Tenant } from '@cauce/protocol';
import type { DatabaseClient } from '../../db.js';
import { withAbortableTransaction, withTransaction } from '../../db.js';
import { StoreError } from '../errors.js';
import type { OutboxAck, OutboxRetryResult } from './contracts.js';
import { validConnectionToken } from './contracts.js';
import { OutboxClaimsRepository } from './claims.js';

export abstract class OutboxSettlementRepository extends OutboxClaimsRepository {
  async ackOutbox(
    ack: OutboxAck,
    signal?: AbortSignal,
  ): Promise<{ status: 'sent' | 'failed' | 'dead'; applied: boolean }> {
    if (!Number.isInteger(ack.attempt) || ack.attempt < 1 || !ack.claim_token) {
      throw new StoreError('fenced', 'outbox ACK requires claim token and positive attempt');
    }
    if (ack.connection !== undefined && !validConnectionToken(ack.connection.connection_token)) {
      return { status: 'failed', applied: false };
    }
    const work = async (client: DatabaseClient): Promise<{
      status: 'sent' | 'failed' | 'dead'; applied: boolean;
    }> => {
      if (ack.connection !== undefined) {
        const lease = await client.query(
          `SELECT 1 FROM connection_leases
            WHERE tenant_id=$1 AND alias=$2 AND instance_id=$3 AND epoch=$4
              AND connection_token=$5::uuid AND lease_until>now()
            FOR UPDATE`,
          [
            ack.connection.tenant_id,
            ack.connection.alias,
            ack.connection.instance_id,
            ack.connection.epoch,
            ack.connection.connection_token,
          ],
        );
        if (lease.rowCount !== 1) return { status: 'failed', applied: false };
      }
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
      if (ack.connection !== undefined && (
        event.kind !== 'wake'
        || event.tenant_id !== ack.connection.tenant_id
        || event.payload.recipient_alias !== ack.connection.alias
      )) return { status: 'failed', applied: false };
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
    };
    return signal === undefined
      ? withTransaction(this.pool, work)
      : withAbortableTransaction(this.pool, signal, work);
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

}
