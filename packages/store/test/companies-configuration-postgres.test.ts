import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigLeafMutation } from '@cauce/protocol';
import { ConfigurationRepository, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyActors, seedCompanyHuman } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let repository: ConfigurationRepository;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
  await seedCompanyActors(pool); repository = new ConfigurationRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function rows(snapshot: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return snapshot[key] as Record<string, unknown>[];
}

describe('configuration scoped to the actor company', () => {
  it('lists only company tenants, rooms, agents and payer accounts even for hubs', async () => {
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,shared_with_pool)
      VALUES('humanizar-pool','codex','company-fixture','Steven','env_path','CAUCE_TEST_ACCOUNT_PATH',true)`);
    const humanizar = await repository.get('Steven', 'company_admin');
    const praxis = await repository.get('PraxisHub', 'company_admin');
    expect(rows(humanizar, 'tenants').some(row => row.id === 'PraxisHub')).toBe(false);
    expect(rows(praxis, 'tenants').map(row => row.id)).toEqual(['PraxisHub', 'PraxisTeam']);
    expect(rows(praxis, 'rooms').map(row => row.tenant_id)).toEqual(['PraxisHub', 'PraxisTeam']);
    expect(rows(praxis, 'agents').map(row => row.tenant_id)).toEqual(['PraxisHub', 'PraxisTeam']);
    expect(rows(praxis, 'provider_accounts')).toEqual([]);
    expect(rows(humanizar, 'provider_accounts')).toHaveLength(1);
    const team = await repository.get('PraxisTeam', 'team_agent');
    expect(rows(team, 'tenants').map(row => row.id)).toEqual(['PraxisTeam']);
    expect(rows(team, 'provider_accounts')).toEqual([]);
  });
  it('rejects foreign mutations and dependency previews before writing a batch', async () => {
    const foreign = { resource: 'room' as const, action: 'create' as const, tenant_id: 'Steven', id: 'foreign-room', value: { enabled: true } };
    await expect(repository.apply('PraxisHub', 'company_admin', foreign, false, 0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.getDependencies('PraxisHub', 'company_admin', { ...foreign, action: 'delete' }, 0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.apply('PraxisHub', 'company_admin', { resource: 'batch', action: 'apply', mutations: [
      { ...foreign, tenant_id: 'PraxisHub', id: 'own-room' }, foreign,
    ] }, false, 0)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query("SELECT id FROM rooms WHERE id IN ('foreign-room','own-room')")).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM config_revisions')).rows).toEqual([]);
  });
  it('denies every foreign tenant, payer, account and host reference across resources', async () => {
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,shared_with_pool,enabled)
      VALUES('humanizar-pool','codex','company-pool','Steven','env_path','CAUCE_TEST_ACCOUNT_PATH',true,true)`);
    const foreign: ConfigLeafMutation[] = [
      { resource: 'tenant', action: 'update', id: 'Isa', value: { display_name: 'Foreign' } },
      { resource: 'room', action: 'retire', tenant_id: 'Steven', id: 'company-humanizar' },
      { resource: 'membership', action: 'create', tenant_id: 'Steven', room_id: 'company-humanizar', alias: 'company_admin', value: { role: 'operator' } },
      { resource: 'acl_edge', action: 'create', from_tenant: 'Steven', to_tenant: 'Isa', value: {} },
      { resource: 'acl_edge', action: 'create', from_tenant: 'PraxisHub', to_tenant: 'Steven', value: {} },
      { resource: 'egress_destination', action: 'create', tenant_id: 'Steven', alias: 'company_admin', handle: 'foreign.channel',
        value: { adapter: 'telegram', channel: 'company', conversation_id: '1', conversation_kind: 'dm' } },
      { resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'company_admin', value: { display_name: 'Foreign' } },
      { resource: 'agent', action: 'update', tenant_id: 'PraxisHub', alias: 'company_admin', value: { host_id: 'company-host' } },
      { resource: 'provider_account', action: 'create', id: 'praxis-foreign-payer', value: { provider: 'codex', external_account_id: 'praxis-foreign',
        payer_tenant_id: 'Steven', credential_ref_kind: 'env_path', credential_ref: 'CAUCE_TEST_FOREIGN_PATH' } },
      { resource: 'provider_account', action: 'update', id: 'humanizar-pool', value: { label: 'Foreign' } },
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Steven', alias: 'company_admin', account_id: 'humanizar-pool' },
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'PraxisHub', alias: 'company_admin', account_id: 'humanizar-pool' },
      { resource: 'agent_account_binding', action: 'create', tenant_id: 'PraxisHub', agent_alias: 'company_admin', account_id: 'humanizar-pool', value: { priority: 0 } },
    ];
    for (const mutation of foreign) {
      await expect(repository.apply('PraxisHub', 'company_admin', mutation, true, 0), mutation.resource).rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.getDependencies('PraxisHub', 'company_admin', mutation, 0), mutation.resource).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect((await pool.query('SELECT id FROM config_revisions')).rows).toEqual([]);
    expect((await pool.query("SELECT label FROM provider_accounts WHERE id='humanizar-pool'")).rows).toEqual([{ label: null }]);
  });
  it('creates tenants in the actor company, including batches and a deletion inverse', async () => {
    const created = await repository.apply('PraxisHub', 'company_admin', { resource: 'batch', action: 'apply', mutations: [
      { resource: 'tenant', action: 'create', id: 'PraxisNew', value: { display_name: 'New' } },
      { resource: 'room', action: 'create', tenant_id: 'PraxisNew', id: 'company-new-room', value: {} },
    ] }, false, 0);
    expect((await pool.query("SELECT company_id FROM tenants WHERE id='PraxisNew'")).rows).toEqual([{ company_id: 'praxis' }]);
    await repository.rollback('PraxisHub', 'company_admin', created.revision, false, created.revision);
    const own = await repository.apply('PraxisHub', 'company_admin', { resource: 'tenant', action: 'create', id: 'PraxisEmpty', value: {} }, false);
    const removed = await repository.apply('PraxisHub', 'company_admin', { resource: 'tenant', action: 'delete', id: 'PraxisEmpty' }, false, own.revision);
    await repository.rollback('PraxisHub', 'company_admin', removed.revision, false, removed.revision);
    expect((await pool.query("SELECT company_id FROM tenants WHERE id='PraxisEmpty'")).rows).toEqual([{ company_id: 'praxis' }]);
  });
  it('keeps revision compare-and-set global while hiding and denying another company revisions', async () => {
    const changed = await repository.apply('Steven', 'company_admin', { resource: 'room', action: 'update',
      tenant_id: 'Steven', id: 'company-humanizar', value: { display_name: 'Changed' } }, false, 0);
    const snapshot = await repository.get('PraxisHub', 'company_admin');
    expect(snapshot.revision).toBe(changed.revision);
    expect(snapshot.revisions).toEqual([]);
    await expect(repository.rollback('PraxisHub', 'company_admin', changed.revision, false, changed.revision)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query("SELECT display_name FROM rooms WHERE id='company-humanizar'")).rows).toEqual([{ display_name: 'Changed' }]);
  });
  it('reserves unpartitioned global catalog writes to the legacy company hub', async () => {
    const snapshot = await repository.get('PraxisHub', 'company_admin');
    const capabilities = snapshot.capabilities as { resources: { resource: string; actions: string[]; scope: string }[] };
    for (const resource of ['harness', 'role_policy', 'chain_policy']) {
      expect(capabilities.resources.find(row => row.resource === resource)).toMatchObject({ actions: [], scope: 'none' });
    }
    await expect(repository.apply('PraxisHub', 'company_admin', { resource: 'harness', action: 'update', id: 'codex',
      value: { display_name: 'Foreign edit' } }, false, 0)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await repository.apply('Steven', 'company_admin', { resource: 'harness', action: 'update', id: 'codex',
      value: { display_name: 'Same company' } }, false, 0)).applied).toBe(true);
  });
  it('protects the last human control authority within each company', async () => {
    await seedCompanyHuman(pool, 'Steven'); await seedCompanyHuman(pool, 'PraxisHub');
    await expect(repository.apply('Steven', 'kant', { resource: 'membership', action: 'retire', tenant_id: 'Steven',
      room_id: 'company-humanizar', alias: 'company_admin' }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT enabled FROM memberships WHERE room_id='company-humanizar'")).rows).toEqual([{ enabled: true }]);
  });
  it('revalidates ownership after waiting for a concurrent configuration writer', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(783_003_004)');
    const attempt = repository.apply('PraxisHub', 'company_admin', { resource: 'room', action: 'create', tenant_id: 'ConcurrentForeign',
      id: 'company-concurrent-room', value: {} }, false).then(() => 'applied', (error: unknown) => error);
    try {
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE wait_event='advisory' AND query='SELECT pg_advisory_xact_lock(783_003_004)'`)).rowCount, { timeout: 5000 }).toBe(1);
      await pool.query("INSERT INTO tenants(id,company_id) VALUES('ConcurrentForeign','humanizar')");
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(await attempt).toMatchObject({ code: 'forbidden' });
    expect((await pool.query("SELECT id FROM rooms WHERE id='company-concurrent-room'")).rows).toEqual([]);
  });
});
