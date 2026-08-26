#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createPool } from '../packages/store/dist/db.js';
import { assertProductionPostgresTls } from './postgres-tls.mjs';
import { collectOutboxMetrics } from './outbox-metrics-core.mjs';
import {
  activeConnectionLeaseCount,
  collectReleaseStateMetrics,
} from './release-state-metrics.mjs';

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function positiveInteger(raw, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('PORT must be a positive integer');
  return value;
}

export async function startOutboxMetrics() {
  const port = positiveInteger(process.env.PORT, 8084);
  const connectionString = required('DATABASE_URL');
  const releaseStateFile = required('CAUCE_RELEASE_STATE_FILE');
  const pool = createPool(connectionString, { max: 2 });

  const collectMetrics = async () => {
    const [outbox, activeLeases] = await Promise.all([
      collectOutboxMetrics(pool),
      activeConnectionLeaseCount(pool),
    ]);
    const release = await collectReleaseStateMetrics(releaseStateFile, activeLeases);
    return `${outbox}${release}`;
  };

  await assertProductionPostgresTls();
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/health/live') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ status: 'live' }));
        return;
      }
      if (request.url === '/health/ready') {
        // Readiness proves the exact exporter queries still match the live schema and return finite
        // values.  A bare SELECT 1 stayed green while the only useful metrics had silently become
        // zero after a query/decoder failure.
        await collectMetrics();
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      if (request.url === '/metrics') {
        const body = await collectMetrics();
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        response.end(body);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    } catch {
      if (request.url === '/metrics') {
        response.writeHead(503, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        response.end('cauce_outbox_query_success 0\ncauce_release_state_valid 0\n');
        return;
      }
      response.writeHead(503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'not_ready' }));
    }
  });
  server.listen(port, '0.0.0.0');

  const stop = async () => {
    await new Promise((resolve) => server.close(resolve));
    await pool.end();
  };
  process.once('SIGINT', () => void stop().finally(() => process.exit(0)));
  process.once('SIGTERM', () => void stop().finally(() => process.exit(0)));
  return { server, stop };
}

const entrypoint = process.argv[1];
if (entrypoint && pathToFileURL(entrypoint).href === import.meta.url) {
  await startOutboxMetrics();
}
