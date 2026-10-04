import { execFileSync, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { CauceRepository, StoreError, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;
let pool: DatabasePool;
let repository: CauceRepository;
let volumes: string[] = [];

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  pool = database.pool;
  repository = new CauceRepository(pool);
  const mounts = JSON.parse(execFileSync('docker', ['inspect', '--format', '{{json .Mounts}}',
    database.container.getId()], { encoding: 'utf8' })) as { Type: string; Name?: string }[];
  volumes = mounts.flatMap((mount) => mount.Type === 'volume' && mount.Name ? [mount.Name] : []);
  console.info('owned-context-control-fields-postgres', database.container.getId(), volumes);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`
    INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES('Steven','argos','claude','Argos',true,'ws-argos','dev','/home/dev','/tmp/argos');
  `);
});

afterAll(async () => {
  if (database === undefined) return;
  const containerId = database.container.getId();
  const results = await Promise.allSettled([pool.end(), database.container.stop()]);
  const failures = results.filter((result) => result.status === 'rejected');
  if (failures.length > 0) throw new AggregateError(failures, 'owned context control cleanup failed');
  const absent = spawnSync('docker', ['inspect', containerId], { encoding: 'utf8' });
  if (absent.status !== 1 || !/no such (object|container)/iu.test(absent.stderr)) {
    throw new Error('owned context control container absence is unverified');
  }
  for (const volume of volumes) {
    const gone = spawnSync('docker', ['volume', 'inspect', volume], { encoding: 'utf8' });
    if (gone.status !== 1 || !/no such volume/iu.test(gone.stderr)) {
      throw new Error('owned context control volume absence is unverified');
    }
  }
  console.info('owned-context-control-fields-postgres-absent', containerId, volumes);
});

function reservationInput() {
  return {
    operationId: randomUUID(), token: randomUUID(), generation: randomUUID(),
    tenantId: 'Steven' as const, alias: 'argos', expectedRevision: null, expectedExpectation: null,
    writer: { runtimeGeneration: 'runtime-a', containerId: 'container-a', writerInstanceId: randomUUID() },
    documents: [{ name: 'CLAUDE.md', path: '/home/dev/.claude/CLAUDE.md', beforeSha: null, targetSha: 'a'.repeat(64) }],
  };
}

async function reserve(): Promise<string> {
  const descriptor = await repository.reserveContextWrite(reservationInput());
  return descriptor.operationId;
}

describe('context quarantine control field integrity', () => {
  it.each([
    ['queued status', "status='queued'"],
    ['expired lease', "lease_until=now()-interval '1 second'"],
    ['different claim token', 'claim_token=gen_random_uuid()'],
    ['missing claim token', 'claim_token=NULL'],
    ['completed target', "payload=jsonb_set(payload,'{completion}',jsonb_build_object('resolution','target','proofSha256',repeat('a',64)))"],
    ['completed old', "payload=jsonb_set(payload,'{completion}',jsonb_build_object('resolution','old','proofSha256',repeat('a',64)))"],
    ['done without completion', "status='done'"],
    ['done with malformed descriptor', "status='done',payload='{}'::jsonb"],
    ['done before authorization', "status='done',payload=jsonb_set(payload,'{completion}',jsonb_build_object('resolution','target','proofSha256',repeat('a',64)))"],
  ])('blocks another alias when a valid descriptor has %s', async (_name, assignment) => {
    const operationId = await reserve();
    await pool.query(`UPDATE jobs SET ${assignment} WHERE id=$1`, [operationId]);
    await expect(repository.acquireLease('Steven', 'kant', 'new-instance', [], 60_000))
      .rejects.toThrow('context write quarantine metadata is invalid');
    const result = await pool.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM connection_leases WHERE tenant_id='Steven' AND alias='kant'",
    );
    expect(result.rows[0]?.count).toBe('0');
  });

  it('keeps a valid reservation scoped to its own alias', async () => {
    await reserve();
    const lease = await repository.acquireLease('Steven', 'kant', 'other-instance', [], 60_000);
    expect(lease.acquired).toBe(true);
    await expect(repository.acquireLease('Steven', 'argos', 'reserved-instance', [], 60_000))
      .rejects.toThrow('context write quarantine fences admission');
  });

  it('admits both aliases after an atomically resolved valid done reservation', async () => {
    const input = reservationInput();
    const descriptor = await repository.authorizeContextWriteDispatch(await repository.reserveContextWrite(input));
    await expect(repository.resolveContextWrite(descriptor, async () => ({
      operationId: descriptor.operationId, token: descriptor.token, generation: descriptor.generation,
      writer: descriptor.writer, state: 'quiescent', durability: 'post_fsync',
      documents: descriptor.documents.map((item) => ({ name: item.name, path: item.path, sha: item.beforeSha })),
    }), async () => { throw new Error('all-old proof must not persist target adoption'); })).resolves.toBe('old');
    expect((await repository.acquireLease('Steven', 'argos', 'resolved-instance', [], 60_000)).acquired).toBe(true);
    expect((await repository.acquireLease('Steven', 'kant', 'other-resolved-instance', [], 60_000)).acquired).toBe(true);
  });

  it.each([
    ['reserve', 'missing'], ['reserve', 'error'],
    ['authorize', 'missing'], ['authorize', 'error'],
  ] as const)('marks a committed %s with %s readback as unverified', async (stage, failure) => {
    const input = reservationInput();
    const descriptor = stage === 'authorize' ? await repository.reserveContextWrite(input) : undefined;
    const readbackTarget: { query: (text: string, values?: unknown[]) => Promise<unknown> } = pool;
    const readback = vi.spyOn(readbackTarget, 'query');
    if (failure === 'error') readback.mockRejectedValueOnce(new StoreError('conflict', 'readback unavailable'));
    else readback.mockResolvedValueOnce({ rows: [], rowCount: 0, command: 'SELECT', oid: 0, fields: [] });
    try {
      const operation = descriptor === undefined
        ? repository.reserveContextWrite(input)
        : repository.authorizeContextWriteDispatch(descriptor);
      await expect(operation).rejects.toMatchObject({
        code: 'conflict', recoveryReason: 'context_write_commit_unverified',
      });
    } finally {
      readback.mockRestore();
    }
    const result = await pool.query<{ status: string; payload: { dispatch: string } }>(
      'SELECT status,payload FROM jobs WHERE id=$1', [input.operationId],
    );
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      status: 'running', payload: { dispatch: stage === 'reserve' ? 'reserved' : 'authorized' },
    });
    await expect(repository.acquireLease('Steven', 'argos', 'uncertain-caller', [], 60_000))
      .rejects.toThrow('context write quarantine fences admission');
  });

  it('keeps a precommit revision conflict distinguishable and without a reservation', async () => {
    const input = { ...reservationInput(), expectedRevision: 1 };
    await expect(repository.reserveContextWrite(input)).rejects.toMatchObject({
      code: 'conflict', recoveryReason: undefined,
    });
    const result = await pool.query('SELECT id FROM jobs WHERE id=$1', [input.operationId]);
    expect(result.rows).toHaveLength(0);
  });
});
