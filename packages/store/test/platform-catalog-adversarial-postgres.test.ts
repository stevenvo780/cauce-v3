import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigLeafMutation } from '@cauce/protocol';
import {
  applyMigrationsThrough, applyPlatformConfiguration, ConfigurationError, createPool, lockCompanyAuthority,
  readPlatformConfiguration, rollbackPlatformConfiguration, withTransaction,
  type DatabaseClient, type DatabasePool, type PlatformActor,
} from '../src/index.js';
import {
  provisionTestLogin, startTestCaseDatabase, startTestDatabaseThrough, TEST_RUNTIME_LOGIN,
  type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { preparePostgresSuite } from './postgres-suite.js';

const base = '086_terminal_grants.sql';
const head = '087_platform_catalog_web.sql';
const catalog = `SELECT line FROM (
  SELECT format('relation %s %s acl=%s',c.relname,c.relkind,(SELECT string_agg(format('%s:%s',
      CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,e.privilege_type),',' ORDER BY 1)
    FROM aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) e)) AS line
  FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f','S')
  UNION ALL
  SELECT format('column %s.%s %s notnull=%s generated=%s default=%s acl=%s',c.relname,a.attname,format_type(a.atttypid,a.atttypmod),
      a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid),NULLIF(a.attacl::text,'{}'))
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f') AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL
  SELECT format('constraint %s %s %s',c.conrelid::regclass,c.conname,pg_get_constraintdef(c.oid))
    FROM pg_constraint c WHERE c.connamespace='public'::regnamespace
  UNION ALL
  SELECT format('index %s',pg_get_indexdef(i.indexrelid)) FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid
    WHERE c.relnamespace='public'::regnamespace
  UNION ALL
  SELECT format('trigger %s enabled=%s %s',t.tgrelid::regclass,t.tgenabled,pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
  UNION ALL
  SELECT format('function %s definer=%s volatility=%s config=%s source=%s acl=%s',p.oid::regprocedure,p.prosecdef,p.provolatile,
      p.proconfig,md5(p.prosrc),(SELECT string_agg(format('%s:%s',CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,
        e.privilege_type),',' ORDER BY 1) FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) e))
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL
  SELECT format('schema acl=%s',(SELECT string_agg(format('%s:%s',CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,
      e.privilege_type),',' ORDER BY 1) FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) e))
    FROM pg_namespace n WHERE n.nspname='public'
) catalog ORDER BY line`;

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let admin: DatabasePool;
let runtime: DatabasePool | undefined;
let people: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough(base); }, 180_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  admin = current.adminPool;
  people = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [people.leon]);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
});
afterEach(async () => { await runtime?.end(); runtime = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const actor = (companyId = 'humanizar'): PlatformActor => ({ humanId: people.steven, tenant: 'Steven', alias: 'kant', companyId });
const policy = (role = 'zz_catalog_probe'): ConfigLeafMutation => ({ resource: 'role_policy', action: 'create', role, value: { allow_read: true } });
const flag = async (client: Pick<DatabaseClient, 'query'>): Promise<string | null> =>
  (await client.query<{ value: string | null }>("SELECT current_setting('cauce.platform_catalog_write',true) AS value")).rows[0]?.value ?? null;

async function activate(): Promise<DatabasePool> {
  await applyMigrationsThrough(admin, head);
  if (!current) throw new Error('test database absent');
  runtime = createPool(await provisionTestLogin(admin, current.adminUrl, TEST_RUNTIME_LOGIN, 'cauce_runtime'), { max: 1 });
  return runtime;
}
async function catalogRows(): Promise<unknown> {
  return (await admin.query(`SELECT jsonb_build_object(
    'harnesses',(SELECT jsonb_agg(to_jsonb(row) ORDER BY id) FROM harness_definitions row),
    'policies',(SELECT jsonb_agg(to_jsonb(row) ORDER BY role) FROM role_policies row)) AS rows`)).rows;
}

describe('platform catalog transactional boundaries and migration 087', () => {
  it('preserves populated catalog rows and restores the exact public schema and privileges on down', async () => {
    await admin.query(`INSERT INTO harness_definitions(id,display_name,command,capabilities,enabled)
      VALUES('zz_catalog_legacy','Legacy catalog',NULL,'["messages.receive","jobs.batch"]',false);
      INSERT INTO role_policies(role,allow_route,allow_read,allow_control,allow_notify)
      VALUES('zz_catalog_legacy',true,false,false,true)`);
    const beforeRows = await catalogRows();
    const beforeSchema = (await admin.query(catalog)).rows;
    const beforeLedger = (await admin.query('SELECT * FROM schema_migration_ledger ORDER BY version')).rows;
    await applyMigrationsThrough(admin, head);
    expect(await catalogRows()).toEqual(beforeRows);
    expect((await admin.query(`SELECT has_table_privilege('cauce_runtime','harness_definitions','INSERT') AS create,
      has_table_privilege('cauce_runtime','role_policies','DELETE') AS remove`)).rows).toEqual([{ create: true, remove: true }]);
    const down = await readFile(new URL(`../migrations/down/${head}`, import.meta.url), 'utf8');
    await withTransaction(admin, client => client.query(down));
    expect(await catalogRows()).toEqual(beforeRows);
    expect((await admin.query(catalog)).rows).toEqual(beforeSchema);
    expect((await admin.query('SELECT * FROM schema_migration_ledger ORDER BY version')).rows).toEqual(beforeLedger);
    await applyMigrationsThrough(admin, head);
    expect(await catalogRows()).toEqual(beforeRows);
  });

  it('clears the local flag after commit and rejects a direct write on the reused pool connection', async () => {
    const pool = await activate();
    const pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows;
    const applied = await applyPlatformConfiguration(pool, actor(), policy(), false, 0);
    expect(applied.applied).toBe(true);
    expect(await flag(pool)).not.toBe('on');
    expect((await pool.query('SELECT pg_backend_pid() AS pid')).rows).toEqual(pid);
    await expect(pool.query("UPDATE role_policies SET allow_notify=true WHERE role='zz_catalog_probe'"))
      .rejects.toMatchObject({ code: '42501' });
    const audit = (await admin.query(`SELECT actor_human_id::text,actor_alias,company_id,created_at,metadata
      FROM audit_events WHERE action='config.change'`)).rows;
    expect(audit).toEqual([expect.objectContaining({ actor_human_id: people.steven, actor_alias: 'kant', company_id: null,
      created_at: expect.any(Date) as unknown, metadata: expect.objectContaining({ mutation: policy() }) as unknown })]);
  });

  it('clears the flag on preview, an SQL failure and a rejected authority change without poisoning reuse', async () => {
    const pool = await activate();
    expect((await applyPlatformConfiguration(pool, actor(), policy(), true, 0)).dry_run).toBe(true);
    expect(await flag(pool)).not.toBe('on');
    await admin.query(`CREATE FUNCTION zz_catalog_reject_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'catalog SQL failure probe' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER zz_catalog_reject_insert BEFORE INSERT ON role_policies
      FOR EACH ROW EXECUTE FUNCTION zz_catalog_reject_insert()`);
    const invalid = policy();
    await expect(applyPlatformConfiguration(pool, actor(), invalid, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    await admin.query('DROP TRIGGER zz_catalog_reject_insert ON role_policies; DROP FUNCTION zz_catalog_reject_insert()');
    expect(await flag(pool)).not.toBe('on');
    await expect(applyPlatformConfiguration(pool, actor(), { resource: 'role_policy', action: 'update', role: 'operator',
      value: { allow_control: false } }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect(await flag(pool)).not.toBe('on');
    expect((await admin.query('SELECT id FROM config_revisions')).rows).toEqual([]);
    expect((await applyPlatformConfiguration(pool, actor(), policy(), false, 0)).applied).toBe(true);
  });

  it('restores the flag after a bound successful operation before its outer transaction commits', async () => {
    const pool = await activate();
    await withTransaction(pool, async client => {
      expect(await flag(client)).not.toBe('on');
      const applied = await applyPlatformConfiguration(pool, actor(), policy(), false, 0, client);
      expect(applied.applied).toBe(true);
      expect(await flag(client)).not.toBe('on');
      await client.query('SAVEPOINT direct_catalog_write');
      await expect(client.query("UPDATE role_policies SET allow_notify=true WHERE role='zz_catalog_probe'"))
        .rejects.toMatchObject({ code: '42501' });
      await client.query('ROLLBACK TO SAVEPOINT direct_catalog_write');
    });
    expect(await flag(pool)).not.toBe('on');
  });

  it('rolls back a real SQL failure inside a bound savepoint and keeps its outer transaction usable', async () => {
    const pool = await activate();
    await admin.query(`CREATE FUNCTION zz_catalog_reject_bound_insert() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'bound catalog SQL failure probe' USING ERRCODE='23514'; END $$;
      CREATE TRIGGER zz_catalog_reject_bound_insert BEFORE INSERT ON role_policies
      FOR EACH ROW EXECUTE FUNCTION zz_catalog_reject_bound_insert()`);
    await withTransaction(pool, async client => {
      await expect(applyPlatformConfiguration(pool, actor(), policy(), false, 0, client))
        .rejects.toMatchObject({ code: 'conflict' });
      expect(await flag(client)).not.toBe('on');
      expect((await client.query('SELECT 1 AS usable')).rows).toEqual([{ usable: 1 }]);
      expect((await client.query("SELECT role FROM role_policies WHERE role='zz_catalog_probe'")).rows).toEqual([]);
      expect((await client.query('SELECT id FROM config_revisions')).rows).toEqual([]);
    });
    expect(await flag(pool)).not.toBe('on');
  });

  it('restores the flag and rows when a bound outer transaction rolls back after a successful catalog write', async () => {
    const pool = await activate();
    await expect(withTransaction(pool, async client => {
      await applyPlatformConfiguration(pool, actor(), policy(), false, 0, client);
      throw new Error('outer transaction rejected');
    })).rejects.toThrow('outer transaction rejected');
    expect(await flag(pool)).not.toBe('on');
    expect((await admin.query("SELECT role FROM role_policies WHERE role='zz_catalog_probe'")).rows).toEqual([]);
    expect((await admin.query('SELECT id FROM config_revisions')).rows).toEqual([]);
  });

  it('revalidates the caller after the authority peek and writes nothing if its access was revoked', async () => {
    const pool = await activate();
    let calls = 0;
    await expect(applyPlatformConfiguration(pool, actor(), policy(), false, 0, undefined, async client => {
      calls += 1;
      if (calls > 1) throw new ConfigurationError('forbidden', 'the verified caller access was revoked');
      return lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: people.steven });
    })).rejects.toMatchObject({ code: 'forbidden' });
    expect(calls).toBe(2);
    expect(await flag(pool)).not.toBe('on');
    expect((await admin.query("SELECT role FROM role_policies WHERE role='zz_catalog_probe'")).rows).toEqual([]);
    expect((await admin.query('SELECT id FROM config_revisions')).rows).toEqual([]);
    expect((await admin.query("SELECT id FROM audit_events WHERE action='config.change'")).rows).toEqual([]);
  });

  it('never substitutes a caller callback for the durable platform actor identity', async () => {
    const pool = await activate();
    await expect(applyPlatformConfiguration(pool, { ...actor(), humanId: people.leon }, policy(), false, 0, undefined,
      client => lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: people.steven })))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect((await admin.query("SELECT role FROM role_policies WHERE role='zz_catalog_probe'")).rows).toEqual([]);
    expect((await admin.query('SELECT id FROM config_revisions')).rows).toEqual([]);
  });

  it('serializes concurrent catalog writes in different acting companies and rejects the stale CAS', async () => {
    await activate();
    if (!current) throw new Error('test database absent');
    const parallel = createPool(await provisionTestLogin(admin, current.adminUrl, TEST_RUNTIME_LOGIN, 'cauce_runtime'), { max: 2 });
    try {
      const outcomes = await Promise.allSettled([
        applyPlatformConfiguration(parallel, actor(), policy('zz_catalog_first'), false, 0),
        applyPlatformConfiguration(parallel, actor('praxis'), policy('zz_catalog_second'), false, 0),
      ]);
      expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = outcomes.filter(result => result.status === 'rejected');
      expect(rejected).toHaveLength(1);
      for (const result of rejected) expect(result.reason as unknown).toMatchObject({ code: 'conflict' });
      expect((await admin.query("SELECT role FROM role_policies WHERE role IN ('zz_catalog_first','zz_catalog_second')")).rowCount).toBe(1);
      expect((await admin.query('SELECT id FROM config_revisions')).rowCount).toBe(1);
      expect((await admin.query("SELECT id FROM audit_events WHERE action='config.change'")).rowCount).toBe(1);
    } finally { await parallel.end(); }
  });

  it('audits create, edit, delete and rollback with the actual human and transaction timestamps', async () => {
    const pool = await activate();
    const created = await applyPlatformConfiguration(pool, actor(), policy(), false, 0);
    const edited = await applyPlatformConfiguration(pool, actor(), { resource: 'role_policy', action: 'update', role: 'zz_catalog_probe',
      value: { allow_route: true } }, false, created.revision);
    const removed = await applyPlatformConfiguration(pool, actor(), { resource: 'role_policy', action: 'delete', role: 'zz_catalog_probe' }, false, edited.revision);
    await rollbackPlatformConfiguration(pool, actor(), removed.revision, false, removed.revision);
    const revisions = (await admin.query(`SELECT actor_human_id::text,actor_tenant,actor_alias,scope,company_id,created_at
      FROM config_revisions ORDER BY id`)).rows;
    expect(revisions).toEqual(Array.from({ length: 4 }, () => ({ actor_human_id: people.steven, actor_tenant: 'Steven', actor_alias: 'kant',
      scope: 'platform', company_id: null, created_at: expect.any(Date) as unknown })));
    const audits = (await admin.query(`SELECT action,actor_human_id::text,created_at,metadata->'mutation'->>'action' AS mutation_action
      FROM audit_events WHERE action LIKE 'config.%' ORDER BY id`)).rows;
    expect(audits).toEqual(['create', 'update', 'delete', 'create'].map((action, index) => ({
      action: index === 3 ? 'config.rollback' : 'config.change', actor_human_id: people.steven,
      created_at: expect.any(Date) as unknown, mutation_action: action,
    })));
    expect((await admin.query("SELECT allow_read,allow_route FROM role_policies WHERE role='zz_catalog_probe'")).rows)
      .toEqual([{ allow_read: true, allow_route: true }]);
  });

  it('reads platform revision history in numeric descending order after crossing a decimal boundary', async () => {
    const pool = await activate();
    let revision = 0;
    const revisions: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const applied = await applyPlatformConfiguration(pool, actor(), policy(`zz_catalog_order_${String(index)}`), false, revision);
      revision = applied.revision;
      revisions.unshift(String(revision));
    }
    const snapshot = await readPlatformConfiguration(pool, actor());
    expect((snapshot.revisions as { id: string }[]).map(row => row.id)).toEqual(revisions);
    expect(snapshot.revision).toBe(revision);
  });
});
