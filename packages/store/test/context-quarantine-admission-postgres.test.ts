import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, CONTEXT_WRITE_QUARANTINE_KIND, createPool, type DatabasePool, type ReserveContextWriteInput } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

const tenant = 'Steven' as const;
const alias = 'argos';
const documentPath = '/home/dev/.claude/CLAUDE.md';
const priorSha = 'a'.repeat(64);
const targetSha = 'b'.repeat(64);
const runtime = { runtimeGeneration: 'runtime-a', containerId: 'container-a', writerInstanceId: randomUUID() };
const expectation = { revision: 1, generation: 'runtime-a', documents: [{ name: 'CLAUDE.md', path: documentPath, sha: priorSha }] };

let database: TestDatabase;
let pool: DatabasePool;
let repository: CauceRepository;
let started = false;

function reservation(overrides: Partial<ReserveContextWriteInput> = {}): ReserveContextWriteInput {
  return {
    operationId: randomUUID(), token: randomUUID(), generation: randomUUID(), tenantId: tenant, alias,
    writer: runtime, expectedRevision: 1, expectedExpectation: expectation,
    documents: [{ name: 'CLAUDE.md', path: documentPath, beforeSha: priorSha, targetSha }], ...overrides,
  };
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  started = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
  console.info('owned-context-quarantine-postgres', execFileSync('docker', ['inspect', '--format',
    '{{json .Id}} {{json .Mounts}} {{json .HostConfig.PortBindings}} {{json .Config.Labels}}',
    database.container.getId()], { encoding: 'utf8' }).trim());
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES('Steven','argos','claude','Argos',true,'ws-argos','dev','/home/dev','/tmp/argos');
    INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES('Steven','argos','Agent profile');
    INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
      VALUES('Steven','grp.steven','argos','agent',true)
      ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role='agent',enabled=true;
  `);
  await repository.recordProfileRuntimeExpectation(tenant, alias, expectation);
});

afterAll(async () => {
  if (!started) return;
  const containerId = database.container.getId();
  const results = await Promise.allSettled([pool.end(), database.container.stop()]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'owned context admission cleanup failed');
  const absent = spawnSync('docker', ['inspect', containerId], { encoding: 'utf8' });
  if (absent.status !== 1 || !/no such (object|container)/iu.test(absent.stderr)) {
    throw new Error('owned context admission container absence is unverified');
  }
  console.info('owned-context-quarantine-postgres-absent', containerId);
});

describe('admission durable durante una escritura de contexto incierta', () => {
  it('mantiene bloqueados lease nuevo, resume, takeover y claims hasta resolver el recibo', async () => {
    const lease = await repository.acquireLease(tenant, alias, 'existing-instance', [], 60_000);
    expect(lease.acquired).toBe(true);
    if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
      throw new Error('initial lease was not acquired with durable fencing fields');
    }

    const descriptor = await repository.reserveContextWrite(reservation());
    const committed = await pool.query<{ status: string; lease_until: Date | null; kind: string }>(
      `SELECT status,lease_until,kind FROM jobs WHERE id=$1`, [descriptor.operationId],
    );
    expect(committed.rows[0]).toEqual({ status: 'running', lease_until: null, kind: CONTEXT_WRITE_QUARANTINE_KIND });

    await pool.end();
    pool = createPool(database.url);
    repository = new CauceRepository(pool);
    expect(await repository.retryExpiredJobs()).toBe(0);

    await expect(repository.acquireLease(tenant, alias, 'existing-instance', [], 60_000, { resume: true }))
      .rejects.toThrow('context write quarantine fences admission');
    await expect(repository.acquireLease(tenant, alias, 'replacement-instance', [], 60_000, { takeover: true }))
      .rejects.toThrow('context write quarantine fences admission');
    await expect(repository.claimDeliveries(
      tenant, alias, 'existing-instance', lease.epoch, 1, 30_000, 3, {}, lease.connection_token,
    )).rejects.toThrow('context write quarantine fences admission');

    const after = await pool.query<{ instance_id: string; epoch: string; connection_token: string }>(
      `SELECT instance_id,epoch,connection_token::text FROM connection_leases WHERE tenant_id=$1 AND alias=$2`,
      [tenant, alias],
    );
    expect(after.rows[0]).toEqual({
      instance_id: 'existing-instance', epoch: String(lease.epoch), connection_token: lease.connection_token,
    });
    const stillReserved = await pool.query<{ status: string; lease_until: Date | null }>(
      `SELECT status,lease_until FROM jobs WHERE id=$1`, [descriptor.operationId],
    );
    expect(stillReserved.rows[0]).toEqual({ status: 'running', lease_until: null });
  });

  it('falla cerrado para cualquier admisión del tenant si una fila activa está malformada', async () => {
    await pool.query(
      `INSERT INTO jobs(tenant_id,lane,kind,payload,status,lease_until)
       VALUES('Steven','interactive',$1,'{}'::jsonb,'queued',now()+interval '1 hour')`,
      [CONTEXT_WRITE_QUARANTINE_KIND],
    );
    await expect(repository.acquireLease(tenant, 'kant', 'new-instance', [], 60_000))
      .rejects.toThrow('context write quarantine metadata is invalid');
    const leases = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM connection_leases WHERE tenant_id=$1 AND alias='kant'`, [tenant],
    );
    expect(leases.rows[0]?.count).toBe('0');
  });

  it('rechaza claims por cuarentena antes de esperar locks de membresía', async () => {
    const lease = await repository.acquireLease(tenant, alias, 'claim-order-instance', [], 60_000);
    if (!lease.acquired || lease.epoch === undefined || lease.connection_token === undefined) {
      throw new Error('claim-order lease was not acquired with durable fencing fields');
    }
    await repository.reserveContextWrite(reservation());

    const blocker = await pool.connect();
    const claimantPool = createPool(database.url, {
      max: 1, applicationName: 'cauce-context-quarantine-claim-order',
    });
    const claimant = new CauceRepository(claimantPool);
    const controller = new AbortController();
    try {
      await blocker.query('BEGIN');
      await blocker.query(
        `SELECT 1 FROM memberships WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [tenant, alias],
      );
      const startedAt = performance.now();
      const claim = claimant.claimDeliveries(
        tenant, alias, 'claim-order-instance', lease.epoch, 1, 30_000, 3, {}, lease.connection_token, controller.signal,
      ).then(() => ({ kind: 'resolved' as const }), (error: unknown) => ({ kind: 'rejected' as const, error }));
      const timeout = Symbol('claim-order-timeout');
      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        claim,
        new Promise<typeof timeout>((resolve) => {
          timer = setTimeout(() => { resolve(timeout); }, 1_000);
        }),
      ]);
      if (timer !== undefined) clearTimeout(timer);
      if (result === timeout) {
        controller.abort(new Error('claim attempted to wait for membership authority'));
        await claim;
        throw new Error('quarantined claim waited on a locked membership row');
      }
      expect(result.kind).toBe('rejected');
      if (result.kind !== 'rejected') throw new Error('quarantined claim unexpectedly resolved');
      expect(result.error).toMatchObject({ message: 'context write quarantine fences admission' });
      expect(performance.now() - startedAt).toBeLessThan(1_000);
      const waiting = await pool.query<{ blocked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM pg_stat_activity activity
           WHERE activity.application_name=$1 AND activity.wait_event_type='Lock'
             AND cardinality(pg_blocking_pids(activity.pid))>0
         ) AS blocked`, ['cauce-context-quarantine-claim-order'],
      );
      expect(waiting.rows[0]?.blocked).toBe(false);
    } finally {
      controller.abort();
      await blocker.query('ROLLBACK');
      blocker.release();
      await claimantPool.end();
    }
  });
});
