import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DatabasePool } from '@cauce/store';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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

    // `/health/ready` served with the same progress contract as main.ts.
    const server = createServer((_request, response) => {
      const progress = metrics.progress(200);
      response.writeHead(progress.ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: progress.ready ? 'ready' : 'not_ready',
        reason: progress.reason,
        ticks: progress.ticks,
        tick_age_ms: progress.tickAgeMs ?? null,
      }));
    });
    health = server;
    await new Promise<void>((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(); }); });
    const address = server.address();
    if (typeof address !== 'object' || address === null) throw new Error('no port');
    const url = `http://127.0.0.1:${String(address.port)}/health/ready`;

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
