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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;

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

  private async reconcileTerminalEffects(): Promise<void> {
    await withTransaction(this.pool, async (client) => {
      // Migration 030 owns the invariant and the exactly-once audit ledger.  It takes both the
      // global DLQ fence and the same causal Telegram advisory locks as the claimant, proves every
      // chunk (including provider id and sent_at), and never performs a remote side effect.
      await client.query(`SELECT cauce_reconcile_telegram_terminal_030('telegram-bridge')`);
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
      if (row?.tenant_id !== tenantId || row.alias !== alias) {
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
    await this.reconcileTerminalEffects();
    const events = rows.map(outboxEvent);
    for (const event of events) {
      this.claims.set(event.event_id, { attempt: event.attempt, claimToken: event.claim_token });
    }
    return events;
  }

  async renew(event: TelegramOriginRelay, leaseMs: number): Promise<boolean> {
    if (!Number.isInteger(leaseMs) || leaseMs < 1_000) throw new Error('Telegram egress lease is invalid');
    const claim = this.claims.get(event.event_id);
    if (claim?.attempt !== event.attempt || claim.claimToken !== event.claim_token) return false;
    const renewed = await this.pool.query(
      `UPDATE adapter_outbox SET claim_expires_at=now()+$4*interval '1 millisecond'
       WHERE id=$1 AND status='processing' AND attempts=$2 AND claim_token=$3
         AND claim_expires_at>now()`,
      [event.event_id, event.attempt, event.claim_token, leaseMs]
    );
    if (renewed.rowCount === 1) return true;
    this.claims.delete(event.event_id);
    return false;
  }

  async ack(acknowledgement: TelegramOriginRelayAck): Promise<void> {
    const claim = this.claims.get(acknowledgement.event_id);
    if (claim?.attempt !== acknowledgement.attempt || claim.claimToken !== acknowledgement.claim_token) {
      throw new Error('Telegram origin relay ACK is not locally owned');
    }
    if (acknowledgement.status === 'sent') {
      const expected = acknowledgement.effect_count;
      if (!Number.isSafeInteger(expected) || (expected ?? 0) < 1) {
        throw new Error('Telegram sent ACK requires a positive effect count');
      }
      const confirmed = await this.pool.query<{
        total: string; sent: string; matching_count: boolean; distinct_indices: string;
        first_chunk: number | null; last_chunk: number | null;
        provider_confirmed: boolean; sent_at_confirmed: boolean;
      }>(
        `SELECT count(*)::text AS total,
                count(*) FILTER (WHERE state='sent')::text AS sent,
                COALESCE(bool_and(chunk_count=$2),false) AS matching_count,
                count(DISTINCT chunk_index)::text AS distinct_indices,
                min(chunk_index) AS first_chunk,max(chunk_index) AS last_chunk,
                COALESCE(bool_and(provider_message_id IS NOT NULL
                  AND btrim(provider_message_id)<>''),false) AS provider_confirmed,
                COALESCE(bool_and(sent_at IS NOT NULL),false) AS sent_at_confirmed
         FROM telegram_egress_effects WHERE outbox_id=$1`,
        [acknowledgement.event_id, expected]
      );
      const row = confirmed.rows[0];
      if (!row || Number(row.total) !== expected || Number(row.sent) !== expected ||
          Number(row.distinct_indices) !== expected || !row.matching_count ||
          row.first_chunk !== 0 || row.last_chunk !== expected - 1 ||
          !row.provider_confirmed || !row.sent_at_confirmed) {
        throw new Error('Telegram sent ACK requires every chunk effect to be confirmed sent');
      }
    }
    try {
      const result = await this.outbox.ackOutbox(acknowledgement);
      const expected = acknowledgement.status === 'retry' ? 'failed' : acknowledgement.status;
      if (!result.applied || result.status !== expected) {
        throw new Error('Telegram origin relay ACK was fenced or returned a mismatched status');
      }
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
      if (row?.outbox_id !== input.outbox_id || row.tenant_id !== input.tenant_id ||
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

  async manualReplayEffect(
    chunkIndex: number,
    payloadHash: string,
    reason: string,
    actorTenant: Tenant,
    actorAlias: string,
    duplicateRiskAcknowledged: boolean,
    requestId: string,
    deadLetterId: string,
    incidentEvidenceSha256: string,
    expectedReplayCount: number
  ): Promise<TelegramEffect> {
    const replayReason = durableDiagnostic(reason);
    if (!actorTenant || !actorAlias.trim()) {
      throw new Error('Telegram manual replay requires an explicit control-authorized actor');
    }
    if (!Number.isSafeInteger(chunkIndex) || chunkIndex < 0 || !SHA256.test(payloadHash)
      || !UUID.test(requestId) || !UUID.test(deadLetterId) || !SHA256.test(incidentEvidenceSha256)
      || !Number.isSafeInteger(expectedReplayCount) || expectedReplayCount < 0) {
      throw new Error('Telegram manual replay requires exact incident evidence and replay count');
    }
    return withTransaction(this.pool, async (client) => {
      // The database function verifies role/tenant control, exact effect hash, causal ordering and
      // the explicit duplicate-risk acknowledgement.  It resolves (never deletes) the incident.
      await client.query(
        `SELECT cauce_manual_replay_telegram_030(
           $1,$2,$3,$4,$5,$6,$7::uuid,$8::uuid,$9,$10
         )`,
        [
          payloadHash, chunkIndex, replayReason, actorTenant, actorAlias.trim(),
          duplicateRiskAcknowledged, requestId, deadLetterId, incidentEvidenceSha256,
          expectedReplayCount,
        ]
      );
      const replayed = await client.query<EffectRow>(
        `SELECT ${EFFECT_COLUMNS} FROM telegram_egress_effects
          WHERE effect_id=(SELECT effect_id FROM telegram_manual_replays WHERE request_id=$1::uuid)`,
        [requestId]
      );
      if (!replayed.rows[0]) throw new Error('Telegram manual replay was fenced');
      return effect(replayed.rows[0]);
    });
  }
}
