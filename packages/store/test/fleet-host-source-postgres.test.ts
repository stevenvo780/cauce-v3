import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetOperationRequest } from '@cauce/protocol';
import { ConfigurationRepository, type DatabasePool, type FleetOperationClaim } from '../src/index.js';
import { FleetHostSource } from '../../../services/gateway/src/fleet/source.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let caseDatabase: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let source: FleetHostSource;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test server absent');
  caseDatabase = await startTestCaseDatabase(database); pool = caseDatabase.pool;
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('source-control','Steven'),('source-room','Isa')");
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','source-control','source_operator','operator')");
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES('source-account','codex','isolated-source-account','Isa','env_path','CAUCE_SYNTHETIC_PRIVATE_SECRET_PATH',true)`);
  source = new FleetHostSource(pool, { snapshotQuery: await readFile(new URL('../../../ops/scripts/fleet-query.sql', import.meta.url), 'utf8') });
});
afterEach(async () => { await caseDatabase?.close(); caseDatabase = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function create(): FleetOperationRequest {
  return { kind: 'create', target: { resource: 'agent', tenant_id: 'Isa', alias: 'source_agent' }, expected_revision: 0,
    idempotency_key: 'source-create-agent', parameters: { runtime_key: 'source-agent', harness_id: 'codex', primary_room_id: 'source-room',
      primary_account_id: 'source-account', memberships: [{ room_id: 'source-room', role: 'agent' }],
      placement: { host_id: 'source-host', mode: 'container', container_name: 'source-agent', runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: '/home/dev/.cauce/source-agent' } } };
}
async function claimed(): Promise<FleetOperationClaim> {
  await source.enqueue('Steven', 'source_operator', create());
  const claim = await source.claim('source-worker', 'source-host'); if (!claim) throw new Error('claim absent');
  return claim;
}
describe('host execution snapshot transaction', () => {
  it('captures the current prepared disabled snapshot and revision without credentials', async () => {
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
      VALUES('unrelated-grok','grok','unrelated-provider-identity','Steven','env_path','CAUCE_UNRELATED_PRIVATE_LOCATOR_PATH',true)`);
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,primary_account_id,enabled)
      VALUES('Steven','source_agent','codex','unrelated-grok',false)`);
    const claim = await claimed();
    expect((await source.execution(claim)).snapshot_revision).toBe(0);
    await source.prepare(claim);
    const execution = await source.execution(claim);
    expect(execution.snapshot_revision).toBe(1);
    expect(execution.operation.desired_revision).toBe(1);
    expect(Object.keys(execution.snapshot).sort()).toEqual(['agents', 'memberships', 'rolePolicies']);
    expect(execution.snapshot.agents).toContainEqual(expect.objectContaining({ tenant_id: 'Isa', alias: 'source_agent', enabled: false,
      runtime_key: 'source-agent', lifecycle_state: 'provisioning' }));
    expect(execution.snapshot.memberships).toContainEqual({ tenant_id: 'Isa', alias: 'source_agent', room_id: 'source-room', role: 'agent', enabled: false });
    expect(execution.desired_memberships).toContainEqual({ tenant_id: 'Isa', alias: 'source_agent', room_id: 'source-room', role: 'agent', enabled: true });
    expect(JSON.stringify(execution)).not.toContain('CAUCE_SYNTHETIC_PRIVATE_SECRET_PATH');
    expect(JSON.stringify(execution.snapshot)).not.toContain('isolated-source-account');
    expect(execution.trusted_accounts).toEqual([{ id: 'source-account', provider: 'codex',
      external_account_id: 'isolated-source-account', payer_tenant_id: 'Isa', shared_with_pool: false, enabled: true }]);
    expect(JSON.stringify(execution.trusted_accounts)).not.toContain('unrelated-provider-identity');
  });
  it('rejects an unrelated newer configuration before an active physical effect', async () => {
    const claim = await claimed(); await source.prepare(claim);
    await new ConfigurationRepository(pool).apply('Steven', 'source_operator', { resource: 'room', action: 'update',
      tenant_id: 'Isa', id: 'source-room', value: { enabled: false } }, false, 1);
    await expect(source.execution(claim)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('allows cancellation cleanup after configuration changes and records the observed revision', async () => {
    const claim = await claimed(); await source.prepare(claim);
    const operation = await source.get('Steven', 'source_operator', claim.operation.id);
    await source.cancel('Steven', 'source_operator', operation.id, operation.version);
    await new ConfigurationRepository(pool).apply('Steven', 'source_operator', { resource: 'room', action: 'update',
      tenant_id: 'Isa', id: 'source-room', value: { enabled: false } }, false, 1);
    const execution = await source.execution(claim);
    expect(execution.operation.status).toBe('cancelling');
    expect(execution.operation.desired_revision).toBe(1);
    expect(execution.snapshot_revision).toBe(2);
    expect(execution.snapshot.agents).toContainEqual(expect.objectContaining({ alias: 'source_agent', enabled: false }));
  });
  it('rejects a replaced or expired claim before exposing host execution input', async () => {
    const claim = await claimed(); await source.prepare(claim);
    await expect(source.execution({ ...claim, epoch: claim.epoch + 1 })).rejects.toMatchObject({ code: 'conflict' });
    await pool.query("UPDATE fleet_operations SET lease_expires_at=clock_timestamp()-interval '1 second' WHERE id=$1", [claim.operation.id]);
    await expect(source.execution(claim)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('rechecks lease expiry after snapshot collection before exposing physical input', async () => {
    const claim = await claimed(); await source.prepare(claim);
    const query = await readFile(new URL('../../../ops/scripts/fleet-query.sql', import.meta.url), 'utf8');
    const slow = new FleetHostSource(pool, { snapshotQuery: `WITH delay AS MATERIALIZED (SELECT pg_sleep(0.2))
      SELECT raw.* FROM delay CROSS JOIN (${query.trim().replace(/;$/u, '')}) raw` });
    await pool.query("UPDATE fleet_operations SET lease_expires_at=clock_timestamp()+interval '100 milliseconds' WHERE id=$1", [claim.operation.id]);
    await expect(slow.execution(claim)).rejects.toMatchObject({ code: 'conflict' });
  });
  it('waits for the configuration lock before observing a committed newer snapshot', async () => {
    const claim = await claimed(); await source.prepare(claim);
    const operation = await source.get('Steven', 'source_operator', claim.operation.id);
    await source.cancel('Steven', 'source_operator', operation.id, operation.version);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SELECT pg_advisory_xact_lock(783_003_004)');
      await client.query("UPDATE agents SET model_id='source-committed-model' WHERE alias='source_agent'");
      await client.query(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
        VALUES('Steven','source_operator','{}','{}','isolated newer snapshot')`);
      const pending = source.execution(claim);
      await client.query('COMMIT');
      const execution = await pending;
      expect(execution.snapshot_revision).toBe(2);
      expect(execution.snapshot.agents).toContainEqual(expect.objectContaining({ alias: 'source_agent', model_id: 'source-committed-model' }));
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
