import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, lockCompanyAuthority, migrationSourcesForApply, type DatabasePool } from '../src/index.js';
import { ContextVersionStore } from '../src/context-version.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { closeTestDatabase, startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase,
  type TestDatabase } from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
const version = '080_agent_alias_immutable.sql';
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('079_host_enrollment_compatibility.sql'); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(requireValue(database, 'database'));
  pool = current.pool;
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { await closeTestDatabase(database); });
async function down() { return readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'); }
async function at080() {
  await applyMigrationsThrough(requireValue(current, 'case database').adminPool, version);
  return requireValue(current, 'case database').adminPool;
}

describe('agent alias immutability', () => {
  it('rejects renaming the alias and keeps the context history of the stable identity', async () => {
    const fixtures = await seedSyntheticCompanyContexts(requireValue(current, 'case database').adminUrl);
    const target = requireValue(fixtures[0], 'fixture');
    const admin = await at080();
    const store = new ContextVersionStore(pool);
    const source = (client: import('../src/db.js').DatabaseClient) =>
      lockCompanyAuthority(client, { tenant: target.tenant_id, alias: 'owner', humanId: target.human_id });
    await store.write(source, target.tenant_id, target.alias,
      { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: 'Mission\n' }] });
    await expect(admin.query("UPDATE agents SET alias='renamed-director' WHERE tenant_id=$1 AND alias=$2",
      [target.tenant_id, target.alias])).rejects.toMatchObject({ code: '23514' });
    await expect(admin.query("UPDATE agents SET alias='renamed-director',display_name='Renamed' WHERE tenant_id=$1 AND alias=$2",
      [target.tenant_id, target.alias])).rejects.toMatchObject({ code: '23514' });
    await admin.query("INSERT INTO rooms(tenant_id,id) VALUES($1,'renamed-room')", [target.tenant_id]);
    await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'renamed-room',$2,'agent')",
      [target.tenant_id, target.alias]);
    await admin.query("UPDATE agents SET display_name='Renamed director',primary_room_id='renamed-room' WHERE tenant_id=$1 AND alias=$2",
      [target.tenant_id, target.alias]);
    expect((await admin.query<{ alias: string; display_name: string }>(
      'SELECT alias,display_name FROM agents WHERE tenant_id=$1', [target.tenant_id])).rows)
      .toEqual(expect.arrayContaining([{ alias: target.alias, display_name: 'Renamed director' }]));
    expect(await store.read(source, target.tenant_id, target.alias))
      .toMatchObject({ company_id: target.company_id, tenant_id: target.tenant_id, alias: target.alias, version: 1 });
    expect((await store.history(source, target.tenant_id, target.alias)).entries.map(entry => entry.version)).toEqual([1]);
  });

  it('records the exact up hash in the atomic ledger', async () => {
    const admin = await at080();
    const source = requireValue((await migrationSourcesForApply()).find(value => value.version === version), '080 migration');
    expect((await admin.query('SELECT source_sha256,source_origin FROM schema_migration_ledger WHERE version=$1', [version])).rows)
      .toEqual([{ source_sha256: source.sourceSha256, source_origin: 'applied-atomically' }]);
    expect(await down()).toContain(source.sourceSha256);
  });

  it('removes the guard on downgrade and restores it on reapply', async () => {
    const fixtures = await seedSyntheticCompanyContexts(requireValue(current, 'case database').adminUrl);
    const target = requireValue(fixtures[0], 'fixture');
    const admin = await at080();
    await admin.query('INSERT INTO agents(tenant_id,alias,enabled) VALUES($1,\'zz-canary-alias\',false)', [target.tenant_id]);
    await expect(admin.query("UPDATE agents SET alias='zz-canary-renamed' WHERE tenant_id=$1 AND alias='zz-canary-alias'",
      [target.tenant_id])).rejects.toMatchObject({ code: '23514' });
    await admin.query(await down());
    expect((await admin.query("SELECT to_regclass('public.agents') AS agents")).rows).toEqual([{ agents: 'agents' }]);
    expect((await admin.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([]);
    await admin.query("UPDATE agents SET alias='zz-canary-renamed' WHERE tenant_id=$1 AND alias='zz-canary-alias'", [target.tenant_id]);
    expect((await admin.query<{ alias: string }>('SELECT alias FROM agents WHERE tenant_id=$1 AND alias=$2',
      [target.tenant_id, 'zz-canary-renamed'])).rows).toEqual([{ alias: 'zz-canary-renamed' }]);
    await applyMigrationsThrough(admin, version);
    await expect(admin.query("UPDATE agents SET alias='zz-canary-again' WHERE tenant_id=$1 AND alias='zz-canary-renamed'",
      [target.tenant_id])).rejects.toMatchObject({ code: '23514' });
  });
});
