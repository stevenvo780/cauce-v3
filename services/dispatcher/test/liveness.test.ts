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

/**
 * Pool que falla siempre. A propósito: lo que hay que demostrar es que el TICK avanza mientras
 * el bucle gira, sin importar si la iteración tuvo éxito. Un tick que falla sigue siendo prueba
 * de que el `setInterval` está vivo; el `SELECT 1` de hoy no distingue ni una cosa ni la otra.
 */
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
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

beforeEach(async () => {
  stateDirectory = await mkdtemp(join(tmpdir(), 'cauce-dispatcher-liveness-'));
});

afterEach(async () => {
  dispatcher?.stop();
  dispatcher = undefined;
  if (health) await new Promise<void>((resolve) => health!.close(() => resolve()));
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

    // `/health/ready` servido con el mismo contrato de progreso que main.ts.
    health = createServer((_request, response) => {
      const progress = metrics.progress(200);
      response.writeHead(progress.ready ? 200 : 503, { 'content-type': 'application/json' });
      response.end(JSON.stringify({
        status: progress.ready ? 'ready' : 'not_ready',
        reason: progress.reason,
        ticks: progress.ticks,
        tick_age_ms: progress.tickAgeMs ?? null,
      }));
    });
    await new Promise<void>((resolve) => health!.listen(0, '127.0.0.1', resolve));
    const address = health.address();
    if (typeof address === 'string' || address === null) throw new Error('no port');
    const url = `http://127.0.0.1:${address.port}/health/ready`;

    // El bucle gira de verdad: esperamos a ver ticks reales antes de juzgar nada.
    await new Promise((resolve) => setTimeout(resolve, 120));
    const turning = metrics.progress().ticks;
    expect(turning).toBeGreaterThan(0);

    expect((await runProbe(url, 200)).code).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 80));
    expect((await runProbe(url, 200)).code).toBe(0);
    expect(metrics.progress().ticks).toBeGreaterThan(turning);

    // Se para el bucle. El proceso HTTP sigue en pie, pero readiness deja de mentir cuando vence
    // el deadline local de progreso.
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
