import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabasePool } from '@cauce/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  startDispatcherHealthServer, type DispatcherHealthServerOptions,
} from '../src/health.js';
import { runDispatcher } from '../src/index.js';
import { DispatcherMetrics } from '../src/metrics.js';

const repositoryRoot = fileURLToPath(new URL('../../..', import.meta.url));
const probePath = join(repositoryRoot, 'deploy/liveness-probe.mjs');

/** Stub pool that throws an error to verify work loop progress under failure. */
const failingPool = {
  query: async () => { throw new Error('stub pool'); },
  connect: async () => { throw new Error('stub pool'); },
} as unknown as DatabasePool;

const idleClient = {
  query: async () => ({ rows: [], rowCount: 0 }),
  on: () => idleClient,
  off: () => idleClient,
  release: () => undefined,
};
const idlePool = {
  query: async () => ({ rows: [], rowCount: 0 }),
  connect: async () => idleClient,
} as unknown as DatabasePool;

let stateDirectory: string;
let health: Server | undefined;
let dispatcher: { stop: () => void } | undefined;

function runProbe(url: string, stallMs: number): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [probePath, url, 'ticks', String(stallMs)], {
      cwd: repositoryRoot,
      env: {
        PATH: process.env.PATH ?? '/usr/bin:/bin',
        HEALTH_TIMEOUT_MS: '3000',
        CAUCE_LIVENESS_STATE_DIR: stateDirectory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => { resolve({ code, stderr }); });
  });
}

async function listenHealth(
  options: Omit<DispatcherHealthServerOptions, 'port' | 'host'>,
  host?: string,
): Promise<string> {
  const server = startDispatcherHealthServer({
    port: 0,
    ...(host === undefined ? {} : { host }),
    ...options,
  });
  health = server;
  await once(server, 'listening');
  const address = server.address();
  if (typeof address !== 'object' || address === null) throw new Error('no port');
  return `http://127.0.0.1:${String(address.port)}`;
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'cauce-dispatcher-liveness-'));
});

afterEach(async () => {
  dispatcher?.stop();
  dispatcher = undefined;
  const currentHealth = health;
  if (currentHealth) await new Promise<void>((resolve) => { currentHealth.close(() => { resolve(); }); });
  health = undefined;
  await rm(stateDirectory, { recursive: true, force: true });
});

