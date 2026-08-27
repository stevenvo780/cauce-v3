import { createServer } from 'node:http';
import { CauceRepository, createPool } from '@cauce/store';
import { StoreOriginRelayRepository } from './repository.js';
import { assertRelayLeaseCoversSend, OriginRelayProgress } from './progress.js';
import {
  HttpWebhookOriginTransport, MapOriginTransportRegistry, type WebhookProvider
} from './transports.js';
import { OriginRelayWorker } from './worker.js';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function list(name: string): string[] {
  const values = required(name).split(',').map((item) => item.trim()).filter((item) => item.length > 0);
  if (values.length === 0) throw new Error(`${name} must contain at least one value`);
  return values;
}

function positiveInteger(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function loadProvider(moduleSpecifier: string): Promise<WebhookProvider> {
  if (/^(?:data|https?):/i.test(moduleSpecifier)) throw new Error('remote webhook provider modules are forbidden');
  const loaded: unknown = await import(moduleSpecifier);
  if (loaded === null || typeof loaded !== 'object') throw new Error('webhook provider module is invalid');
  const exports = loaded as Record<string, unknown>;
  const factory = exports.createWebhookProvider ?? exports.default;
  if (typeof factory !== 'function') throw new Error('webhook provider module must export createWebhookProvider');
  const createProvider = factory as () => void | Promise<unknown>;
  const provider: unknown = await createProvider();
  if (provider === null || typeof provider !== 'object') throw new Error('webhook provider factory returned an invalid provider');
  const candidate = provider as Partial<WebhookProvider>;
  if (typeof candidate.endpoint !== 'function' || typeof candidate.sign !== 'function') {
    throw new Error('webhook provider must implement endpoint and sign');
  }
  return candidate as WebhookProvider;
}

const databaseUrl = required('DATABASE_URL');
if (process.env.NODE_ENV === 'production') {
  const sslMode = new URL(databaseUrl).searchParams.get('sslmode') ?? process.env.PGSSLMODE;
  if (sslMode !== 'verify-full') {
    throw new Error('production PostgreSQL requires sslmode=verify-full');
  }
}
const provider = await loadProvider(required('CAUCE_WEBHOOK_PROVIDER_MODULE'));
const adapters = list('CAUCE_RELAY_ADAPTERS');
const httpTimeoutMs = positiveInteger('CAUCE_RELAY_HTTP_TIMEOUT_MS', 10_000);
const leaseMs = positiveInteger('CAUCE_RELAY_LEASE_MS', 30_000);
assertRelayLeaseCoversSend(leaseMs, httpTimeoutMs);
const transport = new HttpWebhookOriginTransport({
  provider,
  allowedOrigins: list('CAUCE_RELAY_ALLOWED_ORIGINS'),
  timeoutMs: httpTimeoutMs
});
const transports = new MapOriginTransportRegistry();
for (const adapter of adapters) transports.register(adapter, transport);

const pool = createPool(databaseUrl);
const repository = new StoreOriginRelayRepository(new CauceRepository(pool));
const pollMs = positiveInteger('CAUCE_RELAY_POLL_MS', 250);
const progress = new OriginRelayProgress(
  adapters.length,
  adapters.length * httpTimeoutMs + pollMs + 5_000
);
const worker = new OriginRelayWorker({
  repository,
  transports,
  leaseMs,
  // Parsed for compatibility, but OriginRelayWorker deliberately caps this to one fresh lease.
  batchSize: positiveInteger('CAUCE_RELAY_BATCH_SIZE', 1),
  maxAttempts: positiveInteger('CAUCE_RELAY_MAX_ATTEMPTS', 5),
  baseRetryMs: positiveInteger('CAUCE_RELAY_BASE_RETRY_MS', 500),
  pollMs,
  onResult: (result) => progress.result(result),
  onCycleStart: () => progress.cycleStarted(),
  onCycleSuccess: () => progress.cycleSucceeded(),
  onCycleError: () => progress.cycleFailed()
});
const shutdown = new AbortController();
const health = createServer(async (request, response) => {
  if (request.url === '/health/live') {
    const state = progress.snapshot();
    response.writeHead(state.live ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    response.end(JSON.stringify({ status: state.live ? 'live' : 'not_live', reason: state.reason,
      tick_age_ms: state.tick_age_ms }));
    return;
  }
  if (request.url === '/health/ready') {
    try {
      await pool.query('SELECT 1');
      const state = progress.snapshot();
      response.writeHead(state.ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: state.ready ? 'ready' : 'not_ready', reason: state.reason,
        configured_adapters: state.configured_adapters, tick_age_ms: state.tick_age_ms }));
    } catch {
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'not_ready' }));
    }
    return;
  }
  if (request.url === '/metrics') {
    response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
    response.end(progress.renderMetrics());
    return;
  }
  response.writeHead(404, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ error: 'not_found' }));
});
health.listen(positiveInteger('PORT', 8083), '0.0.0.0');
const stop = (): void => shutdown.abort();
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
try {
  await worker.run(shutdown.signal);
} finally {
  await new Promise<void>((resolve) => health.close(() => resolve()));
  await pool.end();
}
