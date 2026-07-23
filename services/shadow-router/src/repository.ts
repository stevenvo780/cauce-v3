import { TenantSchema } from '@cauce/protocol';
import { withTransaction, type DatabasePool } from '@cauce/store';
import { parseShadowEnvelope } from './router.js';
import type {
  ShadowDirection, ShadowEnvelope, ShadowInboxLease, ShadowInboxRepository,
  ShadowMapping, ShadowMappingRepository, ShadowMappingStatus, ShadowMode, ShadowVerdict
} from './types.js';

interface MappingRow {
  direction: ShadowDirection;
  source_event_id: string;
  tenant_id: string;
  mode: ShadowMode;
  target_event_id: string;
  correlation: ShadowMapping['correlation'];
  status: ShadowMappingStatus;
}

function sameCorrelation(left: ShadowMapping['correlation'], right: ShadowMapping['correlation']): boolean {
  return left.request_id === right.request_id && left.trace_id === right.trace_id &&
    left.message_id === right.message_id && left.conversation_key === right.conversation_key;
}

export class PostgresShadowRepository implements ShadowMappingRepository, ShadowInboxRepository {
  private readonly claims = new Map<string, string>();

  constructor(private readonly pool: DatabasePool) {}

  async enqueue(envelope: ShadowEnvelope, mode: ShadowMode): Promise<{ id: string; duplicate: boolean }> {
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO shadow_router_inbox(direction,source_event_id,tenant_id,mode,correlation,envelope)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)
         ON CONFLICT(direction,source_event_id) DO NOTHING RETURNING id`,
        [envelope.direction, envelope.source_event_id, envelope.tenant_id, mode,
          JSON.stringify(envelope.correlation), JSON.stringify(envelope)]
      );
      if (inserted.rows[0]) return { id: inserted.rows[0].id, duplicate: false };
      const existing = await client.query<{ id: string; tenant_id: string; mode: ShadowMode; correlation: ShadowMapping['correlation'] }>(
        `SELECT id,tenant_id,mode,correlation FROM shadow_router_inbox
         WHERE direction=$1 AND source_event_id=$2 FOR UPDATE`, [envelope.direction, envelope.source_event_id]
      );
      const row = existing.rows[0];
      if (!row || row.tenant_id !== envelope.tenant_id || row.mode !== mode || !sameCorrelation(row.correlation, envelope.correlation)) {
        throw new Error('shadow inbox idempotency conflict');
      }
      return { id: row.id, duplicate: true };
    });
  }

  async claim(workerId: string, limit: number, leaseMs: number): Promise<ShadowInboxLease[]> {
    const result = await withTransaction(this.pool, async (client) => {
      await client.query(
        `UPDATE shadow_router_inbox
         SET status=CASE WHEN attempts>=max_attempts THEN 'dead' ELSE 'failed' END,
             available_at=now(),claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,
             last_error='shadow inbox lease expired'
         WHERE status='processing' AND claim_expires_at<=now()`
      );
      return client.query<{
        id: string; direction: ShadowDirection; source_event_id: string; tenant_id: string; mode: ShadowMode;
        envelope: unknown; attempts: number; max_attempts: number; claim_token: string;
      }>(
        `WITH picked AS (
           SELECT id FROM shadow_router_inbox
           WHERE status IN ('pending','failed') AND available_at<=now() AND attempts<max_attempts
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE shadow_router_inbox inbox
         SET status='processing',attempts=inbox.attempts+1,claimed_by=$1,claim_token=gen_random_uuid(),
             claim_expires_at=now()+$3*interval '1 millisecond',last_error=NULL
         FROM picked WHERE inbox.id=picked.id
         RETURNING inbox.id,inbox.direction,inbox.source_event_id,inbox.tenant_id,inbox.mode,
                   inbox.envelope,inbox.attempts,inbox.max_attempts,inbox.claim_token`,
        [workerId, limit, leaseMs]
      );
    });
    return result.rows.map((row) => {
      const parsed = parseShadowEnvelope(row.envelope, row.direction);
      if (parsed.tenant_id !== row.tenant_id || parsed.source_event_id !== row.source_event_id) {
        throw new Error('shadow inbox envelope does not match its trusted columns');
      }
      this.claims.set(row.id, row.claim_token);
      return {
        id: row.id,
        direction: row.direction,
        source_event_id: row.source_event_id,
        tenant_id: TenantSchema.parse(row.tenant_id),
        mode: row.mode,
        envelope: parsed,
        attempt: row.attempts,
        max_attempts: row.max_attempts,
        claim_token: row.claim_token
      };
    });
  }

  private assertClaim(lease: ShadowInboxLease): void {
    if (this.claims.get(lease.id) !== lease.claim_token) throw new Error('shadow inbox lease is not locally owned');
  }

  async completeInbox(lease: ShadowInboxLease): Promise<void> {
    this.assertClaim(lease);
    try {
      const result = await this.pool.query(
        `UPDATE shadow_router_inbox SET status='done',completed_at=now(),claim_expires_at=NULL
         WHERE id=$1 AND status='processing' AND claim_token=$2 AND attempts=$3 AND claim_expires_at>now()`,
        [lease.id, lease.claim_token, lease.attempt]
      );
      if (result.rowCount !== 1) throw new Error('shadow inbox completion was fenced');
    } finally {
      this.claims.delete(lease.id);
    }
  }

  async retryInbox(lease: ShadowInboxLease, delayMs: number, error: string): Promise<'retry' | 'dead'> {
    this.assertClaim(lease);
    try {
      const dead = lease.attempt >= lease.max_attempts;
      const result = await this.pool.query(
        `UPDATE shadow_router_inbox
         SET status=$3,available_at=CASE WHEN $3='failed' THEN now()+$4*interval '1 millisecond' ELSE available_at END,
             claim_expires_at=NULL,claimed_by=NULL,claim_token=NULL,last_error=$5
         WHERE id=$1 AND status='processing' AND claim_token=$2 AND attempts=$6 AND claim_expires_at>now()`,
        [lease.id, lease.claim_token, dead ? 'dead' : 'failed', Math.max(0, delayMs), error.slice(0, 500), lease.attempt]
      );
      if (result.rowCount !== 1) throw new Error('shadow inbox retry was fenced');
      return dead ? 'dead' : 'retry';
    } finally {
      this.claims.delete(lease.id);
    }
  }

  async begin(envelope: ShadowEnvelope, mode: ShadowMode): Promise<ShadowMapping> {
    return withTransaction(this.pool, async (client) => {
      const inserted = await client.query(
        `INSERT INTO shadow_router_mappings(direction,source_event_id,tenant_id,mode,correlation)
         VALUES($1,$2,$3,$4,$5::jsonb) ON CONFLICT(direction,source_event_id) DO NOTHING`,
        [envelope.direction, envelope.source_event_id, envelope.tenant_id, mode, JSON.stringify(envelope.correlation)]
      );
      const selected = await client.query<MappingRow>(
        `SELECT direction,source_event_id,tenant_id,mode,target_event_id,correlation,status
         FROM shadow_router_mappings WHERE direction=$1 AND source_event_id=$2 FOR UPDATE`,
        [envelope.direction, envelope.source_event_id]
      );
      const row = selected.rows[0];
      if (!row || row.tenant_id !== envelope.tenant_id || row.mode !== mode || !sameCorrelation(row.correlation, envelope.correlation)) {
        throw new Error('shadow mapping idempotency conflict');
      }
      return {
        ...row,
        tenant_id: TenantSchema.parse(row.tenant_id),
        created: inserted.rowCount === 1
      };
    });
  }

  async complete(mapping: ShadowMapping, status: ShadowMappingStatus): Promise<void> {
    const result = await this.pool.query(
      `UPDATE shadow_router_mappings SET status=$4,updated_at=now()
       WHERE direction=$1 AND source_event_id=$2 AND target_event_id=$3`,
      [mapping.direction, mapping.source_event_id, mapping.target_event_id, status]
    );
    if (result.rowCount !== 1) throw new Error('shadow mapping completion was fenced');
  }

  async recordVerdict(mapping: ShadowMapping, verdict: ShadowVerdict): Promise<void> {
    await this.pool.query(
      `INSERT INTO shadow_compare_verdicts(
         direction,source_event_id,tenant_id,verdict,baseline_hash,candidate_hash,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT(direction,source_event_id) DO NOTHING`,
      [mapping.direction, mapping.source_event_id, mapping.tenant_id, verdict.verdict,
        verdict.baseline_hash ?? null, verdict.candidate_hash, JSON.stringify(verdict.metadata)]
    );
  }

  async reserveHumanReply(mapping: ShadowMapping, correlationKey: string): Promise<boolean> {
    return withTransaction(this.pool, async (client) => {
      const result = await client.query(
        `INSERT INTO shadow_human_reply_guards(
           tenant_id,correlation_key,direction,source_event_id,target_event_id
         ) VALUES($1,$2,$3,$4,$5) ON CONFLICT(tenant_id,correlation_key) DO NOTHING`,
        [mapping.tenant_id, correlationKey, mapping.direction, mapping.source_event_id, mapping.target_event_id]
      );
      if (result.rowCount === 1) return true;
      const existing = await client.query<{ target_event_id: string }>(
        `SELECT target_event_id FROM shadow_human_reply_guards
         WHERE tenant_id=$1 AND correlation_key=$2 FOR UPDATE`, [mapping.tenant_id, correlationKey]
      );
      return existing.rows[0]?.target_event_id === mapping.target_event_id;
    });
  }
}
