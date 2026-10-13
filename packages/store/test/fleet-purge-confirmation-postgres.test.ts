import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationRequestSchema, sha256Hex, type FleetOperationRequest } from '@cauce/protocol';
import { FleetOperationsRepository, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { finishPurge, purgeFixture, purgeRequest, PURGE_ACTOR_SUBJECT } from './fleet-purge-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database missing');
  current = await startTestCaseDatabase(database); pool = current.pool; await purgeFixture(pool, current.adminPool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('purge confirmation at the durable submission boundary', () => {
  it('rejects unconfirmed direct store calls before inserting requests or events', async () => {
    const repo = new FleetOperationsRepository(pool);
    for (const parameters of [{}, { confirm_alias: 'other' }, { confirm_alias: ' purge_agent' }, { confirm_alias: 'PURGE_AGENT' }]) {
      const request = { ...purgeRequest(), parameters } as FleetOperationRequest;
      await expect(repo.enqueue('Steven', 'purge_operator', request, PURGE_ACTOR_SUBJECT)).rejects.toMatchObject({ code: 'invalid_input' });
      expect((await pool.query('SELECT id FROM fleet_operations')).rowCount).toBe(0);
      expect((await pool.query('SELECT id FROM fleet_operation_events')).rowCount).toBe(0);
    }
  });
  it('reads, resumes and reconciles legacy requests without rewriting their immutable hash', async () => {
    const repo = new FleetOperationsRepository(pool);
    const legacy = { ...purgeRequest(), parameters: {} };
    const hash = sha256Hex(legacy);
    const row = (await pool.query<{ id: string; company_id: string }>(`INSERT INTO fleet_operations(
      actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,idempotency_key,expected_revision,steps)
      VALUES('Steven','purge_operator',$1::jsonb,$2,'legacy-purge','purge-host','purge',$3::jsonb,$4,$5,0,$6::jsonb)
      RETURNING id,company_id`, [JSON.stringify(legacy.target), sha256Hex(legacy.target), JSON.stringify(legacy), hash,
      legacy.idempotency_key, JSON.stringify(['fence', 'stop', 'revoke', 'purge', 'artifacts'].map(name => ({ name, status: 'pending' })))])).rows[0];
    if (!row) throw new Error('legacy operation missing');
    await pool.query(`INSERT INTO fleet_operation_events(operation_id,version,event,metadata)
      VALUES($1,0,'queued',$2::jsonb)`, [row.id, JSON.stringify({ actor_subject: PURGE_ACTOR_SUBJECT, acting_company: row.company_id })]);
    expect((await repo.get('Steven', 'purge_operator', row.id, PURGE_ACTOR_SUBJECT)).request_sha256).toBe(hash);
    expect(await repo.list('Steven', 'purge_operator', legacy.target, PURGE_ACTOR_SUBJECT)).toHaveLength(1);
    expect(await repo.listRecent('Steven', 'purge_operator', 50, PURGE_ACTOR_SUBJECT)).toHaveLength(1);
    await expect(repo.enqueue('Steven', 'purge_operator', { ...legacy, parameters: { confirm_alias: 'purge_agent' } },
      PURGE_ACTOR_SUBJECT)).rejects.toMatchObject({ code: 'conflict' });
    const claim = await repo.claim('legacy-worker', 'purge-host');
    if (!claim) throw new Error('legacy claim missing');
    expect(FleetOperationRequestSchema.parse(claim.request)).toEqual(legacy);
    await repo.prepare(claim); await repo.startStep(claim, 'stop');
    const failed = await repo.fail(claim, { code: 'HOST_UNAVAILABLE', step: 'stop', retryable: true });
    const resumed = await repo.resume('Steven', 'purge_operator', failed.id, failed.version, PURGE_ACTOR_SUBJECT);
    expect(resumed.status).toBe('queued'); expect(resumed.request_sha256).toBe(hash);
    const retry = await repo.claim('legacy-worker-retry', 'purge-host');
    if (!retry) throw new Error('legacy retry missing');
    await repo.prepare(retry);
    expect(FleetOperationRequestSchema.parse((await repo.execution(retry)).request)).toEqual(legacy);
    await finishPurge(repo, retry);
    expect((await repo.get('Steven', 'purge_operator', row.id, PURGE_ACTOR_SUBJECT)).status).toBe('succeeded');
    expect((await pool.query('SELECT request,request_hash FROM fleet_operations WHERE id=$1', [row.id])).rows)
      .toEqual([{ request: legacy, request_hash: hash }]);
  });
});
