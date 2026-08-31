import { CauceRepository, type DatabasePool } from '@cauce/store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
import { JobHandlerRegistry } from '../src/handlers.js';
import { runDispatcher, UnknownJobKindError } from '../src/index.js';
import { DispatcherMetrics } from '../src/metrics.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;

beforeAll(async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 180_000);

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
});

describe('bucle durable del dispatcher', () => {
  it('completa sólo el job cuyo handler registrado termina bien', async () => {
    const handled: Readonly<Record<string, unknown>>[] = [];
    const errors: unknown[] = [];
    const handlers = new JobHandlerRegistry().register('qa.success', async (job) => {
      handled.push(job.payload);
    });
    const metrics = new DispatcherMetrics(pool, () => 1_000);
    const jobId = await repository.enqueueJob(
      'Steven', 'interactive', 7, 'qa.success', { marker: 'handled' }
    );
    const dispatcher = runDispatcher(pool, {
      pollMs: 60_000,
      chainSweepMs: 0,
      retentionIntervalMs: 0,
      handlers,
      metrics,
      onError: (error) => { errors.push(error); },
    });

    try {
      await dispatcher.tick();
    } finally {
      dispatcher.stop();
    }

    const result = await pool.query<{ status: string; attempts: number }>(
      'SELECT status,attempts FROM jobs WHERE id=$1', [jobId]
    );
    const deadLetters = await pool.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM dead_letters WHERE job_id=$1', [jobId]
    );
    expect(handled).toEqual([{ marker: 'handled' }]);
    expect(result.rows[0]).toEqual({ status: 'done', attempts: 1 });
    expect(deadLetters.rows[0]?.count).toBe('0');
    expect(metrics.progress()).toMatchObject({ successfulTicks: 1, ready: true, reason: 'ready' });
    expect(errors).toEqual([]);
  });

  it('reintenta el job que falla sin convertir el tick en fallo del bucle', async () => {
    const errors: unknown[] = [];
    const handlers = new JobHandlerRegistry().register('qa.retry', async () => {
      throw new Error('handler falló');
    });
    const metrics = new DispatcherMetrics(pool, () => 1_000);
    const jobId = await repository.enqueueJob('Steven', 'batch', 3, 'qa.retry', { attempt: 1 });
    const dispatcher = runDispatcher(pool, {
      pollMs: 60_000,
      chainSweepMs: 0,
      retentionIntervalMs: 0,
      handlers,
      metrics,
      onError: (error) => { errors.push(error); },
    });

    try {
      await dispatcher.tick();
    } finally {
      dispatcher.stop();
    }

    const result = await pool.query<{
      status: string; attempts: number; last_error: string; claim_token: string | null;
    }>('SELECT status,attempts,last_error,claim_token FROM jobs WHERE id=$1', [jobId]);
    expect(result.rows[0]).toEqual({
      status: 'queued', attempts: 1, last_error: 'handler falló', claim_token: null
    });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('handler falló');
    expect(metrics.progress()).toMatchObject({ successfulTicks: 1, failedTicks: 0, ready: true });
    expect(await metrics.render(false)).toContain(
      'cauce_dispatcher_jobs_processed_total{lane="batch",result="retry"} 1'
    );
  });

  it('manda a dead letter un kind desconocido y conserva el payload auditable', async () => {
    const errors: unknown[] = [];
    const metrics = new DispatcherMetrics(pool, () => 1_000);
    const jobId = await repository.enqueueJob(
      'Steven', 'interactive', 1, 'qa.unknown', { evidence: 'kept' }
    );
    const dispatcher = runDispatcher(pool, {
      pollMs: 60_000,
      chainSweepMs: 0,
      retentionIntervalMs: 0,
      handlers: new JobHandlerRegistry(),
      metrics,
      onError: (error) => { errors.push(error); },
    });

    try {
      await dispatcher.tick();
    } finally {
      dispatcher.stop();
    }

    const result = await pool.query<{
      status: string; last_error: string; reason: string; payload: Record<string, unknown>;
    }>(
      `SELECT j.status,j.last_error,dl.reason,dl.payload
       FROM jobs j JOIN dead_letters dl ON dl.job_id=j.id WHERE j.id=$1`,
      [jobId]
    );
    expect(result.rows[0]).toEqual({
      status: 'dead',
      last_error: 'unknown job kind: qa.unknown',
      reason: 'unknown job kind: qa.unknown',
      payload: { evidence: 'kept' },
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toBeInstanceOf(UnknownJobKindError);
    expect(await metrics.render(false)).toContain(
      'cauce_dispatcher_jobs_processed_total{lane="interactive",result="unknown_kind"} 1'
    );
  });

  it('cuenta una sola vez el fencing que impide completar el job', async () => {
    const errors: unknown[] = [];
    const handlers = new JobHandlerRegistry().register('qa.fenced', async (job) => {
      await pool.query('UPDATE jobs SET claim_token=gen_random_uuid() WHERE id=$1', [job.id]);
    });
    const metrics = new DispatcherMetrics(pool, () => 1_000);
    const jobId = await repository.enqueueJob('Steven', 'interactive', 5, 'qa.fenced', {});
    const dispatcher = runDispatcher(pool, {
      pollMs: 60_000,
      chainSweepMs: 0,
      retentionIntervalMs: 0,
      handlers,
      metrics,
      onError: (error) => { errors.push(error); },
    });

    try {
      await dispatcher.tick();
    } finally {
      dispatcher.stop();
    }

    const result = await pool.query<{ status: string; dead_letters: string }>(
      `SELECT j.status,count(dl.id)::text AS dead_letters
       FROM jobs j LEFT JOIN dead_letters dl ON dl.job_id=j.id
       WHERE j.id=$1 GROUP BY j.status`,
      [jobId]
    );
    expect(result.rows[0]).toEqual({ status: 'running', dead_letters: '0' });
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toBe('job completion fenced');
    expect(metrics.progress()).toMatchObject({ fencedTicks: 1, ready: false, reason: 'fenced' });
    expect(await metrics.render(false)).toContain(
      'cauce_dispatcher_jobs_processed_total{lane="interactive",result="fenced"} 1'
    );
  });

  it('no reclama un segundo job mientras el tick anterior sigue ejecutándose', async () => {
    let releaseFirst: (() => void) | undefined;
    let markEntered: (() => void) | undefined;
    const firstEntered = new Promise<void>((resolve) => { markEntered = resolve; });
    const firstRelease = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const handled: string[] = [];
    const handlers = new JobHandlerRegistry().register('qa.serial', async (job) => {
      handled.push(job.id);
      if (handled.length === 1) {
        markEntered?.();
        await firstRelease;
      }
    });
    await repository.enqueueJob('Steven', 'interactive', 2, 'qa.serial', { order: 1 });
    await repository.enqueueJob('Steven', 'interactive', 1, 'qa.serial', { order: 2 });
    const metrics = new DispatcherMetrics(pool, () => 1_000);
    const dispatcher = runDispatcher(pool, {
      pollMs: 60_000,
      chainSweepMs: 0,
      retentionIntervalMs: 0,
      handlers,
      metrics,
    });

    try {
      const firstTick = dispatcher.tick();
      await firstEntered;
      await dispatcher.tick();
      const duringFirst = await pool.query<{ status: string; count: string }>(
        'SELECT status,count(*)::text AS count FROM jobs GROUP BY status ORDER BY status'
      );
      expect(duringFirst.rows).toEqual([
        { status: 'queued', count: '1' },
        { status: 'running', count: '1' },
      ]);
      expect(handled).toHaveLength(1);
      releaseFirst?.();
      await firstTick;
      await dispatcher.tick();
    } finally {
      releaseFirst?.();
      dispatcher.stop();
    }

    const completed = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM jobs WHERE status='done'`
    );
    expect(completed.rows[0]?.count).toBe('2');
    expect(handled).toHaveLength(2);
    expect(metrics.progress()).toMatchObject({ ticks: 2, successfulTicks: 2 });
  });
});
