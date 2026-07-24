import { OriginSchema, TenantSchema, type Tenant } from '@cauce/protocol';
import {
  CauceRepository, withTransaction, type ClaimedOutboxEvent, type DatabasePool
} from '@cauce/store';
import type {
  PollLease, TelegramCursorRepository, TelegramEffect, TelegramEffectInput, TelegramEgressRepository,
  TelegramOriginRelay, TelegramOriginRelayAck
} from './types.js';

function lease(row: { bot_id: string; owner_id: string; epoch: string | number; lease_until: Date }): PollLease {
  return {
    bot_id: row.bot_id,
    owner_id: row.owner_id,
    epoch: Number(row.epoch),
    lease_until: row.lease_until
  };
}

function outboxEvent(row: ClaimedOutboxEvent): TelegramOriginRelay {
  const tenant = TenantSchema.parse(row.tenant_id);
  const origin = OriginSchema.parse(row.origin);
  if (row.kind !== 'origin_relay' || row.adapter !== 'telegram') throw new Error('claimed non-Telegram relay event');
  return {
    event_id: row.event_id,
    attempt: row.attempt,
    max_attempts: row.max_attempts,
    claim_token: row.claim_token,
    tenant_id: tenant,
    adapter: row.adapter,
    origin,
    payload: row.payload
  };
}

interface EffectRow {
  effect_id: string;
  outbox_id: string;
  tenant_id: Tenant;
  bridge_alias: string;
  chunk_index: number;
  chunk_count: number;
  payload_hash: string;
  state: 'prepared' | 'sending' | 'sent' | 'ambiguous' | 'dead';
  provider_message_id: string | null;
  diagnostic: string | null;
  diagnosed_at: Date | null;
  replay_count: number;
  replayed_at: Date | null;
}

const EFFECT_COLUMNS = `effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,
  payload_hash,state,provider_message_id,diagnostic,diagnosed_at,replay_count,replayed_at`;

function durableDiagnostic(value: string): string {
  const diagnostic = value.replace(/[\r\n\t]/g, ' ').trim().slice(0, 1_000);
  if (!diagnostic) throw new Error('Telegram effect diagnostic is required');
  return diagnostic;
}

function effect(row: EffectRow): TelegramEffect {
  return {
    effect_id: row.effect_id,
    outbox_id: row.outbox_id,
    tenant_id: TenantSchema.parse(row.tenant_id),
    bridge_alias: row.bridge_alias,
    chunk_index: row.chunk_index,
    chunk_count: row.chunk_count,
    payload_hash: row.payload_hash,
    state: row.state,
    replay_count: row.replay_count,
    ...(row.provider_message_id === null ? {} : { provider_message_id: row.provider_message_id }),
    ...(row.diagnostic === null ? {} : { diagnostic: row.diagnostic }),
    ...(row.diagnosed_at === null ? {} : { diagnosed_at: row.diagnosed_at }),
    ...(row.replayed_at === null ? {} : { replayed_at: row.replayed_at })
  };
}

export class PostgresTelegramBridgeRepository implements TelegramCursorRepository, TelegramEgressRepository {
  private readonly outbox: CauceRepository;
  private readonly claims = new Map<string, { attempt: number; claimToken: string }>();

  constructor(private readonly pool: DatabasePool) {
    this.outbox = new CauceRepository(pool);
  }

