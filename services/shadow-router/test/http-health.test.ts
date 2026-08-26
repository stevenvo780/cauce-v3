import { mkdtemp, rm } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ShadowRouterMetrics, shutdownShadowIngressServer, startShadowIngressServer,
} from '../src/http.js';
import { ShadowRouterProgress } from '../src/progress.js';
import { ShadowInboxIdempotencyConflictError } from '../src/errors.js';
import type { ShadowInboxHealth, ShadowInboxRepository } from '../src/types.js';

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map(async (directory) => rm(directory, { recursive: true, force: true })));
});

async function get(socketPath: string, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({ socketPath, path, method: 'GET' }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end();
  });
}

async function post(socketPath: string, path: string, body: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      socketPath, path, method: 'POST',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(body)) },
    }, (response) => {
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => chunks.push(chunk));
      response.on('end', () => resolve({
        status: response.statusCode ?? 0,
        body: Buffer.concat(chunks).toString('utf8'),
      }));
    });
    request.once('error', reject);
    request.end(body);
  });
}

function health(overrides: Partial<ShadowInboxHealth> = {}): ShadowInboxHealth {
  return {
    pending: 0, failed: 0, dead: 0, processing: 0, owned_processing: 0,
    orphaned_processing: 0, oldest_ready_seconds: 0, ...overrides,
  };
}

function repository(): ShadowInboxRepository {
  return {
    enqueue: vi.fn(async () => ({ id: 'inbox-1', duplicate: false })),
    claim: vi.fn(async () => []),
    markTargetStarted: vi.fn(async () => undefined),
    completeInbox: vi.fn(async () => undefined),
    retryInbox: vi.fn(async (): Promise<'retry'> => 'retry'),
    releaseUnstartedInbox: vi.fn(async () => undefined),
    abandonLocalInboxClaim: vi.fn(),
    health: vi.fn(async () => health()),
  };
}

