import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import { ConfigurationRepository, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { finishPurge, messageFixture, preparePurge, purgeFixture } from './fleet-purge-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database missing');
  current = await startTestCaseDatabase(database); pool = current.pool; await purgeFixture(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function rejects(mutations: ConfigMutation[], revision: number): Promise<void> {
  const repo = new ConfigurationRepository(pool);
  for (const mutation of mutations) {
    await expect(repo.apply('Steven', 'purge_operator', mutation, false, revision)).rejects.toMatchObject({ code: 'conflict' });
  }
}

describe('configuration admission and purged secondary scopes on PostgreSQL', () => {
  it('keeps an unprovisioned draft disabled through generic updates and previews', async () => {
    const repo = new ConfigurationRepository(pool);
    const created = await repo.apply('Steven', 'purge_operator', { resource: 'agent', action: 'create', tenant_id: 'Steven',
      alias: 'unprovisioned', value: { harness_id: 'codex', display_name: 'Draft', container_name: 'isolated-unprovisioned',
        runtime_user: 'dev', home_directory: '/home/dev', state_directory: '/home/dev/.cauce' } }, false, 0);
    for (const dryRun of [true, false]) {
      await expect(repo.apply('Steven', 'purge_operator', { resource: 'agent', action: 'update', tenant_id: 'Steven',
        alias: 'unprovisioned', value: { enabled: true } }, dryRun, created.revision)).rejects.toMatchObject({ code: 'conflict' });
    }
    expect((await pool.query("SELECT enabled,runtime_key,lifecycle_state FROM agents WHERE alias='unprovisioned'")).rows[0])
      .toEqual({ enabled: false, runtime_key: null, lifecycle_state: 'draft' });
    expect((await pool.query('SELECT 1 FROM fleet_operations')).rowCount).toBe(0);
  });
  it('rejects recreation and edits of routing configuration owned by a purged agent while permitting cleanup', async () => {
    await messageFixture(pool);
    const { repo, claim } = await preparePurge(pool); await finishPurge(repo, claim);
    await rejects([
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Steven', alias: 'purge_agent', account_id: 'purge-account' },
      { resource: 'egress_destination', action: 'create', tenant_id: 'Steven', alias: 'purge_agent', handle: 'recreated',
        value: { conversation_id: '123', conversation_kind: 'dm', allow_kinds: ['task_complete'] } },
    ], 2);
    await pool.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('Steven','purge_agent','purge-account','Steven','Steven')`);
    await rejects([{ resource: 'agent_account_binding', action: 'create', tenant_id: 'Steven', agent_alias: 'purge_agent',
      account_id: 'purge-account', value: { priority: 1, enabled: true } }], 2);
    await pool.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
      VALUES('Steven','purge_agent','purge-account',1,false)`);
    await rejects([{ resource: 'agent_account_binding', action: 'update', tenant_id: 'Steven', agent_alias: 'purge_agent',
      account_id: 'purge-account', value: { priority: 2, enabled: true } }], 2);
    const snapshot = await new ConfigurationRepository(pool).get('Steven', 'purge_operator');
    expect(JSON.stringify([snapshot.alias_routing_ceiling, snapshot.agent_account_bindings])).not.toContain('purge_agent');
    await new ConfigurationRepository(pool).apply('Steven', 'purge_operator', { resource: 'alias_routing_ceiling', action: 'delete',
      tenant_id: 'Steven', alias: 'purge_agent', account_id: 'purge-account' }, false, 2);
    expect((await pool.query("SELECT 1 FROM agent_account_bindings WHERE tenant_id='Steven' AND agent_alias='purge_agent'")).rowCount).toBe(0);
    expect((await pool.query("SELECT 1 FROM messages WHERE actor_alias='purge_agent'")).rowCount).toBe(1);
  });
  it('rejects new authority and account edits under a purged payer without deleting borrowed historical references', async () => {
    await pool.query("INSERT INTO tenants(id,display_name) VALUES('PurgedPayer','Historical payer')");
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,shared_with_pool,enabled)
      VALUES('historical-account','codex','historical-account','PurgedPayer','env_path','CAUCE_TEST_HISTORICAL_PATH',true,true)`);
    await pool.query(`INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_control)
      VALUES('Steven','PurgedPayer',true,true)`);
    await pool.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('Isa','purge_agent','historical-account','PurgedPayer','Isa')`);
    await pool.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
      VALUES('Isa','purge_agent','historical-account',1,false)`);
    const { repo, claim } = await preparePurge(pool, { resource: 'tenant', tenant_id: 'PurgedPayer' });
    await finishPurge(repo, claim);
    await rejects([
      { resource: 'acl_edge', action: 'create', from_tenant: 'PurgedPayer', to_tenant: 'Isa', value: { enabled: true } },
      { resource: 'acl_edge', action: 'create', from_tenant: 'Isa', to_tenant: 'PurgedPayer', value: { enabled: true } },
      { resource: 'acl_edge', action: 'update', from_tenant: 'Steven', to_tenant: 'PurgedPayer', value: { enabled: true } },
      { resource: 'provider_account', action: 'create', id: 'recreated-payer-account', value: { provider: 'codex',
        external_account_id: 'new-external', payer_tenant_id: 'PurgedPayer', credential_ref_kind: 'env_path', credential_ref: 'CAUCE_TEST_NEW_PATH' } },
      { resource: 'provider_account', action: 'update', id: 'historical-account', value: { enabled: true } },
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Steven', alias: 'purge_agent', account_id: 'historical-account' },
      { resource: 'agent_account_binding', action: 'update', tenant_id: 'Isa', agent_alias: 'purge_agent',
        account_id: 'historical-account', value: { enabled: true } },
    ], 2);
    expect((await pool.query("SELECT enabled FROM provider_accounts WHERE id='historical-account'")).rows[0]).toEqual({ enabled: false });
    expect((await pool.query("SELECT 1 FROM agent_account_bindings WHERE tenant_id='Isa' AND account_id='historical-account'")).rowCount).toBe(1);
    expect((await pool.query("SELECT enabled FROM acl_edges WHERE to_tenant='PurgedPayer'")).rows[0]).toEqual({ enabled: false });
    const snapshot = await new ConfigurationRepository(pool).get('Steven', 'purge_operator');
    expect(JSON.stringify([snapshot.acl_edges, snapshot.provider_accounts, snapshot.alias_routing_ceiling,
      snapshot.agent_account_bindings])).not.toContain('historical-account');
    expect(JSON.stringify(snapshot.acl_edges)).not.toContain('PurgedPayer');
  });
});
