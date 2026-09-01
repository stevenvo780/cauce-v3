import { createPool } from '@cauce/store';
import { configuredDispatcher } from './config.js';
import { startDispatcherHealthServer } from './health.js';
import { createDefaultJobHandlerRegistry, DispatcherMetrics, runDispatcher } from './index.js';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL is required');
const config = configuredDispatcher();
const pool = createPool(databaseUrl);
let lastError: string | undefined;
const metrics = new DispatcherMetrics(pool);
const dispatcher = runDispatcher(pool, {
  pollMs: config.pollMs,
  staleAckMs: config.ackTimeoutMs,
  interactiveBurst: config.interactiveBurst,
  retryStartedDeliveries: config.retryStartedDeliveries,
  leaseCapMs: config.leaseCapMs,
  leaseCapGraceMs: config.leaseCapGraceMs,
  retentionIntervalMs: config.retentionIntervalMs,
  retention: {
    ackRenewalMs: config.retentionAckRenewalMs,
    ackMs: config.retentionAckMs,
    auditRenewalMs: config.retentionAuditRenewalMs,
    auditMs: config.retentionAuditMs,
    batch: config.retentionBatch,
  },
  jobLeaseMs: config.jobLeaseMs,
  chainSweepMs: config.chainSweepMs,
  chainSweep: {
    idleMs: config.chainIdleMs,
    settledGraceMs: config.chainSettledGraceMs,
    maxAgeMs: config.chainMaxAgeMs,
    limit: config.chainSweepLimit
  },
  handlers: createDefaultJobHandlerRegistry(pool),
  metrics,
  onError: (error) => {
    lastError = error instanceof Error ? error.message : 'dispatcher tick failed';
    console.error(JSON.stringify({ event: 'dispatcher_tick_failed', error: lastError }));
  }
});

const port = Number(process.env.PORT ?? 8082);
const health = startDispatcherHealthServer({
  port,
  pool,
  metrics,
  healthStaleMs: config.healthStaleMs,
  environment: process.env.NODE_ENV,
  lastError: () => lastError,
});

let shuttingDown = false;
async function shutdown(): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  dispatcher.stop();
  await new Promise<void>((resolve) => { health.close(() => { resolve(); }); });
  await pool.end();
}
process.once('SIGINT', () => { void shutdown(); });
process.once('SIGTERM', () => { void shutdown(); });
