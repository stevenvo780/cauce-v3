#!/usr/bin/env node
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createPool } from '../packages/store/dist/db.js';
import { assertProductionPostgresTls } from './postgres-tls.mjs';

const kinds = ['wake', 'origin_relay'];
const statuses = ['pending', 'processing', 'sent', 'failed', 'dead'];

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

function number(value) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

async function collect(pool) {
  const [depth, oldest, deadLetters] = await Promise.all([
    pool.query(`SELECT kind, status, count(*)::bigint AS value
      FROM adapter_outbox GROUP BY kind, status`),
    pool.query(`SELECT kind, status,
        extract(epoch FROM greatest(interval '0 seconds', now() - min(created_at)))::float8 AS value
      FROM adapter_outbox WHERE status IN ('pending','processing','failed') GROUP BY kind, status`),
    pool.query(`SELECT kind, count(*)::bigint AS value
      FROM outbox_dead_letters WHERE resolved_at IS NULL GROUP BY kind`),
  ]);
  const depthMap = new Map(depth.rows.map((row) => [`${row.kind}:${row.status}`, number(row.value)]));
  const oldestMap = new Map(oldest.rows.map((row) => [`${row.kind}:${row.status}`, number(row.value)]));
  const deadMap = new Map(deadLetters.rows.map((row) => [row.kind, number(row.value)]));
  const lines = [
    '# HELP cauce_outbox_query_success Whether exact PostgreSQL outbox gauges were collected.',
    '# TYPE cauce_outbox_query_success gauge',
    'cauce_outbox_query_success 1',
    '# HELP cauce_outbox_depth Adapter outbox rows by durable kind and status.',
    '# TYPE cauce_outbox_depth gauge',
  ];
  for (const kind of kinds) for (const status of statuses) {
    lines.push(`cauce_outbox_depth{kind="${kind}",status="${status}"} ${depthMap.get(`${kind}:${status}`) ?? 0}`);
  }
  lines.push(
    '# HELP cauce_outbox_oldest_seconds Age of the oldest unfinished adapter outbox row.',
    '# TYPE cauce_outbox_oldest_seconds gauge',
  );
  for (const kind of kinds) for (const status of ['pending', 'processing', 'failed']) {
    lines.push(`cauce_outbox_oldest_seconds{kind="${kind}",status="${status}"} ${oldestMap.get(`${kind}:${status}`) ?? 0}`);
  }
  lines.push(
    '# HELP cauce_outbox_dead_letters_open Open adapter outbox dead letters.',
    '# TYPE cauce_outbox_dead_letters_open gauge',
  );
  for (const kind of kinds) lines.push(`cauce_outbox_dead_letters_open{kind="${kind}"} ${deadMap.get(kind) ?? 0}`);
  return `${lines.join('\n')}\n`;
}

export async function startOutboxMetrics() {
  const port = positiveInteger(process.env.PORT, 8084);
  const connectionString = required('DATABASE_URL');
  const pool = createPool(connectionString, { max: 2 });

  await assertProductionPostgresTls();
  const server = createServer(async (request, response) => {
    try {
      if (request.url === '/health/live') {
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ status: 'live' }));
        return;
      }
      if (request.url === '/health/ready') {
        await pool.query('SELECT 1');
        response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        response.end(JSON.stringify({ status: 'ready' }));
        return;
      }
      if (request.url === '/metrics') {
        const body = await collect(pool);
        response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
        response.end(body);
        return;
      }
      response.writeHead(404, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: 'not_found' }));
    } catch {
      if (request.url === '/metrics') {
        response.writeHead(503, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8' });
        response.end('cauce_outbox_query_success 0\n');
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