describe('dispatcher liveness: the probe must go red when the loop stops', () => {
  it('passes while the real dispatcher loop ticks and fails after stop()', async () => {
    const metrics = new DispatcherMetrics(idlePool);
    dispatcher = runDispatcher(idlePool, {
      pollMs: 10,
      chainSweepMs: 0,
      metrics,
      onError: () => undefined,
    });

    const baseUrl = await listenHealth({
      pool: idlePool,
      metrics,
      healthStaleMs: 200,
      environment: 'test',
      lastError: () => undefined,
    }, '127.0.0.1');
    const url = `${baseUrl}/health/ready`;

    // Loop runs for real: wait to see real ticks before assertions.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const turning = metrics.progress().ticks;
    expect(turning).toBeGreaterThan(0);

    expect((await runProbe(url, 200)).code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await runProbe(url, 200)).code).toBe(0);
    expect(metrics.progress().ticks).toBeGreaterThan(turning);

    // Stop the loop. The HTTP process stays alive, but readiness fails once the deadline expires.
    dispatcher.stop();
    const frozen = metrics.progress().ticks;
    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(metrics.progress().ticks).toBe(frozen);

    const stillAnswering = await fetch(url);
    expect(stillAnswering.status).toBe(200);
    expect(((await stillAnswering.json()) as { status: string }).status).toBe('ready');

    await new Promise((resolve) => setTimeout(resolve, 120));
    const dead = await runProbe(url, 200);
    expect(dead.code).toBe(1);
    expect(dead.stderr).toContain('HTTP 503');
  });

  it('serves liveness, readiness, metrics and not-found from the production implementation', async () => {
    const metrics = new DispatcherMetrics(idlePool);
    const baseUrl = await listenHealth({
      pool: idlePool,
      metrics,
      healthStaleMs: 1_000,
      environment: 'test',
      lastError: () => 'previous tick failed',
    });

    const live = await fetch(`${baseUrl}/health/live`);
    expect(live.status).toBe(200);
    expect(live.headers.get('cache-control')).toBe('no-store');
    expect(await live.json()).toMatchObject({ status: 'live', reason: 'starting', ticks: 0 });

    const starting = await fetch(`${baseUrl}/health/ready`);
    expect(starting.status).toBe(503);
    expect(await starting.json()).toEqual({ status: 'not_ready', reason: 'starting' });

    metrics.recordTick('ok');
    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({
      status: 'ready',
      last_error: 'previous tick failed',
      ticks: 1,
      successful_ticks: 1,
      failed_ticks: 0,
      fenced_ticks: 0,
    });

    const rendered = await fetch(`${baseUrl}/metrics`);
    expect(rendered.status).toBe(200);
    expect(rendered.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(await rendered.text()).toContain('cauce_dispatcher_metrics_query_success 1');

    const missing = await fetch(`${baseUrl}/missing`);
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ status: 'not_found' });
  });

  it('answers the probe path with a query string and rejects a non-GET method', async () => {
    const metrics = new DispatcherMetrics(idlePool);
    const baseUrl = await listenHealth({
      pool: idlePool,
      metrics,
      healthStaleMs: 1_000,
      environment: 'test',
      lastError: () => undefined,
    });

    const queried = await fetch(`${baseUrl}/health/live?probe=kubelet`);
    expect(queried.status).toBe(200);
    expect(queried.headers.get('content-type')).toBe('application/json; charset=utf-8');
    expect(queried.headers.get('content-length')).not.toBeNull();
    expect(await queried.json()).toMatchObject({ status: 'live', reason: 'starting' });

    const posted = await fetch(`${baseUrl}/health/live`, { method: 'POST' });
    expect(posted.status).toBe(405);
    expect(await posted.json()).toEqual({ status: 'method_not_allowed' });
  });

  it('reports database failures without disguising them as loop progress failures', async () => {
    const metrics = new DispatcherMetrics(failingPool);
    const baseUrl = await listenHealth({
      pool: failingPool,
      metrics,
      healthStaleMs: 1_000,
      environment: 'test',
      lastError: () => undefined,
    });

    const response = await fetch(`${baseUrl}/health/ready`);
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({
      status: 'not_ready',
      reason: 'postgres_unavailable',
    });
  });

  it('requires the active PostgreSQL connection to be encrypted in production', async () => {
    let encrypted = false;
    const tlsPool = {
      query: async (statement: string) => statement.startsWith('SELECT ssl')
        ? { rows: [{ ssl: encrypted }], rowCount: 1 }
        : { rows: [], rowCount: 1 },
      connect: async () => idleClient,
    } as unknown as DatabasePool;
    const metrics = new DispatcherMetrics(tlsPool);
    metrics.recordTick('ok');
    const baseUrl = await listenHealth({
      pool: tlsPool,
      metrics,
      healthStaleMs: 1_000,
      environment: 'production',
      lastError: () => undefined,
    });

    const rejected = await fetch(`${baseUrl}/health/ready`);
    expect(rejected.status).toBe(503);
    expect(await rejected.json()).toEqual({
      status: 'not_ready',
      reason: 'postgres_tls_required',
    });

    encrypted = true;
    const ready = await fetch(`${baseUrl}/health/ready`);
    expect(ready.status).toBe(200);
    expect(await ready.json()).toMatchObject({ status: 'ready', last_error: null });
  });

  it('counts a failing tick as liveness progress but never as readiness success', () => {
    let now = 1_000;
    const metrics = new DispatcherMetrics(failingPool, () => now);
    expect(metrics.progress()).toMatchObject({ ticks: 0, live: true, ready: false, reason: 'starting' });
    metrics.recordTick('error');
    const progress = metrics.progress();
    expect(progress).toMatchObject({ ticks: 1, live: true, ready: false, reason: 'tick_error' });
    now += 6_000;
    expect(metrics.progress()).toMatchObject({ live: false, ready: false, reason: 'loop_stale' });
  });

  it('classifies a fenced job completion as a failed tick until a clean tick follows', () => {
    const metrics = new DispatcherMetrics(failingPool, () => 1_000);
    metrics.recordJob('interactive', 'fenced');
    metrics.recordTick('ok');
    expect(metrics.progress()).toMatchObject({
      ticks: 1, successfulTicks: 0, fencedTicks: 1, ready: false, reason: 'fenced'
    });
    metrics.recordTick('ok');
    expect(metrics.progress()).toMatchObject({ successfulTicks: 1, ready: true, reason: 'ready' });
  });

  it('publishes the tick age so Prometheus sees a stopped loop as well', async () => {
    const metrics = new DispatcherMetrics(failingPool);
    const before = await metrics.render(false);
    expect(before).toContain('cauce_dispatcher_tick_age_seconds -1');
    metrics.recordTick('ok');
    expect(await metrics.render(false)).toMatch(/cauce_dispatcher_tick_age_seconds (0|0\.\d+)/);
  });
});
