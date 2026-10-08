import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetEvidence, FleetOperationRequest, FleetStepName } from '@cauce/protocol';
import { ConfigurationRepository, FleetOperationsRepository, type DatabasePool, type FleetOperationClaim } from '../src/index.js';
import { admitFleetAgent } from '../src/repository/fleet-operation-admission.js';
import type { FleetOperationRow } from '../src/repository/fleet-operation-contracts.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let caseDatabase: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test server absent');
  caseDatabase = await startTestCaseDatabase(database); pool = caseDatabase.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('admission-control','Steven'),('admission-room','Isa'),('admission-optional','Isa')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','admission-control','admission_operator','operator')");
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('admission-account','codex','isolated-admission-account','Isa','env_path','CAUCE_ISOLATED_ADMISSION_PATH',true)`);
});
afterEach(async () => { await caseDatabase?.close(); caseDatabase = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function create(): FleetOperationRequest {
  return { kind: 'create', target: { resource: 'agent', tenant_id: 'Isa', alias: 'admitted_agent' }, expected_revision: 0,
    idempotency_key: 'admission-create', parameters: { runtime_key: 'admitted-agent', harness_id: 'codex',
      primary_room_id: 'admission-room', primary_account_id: 'admission-account', memberships: [
        { room_id: 'admission-room', role: 'agent' }, { room_id: 'admission-optional', role: 'agent', enabled: false }],
      placement: { host_id: 'admission-host', mode: 'container', container_name: 'admitted-agent', runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: '/home/dev/.cauce/admitted-agent' } } };
}
async function claim(repo: FleetOperationsRepository): Promise<FleetOperationClaim> {
  await repo.enqueue('Steven', 'admission_operator', create());
  const value = await repo.claim('admission-worker', 'admission-host'); if (!value) throw new Error('claim absent');
  return value;
}
async function verify(repo: FleetOperationsRepository, value: FleetOperationClaim): Promise<void> {
  for (const [name, evidence] of [['artifacts', { artifact_sha256: 'a'.repeat(64) }],
    ['credentials', { certificate_fingerprint: 'b'.repeat(64) }], ['runtime', { runtime_digest: 'c'.repeat(64) }],
    ['authenticate', { provider_verified: true }], ['profile', { profile_verified: true }],
    ['verify', { hello_verified: true, roundtrip_verified: true }],
    ['admission', { authority_verified: true, artifact_sha256: 'd'.repeat(64) }]] as [FleetStepName, FleetEvidence][]) {
    await repo.startStep(value, name); await repo.completeStep(value, name, evidence);
  }
}
const disabled = [
  ['tenant', "UPDATE tenants SET enabled=false WHERE id='Isa'"],
  ['retired tenant', "UPDATE tenants SET enabled=false,retired_at=clock_timestamp(),retired_enabled=true WHERE id='Isa'"],
  ['primary room', "UPDATE rooms SET enabled=false WHERE id='admission-room'"],
  ['retired primary room', "UPDATE rooms SET enabled=false,retired_at=clock_timestamp(),retired_enabled=true WHERE id='admission-room'"],
  ['harness', "UPDATE harness_definitions SET enabled=false WHERE id='codex'"],
] as const;
describe('fleet admission current configuration', () => {
  it.each(disabled)('rejects an unavailable %s before preview enqueue and preparation', async (_name, sql) => {
    const repo = new FleetOperationsRepository(pool); const value = await claim(repo);
    await pool.query(sql);
    await expect(repo.preview('Steven', 'admission_operator', create())).rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.enqueue('Steven', 'admission_operator', { ...create(), idempotency_key: 'another-admission-key' }))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(repo.prepare(value)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT 1 FROM agents WHERE alias='admitted_agent'")).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM config_revisions')).rowCount).toBe(0);
  });
  it.each(disabled)('rejects an unavailable %s at settle even after complete runtime evidence', async (_name, sql) => {
    const repo = new FleetOperationsRepository(pool); const value = await claim(repo); await repo.prepare(value); await verify(repo, value);
    const version = (await repo.get('Steven', 'admission_operator', value.operation.id)).version;
    await pool.query(sql);
    await expect(repo.settle(value)).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.get('Steven', 'admission_operator', value.operation.id)).version).toBe(version);
    expect((await pool.query("SELECT enabled,lifecycle_state FROM agents WHERE alias='admitted_agent'")).rows[0])
      .toEqual({ enabled: false, lifecycle_state: 'provisioning' });
    expect((await pool.query("SELECT 1 FROM memberships WHERE alias='admitted_agent' AND enabled")).rowCount).toBe(0);
  });
  it.each([
    ['primary identity', "UPDATE agents SET primary_room_id='admission-optional' WHERE alias='admitted_agent'"],
    ['primary role', "UPDATE memberships SET role='operator' WHERE alias='admitted_agent' AND room_id='admission-room'"],
    ['retired membership', "UPDATE memberships SET retired_at=clock_timestamp(),retired_enabled=true WHERE alias='admitted_agent' AND room_id='admission-room'"],
    ['revoked primary role policy', "UPDATE role_policies SET allow_route=false WHERE role='agent'"],
  ])('rejects changed %s instead of admitting different routing intent', async (_name, sql) => {
    const repo = new FleetOperationsRepository(pool); const value = await claim(repo); await repo.prepare(value); await verify(repo, value);
    await pool.query(sql);
    await expect(repo.settle(value)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT enabled FROM agents WHERE alias='admitted_agent'")).rows[0]).toEqual({ enabled: false });
  });
  it('keeps generic configuration on the same revision CAS before fleet admission', async () => {
    const repo = new FleetOperationsRepository(pool); const value = await claim(repo); await repo.prepare(value); await verify(repo, value);
    const config = new ConfigurationRepository(pool);
    const result = await config.apply('Steven', 'admission_operator', { resource: 'room', action: 'update', tenant_id: 'Isa',
      id: 'admission-room', value: { enabled: false } }, false, 1);
    expect(result.revision).toBe(2);
    await expect(repo.settle(value)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT enabled FROM agents WHERE alias='admitted_agent'")).rows[0]).toEqual({ enabled: false });
  });
  it('holds the complete admission authority under row locks until the transaction ends', async () => {
    const repo = new FleetOperationsRepository(pool); const value = await claim(repo); await repo.prepare(value); await verify(repo, value);
    const transaction = await pool.connect();
    try {
      await transaction.query('BEGIN');
      const row = (await transaction.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [value.operation.id])).rows[0];
      if (!row) throw new Error('operation absent');
      await admitFleetAgent(transaction, row);
      for (const lookup of ["tenants WHERE id='Isa'", "rooms WHERE id='admission-room'", "harness_definitions WHERE id='codex'",
        "provider_accounts WHERE id='admission-account'", "role_policies WHERE role='agent'",
        "memberships WHERE alias='admitted_agent' AND room_id='admission-room'"]) {
        await expect(pool.query(`SELECT 1 FROM ${lookup} FOR UPDATE NOWAIT`)).rejects.toMatchObject({ code: '55P03' });
      }
    } finally { await transaction.query('ROLLBACK'); transaction.release(); }
    expect((await pool.query("SELECT enabled FROM agents WHERE alias='admitted_agent'")).rows[0]).toEqual({ enabled: false });
  });
});
