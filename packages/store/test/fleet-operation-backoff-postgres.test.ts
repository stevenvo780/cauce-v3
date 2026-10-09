import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository } from '../src/index.js';
import type { DatabasePool, FleetOperationClaim } from '../src/index.js';
import type { FleetOperationRequest } from '@cauce/protocol';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const HOST = 'backoff-host';
const FAILURE = { code: 'STEP_FAILED', retryable: true } as const;
let database: TestDatabase | undefined;
let caseDatabase: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test server absent');
  caseDatabase = await startTestCaseDatabase(database); pool = caseDatabase.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('fleet-test','Steven')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','fleet-test','fleet_operator','operator')");
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('fleet-test-account','codex','isolated-test-account','Steven','env_path','CAUCE_ISOLATED_TEST_ACCOUNT_PATH',true)`);
});
afterEach(async () => { await caseDatabase?.close(); caseDatabase = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function create(name: string): FleetOperationRequest {
  return { kind: 'create', target: { resource: 'agent', tenant_id: 'Steven', alias: name }, expected_revision: 0,
    idempotency_key: `create-${name}`, parameters: { runtime_key: name.replaceAll('_', '-'), harness_id: 'codex',
      primary_room_id: 'fleet-test', primary_account_id: 'fleet-test-account', memberships: [{ room_id: 'fleet-test', role: 'agent' }],
      placement: { host_id: HOST, mode: 'container', container_name: `container-${name}`, runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: `/home/dev/.cauce/${name}` } } };
}
async function claimed(repo: FleetOperationsRepository): Promise<FleetOperationClaim> {
  const claim = await repo.claim('backoff-worker', HOST);
  if (!claim) throw new Error('claim absent');
  return claim;
}
async function cancelledOperation(repo: FleetOperationsRepository, name: string, enqueueNewer?: () => Promise<void>): Promise<string> {
  await repo.enqueue('Steven', 'fleet_operator', create(name));
  await enqueueNewer?.();
  const claim = await claimed(repo); await repo.prepare(claim);
  const current = await repo.get('Steven', 'fleet_operator', claim.operation.id);
  await repo.cancel('Steven', 'fleet_operator', current.id, current.version);
  await repo.fail(claim, FAILURE);
  return current.id;
}
async function failCompensation(repo: FleetOperationsRepository): Promise<void> {
  await repo.fail(await claimed(repo), FAILURE);
}
async function ageFailures(seconds: number): Promise<void> {
  await pool.query('ALTER TABLE fleet_operation_events DISABLE TRIGGER fleet_events_history');
  await pool.query("UPDATE fleet_operation_events SET created_at=created_at-$1::integer*interval '1 second'", [seconds]);
  await pool.query('ALTER TABLE fleet_operation_events ENABLE TRIGGER fleet_events_history');
}

describe('fleet compensation backoff', () => {
  it('claims a cancellation promptly when the interrupted attempt was an ordinary step', async () => {
    const repo = new FleetOperationsRepository(pool);
    const id = await cancelledOperation(repo, 'prompt_cancel');
    expect((await claimed(repo)).operation.id).toBe(id);
  });

  it('does not re-claim a failed compensation before its backoff and serves newer operations meanwhile', async () => {
    const repo = new FleetOperationsRepository(pool);
    const stuck = await cancelledOperation(repo, 'stuck_cancel', async () => { await repo.enqueue('Steven', 'fleet_operator', create('newer_agent')); });
    await failCompensation(repo);
    const newer = await claimed(repo);
    expect(newer.operation.id).not.toBe(stuck);
    expect(newer.operation.target).toMatchObject({ alias: 'newer_agent' });
    await repo.fail(newer, FAILURE);
    expect(await repo.claim('backoff-worker', HOST)).toBeNull();
    await ageFailures(6);
    expect((await claimed(repo)).operation.id).toBe(stuck);
  });

  it('doubles the wait per consecutive failure and caps it at five minutes', async () => {
    const repo = new FleetOperationsRepository(pool);
    await cancelledOperation(repo, 'growing_backoff');
    await failCompensation(repo);
    await ageFailures(6); await failCompensation(repo);
    await ageFailures(6);
    expect(await repo.claim('backoff-worker', HOST)).toBeNull();
    await ageFailures(5); await failCompensation(repo);
    await ageFailures(15);
    expect(await repo.claim('backoff-worker', HOST)).toBeNull();
    await ageFailures(6); await failCompensation(repo);
    for (let attempt = 0; attempt < 6; attempt += 1) { await ageFailures(301); await failCompensation(repo); }
    await ageFailures(299);
    expect(await repo.claim('backoff-worker', HOST)).toBeNull();
    await ageFailures(2);
    await failCompensation(repo);
  });

  it('lets an operator cancel request retry a backing-off compensation immediately', async () => {
    const repo = new FleetOperationsRepository(pool);
    const id = await cancelledOperation(repo, 'operator_retry');
    await failCompensation(repo);
    expect(await repo.claim('backoff-worker', HOST)).toBeNull();
    const current = await repo.get('Steven', 'fleet_operator', id);
    await repo.cancel('Steven', 'fleet_operator', id, current.version);
    expect((await claimed(repo)).operation.id).toBe(id);
  });

  it('resets the backoff after a compensation step succeeds', async () => {
    const repo = new FleetOperationsRepository(pool);
    const id = await cancelledOperation(repo, 'reset_backoff');
    await failCompensation(repo);
    await ageFailures(6); await failCompensation(repo);
    await ageFailures(11);
    const claim = await claimed(repo);
    expect(claim.operation.id).toBe(id);
    const slices = await repo.hostSlices(claim);
    const slice = slices[0]; if (!slice) throw new Error('host slice absent');
    await repo.completeHostStep(claim, 'compensate', slice.host_id, slice.target_sha256, { stopped_verified: true, revocation_verified: true });
    await repo.fail(claim, FAILURE);
    expect(await repo.claim('backoff-worker', HOST)).toBeNull();
    await ageFailures(6);
    expect((await claimed(repo)).operation.id).toBe(id);
  });
});