describe('shadow-router health', () => {
  it('requires DB and observed loop progress, and exposes the real reason', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-shadow-health-'));
    directories.push(directory);
    const socketPath = join(directory, 'router.sock');
    const repo = repository();
    const progress = new ShadowRouterProgress(20_000);
    const server = await startShadowIngressServer({
      socketPath, mode: 'shadow', allowedTenants: new Set(['Steven']),
      repository: repo, metrics: new ShadowRouterMetrics(), progress,
    });
    try {
      const starting = await get(socketPath, '/health/ready');
      expect(starting.status).toBe(503);
      expect(JSON.parse(starting.body)).toMatchObject({ status: 'not_ready', reason: 'starting' });

      progress.cycleStarted();
      progress.cycleCompleted({ claimed: 0, routed: 0, failed: 0 });
      const ready = await get(socketPath, '/health/ready');
      expect(ready.status).toBe(200);
      expect(JSON.parse(ready.body)).toMatchObject({ status: 'ready', reason: 'ready' });

      repo.health = vi.fn(async () => health({ failed: 1 }));
      const retry = await get(socketPath, '/health/ready');
      expect(retry.status).toBe(503);
      expect(JSON.parse(retry.body)).toMatchObject({ status: 'not_ready', reason: 'retry_backlog' });

      repo.health = vi.fn(async () => health({ dead: 1 }));
      const dead = await get(socketPath, '/health/ready');
      expect(dead.status).toBe(503);
      expect(JSON.parse(dead.body)).toMatchObject({ status: 'not_ready', reason: 'dead_inbox' });

      repo.health = vi.fn(async () => health({ processing: 1, orphaned_processing: 1 }));
      const orphaned = await get(socketPath, '/health/ready');
      expect(orphaned.status).toBe(503);
      expect(JSON.parse(orphaned.body)).toMatchObject({
        status: 'not_ready', reason: 'orphaned_processing',
      });

      repo.health = vi.fn(async () => { throw new Error('database down'); });
      const database = await get(socketPath, '/health/ready');
      expect(database.status).toBe(503);
      expect(JSON.parse(database.body)).toMatchObject({ status: 'not_ready', reason: 'database' });

      repo.health = vi.fn(async () => health({ pending: 4, oldest_ready_seconds: 12.5 }));
      const metrics = await get(socketPath, '/metrics');
      expect(metrics.status).toBe(200);
      expect(metrics.body).toContain('cauce_shadow_router_ready 1');
      expect(metrics.body).toContain('cauce_shadow_router_inbox{status="pending"} 4');
      expect(metrics.body).toContain('cauce_shadow_router_oldest_ready_seconds 12.5');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('turns liveness red when a cycle hangs past the bound', async () => {
    let now = 10_000;
    const directory = await mkdtemp(join(tmpdir(), 'cauce-shadow-live-'));
    directories.push(directory);
    const socketPath = join(directory, 'router.sock');
    const progress = new ShadowRouterProgress(20_000, () => now);
    const server = await startShadowIngressServer({
      socketPath, mode: 'shadow', allowedTenants: new Set(['Steven']),
      repository: repository(),
      metrics: new ShadowRouterMetrics(), progress,
    });
    try {
      progress.cycleStarted();
      now += 20_001;
      const live = await get(socketPath, '/health/live');
      expect(live.status).toBe(503);
      expect(JSON.parse(live.body)).toMatchObject({ status: 'not_live', reason: 'loop_stale' });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('aborts a hung health query and closes the listener inside the shutdown budget', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-shadow-shutdown-'));
    directories.push(directory);
    const socketPath = join(directory, 'router.sock');
    const repo = repository();
    let healthEntered: (() => void) | undefined;
    const entered = new Promise<void>((resolve) => { healthEntered = resolve; });
    let observedAbort = false;
    repo.health = vi.fn(async (signal?: AbortSignal): Promise<ShadowInboxHealth> => {
      healthEntered?.();
      return new Promise<never>((_resolve, reject) => {
        const aborted = (): void => {
          observedAbort = true;
          reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'));
        };
        signal?.addEventListener('abort', aborted, { once: true });
        if (signal?.aborted) aborted();
      });
    });
    const controller = new AbortController();
    const server = await startShadowIngressServer({
      socketPath, mode: 'shadow', allowedTenants: new Set(['Steven']), repository: repo,
      metrics: new ShadowRouterMetrics(), progress: new ShadowRouterProgress(20_000),
      signal: controller.signal,
    });
    const pendingHealth = get(socketPath, '/health/ready').catch((error: unknown) => error);
    await entered;
    const started = performance.now();

    controller.abort(new Error('shutdown'));
    expect(server.listening).toBe(false);
    await shutdownShadowIngressServer(server);

    expect(performance.now() - started).toBeLessThan(250);
    expect(observedAbort).toBe(true);
    await pendingHealth;
  });

  it('returns retryable 503 when durable ingress fails, without confusing it with invalid input', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-shadow-ingress-'));
    directories.push(directory);
    const socketPath = join(directory, 'router.sock');
    const repo = repository();
    repo.enqueue = vi.fn(async () => { throw new Error('database unavailable'); });
    const progress = new ShadowRouterProgress(20_000);
    const server = await startShadowIngressServer({
      socketPath, mode: 'shadow', allowedTenants: new Set(['Steven']), repository: repo,
      metrics: new ShadowRouterMetrics(), progress,
    });
    const valid = JSON.stringify({
      direction: 'v2-to-v3', source_event_id: 'source-1', tenant_id: 'Steven',
      correlation: { request_id: 'request-1', trace_id: 'trace-1' },
      payload: {}, expects_human_reply: false,
    });
    try {
      const unavailable = await post(socketPath, '/ingress/v2', valid);
      expect(unavailable.status).toBe(503);
      expect(JSON.parse(unavailable.body)).toEqual({ error: 'temporarily_unavailable' });

      const invalid = await post(socketPath, '/ingress/v2', '{');
      expect(invalid.status).toBe(400);
      expect(JSON.parse(invalid.body)).toEqual({ error: 'invalid_request' });

      const metrics = await get(socketPath, '/metrics');
      expect(metrics.body).toContain('events_total{result="failed"} 1');
      expect(metrics.body).toContain('events_total{result="ingress_denied"} 1');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('returns durable idempotency mismatch as non-retryable 409', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'cauce-shadow-conflict-'));
    directories.push(directory);
    const socketPath = join(directory, 'router.sock');
    const repo = repository();
    repo.enqueue = vi.fn(async () => { throw new ShadowInboxIdempotencyConflictError(); });
    const server = await startShadowIngressServer({
      socketPath, mode: 'shadow', allowedTenants: new Set(['Steven']), repository: repo,
      metrics: new ShadowRouterMetrics(), progress: new ShadowRouterProgress(20_000),
    });
    const valid = JSON.stringify({
      direction: 'v2-to-v3', source_event_id: 'source-1', tenant_id: 'Steven',
      correlation: { request_id: 'request-1', trace_id: 'trace-1' },
      payload: {}, expects_human_reply: false,
    });
    try {
      const conflict = await post(socketPath, '/ingress/v2', valid);
      expect(conflict.status).toBe(409);
      expect(JSON.parse(conflict.body)).toEqual({ error: 'idempotency_conflict' });
      expect((await get(socketPath, '/metrics')).body)
        .toContain('events_total{result="ingress_conflict"} 1');
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => error ? reject(error) : resolve()));
    }
  });
});
