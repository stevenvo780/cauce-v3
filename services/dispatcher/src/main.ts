import { createServer } from 'node:http';
import { createPool } from '@cauce/store';
import { configuredDispatcher } from './config.js';
import { createDefaultJobHandlerRegistry, DispatcherMetrics, runDispatcher } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const config = configuredDispatcher();
const pool = createPool(databaseUrl);
const tlsPolicy = postgresTlsPolicy(databaseUrl, process.env.NODE_ENV);
let lastError: string | undefined;
const metrics = new DispatcherMetrics(pool);
const dispatcher = tlsPolicy.ok ? runDispatcher(pool, {
  pollMs: config.pollMs,
  staleAckMs: config.ackTimeoutMs,
  interactiveBurst: config.interactiveBurst,
  retryStartedDeliveries: config.retryStartedDeliveries,
  jobLeaseMs: config.jobLeaseMs,
  handlers: createDefaultJobHandlerRegistry(pool),
  metrics,
  onError: (error) => {
    lastError = error instanceof Error ? error.message : 'dispatcher tick failed';
    console.error(JSON.stringify({ event: 'dispatcher_tick_failed', error: lastError }));
  }
}) : { stop: () => undefined };
if (!tlsPolicy.ok) {
  lastError = tlsPolicy.reason;
  console.error(JSON.stringify({ event: 'dispatcher_not_ready', reason: tlsPolicy.reason }));
}

const port = Number(process.env.PORT ?? 8082);
const health = createServer(async (request, response) => {
  response.setHeader('content-type', 'application/json');
  response.setHeader('cache-control', 'no-store');
  if (request.url === '/health/live') {
    response.statusCode = 200;
    response.end(JSON.stringify({ status: 'live' }));
    return;
  }
  if (request.url === '/health/ready') {
    try {
      if (!tlsPolicy.ok) throw new Error(tlsPolicy.reason);
      await pool.query('SELECT 1');
      if (process.env.NODE_ENV === 'production') {
        const encrypted = await pool.query<{ ssl: boolean }>(
          'SELECT ssl FROM pg_stat_ssl WHERE pid=pg_backend_pid()',
        );
        if (encrypted.rows[0]?.ssl !== true) throw new Error('postgres connection is not encrypted');
      }
      response.statusCode = 200;
      response.end(JSON.stringify({ status: 'ready', last_error: lastError ?? null }));
    } catch (error) {
      response.statusCode = 503;
      response.end(JSON.stringify({
        status: 'not_ready',
        reason: error instanceof Error && /ssl|tls|encrypt/i.test(error.message) ? 'postgres_tls_required' : 'postgres_unavailable',
      }));
    }
    return;
  }
  if (request.url === '/metrics') {
    response.setHeader('content-type', 'text/plain; version=0.0.4; charset=utf-8');
    response.statusCode = 200;
    response.end(await metrics.render(tlsPolicy.ok));
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ error: 'not_found' }));
});
health.listen(port, '0.0.0.0');

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  dispatcher.stop();
  await new Promise<void>((resolve) => health.close(() => resolve()));
  await pool.end();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });

function postgresTlsPolicy(connectionString: string, environment: string | undefined): { ok: boolean; reason?: string } {
  if (environment !== 'production') return { ok: true };
  let mode: string | null;
  try {
    const url = new URL(connectionString);
    mode = url.searchParams.get('sslmode') ?? process.env.PGSSLMODE ?? null;
  } catch {
    return { ok: false, reason: 'invalid DATABASE_URL' };
  }
  if (mode !== 'verify-full') {
    return { ok: false, reason: 'production PostgreSQL requires sslmode=verify-full' };
  }
  return { ok: true };
}
