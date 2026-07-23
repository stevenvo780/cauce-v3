#!/usr/bin/env node
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { assertProductionPostgresTls } from './postgres-tls.mjs';

const require = createRequire(new URL('../packages/store/package.json', import.meta.url));
const { Pool } = require('pg');
const connectionString = process.env.DATABASE_URL;
if (!connectionString) throw new Error('DATABASE_URL is required');
const maxSideEffects = Number(process.env.CAUCE_SHADOW_MAX_SIDE_EFFECTS ?? '0');
if (!Number.isSafeInteger(maxSideEffects) || maxSideEffects < 0) throw new Error('CAUCE_SHADOW_MAX_SIDE_EFFECTS must be a non-negative integer');
const port = Number(process.env.PORT ?? '8085');
if (!Number.isSafeInteger(port) || port < 1) throw new Error('PORT must be a positive integer');
const pool = new Pool({ connectionString, max: 2 });

async function violations() {
  const result = await pool.query(`SELECT count(*)::bigint AS count
    FROM adapter_outbox
    WHERE coalesce(origin->>'shadow', 'false') = 'true'
      AND kind IN ('wake', 'origin_relay')`);
  return Number(result.rows[0]?.count ?? 0);
}

await assertProductionPostgresTls();
const server = createServer(async (request, response) => {
  try {
    if (request.url === '/health/live') {
      response.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: 'live' }));
      return;
    }
    const count = await violations();
    if (request.url === '/health/ready') {
      const ready = count <= maxSideEffects;
      response.writeHead(ready ? 200 : 503, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      response.end(JSON.stringify({ status: ready ? 'ready' : 'shadow_side_effect_detected' }));
      return;
    }
    if (request.url === '/metrics') {
      response.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'cache-control': 'no-store' });
      response.end(`# HELP cauce_shadow_side_effect_rows Shadow-tagged wake or relay rows; must remain zero.\n# TYPE cauce_shadow_side_effect_rows gauge\ncauce_shadow_side_effect_rows ${count}\n`);
      return;
    }
    response.writeHead(404, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: 'not_found' }));
  } catch {
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
