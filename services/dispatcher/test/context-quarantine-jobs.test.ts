import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { CauceRepository, CONTEXT_WRITE_QUARANTINE_KIND, type DatabasePool } from '@cauce/store';
import {
  dockerTestRequirement, resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { DispatcherMetrics } from '../src/metrics.js';
import { runDispatcher } from '../src/index.js';

let database: TestDatabase | undefined;
let pool: DatabasePool;
let repository: CauceRepository;
const postgresRequirement = dockerTestRequirement('dispatcher metrics exclude reserved context-quarantine rows');

beforeEach(async ({ skip }) => {
  if (!process.env.CAUCE_TEST_DATABASE_URL && process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1') {
    await postgresRequirement.skipIfUnavailable(skip);
  }
  if (database === undefined) {
    database = await startTestDatabase({ requireOwnedContainer: true });
    pool = database.pool;
    repository = new CauceRepository(pool);
    console.info('owned-dispatcher-context-jobs-postgres', execFileSync('docker', ['inspect', '--format',
      '{{json .Id}} {{json .Mounts}} {{json .HostConfig.PortBindings}} {{json .Config.Labels}}',
      database.container.getId()], { encoding: 'utf8' }).trim());
  }
  await resetTestDatabase(pool);
}, 180_000);

async function closeOwnedDatabase(database: TestDatabase) {
  const containerId = database.container.getId();
  const results = await Promise.allSettled([database.pool.end(), database.container.stop()]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'owned dispatcher metrics cleanup failed');
  const absent = spawnSync('docker', ['inspect', containerId], { encoding: 'utf8' });
  if (absent.status !== 1 || !/no such (object|container)/iu.test(absent.stderr)) {
    throw new Error('owned dispatcher metrics container absence is unverified');
  }
  console.info('owned-dispatcher-context-jobs-postgres-absent', containerId);
}

afterAll(async () => { if (database) await closeOwnedDatabase(database); });

function value(exposition: string, sample: string): number {
  const line = exposition.split('\n').find((candidate) => candidate.startsWith(`${sample} `));
  if (line === undefined) throw new Error(`missing metric sample: ${sample}`);
  return Number(line.slice(sample.length + 1));
}

describe('dispatcher context-quarantine accounting', () => {
  it('keeps external database fallback distinct from explicitly owned Docker containers', async () => {
    if (!database) throw new Error('owned dispatcher database unavailable');
    let external: TestDatabase | undefined;
    let owned: TestDatabase | undefined;
    try {
      vi.stubEnv('CAUCE_TEST_DATABASE_URL', database.url);
      vi.stubEnv('CAUCE_REQUIRE_TESTCONTAINERS', '0');
      external = await startTestDatabase();
      expect(external.container.getHost()).toBe('external');
      expect(() => external?.container.getId()).toThrow('External PostgreSQL has no owned Docker container');
      expect(() => external?.container.getName()).toThrow('External PostgreSQL has no owned Docker container');
      expect(new URL(external.url).pathname).not.toBe(new URL(database.url).pathname);
      vi.stubEnv('CAUCE_REQUIRE_TESTCONTAINERS', '1');
      await expect(startTestDatabase()).rejects.toThrow('CAUCE_REQUIRE_TESTCONTAINERS=1 rejects the external database fallback');
      vi.stubEnv('CAUCE_TEST_DATABASE_URL', 'postgresql://unused@127.0.0.1:1/cauce_test_closed');
      owned = await startTestDatabase({ requireOwnedContainer: true });
      expect(owned.container.getId()).toMatch(/^[0-9a-f]{64}$/u);
      expect(owned.container.getId()).not.toBe(database.container.getId());
      expect((await owned.pool.query('SELECT current_database() AS name')).rows[0]).toEqual({ name: 'cauce_test' });
    } finally {
      try {
        if (external) await external.pool.end().finally(() => external?.container.stop());
      } finally {
        try { if (owned) await closeOwnedDatabase(owned); }
        finally { vi.unstubAllEnvs(); }
      }
    }
  }, 120_000);

  it('omits reserved rows from queue, lease and dead-letter metrics while retaining ordinary jobs', async () => {
    const queuedSentinel = await pool.query<{ id: string }>(
      `INSERT INTO jobs(tenant_id,lane,kind,payload,status)
       VALUES('Steven','interactive',$1,'{}'::jsonb,'queued') RETURNING id`, [CONTEXT_WRITE_QUARANTINE_KIND],
    );
    const runningSentinel = await pool.query<{ id: string }>(
      `INSERT INTO jobs(tenant_id,lane,kind,payload,status,claimed_by,claim_token,lease_until)
       VALUES('Steven','interactive',$1,'{}'::jsonb,'running','coordinator',gen_random_uuid(),now()+interval '1 hour')
       RETURNING id`, [CONTEXT_WRITE_QUARANTINE_KIND],
    );
    const queuedId = queuedSentinel.rows[0]?.id;
    const runningId = runningSentinel.rows[0]?.id;
    if (queuedId === undefined || runningId === undefined) throw new Error('quarantine metric fixtures missing identifiers');
    await pool.query(
      `INSERT INTO dead_letters(job_id,tenant_id,reason,payload,attempts)
       VALUES($1,'Steven','quarantine fixture','{}'::jsonb,1)`, [queuedId],
    );
    await repository.enqueueJob('Steven', 'batch', 1, 'system.database.probe', { probe: true });

    const exposition = await new DispatcherMetrics(pool).render();
    expect(value(exposition, 'cauce_dispatcher_metrics_query_success')).toBe(1);
    expect(value(exposition, 'cauce_dispatcher_job_queue_depth{lane="interactive",status="queued"}')).toBe(0);
    expect(value(exposition, 'cauce_dispatcher_job_queue_depth{lane="batch",status="queued"}')).toBe(1);
    expect(value(exposition, 'cauce_dispatcher_job_leases_active{lane="interactive"}')).toBe(0);
    expect(value(exposition, 'cauce_dispatcher_dlq_depth{lane="interactive",target="job"}')).toBe(0);
    expect(exposition).not.toContain(queuedId);
    expect(exposition).not.toContain(runningId);
  });

  it('does not dispatch or dead-letter the reserved kind even if it reaches the worker loop', async () => {
    const unexpected = vi.fn(async () => undefined);
    const onError = vi.fn();
    const metrics = new DispatcherMetrics(pool);
    const claim = vi.spyOn(CauceRepository.prototype, 'claimFairJobs').mockResolvedValue([{
      id: '00000000-0000-4000-8000-000000000001', tenant_id: 'Steven', lane: 'interactive',
      status: 'running', attempts: 1, claimed_by: 'dispatcher-test', claim_token: 'reserved-token',
      lease_until: new Date(Date.now() + 30_000), kind: CONTEXT_WRITE_QUARANTINE_KIND, payload: {},
    }]);
    const dispatcher = runDispatcher(pool, {
      pollMs: 60_000, chainSweepMs: 0, handlers: { [CONTEXT_WRITE_QUARANTINE_KIND]: unexpected },
      metrics, onError,
    });
    try {
      await dispatcher.tick();
    } finally {
      dispatcher.stop();
      claim.mockRestore();
    }
    expect(unexpected).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(await metrics.render(false)).toContain(
      'cauce_dispatcher_jobs_processed_total{lane="interactive",result="fenced"} 1',
    );
    expect((await pool.query(`SELECT 1 FROM dead_letters WHERE job_id='00000000-0000-4000-8000-000000000001'`)).rowCount).toBe(0);
  });
});
