import { createHash } from 'node:crypto';

export const legacyConsoleOutboxReason =
  'fenced:legacy-console-origin-relay-has-no-transport-v1';
const auditAction = 'outbox.reconcile.legacy_console_v1';

function finiteCount(value, label) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} is not a finite count`);
  return parsed;
}

export async function inspectLegacyConsoleOutbox(pool, options = {}) {
  const thresholdSeconds = options.thresholdSeconds ?? 86_400;
  if (!Number.isSafeInteger(thresholdSeconds) || thresholdSeconds < 3_600) {
    throw new Error('legacy console outbox threshold must be an integer of at least one hour');
  }
  const baselineAt = options.baselineAt ?? null;
  if (baselineAt !== null && Number.isNaN(Date.parse(baselineAt))) {
    throw new Error('legacy console outbox baseline timestamp is invalid');
  }
  const result = await pool.query(
    `SELECT
       (SELECT count(*) FROM adapter_outbox outbox
         WHERE outbox.kind='origin_relay' AND outbox.adapter='console'
           AND outbox.status='pending'
           AND outbox.created_at<=now()-$1*interval '1 second')::text AS candidates,
       (SELECT count(*) FROM adapter_outbox outbox
         WHERE outbox.kind='origin_relay' AND outbox.adapter='console'
           AND outbox.status='processing'
           AND COALESCE(outbox.claim_expires_at,outbox.claimed_at,outbox.created_at)<=now())::text
         AS stale_processing,
       (SELECT count(*) FROM adapter_outbox outbox
          JOIN outbox_dead_letters dead ON dead.outbox_id=outbox.id
         WHERE outbox.kind='origin_relay' AND outbox.adapter='console'
           AND outbox.status<>'dead')::text AS inconsistent_dead_letters,
       (SELECT count(*) FROM outbox_dead_letters)::text AS dead_total,
       (SELECT count(*) FROM outbox_dead_letters dead
         WHERE $2::timestamptz IS NOT NULL AND dead.created_at<$2::timestamptz)::text AS dead_before_baseline,
       (SELECT count(*) FROM outbox_dead_letters dead
         WHERE $2::timestamptz IS NOT NULL AND dead.created_at>=$2::timestamptz)::text AS dead_after_baseline,
       (SELECT count(*) FROM outbox_dead_letters dead
         WHERE dead.created_at>=now()-interval '24 hours')::text AS dead_last_24h,
       (SELECT count(*) FROM audit_events audit
         WHERE audit.action=$3 AND audit.metadata->>'reason'=$4)::text AS reconciliation_audits,
       (SELECT extract(epoch FROM now()-min(outbox.created_at))
          FROM adapter_outbox outbox
         WHERE outbox.kind='origin_relay' AND outbox.adapter='console'
           AND outbox.status='pending'
           AND outbox.created_at<=now()-$1*interval '1 second')::text AS oldest_candidate_seconds`,
    [thresholdSeconds, baselineAt, auditAction, legacyConsoleOutboxReason],
  );
  const row = result.rows[0] ?? {};
  const oldestRaw = row.oldest_candidate_seconds;
  const oldestCandidateSeconds = oldestRaw === null
    ? null
    : Number(oldestRaw);
  if (oldestCandidateSeconds !== null
      && (!Number.isFinite(oldestCandidateSeconds) || oldestCandidateSeconds < 0)) {
    throw new Error('oldest legacy console outbox age is not finite');
  }
  return {
    thresholdSeconds,
    baselineAt,
    reason: legacyConsoleOutboxReason,
    counts: {
      candidates: finiteCount(row.candidates, 'candidate count'),
      staleProcessing: finiteCount(row.stale_processing, 'stale processing count'),
      inconsistentDeadLetters: finiteCount(row.inconsistent_dead_letters, 'inconsistent DLQ count'),
      deadTotal: finiteCount(row.dead_total, 'dead total'),
      deadBeforeBaseline: finiteCount(row.dead_before_baseline, 'dead before baseline count'),
      deadAfterBaseline: finiteCount(row.dead_after_baseline, 'dead after baseline count'),
      deadLast24h: finiteCount(row.dead_last_24h, 'dead last 24h count'),
      reconciliationAudits: finiteCount(row.reconciliation_audits, 'reconciliation audit count'),
    },
    oldestCandidateSeconds,
  };
}

export async function applyLegacyConsoleOutboxReconciliation(pool, options = {}) {
  const thresholdSeconds = options.thresholdSeconds ?? 86_400;
  const expectedCandidates = options.expectedCandidates ?? 1;
  if (!Number.isSafeInteger(expectedCandidates) || expectedCandidates !== 1) {
    throw new Error('legacy console outbox reconciliation requires exactly one expected candidate');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(783003029)');
    const invalid = await client.query(
      `SELECT
         count(*) FILTER (WHERE outbox.status='processing')::text AS processing,
         count(*) FILTER (WHERE dead.outbox_id IS NOT NULL AND outbox.status<>'dead')::text AS inconsistent
       FROM adapter_outbox outbox
       LEFT JOIN outbox_dead_letters dead ON dead.outbox_id=outbox.id
       WHERE outbox.kind='origin_relay' AND outbox.adapter='console'
         AND outbox.created_at<=now()-$1*interval '1 second'
         AND (outbox.status IN ('pending','processing') OR dead.outbox_id IS NOT NULL)`,
      [thresholdSeconds],
    );
    if (finiteCount(invalid.rows[0]?.processing, 'stale processing count') !== 0
        || finiteCount(invalid.rows[0]?.inconsistent, 'inconsistent DLQ count') !== 0) {
      throw new Error('legacy console outbox has a claimed or inconsistent row; refusing reconciliation');
    }
    const selected = await client.query(
      `SELECT outbox.id,outbox.tenant_id,outbox.request_id,outbox.message_id,outbox.delivery_id,
              outbox.trace_id,outbox.payload,outbox.attempts,outbox.status
         FROM adapter_outbox outbox
        WHERE outbox.kind='origin_relay' AND outbox.adapter='console'
          AND outbox.status='pending'
          AND outbox.created_at<=now()-$1*interval '1 second'
        ORDER BY outbox.created_at FOR UPDATE OF outbox`,
      [thresholdSeconds],
    );
    if (selected.rows.length === 0) {
      const prior = await client.query(
        `SELECT count(*)::text AS count FROM audit_events
          WHERE action=$1 AND metadata->>'reason'=$2`,
        [auditAction, legacyConsoleOutboxReason],
      );
      if (finiteCount(prior.rows[0]?.count, 'prior reconciliation count') < 1) {
        throw new Error('expected legacy console outbox candidate is absent without reconciliation evidence');
      }
      await client.query('COMMIT');
      return { appliedCount: 0, alreadyApplied: true, rowDigests: [] };
    }
    if (selected.rows.length !== expectedCandidates) {
      throw new Error(`expected exactly ${expectedCandidates} legacy console outbox candidate`);
    }
    const rowDigests = [];
    for (const row of selected.rows) {
      await client.query(
        `UPDATE adapter_outbox SET status='dead',dead_at=now(),last_error=$2,
           claimed_by=NULL,claim_token=NULL,claim_expires_at=NULL
         WHERE id=$1 AND status='pending'`,
        [row.id, legacyConsoleOutboxReason],
      );
      await client.query(
        `INSERT INTO outbox_dead_letters(outbox_id,tenant_id,adapter,kind,reason,payload,attempts)
         VALUES($1,$2,'console','origin_relay',$3,$4::jsonb,$5)`,
        [row.id, row.tenant_id, legacyConsoleOutboxReason, JSON.stringify(row.payload), row.attempts],
      );
      const rowDigest = createHash('sha256').update(String(row.id)).digest('hex');
      rowDigests.push(rowDigest);
      await client.query(
        `INSERT INTO audit_events(
           tenant_id,actor_alias,action,decision,request_id,message_id,delivery_id,trace_id,metadata
         ) VALUES($1,NULL,$2,'info',$3,$4,$5,$6,$7::jsonb)`,
        [row.tenant_id, auditAction, row.request_id, row.message_id, row.delivery_id, row.trace_id,
          JSON.stringify({
            reason: legacyConsoleOutboxReason,
            outbox_id_sha256: rowDigest,
            previous_status: row.status,
            terminal_status: 'dead',
            payload_preserved_in_outbox_dlq: true,
          })],
      );
    }
    await client.query('COMMIT');
    return { appliedCount: selected.rows.length, alreadyApplied: false, rowDigests };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
