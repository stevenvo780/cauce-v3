import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import type { Lane } from '@cauce/protocol';
import { CauceRepository, CONTEXT_WRITE_QUARANTINE_KIND, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;
let started = false;

async function sentinel(lane: Lane, status: 'queued' | 'running', expired: boolean): Promise<string> {
  const result = await pool.query<{ id: string }>(
    `INSERT INTO jobs(tenant_id,lane,kind,payload,status,claimed_by,claim_token,lease_until,attempts,max_attempts)
     VALUES('Steven',$1,$2,'{}'::jsonb,$3,'quarantine-coordinator',$4::uuid,
       CASE WHEN $5 THEN now()-interval '1 second' ELSE now()+interval '1 hour' END,4,4)
     RETURNING id`,
    [lane, CONTEXT_WRITE_QUARANTINE_KIND, status, randomUUID(), expired],
  );
  const id = result.rows[0]?.id;
  if (id === undefined) throw new Error('quarantine fixture row was not inserted');
  return id;
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  started = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
  console.info('owned-context-jobs-postgres', execFileSync('docker', ['inspect', '--format',
    '{{json .Id}} {{json .Mounts}} {{json .HostConfig.PortBindings}} {{json .Config.Labels}}',
    database.container.getId()], { encoding: 'utf8' }).trim());
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
      VALUES('quarantine-reader',false,true,false,false)
      ON CONFLICT(role) DO UPDATE SET allow_read=true;
    INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
      VALUES('Steven','grp.steven','argos','quarantine-reader',true)
      ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role='quarantine-reader',enabled=true;
  `);
});

afterAll(async () => {
  if (!started) return;
  const containerId = database.container.getId();
  const results = await Promise.allSettled([pool.end(), database.container.stop()]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'owned context jobs cleanup failed');
  const absent = spawnSync('docker', ['inspect', containerId], { encoding: 'utf8' });
  if (absent.status !== 1 || !/no such (object|container)/iu.test(absent.stderr)) {
    throw new Error('owned context jobs container absence is unverified');
  }
  console.info('owned-context-jobs-postgres-absent', containerId);
});

describe('el kind de cuarentena no pertenece al ciclo genérico de jobs', () => {
  it('no se encola, reclama, reintenta, finaliza ni aparece en listados genéricos', async () => {
    await expect(repository.enqueueJob(
      'Steven', 'interactive', 1, CONTEXT_WRITE_QUARANTINE_KIND, {},
    )).rejects.toThrow('context reservation repository');

    const queued = await sentinel('interactive', 'queued', false);
    const expired = await sentinel('batch', 'running', true);
    const live = await sentinel('interactive', 'running', false);
    const ordinary = await repository.enqueueJob(
      'Steven', 'batch', 2, 'system.database.probe', { probe: true },
    );

    const simpleClaims = await repository.claimJobs('interactive', 'jobs-worker', 10, 30_000);
    expect(simpleClaims.map((job) => job.id)).toEqual([]);
    const fairClaims = await repository.claimFairJobs('fair-worker', 10, 30_000, 1, 'quarantine-test');
    expect(fairClaims.map((job) => job.id)).toEqual([ordinary]);

    expect(await repository.completeJob(live, 'quarantine-coordinator', await tokenFor(live))).toBe(false);
    expect(await repository.failJob(live, 'quarantine-coordinator', 'unexpected', await tokenFor(live))).toBe('fenced');
    expect(await repository.retryExpiredJobs()).toBe(0);
    const listed = (await repository.listJobs('Steven', 'argos')).items as Record<string, unknown>[];
    expect(listed.map((job) => job.job_id)).toEqual([ordinary]);
    expect(listed.some((job) => job.kind === CONTEXT_WRITE_QUARANTINE_KIND)).toBe(false);

    const rows = await pool.query<{ id: string; status: string; attempts: number; lease_until: Date | null }>(
      `SELECT id,status,attempts,lease_until FROM jobs WHERE id=ANY($1::uuid[]) ORDER BY id`,
      [[queued, expired, live]],
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.find((row) => row.id === queued)?.status).toBe('queued');
    expect(rows.rows.find((row) => row.id === expired)?.status).toBe('running');
    expect(rows.rows.find((row) => row.id === expired)?.attempts).toBe(4);
    expect(rows.rows.find((row) => row.id === live)?.status).toBe('running');
    expect(await pool.query('SELECT 1 FROM dead_letters WHERE job_id=ANY($1::uuid[])', [[queued, expired, live]])
      .then((result) => result.rowCount)).toBe(0);
  });
});

async function tokenFor(id: string): Promise<string> {
  const result = await pool.query<{ claim_token: string }>('SELECT claim_token::text FROM jobs WHERE id=$1', [id]);
  const token = result.rows[0]?.claim_token;
  if (token === undefined) throw new Error('quarantine fixture token is missing');
  return token;
}
