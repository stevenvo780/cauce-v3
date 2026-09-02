import { randomUUID } from 'node:crypto';
import { logEvent } from '@cauce/protocol';
import {
  CauceRepository, type ChainSilenceSweepOptions, type DatabasePool,
  type ObservabilityRetentionPolicy,
} from '@cauce/store';
import { asClaimedJob, createDefaultJobHandlerRegistry, type JobHandlers } from './handlers.js';
import type { DispatcherMetrics } from './metrics.js';
import { type DispatcherPhase, PhaseGuard } from './phases.js';

interface DispatcherOptions {
  pollMs?: number;
  staleAckMs?: number;
  interactiveBurst?: number;
  jobLeaseMs?: number;
  /** See `DispatcherConfig.retryStartedDeliveries` and `CauceRepository.retryStaleDeliveries`. */
  retryStartedDeliveries?: boolean;
  /** Total lease cap per attempt. See `DEFAULT_DELIVERY_LEASE_CAP_MS` in the store. */
  leaseCapMs?: number;
  leaseCapGraceMs?: number;
  /** Observability sweep interval. 0 disables the sweep. */
  retentionIntervalMs?: number;
  retention?: ObservabilityRetentionPolicy;
  /** Silent-chain watchdog clock (P0-4). 0 disables it. */
  chainSweepMs?: number;
  chainSweep?: ChainSilenceSweepOptions;
  handlers?: JobHandlers;
  metrics?: DispatcherMetrics;
  onError?: (error: unknown, phase?: DispatcherPhase) => void;
}

export function runDispatcher(pool: DatabasePool, options: DispatcherOptions = {}): { stop: () => void; tick: () => Promise<void> } {
  const repository = new CauceRepository(pool);
  const handlers = options.handlers ?? createDefaultJobHandlerRegistry(pool);
  const worker = `dispatcher:${randomUUID()}`;
  const chainSweepMs = options.chainSweepMs ?? 60_000;
  const pollMs = options.pollMs ?? 250;
  const guard = new PhaseGuard({
    baseMs: pollMs,
    onFailure: (phase, error) => {
      options.metrics?.recordPhaseFailure(phase);
      options.onError?.(error, phase);
    },
  });
  let running = false;
  const retentionIntervalMs = options.retentionIntervalMs ?? 0;
  // Initialize to -Infinity so the first sweep fires on the initial tick.
  let nextPruneAtMs = Number.NEGATIVE_INFINITY;
  let lastChainSweep = Number.NEGATIVE_INFINITY;

  const runClaimedJobs = async (jobs: readonly Readonly<Record<string, unknown>>[]): Promise<void> => {
    for (const job of jobs) {
      const claimed = asClaimedJob(job);
      const handler = Object.hasOwn(handlers, claimed.kind) ? handlers[claimed.kind] : undefined;
      if (!handler) {
        const error = new UnknownJobKindError(claimed.kind);
        const deadLettered = await deadLetterUnknownJob(
          pool, claimed.id, worker, claimed.claim_token, error.message
        );
        options.metrics?.recordJob(claimed.lane, deadLettered ? 'unknown_kind' : 'fenced');
        options.onError?.(error);
        continue;
      }
      try {
        await handler(claimed);
        if (!await repository.completeJob(claimed.id, worker, claimed.claim_token)) {
          throw new Error('job completion fenced');
        }
        options.metrics?.recordJob(claimed.lane, 'done');
      } catch (error) {
        const result = await repository.failJob(
          claimed.id, worker, error instanceof Error ? error.message : 'unknown job error',
          claimed.claim_token
        );
        options.metrics?.recordJob(claimed.lane, result);
        options.onError?.(error);
      }
    }
  };

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const stale = await guard.run('stale_deliveries', async () => repository.retryStaleDeliveries(
        options.staleAckMs ?? 30_000, 100, {
          retryStartedDeliveries: options.retryStartedDeliveries === true,
          ...(options.leaseCapMs === undefined ? {} : { leaseCapMs: options.leaseCapMs }),
          ...(options.leaseCapGraceMs === undefined
            ? {}
            : { leaseCapGraceMs: options.leaseCapGraceMs })
        }
      ));
      const expired = await guard.run('expired_jobs', async () => repository.retryExpiredJobs());
      if (chainSweepMs > 0 && Date.now() - lastChainSweep >= chainSweepMs) {
        const swept = await guard.run(
          'chain_sweep', async () => repository.sweepSilentChains(options.chainSweep)
        );
        if (swept.status !== 'skipped') lastChainSweep = Date.now();
        if (swept.status === 'ok') options.metrics?.recordChainSweep(swept.value);
        if (swept.status === 'failed') options.metrics?.recordChainSweepFailure();
      }
      const claimed = await guard.run('claim_jobs', async () => repository.claimFairJobs(
        worker, 1, options.jobLeaseMs ?? 30_000, options.interactiveBurst ?? 3, 'dispatcher'
      ));
      if (claimed.status === 'ok') await runClaimedJobs(claimed.value);
      if (retentionIntervalMs > 0 && Date.now() >= nextPruneAtMs) {
        nextPruneAtMs = Date.now() + retentionIntervalMs;
        await guard.run('retention', async () => {
          const pruned = await repository.pruneObservability(options.retention ?? {});
          if (pruned.ack_renewals + pruned.acks + pruned.audit_renewals + pruned.audit_events > 0) {
            logEvent('observability_pruned', { ...pruned }, { level: 'info' });
          }
        });
      }
      const degraded = [stale, expired, claimed].some((outcome) => outcome.status !== 'ok');
      options.metrics?.recordTick(degraded ? 'error' : 'ok');
    } catch (error) {
      options.metrics?.recordTick('error');
      throw error;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((error: unknown) => options.onError?.(error));
  }, pollMs);
  timer.unref();
  return { stop: () => { clearInterval(timer); }, tick };
}

export class UnknownJobKindError extends Error {
  constructor(readonly kind: string) {
    super(`unknown job kind: ${kind}`);
    this.name = 'UnknownJobKindError';
  }
}

async function deadLetterUnknownJob(
  pool: DatabasePool, id: string, worker: string, claimToken: string, reason: string
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const selected = await client.query<{ tenant_id: string; payload: Record<string, unknown>; attempts: number }>(
      `UPDATE jobs SET status='dead',lease_until=NULL,claim_token=NULL,last_error=$4,updated_at=now()
       WHERE id=$1 AND claimed_by=$2 AND claim_token=$3 AND status='running' AND lease_until>now()
       RETURNING tenant_id,payload,attempts`,
      [id, worker, claimToken, reason.slice(0, 2_000)],
    );
    const row = selected.rows[0];
    if (!row) {
      await client.query('ROLLBACK');
      return false;
    }
    await client.query(
      `INSERT INTO dead_letters(job_id,tenant_id,reason,payload,attempts)
       VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(job_id) DO NOTHING`,
      [id, row.tenant_id, reason.slice(0, 2_000), JSON.stringify(row.payload), row.attempts],
    );
    await client.query('COMMIT');
    return true;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

export * from './handlers.js';
export * from './config.js';
export * from './metrics.js';
export * from './phases.js';
