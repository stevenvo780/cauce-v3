import { createServer, type Server } from 'node:http';
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
  const health = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json');
    response.setHeader('cache-control', 'no-store');
    if (request.url === '/health/live') {
      const progress = options.metrics.progress(options.healthStaleMs);
      response.statusCode = progress.live ? 200 : 503;
      response.end(JSON.stringify({
        status: progress.live ? 'live' : 'not_live',
        reason: progress.reason,
        ticks: progress.ticks,
        tick_age_ms: progress.tickAgeMs ?? null,
      }));
      return;
    }
    if (request.url === '/health/ready') {
      try {
        await assertPostgresReady(options.pool, options.environment);
        const progress = options.metrics.progress(options.healthStaleMs);
        if (!progress.ready) {
          response.statusCode = 503;
          response.end(JSON.stringify({
            status: 'not_ready',
            reason: progress.reason,
          }));
          return;
        }
        response.statusCode = 200;
        response.end(JSON.stringify({
          status: 'ready',
          last_error: options.lastError() ?? null,
          ticks: progress.ticks,
          tick_age_ms: progress.tickAgeMs ?? null,
          successful_ticks: progress.successfulTicks,
          failed_ticks: progress.failedTicks,
          fenced_ticks: progress.fencedTicks,
        }));
      } catch (error) {
        response.statusCode = 503;
        response.end(JSON.stringify({
          status: 'not_ready',
          reason: error instanceof Error && /ssl|tls|encrypt/i.test(error.message)
            ? 'postgres_tls_required'
            : 'postgres_unavailable',
        }));
      }
      return;
    }
    if (request.url === '/metrics') {
      response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
      response.statusCode = 200;
      response.end(await options.metrics.render());
      return;
    }
    response.statusCode = 404;
    response.end(JSON.stringify({ error: 'not_found' }));
  });
  health.listen(options.port, options.host ?? '0.0.0.0');
  return health;
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
