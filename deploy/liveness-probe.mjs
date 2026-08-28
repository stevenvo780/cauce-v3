#!/usr/bin/env node

/**
 * PROGRESS probe, not a responsiveness probe.
 *
 * `readiness-probe.mjs` answers "does the process answer and is its Postgres alive?". That
 * question is answered YES while the work loop is STOPPED: the dispatcher may have its
 * `setInterval` dead, the bridge may have stopped asking for updates, and `SELECT 1` keeps
 * succeeding. All nine control-plane containers reported `healthy` in that state.
 *
 * This probe asks a different question: **did the loop counter MOVE since the last sample?**.
 * It takes one sample per run, persists it, and only fails when the counter has been frozen
 * for `stallMs`. It trusts no clock and no service-side computation: it compares two
 * independent observations of the same monotonic counter.
 *
 *   node deploy/liveness-probe.mjs <url> <field> [stallMs]
 *
 * `field` accepts dotted paths (`progress.ticks`). It MUST be a non-negative monotonic counter.
 *
 * States and verdicts:
 *   - no prior state              -> sample recorded and PASS (startup; we don't know yet)
 *   - value > previous            -> loop advanced, PASS and reset window
 *   - value < previous            -> process restarted, PASS and reset window
 *   - value == prev, age < stallMs -> PASS (a slow loop MUST NOT flap the container)
 *   - value == prev, age >= stallMs -> FAIL: the loop is stopped
 *
 * State lives in a file whose name is a hash of (url, field): if the container restarts,
 * state is lost and the probe restarts from scratch, which is exactly right — a freshly
 * started loop has no right to be declared dead yet.
 */

import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const [rawUrl, rawField, rawStallMs] = process.argv.slice(2);
const timeoutMs = positiveInteger(process.env.HEALTH_TIMEOUT_MS, 3000, 'HEALTH_TIMEOUT_MS');
const stateDirectory = process.env.CAUCE_LIVENESS_STATE_DIR || join(tmpdir(), 'cauce-liveness');
const maximumBodyBytes = 65_536;

function positiveInteger(value, fallback, name) {
  if (value === undefined || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

/** Read `a.b.c` without inheriting anything from the prototype: a hostile body cannot smuggle `__proto__`. */
function fieldValue(document, path) {
  let current = document;
  for (const segment of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined;
    if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
    current = current[segment];
  }
  return current;
}

function optionalFile(name) {
  const file = process.env[name];
  return file ? readFile(file) : Promise.resolve(undefined);
}

async function fetchHealthDocument(url) {
  const secure = url.protocol === 'https:';
  if (!secure && url.protocol !== 'http:') throw new Error('health URL must use HTTP or HTTPS');
  const [ca, cert, key] = secure
    ? await Promise.all([
      optionalFile('CAUCE_HEALTH_TLS_CA_FILE'),
      optionalFile('CAUCE_HEALTH_TLS_CERT_FILE'),
      optionalFile('CAUCE_HEALTH_TLS_KEY_FILE'),
    ])
    : [];
  if (secure && !ca) throw new Error('CAUCE_HEALTH_TLS_CA_FILE is required for HTTPS health');
  if (secure && ((cert && !key) || (!cert && key))) {
    throw new Error('health client certificate and key must be configured together');
  }
  const body = await new Promise((resolve, reject) => {
    const call = (secure ? httpsRequest : httpRequest)({
      protocol: url.protocol,
      hostname: url.hostname,
      port: url.port,
      path: `${url.pathname}${url.search}`,
      method: 'GET',
      headers: { accept: 'application/json' },
      signal: globalThis.AbortSignal.timeout(timeoutMs),
      ...(secure ? {
        ca,
        ...(cert && key ? { cert, key } : {}),
        servername: process.env.CAUCE_HEALTH_TLS_SERVERNAME || url.hostname,
        rejectUnauthorized: true,
      } : {}),
    }, (response) => {
      const chunks = [];
      let size = 0;
      response.on('data', (chunk) => {
        size += chunk.length;
        if (size > maximumBodyBytes) response.destroy(new Error('health response is too large'));
        else chunks.push(chunk);
      });
      response.once('error', reject);
      response.on('end', () => {
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(`HTTP ${response.statusCode ?? 0}`));
          return;
        }
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });
    call.once('error', reject);
    call.end();
  });
  return JSON.parse(body);
}

function statePath(url, field) {
  const digest = createHash('sha256').update(`${url}\u0000${field}`).digest('hex').slice(0, 32);
  return join(stateDirectory, `${digest}.json`);
}

async function readState(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch {
    return undefined;
  }
  try {
    const decoded = JSON.parse(contents);
    const value = Number(decoded?.value);
    const since = Number(decoded?.since);
    if (!Number.isFinite(value) || value < 0) return undefined;
    if (!Number.isSafeInteger(since) || since <= 0) return undefined;
    return { value, since };
  } catch {
    // A corrupted state MUST NOT take the container down: treat it as the first observation.
    return undefined;
  }
}

/** Atomic write, mode 0600: the state file carries no secrets, but it is also not shared. */
async function writeState(path, state) {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

try {
  if (!rawUrl || !rawField) {
    throw new Error('usage: liveness-probe.mjs <url> <progress-field> [stallMs]');
  }
  const stallMs = positiveInteger(rawStallMs, 60_000, 'stallMs');
  const url = new URL(rawUrl);
  const document = await fetchHealthDocument(url);
  const raw = fieldValue(document, rawField);
  const value = typeof raw === 'number' ? raw : Number.NaN;
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`progress field ${rawField} is missing or not a counter`);
  }

  const path = statePath(rawUrl, rawField);
  const previous = await readState(path);
  const now = Date.now();

  if (!previous || value !== previous.value) {
    // Advanced (or the process restarted and the counter went back): new window.
    await writeState(path, { value, since: now });
    process.exit(0);
  }

  const stalledMs = now - previous.since;
  if (stalledMs >= stallMs) {
    throw new Error(`progress stalled: ${rawField} frozen at ${value} for ${stalledMs}ms (limit ${stallMs}ms)`);
  }
  process.exit(0);
} catch (error) {
  console.error(`liveness failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exit(1);
}
