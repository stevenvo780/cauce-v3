import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentQuotaOperationsRepository, lockCompanyAuthority, withTransaction, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { readAgentQuotaPlacement } from '../src/agent-quota-operations-model.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let identities: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>;
const target = { tenant_id: 'ContextAlpha', alias: 'director' };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(requireValue(database, 'database')); pool = current.pool;
  identities = await seedSyntheticCompanyContexts(current.adminUrl);
  await admin().query(`INSERT INTO fleet_hosts(host_id,display_name,company_id)
    VALUES('zz-canary-quota-reader','Quota reader','context_alpha');
    UPDATE agents SET harness_id='codex',runtime_mode='container',host_id='zz-canary-quota-reader',
      container_name='zz-canary-quota-reader',runtime_user='dev',home_directory='/home/dev',
      state_directory='/home/dev/.cauce/dev',systemd_user='stev',runtime_key='zz-canary-quota-reader'
      WHERE tenant_id='ContextAlpha' AND alias='director';`);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function admin() { return requireValue(current, 'case database').adminPool; }
function authority(client: DatabaseClient) {
  const person = requireValue(identities[0], 'company');
  return lockCompanyAuthority(client, { tenant: person.tenant_id, alias: 'owner', humanId: person.human_id });
}
function placement() {
  return withTransaction(pool, async client => readAgentQuotaPlacement(client, await authority(client), target));
}

describe('agent quota reader availability with real PostgreSQL', () => {
  it.each(['codex', 'claude', 'grok'])('distinguishes a legacy %s runtime from a missing harness reader', async harness => {
    await admin().query("UPDATE agents SET harness_id=$1,runtime_mode='native' WHERE tenant_id=$2 AND alias=$3",
      [harness, target.tenant_id, target.alias]);
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_target_unplaced' });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: false, reason: 'quota_target_unplaced', status: 'unsupported' });
  });
  it.each([
    ['missing host', "UPDATE agents SET host_id=NULL WHERE tenant_id='ContextAlpha' AND alias='director'"],
    ['disabled host', "UPDATE fleet_hosts SET enabled=false WHERE host_id='zz-canary-quota-reader'"],
    ['disabled harness', "UPDATE harness_definitions SET enabled=false WHERE id='codex'"],
    ['disabled agent', "UPDATE agents SET enabled=false WHERE tenant_id='ContextAlpha' AND alias='director'"],
    ['retired agent', "UPDATE agents SET enabled=false,retired_at=now() WHERE tenant_id='ContextAlpha' AND alias='director'"],
  ])('reports target unavailability for a %s', async (_name, sql) => {
    await admin().query(sql);
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_target_unplaced' });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: false, reason: 'quota_target_unplaced' });
  });
  it.each(['openclaw', 'muse', 'hermes', 'opencode'])('reports a missing reader only for the unsupported %s harness', async harness => {
    await admin().query('UPDATE agents SET harness_id=$1 WHERE tenant_id=$2 AND alias=$3',
      [harness, target.tenant_id, target.alias]);
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_reader_unavailable' });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: false, reason: 'quota_reader_unavailable' });
  });
  it('retains the reader for an enabled supported container runtime', async () => {
    expect(await placement()).toMatchObject({ reader: true, reason: null });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: true, reason: null, status: 'unknown' });
  });
  it('keeps unchanged unsupported observations stable across repeated reads', async () => {
    await admin().query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    const repository = new AgentQuotaOperationsRepository(pool);
    await repository.snapshot(authority, target);
    const before = (await admin().query('SELECT xmin::text,updated_at FROM agent_quota_observations')).rows;
    await repository.snapshot(authority, target);
    expect((await admin().query('SELECT xmin::text,updated_at FROM agent_quota_observations')).rows).toEqual(before);
  });
});
