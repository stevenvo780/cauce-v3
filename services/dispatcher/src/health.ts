import type { Server } from 'node:http';
import { startHealthServer, type HealthAnswer } from '@cauce/protocol';
import type { DatabasePool } from '@cauce/store';
import type { DispatcherMetrics } from './metrics.js';

export interface DispatcherHealthServerOptions {
  port: number;
  host?: string;
  pool: DatabasePool;
  metrics: DispatcherMetrics;
  healthStaleMs: number;
  environment: string | undefined;
  lastError: () => string | undefined;
}

export function startDispatcherHealthServer(options: DispatcherHealthServerOptions): Server {
  return startHealthServer({
    port: options.port,
    ...(options.host === undefined ? {} : { host: options.host }),
    live: (): HealthAnswer => {
      const progress = options.metrics.progress(options.healthStaleMs);
      return {
        ok: progress.live,
        body: {
          status: progress.live ? 'live' : 'not_live',
          reason: progress.reason,
          ticks: progress.ticks,
          tick_age_ms: progress.tickAgeMs ?? null,
        },
      };
    },
    ready: async (): Promise<HealthAnswer> => {
      try {
        await assertPostgresReady(options.pool, options.environment);
      } catch (error) {
        return {
          ok: false,
          body: {
            status: 'not_ready',
            reason: error instanceof Error && /ssl|tls|encrypt/i.test(error.message)
              ? 'postgres_tls_required'
              : 'postgres_unavailable',
          },
        };
      }
      const progress = options.metrics.progress(options.healthStaleMs);
      if (!progress.ready) {
        return { ok: false, body: { status: 'not_ready', reason: progress.reason } };
      }
      return {
        ok: true,
        body: {
          status: 'ready',
          last_error: options.lastError() ?? null,
          ticks: progress.ticks,
          tick_age_ms: progress.tickAgeMs ?? null,
          successful_ticks: progress.successfulTicks,
          failed_ticks: progress.failedTicks,
          fenced_ticks: progress.fencedTicks,
        },
      };
    },
    metrics: async (): Promise<string> => options.metrics.render(),
  });
}

async function assertPostgresReady(
  pool: DatabasePool,
  environment: string | undefined,
): Promise<void> {
  await pool.query('SELECT 1');
  if (environment !== 'production') return;
  const encrypted = await pool.query<{ ssl: boolean }>(
    'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
  );
  if (encrypted.rows[0]?.ssl !== true) throw new Error('postgres connection is not encrypted');
}
