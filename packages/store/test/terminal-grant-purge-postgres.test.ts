import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, createPool, withTransaction, type DatabasePool } from '../src/index.js';
import { PURGE_CONFIGURATION } from '../src/repository/fleet-operation-purge-plan.js';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  provisionTestLogin, startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { downsThrough } from './migration-downs.fixtures.js';
import { finishPurge, preparePurge, purgeFixture } from './fleet-purge-postgres.fixtures.js';

const humanId = 'fdbc7f94-5f87-4a1a-aa7d-e107439c5c58';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let runtime: DatabasePool | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database missing');
  current = await startTestCaseDatabase(database);
  // Always the real gateway login, in cauce_runtime: the default test pool is the owner unless CAUCE_TEST_RUNTIME_ROLE=1.
  runtime = createPool(await provisionTestLogin(current.adminPool, current.adminUrl, 'cauce_gateway_purge', 'cauce_runtime'), { max: 2 });
  await purgeFixture(runtime, current.adminPool);
});
afterEach(async () => { await runtime?.end(); runtime = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function pools(): { runtime: DatabasePool; admin: DatabasePool } {
  if (!runtime || !current) throw new Error('test database missing');
  return { runtime, admin: current.adminPool };
}

describe('purging an agent as a member of cauce_runtime', () => {
  it('lets cauce_runtime delete every table the purge removes', async () => {
    const { admin } = pools();
    const denied = (await admin.query<{ relname: string }>(`SELECT relname FROM pg_class
      WHERE relnamespace='public'::regnamespace AND relname=ANY($1) AND NOT has_table_privilege('cauce_runtime',oid,'DELETE')`,
    [PURGE_CONFIGURATION])).rows.map(row => row.relname);
    expect(denied).toEqual([]);
  });

  it('purges an agent that has terminal grants and keeps the grants of other agents', async () => {
    const { runtime: gateway, admin } = pools();
    const grant = (alias: string, mode: string) => admin.query(`INSERT INTO terminal_grants(tenant_id,alias,grantee_human_id,modes,granted_by_human_id)
      VALUES('Steven',$1,$2,ARRAY[$3],$2)`, [alias, humanId, mode]);
    await grant('purge_agent', 'shell');
    await grant('*', 'shell');
    await admin.query(`INSERT INTO agents(tenant_id,alias) VALUES('Steven','purge_other')`);
    await admin.query(`INSERT INTO terminal_grants(tenant_id,alias,grantee_human_id,modes,granted_by_human_id,revoked_at,revoked_by_human_id)
      VALUES('Steven','purge_other',$1,ARRAY['shell'],$1,now(),$1)`, [humanId]);
    await admin.query(`UPDATE terminal_grants SET revoked_at=now(),revoked_by_human_id=$1,version=version+1
      WHERE tenant_id='Steven' AND alias='purge_agent'`, [humanId]);
    await grant('purge_agent', 'harness_rw');

    const { repo, claim } = await preparePurge(gateway);
    await finishPurge(repo, claim);

    expect((await admin.query<{ alias: string }>(`SELECT alias FROM terminal_grants ORDER BY alias`)).rows)
      .toEqual([{ alias: '*' }, { alias: 'purge_other' }]);
    const archived = (await admin.query<{ archived: string }>(`SELECT jsonb_array_length(metadata->'deleted_configuration'->'terminal_grants')::text AS archived
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'purge_scope'`, [claim.operation.id])).rows[0];
    expect(archived).toEqual({ archived: '2' });
    expect((await admin.query("SELECT purged_at IS NOT NULL AS purged FROM agents WHERE tenant_id='Steven' AND alias='purge_agent'")).rows[0])
      .toEqual({ purged: true });
  });

  it('still refuses the writes the runtime never had on terminal grants', async () => {
    const { runtime: gateway, admin } = pools();
    await admin.query(`INSERT INTO terminal_grants(tenant_id,alias,grantee_human_id,modes,granted_by_human_id)
      VALUES('Steven','purge_agent',$1,ARRAY['shell'],$1)`, [humanId]);
    await expect(gateway.query('TRUNCATE terminal_grants')).rejects.toMatchObject({ code: '42501' });
    await expect(gateway.query("UPDATE terminal_grants SET note='kept'")).resolves.toMatchObject({ rowCount: 1 });
  });

  it('reverts its grant with down/095 and restores it when reapplied', async () => {
    const { admin } = pools();
    const deletable = async () => (await admin.query<{ ok: boolean }>(
      "SELECT has_table_privilege('cauce_runtime','terminal_grants','DELETE') AS ok")).rows[0]?.ok;
    expect(await deletable()).toBe(true);
    const down = (await downsThrough('095_terminal_grants_runtime_delete.sql')).join('\n');
    await withTransaction(admin, client => client.query(down));
    expect(await deletable()).toBe(false);
    expect((await admin.query("SELECT 1 FROM pg_proc WHERE proname='cauce_runtime_grants_095'")).rowCount).toBe(0);
    await applyMigrations(admin);
    expect(await deletable()).toBe(true);
  });
});
