import { TenantSchema } from '@cauce/protocol';
import { withAbortableTransaction, withTransaction, type DatabasePool, type DatabaseClient } from '@cauce/store';
import { ShadowInboxIdempotencyConflictError } from './errors.js';
import { parseShadowEnvelope } from './router.js';
import type {
  ShadowDirection, ShadowEnvelope, ShadowInboxLease, ShadowInboxRepository,
  ShadowInboxHealth, ShadowMapping, ShadowMappingRepository, ShadowMappingStatus, ShadowMode, ShadowVerdict
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

const UNSTARTED_RELEASE_PREFIX = 'shadow inbox lease released before target dispatch:';
const OBSERVED_SETTLEMENT_PREFIX = 'shadow target settlement observed:';

function transaction<T>(
  pool: DatabasePool,
  signal: AbortSignal | undefined,
  work: (client: DatabaseClient) => Promise<T>,
): Promise<T> {
  return signal === undefined
    ? withTransaction(pool, work)
    : withAbortableTransaction(pool, signal, work);
}

export class PostgresShadowRepository implements ShadowMappingRepository, ShadowInboxRepository {
  private readonly claims = new Map<string, string>();

  constructor(private readonly pool: DatabasePool) {}

  async health(signal?: AbortSignal): Promise<ShadowInboxHealth> {
    const localClaimTokens = [...this.claims.values()];
    const result = await transaction(this.pool, signal, (client) => client.query<{
      pending: string; failed: string; dead: string; processing: string;
      owned_processing: string; oldest_ready_seconds: string;
    }>(
      `SELECT
         count(*) FILTER (WHERE status='pending') AS pending,
         count(*) FILTER (WHERE status='failed') AS failed,
         count(*) FILTER (WHERE status='dead') AS dead,
         count(*) FILTER (WHERE status='processing') AS processing,
         count(*) FILTER (
           WHERE status='processing' AND claim_expires_at>now()
             AND claim_token=ANY($1::uuid[])
         ) AS owned_processing,
         COALESCE(EXTRACT(EPOCH FROM now() - (
           min(created_at) FILTER (
             WHERE status IN ('pending','failed') AND available_at<=now()
           )
         )),0)::float8 AS oldest_ready_seconds
       FROM shadow_router_inbox`,
      [localClaimTokens],
    ));
    const row = result.rows[0];
    const counts = {
      pending: Number(row?.pending ?? Number.NaN),
      failed: Number(row?.failed ?? Number.NaN),
      dead: Number(row?.dead ?? Number.NaN),
      processing: Number(row?.processing ?? Number.NaN),
      owned_processing: Number(row?.owned_processing ?? Number.NaN),
    };
    const oldestReadySeconds = Number(row?.oldest_ready_seconds ?? Number.NaN);
    if (!Object.values(counts).every((value) => Number.isSafeInteger(value) && value >= 0)
      || counts.owned_processing > counts.processing
      || !Number.isFinite(oldestReadySeconds) || oldestReadySeconds < 0) {
      throw new Error('shadow inbox health query returned invalid counts');
    }
    return {
      ...counts,
      orphaned_processing: counts.processing - counts.owned_processing,
      oldest_ready_seconds: oldestReadySeconds,
    };
  }

  async enqueue(
    envelope: ShadowEnvelope,
    mode: ShadowMode,
    signal?: AbortSignal,
  ): Promise<{ id: string; duplicate: boolean }> {
    return transaction(this.pool, signal, async (client) => {
      const inserted = await client.query<{ id: string }>(
        `INSERT INTO shadow_router_inbox(direction,source_event_id,tenant_id,mode,correlation,envelope)
         VALUES($1,$2,$3,$4,$5::jsonb,$6::jsonb)
         ON CONFLICT(direction,source_event_id) DO NOTHING RETURNING id`,
        [envelope.direction, envelope.source_event_id, envelope.tenant_id, mode,
          JSON.stringify(envelope.correlation), JSON.stringify(envelope)]
      );
      if (inserted.rows[0]) return { id: inserted.rows[0].id, duplicate: false };
      const existing = await client.query<{
        id: string; tenant_id: string; mode: ShadowMode;
        correlation: ShadowMapping['correlation']; envelope_equal: boolean;
      }>(
        `SELECT id,tenant_id,mode,correlation,envelope=$3::jsonb AS envelope_equal
         FROM shadow_router_inbox
         WHERE direction=$1 AND source_event_id=$2 FOR UPDATE`,
        [envelope.direction, envelope.source_event_id, JSON.stringify(envelope)]
      );
      const row = existing.rows[0];
      if (!row || row.tenant_id !== envelope.tenant_id || row.mode !== mode || !row.envelope_equal
        || !sameCorrelation(row.correlation, envelope.correlation)) {
        throw new ShadowInboxIdempotencyConflictError();
      }
      return { id: row.id, duplicate: true };
    });
  }

  async claim(
    workerId: string,
    limit: number,
    leaseMs: number,
    signal?: AbortSignal,
  ): Promise<ShadowInboxLease[]> {
    const work = async (client: DatabaseClient) => {
      const reaped = await client.query<{ id: string }>(
        `WITH expired AS (
           SELECT inbox.id,inbox.attempts,inbox.max_attempts,
                  inbox.claim_target_started,
                  EXISTS (
                    SELECT 1 FROM shadow_router_mappings mapping
                     WHERE mapping.direction=inbox.direction
                       AND mapping.source_event_id=inbox.source_event_id
                       AND mapping.target_event_id IS NOT NULL
                       AND mapping.status IN ('shadowed','compared','delivered','blocked')
                  ) AS mapping_terminal
             FROM shadow_router_inbox inbox
            WHERE inbox.status='processing' AND inbox.claim_expires_at<=now()
            FOR UPDATE OF inbox
         )
         UPDATE shadow_router_inbox inbox
                SET status=CASE
                  WHEN expired.mapping_terminal THEN 'done'
                  WHEN inbox.attempts=0 THEN 'pending'
                  ELSE 'failed'
                END,
                attempts=inbox.attempts+CASE
                  WHEN expired.mapping_terminal
                    AND expired.claim_target_started
                    THEN 1
                  ELSE 0
                END,
                available_at=now(),
                completed_at=CASE WHEN expired.mapping_terminal THEN now() ELSE inbox.completed_at END,
                claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL,
                claim_target_started=false,
                last_error=CASE
                  WHEN expired.mapping_terminal THEN NULL
                  WHEN expired.claim_target_started THEN 'shadow target dispatch outcome was lost; replaying idempotently'
                  ELSE 'shadow inbox lease expired before target dispatch'
                END
           FROM expired
          WHERE inbox.id=expired.id
          RETURNING inbox.id`
      );
      const claimed = await client.query<{
        id: string; direction: ShadowDirection; source_event_id: string; tenant_id: string; mode: ShadowMode;
        envelope: unknown; attempts: number; max_attempts: number; claim_token: string;
      }>(
        `WITH picked AS (
           SELECT id FROM shadow_router_inbox
           WHERE status IN ('pending','failed') AND available_at<=now() AND attempts<max_attempts
           ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT $2
         )
         UPDATE shadow_router_inbox inbox
         SET status='processing',claimed_by=$1,claim_token=gen_random_uuid(),
             claim_expires_at=now()+$3*interval '1 millisecond',
             claim_target_started=false,
             last_error=NULL
         FROM picked WHERE inbox.id=picked.id
         RETURNING inbox.id,inbox.direction,inbox.source_event_id,inbox.tenant_id,inbox.mode,
                   inbox.envelope,inbox.attempts+1 AS attempts,
                   inbox.max_attempts,inbox.claim_token`,
        [workerId, limit, leaseMs]
      );
      return { claimed, reapedIds: reaped.rows.map((row) => row.id) };
    };
    const result = await transaction(this.pool, signal, work);
    for (const id of result.reapedIds) this.claims.delete(id);
    return result.claimed.rows.map((row) => {
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

  abandonLocalInboxClaim(lease: ShadowInboxLease): void {
    if (this.claims.get(lease.id) === lease.claim_token) this.claims.delete(lease.id);
  }

  async markTargetStarted(lease: ShadowInboxLease, signal?: AbortSignal): Promise<void> {
    this.assertClaim(lease);
    const result = await transaction(this.pool, signal, (client) => client.query(
      `UPDATE shadow_router_inbox
          SET claim_target_started=true
        WHERE id=$1 AND status='processing' AND claim_token=$2
          AND claim_target_started=false
          AND attempts=$3::integer-1
          AND attempts<max_attempts AND claim_expires_at>now()`,
      [lease.id, lease.claim_token, lease.attempt],
    ));
    if (result.rowCount !== 1) throw new Error('shadow inbox target start was fenced');
  }

  async completeInbox(lease: ShadowInboxLease, signal?: AbortSignal): Promise<void> {
    this.assertClaim(lease);
    let settled = false;
    try {
      await transaction(this.pool, signal, async (client) => {
        const result = await client.query(
          `UPDATE shadow_router_inbox
              SET status='done',
                  attempts=attempts+CASE WHEN claim_target_started THEN 1 ELSE 0 END,
                  completed_at=now(),claim_expires_at=NULL,claimed_by=NULL,
                  claim_token=NULL,claim_target_started=false
            WHERE id=$1 AND status='processing' AND claim_token=$2
              AND attempts=$3::integer-1
              AND claim_expires_at>now()`,
          [lease.id, lease.claim_token, lease.attempt]
        );
        if (result.rowCount === 1) return;
        // A lost COMMIT acknowledgement can make the first call throw after PostgreSQL already
        // committed. The worker retries terminal completion (never target retry), so recognize the
        // same row already done as an idempotent success.
        const existing = await client.query<{ status: string }>(
          `SELECT status FROM shadow_router_inbox WHERE id=$1`, [lease.id],
        );
        if (existing.rows[0]?.status !== 'done') throw new Error('shadow inbox completion was fenced');
      });
      settled = true;
    } finally {
      if (settled) this.claims.delete(lease.id);
    }
  }

  async retryInbox(
    lease: ShadowInboxLease,
    delayMs: number,
    error: string,
    signal?: AbortSignal,
  ): Promise<'retry' | 'dead' | 'done'> {
    this.assertClaim(lease);
    let settled = false;
    try {
      const dead = lease.attempt >= lease.max_attempts;
      // The marker survives a drained schema downgrade. If 036 is later applied again, its
      // historical repair can distinguish this observed settlement from legacy eager claims,
      // whose attempt count has no durable evidence.
      const settlementError = `${OBSERVED_SETTLEMENT_PREFIX} ${error}`.slice(0, 500);
      const status = await transaction(this.pool, signal, async (client): Promise<string> => {
        // Lock mapping before inbox so a competing late terminal completion and this failure
        // settlement have a total order. The mapping AFTER trigger repairs inbox if completion is
        // ordered second; if ordered first, this query observes terminal and settles done itself.
        const mapping = await client.query<{ status: ShadowMappingStatus }>(
          `SELECT status FROM shadow_router_mappings
            WHERE direction=$1 AND source_event_id=$2 FOR UPDATE`,
          [lease.direction, lease.source_event_id],
        );
        const mappingStatus = mapping.rows[0]?.status;
        if (!mappingStatus) throw new Error('shadow inbox mapping was unavailable during retry');
        const terminal = ['shadowed', 'compared', 'delivered', 'blocked'].includes(mappingStatus);
        const updated = await client.query<{ status: string }>(
          `UPDATE shadow_router_inbox inbox
            SET status=CASE WHEN $7::boolean THEN 'done' ELSE $3 END,
                attempts=inbox.attempts+1,
                available_at=CASE
                  WHEN NOT $7::boolean AND $3='failed'
                    THEN now()+$4*interval '1 millisecond'
                  ELSE inbox.available_at
                END,
                completed_at=CASE WHEN $7::boolean THEN now() ELSE inbox.completed_at END,
                claim_expires_at=NULL,claimed_by=NULL,claim_token=NULL,
                claim_target_started=false,
                last_error=CASE WHEN $7::boolean THEN NULL ELSE $5 END
          WHERE inbox.id=$1 AND inbox.status='processing' AND inbox.claim_token=$2
            AND inbox.claim_target_started=true
            AND inbox.attempts=$6::integer-1 AND inbox.attempts<inbox.max_attempts
            AND inbox.claim_expires_at>now()
         RETURNING inbox.status`,
          [lease.id, lease.claim_token, dead ? 'dead' : 'failed', Math.max(0, delayMs),
            settlementError, lease.attempt, terminal]
        );
        if (updated.rowCount === 1) return updated.rows[0]!.status;
        if (terminal) {
          const existing = await client.query<{ status: string }>(
            `SELECT status FROM shadow_router_inbox WHERE id=$1`, [lease.id],
          );
          if (existing.rows[0]?.status === 'done') return 'done';
        }
        throw new Error('shadow inbox retry was fenced');
      });
      settled = true;
      if (status === 'done') return 'done';
      return dead ? 'dead' : 'retry';
    } finally {
      if (settled) this.claims.delete(lease.id);
    }
  }

  async releaseUnstartedInbox(
    lease: ShadowInboxLease,
    reason: string,
    signal?: AbortSignal,
  ): Promise<void> {
    this.assertClaim(lease);
    let settled = false;
    try {
      // Claim and dispatch arming do not increment attempts. This path returns a lease whose
      // target method did not run; the expiry reaper performs the same no-consumption recovery
      // when shutdown cleanup cannot reach PostgreSQL or a COMMIT acknowledgement is lost.
      // Keep a durable accounting marker after releasing the lease. An expired predecessor may
      // still publish a terminal mapping after this transaction; the schema trigger then knows
      // that the current lease consumed no attempt and charges the predecessor's settled effect.
      const releaseReason = `${UNSTARTED_RELEASE_PREFIX} ${reason}`.slice(0, 500);
      const result = await transaction(this.pool, signal, (client) => client.query(
        `UPDATE shadow_router_inbox
         SET status=CASE WHEN attempts=0 THEN 'pending' ELSE 'failed' END,
             available_at=now(),claim_expires_at=NULL,claimed_by=NULL,claim_token=NULL,
             claim_target_started=false,last_error=$4
         WHERE id=$1 AND status='processing' AND claim_token=$2
           AND attempts=$3::integer-1`,
        [lease.id, lease.claim_token, lease.attempt, releaseReason]
      ));
      settled = true;
      if (result.rowCount !== 1) throw new Error('shadow inbox unstarted release was fenced');
    } finally {
      if (settled) this.claims.delete(lease.id);
    }
  }

  async begin(
    envelope: ShadowEnvelope,
    mode: ShadowMode,
    signal?: AbortSignal,
  ): Promise<ShadowMapping> {
    return transaction(this.pool, signal, async (client) => {
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

  async complete(
    mapping: ShadowMapping,
    status: ShadowMappingStatus,
    signal?: AbortSignal,
  ): Promise<void> {
    const result = await transaction(this.pool, signal, (client) => client.query(
      `UPDATE shadow_router_mappings
       SET status=CASE
             WHEN status IN ('shadowed','compared','delivered','blocked') THEN status
             ELSE $4
           END,
           updated_at=CASE
             WHEN status IN ('shadowed','compared','delivered','blocked') THEN updated_at
             ELSE now()
           END
       WHERE direction=$1 AND source_event_id=$2 AND target_event_id=$3`,
      [mapping.direction, mapping.source_event_id, mapping.target_event_id, status]
    ));
    if (result.rowCount !== 1) throw new Error('shadow mapping completion was fenced');
  }

  async recordVerdict(
    mapping: ShadowMapping,
    verdict: ShadowVerdict,
    signal?: AbortSignal,
  ): Promise<void> {
    await transaction(this.pool, signal, (client) => client.query(
      `INSERT INTO shadow_compare_verdicts(
         direction,source_event_id,tenant_id,verdict,baseline_hash,candidate_hash,metadata
       ) VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)
       ON CONFLICT(direction,source_event_id) DO NOTHING`,
      [mapping.direction, mapping.source_event_id, mapping.tenant_id, verdict.verdict,
        verdict.baseline_hash ?? null, verdict.candidate_hash, JSON.stringify(verdict.metadata)]
    ));
  }

  async reserveHumanReply(
    mapping: ShadowMapping,
    correlationKey: string,
    signal?: AbortSignal,
  ): Promise<boolean> {
    return transaction(this.pool, signal, async (client) => {
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
