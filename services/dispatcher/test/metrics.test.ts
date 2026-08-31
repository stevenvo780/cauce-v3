import { CauceRepository, type DatabasePool } from '@cauce/store';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase
} from '../../../tests/helpers/postgres.js';
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

function metricValue(exposition: string, sample: string): number {
  const line = exposition.split('\n').find((candidate) => candidate.startsWith(`${sample} `));
  if (line === undefined) throw new Error(`missing metric sample: ${sample}`);
  return Number(line.slice(sample.length + 1));
}

describe('gauges PostgreSQL del dispatcher', () => {
  it('publica la antigüedad real de la cola y deja en cero el carril sin filas', async () => {
    const jobId = await repository.enqueueJob(
      'Steven', 'interactive', 1, 'system.database.probe', { probe: true }
    );
    await pool.query(
      `UPDATE jobs SET created_at=now()-interval '42 seconds',updated_at=now()-interval '42 seconds'
       WHERE id=$1`,
      [jobId]
    );

    const exposition = await new DispatcherMetrics(pool).render();
    const interactiveAge = metricValue(
      exposition, 'cauce_dispatcher_job_oldest_seconds{lane="interactive",status="queued"}'
    );
    const batchAge = metricValue(
      exposition, 'cauce_dispatcher_job_oldest_seconds{lane="batch",status="queued"}'
    );
    expect(metricValue(exposition, 'cauce_dispatcher_metrics_query_success')).toBe(1);
    expect(metricValue(
      exposition, 'cauce_dispatcher_job_queue_depth{lane="interactive",status="queued"}'
    )).toBe(1);
    expect(metricValue(
      exposition, 'cauce_dispatcher_job_queue_depth{lane="batch",status="queued"}'
    )).toBe(0);
    expect(interactiveAge).toBeGreaterThanOrEqual(40);
    expect(interactiveAge).toBeLessThan(60);
    expect(batchAge).toBe(0);
  });

  it('declara fallida una lectura inválida sin publicar éxito ni gauges parciales', async () => {
    const jobId = await repository.enqueueJob(
      'Steven', 'interactive', 1, 'system.database.probe', { probe: true }
    );
    await pool.query(
      `UPDATE jobs SET created_at=now()+interval '1 hour',updated_at=now()+interval '1 hour'
       WHERE id=$1`,
      [jobId]
    );

    const exposition = await new DispatcherMetrics(pool).render();
    const queryResults = exposition.split('\n').filter((line) =>
      line.startsWith('cauce_dispatcher_metrics_query_success ')
    );
    expect(queryResults).toEqual(['cauce_dispatcher_metrics_query_success 0']);
    expect(exposition).not.toContain('# HELP cauce_dispatcher_job_queue_depth');
    expect(exposition.match(/# HELP cauce_dispatcher_metrics_query_success/gu)).toHaveLength(1);
  });
});