  private async reconcileTerminalSendingEffects(): Promise<void> {
    const diagnostic = 'Interrupted on the final outbox attempt while a Telegram request may have been in flight; '
      + 'automatic replay is disabled';
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE telegram_egress_effects effect SET
           state='ambiguous',diagnostic=$1,diagnosed_at=now()
         FROM adapter_outbox outbox
         WHERE effect.outbox_id=outbox.id AND effect.state='sending' AND outbox.status='dead'`,
        [diagnostic]
      );
      const affected = await client.query<{ id: string }>(
        `UPDATE adapter_outbox outbox SET last_error=effect.diagnostic
         FROM telegram_egress_effects effect
         WHERE effect.outbox_id=outbox.id AND effect.state='ambiguous'
           AND outbox.status='dead'
           AND outbox.last_error='outbox lease expired: max attempts exhausted'
         RETURNING outbox.id`
      );
      const outboxIds = [...new Set(affected.rows.map((row) => row.id))];
      if (outboxIds.length === 0) return;
      await client.query(
        `UPDATE outbox_dead_letters letter SET reason=outbox.last_error
         FROM adapter_outbox outbox
         WHERE letter.outbox_id=outbox.id AND letter.outbox_id=ANY($1::uuid[])`,
        [outboxIds]
      );
    });
  }

  async initializeCursor(botId: string, tenantId: Tenant, alias: string): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO channel_bridge_cursors(bot_id,tenant_id,alias)
         VALUES($1,$2,$3) ON CONFLICT(bot_id) DO NOTHING`,
        [botId, tenantId, alias]
      );
      const existing = await client.query<{ tenant_id: string; alias: string }>(
        `SELECT tenant_id,alias FROM channel_bridge_cursors WHERE bot_id=$1 FOR UPDATE`, [botId]
      );
      const row = existing.rows[0];
      if (!row || row.tenant_id !== tenantId || row.alias !== alias) {
        throw new Error('Telegram bot is already bound to another tenant or alias');
      }
    });
  }

  async acquirePollLease(botId: string, ownerId: string, leaseMs: number): Promise<PollLease | undefined> {
    const result = await this.pool.query<{
      bot_id: string; owner_id: string; epoch: string; lease_until: Date;
    }>(
      `INSERT INTO channel_bridge_leases(bot_id,owner_id,epoch,lease_until)
       VALUES($1,$2,1,now()+$3*interval '1 millisecond')
       ON CONFLICT(bot_id) DO UPDATE SET
         owner_id=EXCLUDED.owner_id,
         epoch=CASE WHEN channel_bridge_leases.owner_id=EXCLUDED.owner_id
                    THEN channel_bridge_leases.epoch ELSE channel_bridge_leases.epoch+1 END,
         lease_until=EXCLUDED.lease_until,updated_at=now()
       WHERE channel_bridge_leases.lease_until<=now()
          OR channel_bridge_leases.owner_id=EXCLUDED.owner_id
       RETURNING bot_id,owner_id,epoch,lease_until`,
      [botId, ownerId, leaseMs]
    );
    return result.rows[0] ? lease(result.rows[0]) : undefined;
  }

  async renewPollLease(current: PollLease, leaseMs: number): Promise<PollLease | undefined> {
    const result = await this.pool.query<{
      bot_id: string; owner_id: string; epoch: string; lease_until: Date;
    }>(
      `UPDATE channel_bridge_leases SET lease_until=now()+$4*interval '1 millisecond',updated_at=now()
       WHERE bot_id=$1 AND owner_id=$2 AND epoch=$3 AND lease_until>now()
       RETURNING bot_id,owner_id,epoch,lease_until`,
      [current.bot_id, current.owner_id, current.epoch, leaseMs]
    );
    return result.rows[0] ? lease(result.rows[0]) : undefined;
  }

  async cursor(current: PollLease): Promise<number> {
    const result = await this.pool.query<{ next_update_id: string }>(
      `SELECT cursor.next_update_id FROM channel_bridge_cursors cursor
       JOIN channel_bridge_leases lease ON lease.bot_id=cursor.bot_id
       WHERE cursor.bot_id=$1 AND lease.owner_id=$2 AND lease.epoch=$3 AND lease.lease_until>now()`,
      [current.bot_id, current.owner_id, current.epoch]
    );
    const value = result.rows[0]?.next_update_id;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('Telegram poll lease was fenced');
    return parsed;
  }

  async advanceCursor(current: PollLease, nextUpdateId: number): Promise<void> {
    if (!Number.isSafeInteger(nextUpdateId) || nextUpdateId < 0) throw new Error('invalid Telegram cursor');
    const result = await this.pool.query(
      `UPDATE channel_bridge_cursors cursor
       SET next_update_id=GREATEST(cursor.next_update_id,$4),updated_at=now()
       WHERE cursor.bot_id=$1 AND EXISTS (
         SELECT 1 FROM channel_bridge_leases lease
         WHERE lease.bot_id=cursor.bot_id AND lease.owner_id=$2 AND lease.epoch=$3 AND lease.lease_until>now()
       )`,
      [current.bot_id, current.owner_id, current.epoch, nextUpdateId]
    );
    if (result.rowCount !== 1) throw new Error('Telegram poll lease was fenced');
  }

  async claim(workerId: string, limit: number, leaseMs: number): Promise<TelegramOriginRelay[]> {
    const rows = await this.outbox.claimOutbox('origin_relay', workerId, limit, leaseMs, 'telegram');
    // claimOutbox moves an expired final attempt directly to dead without returning it.
    // Reconcile its in-flight effect so no sending row is stranded or mistaken for sent.
    await this.reconcileTerminalSendingEffects();
    const events = rows.map(outboxEvent);
    for (const event of events) {
      this.claims.set(event.event_id, { attempt: event.attempt, claimToken: event.claim_token });
    }
    return events;
  }

  async ack(acknowledgement: TelegramOriginRelayAck): Promise<void> {
    const claim = this.claims.get(acknowledgement.event_id);
    if (!claim || claim.attempt !== acknowledgement.attempt || claim.claimToken !== acknowledgement.claim_token) {
      throw new Error('Telegram origin relay ACK is not locally owned');
    }
    if (acknowledgement.status === 'sent') {
      const expected = acknowledgement.effect_count;
      if (!Number.isSafeInteger(expected) || (expected ?? 0) < 1) {
        throw new Error('Telegram sent ACK requires a positive effect count');
      }
      const confirmed = await this.pool.query<{
        total: string; sent: string; matching_count: boolean; first_chunk: number | null; last_chunk: number | null;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE state='sent')::text AS sent,
                COALESCE(bool_and(chunk_count=$2),false) AS matching_count,
                min(chunk_index) AS first_chunk,max(chunk_index) AS last_chunk
         FROM telegram_egress_effects WHERE outbox_id=$1`,
        [acknowledgement.event_id, expected]
      );
      const row = confirmed.rows[0];
      if (!row || Number(row.total) !== expected || Number(row.sent) !== expected ||
          !row.matching_count || row.first_chunk !== 0 || row.last_chunk !== expected - 1) {
        throw new Error('Telegram sent ACK requires every chunk effect to be confirmed sent');
      }
    }
    try {
      const result = await this.outbox.ackOutbox(acknowledgement);
      if (!result.applied) throw new Error('Telegram origin relay ACK was fenced');
    } finally {
      this.claims.delete(acknowledgement.event_id);
    }
  }

  async prepareEffect(input: TelegramEffectInput): Promise<TelegramEffect> {
    if (!Number.isSafeInteger(input.chunk_count) || input.chunk_count < 1 ||
        !Number.isSafeInteger(input.chunk_index) || input.chunk_index < 0 || input.chunk_index >= input.chunk_count) {
      throw new Error('Telegram effect has invalid chunk coordinates');
    }
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `INSERT INTO telegram_egress_effects(
           effect_id,outbox_id,tenant_id,bridge_alias,chunk_index,chunk_count,payload_hash,state
         ) VALUES($1,$2,$3,$4,$5,$6,$7,'prepared')
         ON CONFLICT(effect_id) DO UPDATE SET
           chunk_count=COALESCE(telegram_egress_effects.chunk_count,EXCLUDED.chunk_count)`,
        [input.effect_id, input.outbox_id, input.tenant_id, input.bridge_alias, input.chunk_index,
          input.chunk_count, input.payload_hash]
      );
      const selected = await client.query<EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM telegram_egress_effects WHERE effect_id=$1 FOR UPDATE`, [input.effect_id]
      );
      const row = selected.rows[0];
      if (!row || row.outbox_id !== input.outbox_id || row.tenant_id !== input.tenant_id ||
           row.bridge_alias !== input.bridge_alias || row.chunk_index !== input.chunk_index ||
           row.chunk_count !== input.chunk_count || row.payload_hash !== input.payload_hash) {
        throw new Error('Telegram effect idempotency conflict');
      }
      return effect(row);
    });
  }

  async beginEffect(effectId: string, payloadHash: string): Promise<TelegramEffect> {
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE telegram_egress_effects SET state='sending',sending_at=now()
         WHERE effect_id=$1 AND payload_hash=$2 AND state='prepared'`, [effectId, payloadHash]
      );
      const selected = await client.query<EffectRow>(
        `SELECT ${EFFECT_COLUMNS}
         FROM telegram_egress_effects WHERE effect_id=$1 AND payload_hash=$2 FOR UPDATE`,
        [effectId, payloadHash]
      );
      if (!selected.rows[0]) throw new Error('Telegram effect does not exist or payload changed');
      return effect(selected.rows[0]);
    });
  }

  async resetPrepared(effectId: string, payloadHash: string): Promise<void> {
    const result = await this.pool.query(
      `UPDATE telegram_egress_effects SET state='prepared',sending_at=NULL
       WHERE effect_id=$1 AND payload_hash=$2 AND state='sending'`, [effectId, payloadHash]
    );
    if (result.rowCount !== 1) throw new Error('Telegram effect retry reset was fenced');
  }

  async completeEffect(effectId: string, payloadHash: string, providerMessageId: string): Promise<void> {
    if (!providerMessageId) throw new Error('Telegram provider message id is required');
    const result = await this.pool.query(
      `UPDATE telegram_egress_effects
       SET state='sent',provider_message_id=$3,sent_at=now()
       WHERE effect_id=$1 AND payload_hash=$2 AND state='sending'`,
      [effectId, payloadHash, providerMessageId]
    );
    if (result.rowCount !== 1) throw new Error('Telegram effect completion was fenced');
  }

  private async diagnoseEffect(
    effectId: string,
    payloadHash: string,
    state: 'ambiguous' | 'dead',
    diagnostic: string
  ): Promise<TelegramEffect> {
    const message = durableDiagnostic(diagnostic);
    return withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE telegram_egress_effects
         SET state=$3,diagnostic=$4,diagnosed_at=now()
         WHERE effect_id=$1 AND payload_hash=$2
           AND state IN ('prepared','sending')`,
        [effectId, payloadHash, state, message]
      );
      const selected = await client.query<EffectRow>(
        `SELECT ${EFFECT_COLUMNS} FROM telegram_egress_effects
         WHERE effect_id=$1 AND payload_hash=$2 FOR UPDATE`,
        [effectId, payloadHash]
      );
      const row = selected.rows[0];
      if (!row) throw new Error('Telegram effect does not exist or payload changed');
      if (row.state !== state && row.state !== 'sent') {
        throw new Error('Telegram effect diagnosis was fenced');
      }
      return effect(row);
    });
  }

  async markEffectAmbiguous(effectId: string, payloadHash: string, diagnostic: string): Promise<TelegramEffect> {
    return this.diagnoseEffect(effectId, payloadHash, 'ambiguous', diagnostic);
  }

  async markEffectDead(effectId: string, payloadHash: string, diagnostic: string): Promise<TelegramEffect> {
    return this.diagnoseEffect(effectId, payloadHash, 'dead', diagnostic);
  }

  async getEffect(effectId: string): Promise<TelegramEffect | undefined> {
    const selected = await this.pool.query<EffectRow>(
      `SELECT ${EFFECT_COLUMNS} FROM telegram_egress_effects WHERE effect_id=$1`, [effectId]
    );
    return selected.rows[0] ? effect(selected.rows[0]) : undefined;
  }

  async manualReplayEffect(effectId: string, payloadHash: string, reason: string): Promise<TelegramEffect> {
    const replayReason = durableDiagnostic(reason);
    return withTransaction(this.pool, async (client) => {
      const selected = await client.query<EffectRow>(
        `SELECT ${EFFECT_COLUMNS} FROM telegram_egress_effects
         WHERE effect_id=$1 AND payload_hash=$2 FOR UPDATE`, [effectId, payloadHash]
      );
      const row = selected.rows[0];
      if (!row) throw new Error('Telegram effect does not exist or payload changed');
      if (row.state !== 'ambiguous' && row.state !== 'dead') {
        throw new Error('Only an ambiguous or dead Telegram effect can be manually replayed');
      }
      const outboxIdentity = await client.query<{
        acknowledgement: boolean;
        root_message_id: string | null;
      }>(
        `SELECT payload->>'relay_kind'='ack' AS acknowledgement,
                COALESCE(
                  payload#>>'{correlation,root_message_id}',
                  payload#>>'{correlation,message_id}'
                ) AS root_message_id
         FROM adapter_outbox WHERE id=$1`,
        [row.outbox_id]
      );
      const identity = outboxIdentity.rows[0];
      if (identity?.acknowledgement && identity.root_message_id) {
        await client.query(
          `SELECT pg_advisory_xact_lock(hashtextextended($1,0))`,
          [`telegram-origin-relay:${identity.root_message_id}`]
        );
      }
      const outbox = await client.query<{ status: string; acknowledgement: boolean }>(
        `SELECT status,payload->>'relay_kind'='ack' AS acknowledgement
         FROM adapter_outbox WHERE id=$1 FOR UPDATE`,
        [row.outbox_id]
      );
      const outboxRow = outbox.rows[0];
      if (outboxRow?.status !== 'dead') {
        throw new Error('Telegram manual replay requires a dead outbox event');
      }
      if (outboxRow.acknowledgement) {
        // Lock every correlated final, including pending ones, so a concurrent
        // final claim cannot cross the replay transition.
        const correlatedFinals = await client.query<{ status: string }>(
          `SELECT final.status
           FROM adapter_outbox final
           JOIN adapter_outbox acknowledgement ON acknowledgement.id=$1
           WHERE final.tenant_id=acknowledgement.tenant_id
             AND final.adapter=acknowledgement.adapter
             AND final.kind=acknowledgement.kind
             AND final.id<>acknowledgement.id
             AND final.payload->>'relay_kind' IS DISTINCT FROM 'ack'
             AND COALESCE(
               final.payload#>>'{correlation,root_message_id}',
               final.payload#>>'{correlation,message_id}'
             )=COALESCE(
               acknowledgement.payload#>>'{correlation,root_message_id}',
               acknowledgement.payload#>>'{correlation,message_id}'
             )
           FOR UPDATE OF final`,
          [row.outbox_id]
        );
        if (correlatedFinals.rows.some(
          (final) => final.status === 'processing' || final.status === 'sent' || final.status === 'dead'
        )) {
          throw new Error(
            'Telegram acceptance ACK replay is forbidden after its final relay was claimed or completed'
          );
        }
      }
      await client.query(
        `UPDATE telegram_egress_effects SET
           state='prepared',sending_at=NULL,provider_message_id=NULL,
           diagnostic=$3,diagnosed_at=now(),replay_count=replay_count+1,replayed_at=now()
         WHERE effect_id=$1 AND payload_hash=$2 AND state IN ('ambiguous','dead')`,
        [effectId, payloadHash, `Manual replay authorized: ${replayReason}`]
      );
      await client.query(
        `UPDATE adapter_outbox SET
           status='failed',available_at=now(),claimed_by=NULL,claim_token=NULL,
           claim_expires_at=NULL,dead_at=NULL,last_error=$2,
           max_attempts=GREATEST(max_attempts,attempts+1)
         WHERE id=$1 AND status='dead'`,
        [row.outbox_id, `Manual Telegram replay authorized: ${replayReason}`]
      );
      // The effect retains the durable diagnosis and replay audit. Removing the stale DLQ
      // projection lets a subsequent terminal result publish the current diagnosis.
      await client.query(`DELETE FROM outbox_dead_letters WHERE outbox_id=$1`, [row.outbox_id]);
      const replayed = await client.query<EffectRow>(
        `SELECT ${EFFECT_COLUMNS} FROM telegram_egress_effects WHERE effect_id=$1`, [effectId]
      );
      if (!replayed.rows[0]) throw new Error('Telegram manual replay was fenced');
      return effect(replayed.rows[0]);
    });
  }
}
