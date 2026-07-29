import { randomUUID } from 'node:crypto';
import {
  CauceRepository, type ChainSilenceSweepOptions, type DatabasePool,
  type ObservabilityRetentionPolicy,
} from '@cauce/store';
import { asClaimedJob, createDefaultJobHandlerRegistry, type JobHandlerRegistry } from './handlers.js';
import type { DispatcherMetrics } from './metrics.js';

export interface DispatcherOptions {
  pollMs?: number;
  staleAckMs?: number;
  interactiveBurst?: number;
  jobLeaseMs?: number;
  /** Ver `DispatcherConfig.retryStartedDeliveries` y `CauceRepository.retryStaleDeliveries`. */
  retryStartedDeliveries?: boolean;
  /** Techo de vida total de un intento. Ver `DEFAULT_DELIVERY_LEASE_CAP_MS` en el store. */
  leaseCapMs?: number;
  leaseCapGraceMs?: number;
  /** Cada cuánto se poda la observabilidad. 0 apaga el barrido. */
  retentionIntervalMs?: number;
  retention?: ObservabilityRetentionPolicy;
  /** Reloj propio del vigía de cadenas mudas (P0-4). 0 lo apaga. */
  chainSweepMs?: number;
  chainSweep?: ChainSilenceSweepOptions;
  handlers?: JobHandlerRegistry;
  metrics?: DispatcherMetrics;
  onError?: (error: unknown) => void;
}

export function runDispatcher(pool: DatabasePool, options: DispatcherOptions = {}): { stop: () => void; tick: () => Promise<void> } {
  const repository = new CauceRepository(pool);
  const handlers = options.handlers ?? createDefaultJobHandlerRegistry(pool);
  const worker = `dispatcher:${randomUUID()}`;
  const chainSweepMs = options.chainSweepMs ?? 60_000;
  let running = false;
  const retentionIntervalMs = options.retentionIntervalMs ?? 0;
  // Arranca en -infinito para que el PRIMER tick barra: si arrancara en `Date.now()` un
  // dispatcher que se reinicia cada pocos minutos —lo normal durante un despliegue— nunca
  // llegaría a podar nada.
  let nextPruneAtMs = Number.NEGATIVE_INFINITY;
  // Mismo criterio para el vigía: el primer tick tras un despliegue ya barre, porque una raíz
  // que lleva horas muda no tiene por qué esperar otro minuto más.
  let lastChainSweep = Number.NEGATIVE_INFINITY;

  const tick = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      await repository.retryStaleDeliveries(options.staleAckMs ?? 30_000, 100, {
        retryStartedDeliveries: options.retryStartedDeliveries === true,
        ...(options.leaseCapMs === undefined ? {} : { leaseCapMs: options.leaseCapMs }),
        ...(options.leaseCapGraceMs === undefined
          ? {}
          : { leaseCapGraceMs: options.leaseCapGraceMs })
      });
      await repository.retryExpiredJobs();
      // Reloj propio: ~1 barrido/min contra los ~10 ticks/s del reaper. Y con su propio
      // try/catch, porque el vigía existe para que el dueño no se quede sin noticias: no
      // puede ser él quien tumbe el tick que reparte el trabajo.
      if (chainSweepMs > 0 && Date.now() - lastChainSweep >= chainSweepMs) {
        lastChainSweep = Date.now();
        try {
          options.metrics?.recordChainSweep(await repository.sweepSilentChains(options.chainSweep));
        } catch (error) {
          options.metrics?.recordChainSweepFailure();
          options.onError?.(error);
        }
      }
      const jobs = await repository.claimFairJobs(
        worker, 1, options.jobLeaseMs ?? 30_000, options.interactiveBurst ?? 3, 'dispatcher'
      );
      for (const job of jobs) {
        const claimed = asClaimedJob(job);
        const handler = handlers.get(claimed.kind);
        if (!handler) {
          const error = new UnknownJobKindError(claimed.kind);
          const deadLettered = await deadLetterUnknownJob(pool, claimed.id, worker, claimed.claim_token, error.message);
          options.metrics?.recordJob(claimed.lane, deadLettered ? 'unknown_kind' : 'fenced');
          options.onError?.(error);
          continue;
        }
        try {
          await handler(claimed);
          if (!await repository.completeJob(claimed.id, worker, claimed.claim_token)) {
            options.metrics?.recordJob(claimed.lane, 'fenced');
            throw new Error('job completion fenced');
          }
          options.metrics?.recordJob(claimed.lane, 'done');
        } catch (error) {
          const result = await repository.failJob(
            claimed.id, worker, error instanceof Error ? error.message : 'unknown job error', claimed.claim_token
          );
          options.metrics?.recordJob(claimed.lane, result);
          options.onError?.(error);
        }
      }
      // Va al final y con su propio try: la retención es mantenimiento, y un DELETE que falla
      // (por ejemplo porque la migración 014 todavía no aterrizó en esta base y no existe
      // `delivery_acks.renewal`) no puede dejar de reintentar garras vencidas, que es el
      // trabajo por el que existe el dispatcher. Se reporta por `onError`, no se traga.
      if (retentionIntervalMs > 0 && Date.now() >= nextPruneAtMs) {
        nextPruneAtMs = Date.now() + retentionIntervalMs;
        try {
          const pruned = await repository.pruneObservability(options.retention ?? {});
          if (pruned.ack_renewals + pruned.acks + pruned.audit_renewals + pruned.audit_events > 0) {
            console.log(JSON.stringify({ event: 'observability_pruned', ...pruned }));
          }
        } catch (error) {
          options.onError?.(error);
        }
      }
      options.metrics?.recordTick('ok');
    } catch (error) {
      options.metrics?.recordTick('error');
      throw error;
    } finally {
      running = false;
    }
  };

  const timer = setInterval(() => {
    void tick().catch((error: unknown) => options.onError?.(error));
  }, options.pollMs ?? 250);
  timer.unref();
  return { stop: () => clearInterval(timer), tick };
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
export * from './scheduler.js';
