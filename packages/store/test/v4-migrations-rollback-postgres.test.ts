import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, migrationSourcesForApply, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

// The schema production runs before V4 and the last migration of the V4 bundle.
const base = '051_companies.sql';
const head = '065_runtime_grants_replay.sql';
// Every object of the public schema with its effective privileges, so a materialized default ACL equals NULL.
const CATALOG = `SELECT line FROM (
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
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabaseThrough(base);
}, 240_000);
beforeEach(async () => {
  if (!database) return;
  current = await startTestCaseDatabase(database); pool = current.adminPool;
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function bundle(): Promise<string[]> {
  const versions = (await migrationSourcesForApply()).map(source => source.version);
  return versions.slice(versions.indexOf(base) + 1, versions.indexOf(head) + 1);
}
async function downSql(version: string): Promise<string> {
  return readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
}
async function catalog(): Promise<string[]> {
  return (await pool.query<{ line: string }>(CATALOG)).rows.map(row => row.line);
}
async function schemaVersion(): Promise<{ migrations: string | null; ledger: string | null }> {
  return (await pool.query<{ migrations: string | null; ledger: string | null }>(`SELECT
    (SELECT max(version) FROM schema_migrations) AS migrations,(SELECT max(version) FROM schema_migration_ledger) AS ledger`)).rows[0]
    ?? { migrations: null, ledger: null };
}
/** Every row of every public table, the migration ledgers included, as sorted row hashes per table. */
async function rows(): Promise<Record<string, string[]>> {
  const tables = (await pool.query<{ name: string }>(`SELECT relname AS name FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND NOT relispartition ORDER BY 1`)).rows;
  const result: Record<string, string[]> = {};
  for (const { name } of tables) {
    result[name] = (await pool.query<{ hash: string }>(`SELECT md5(to_jsonb(entry)::text) AS hash FROM public.${JSON.stringify(name)} entry
      ORDER BY 1`)).rows.map(row => row.hash);
  }
  return result;
}
interface Director {
  company_id: string; tenant_id: string; principal_alias: string; delivery_source_only: boolean;
  enabled: boolean; room_id: string | null; role: string | null;
}
async function directors(): Promise<Director[]> {
  return (await pool.query<Director>(`SELECT principal.company_id,principal.tenant_id,principal.principal_alias,principal.delivery_source_only,
      agent.enabled,member.room_id,member.role FROM company_system_principals principal
    JOIN agents agent ON agent.tenant_id=principal.tenant_id AND agent.alias=principal.principal_alias
    LEFT JOIN memberships member ON member.tenant_id=principal.tenant_id AND member.alias=principal.principal_alias
    WHERE principal.kind='director' ORDER BY 1,2,3,6`)).rows;
}
async function contextDirectorAgents(): Promise<string[]> {
  return (await pool.query<{ alias: string }>("SELECT alias FROM agents WHERE alias LIKE 'context-director%' ORDER BY 1"))
    .rows.map(row => row.alias);
}

async function rollBackOneByOne(versions: string[]): Promise<void> {
  for (const version of [...versions].reverse()) {
    await pool.query(await downSql(version));
    const previous = versions[versions.indexOf(version) - 1] ?? base;
    expect({ version, ...await schemaVersion() }).toEqual({ version, migrations: previous, ledger: previous });
  }
}

describe('V4 bundle 052-065 rolled back one down at a time', () => {
  it.each([
    ['063 backfills a source-only director', false],
    ['argos is the real director that 054 seeds', true],
  ])('returns to the exact 051 schema and rows and reapplies the same 065 schema when %s', async (_name, realDirector) => {
    const versions = await bundle();
    expect(versions[0]).toBe('052_runtime_roles.sql');
    expect(versions.at(-1)).toBe(head);
    if (realDirector) {
      await pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES('Steven','argos','codex',false),('Steven','kant','codex',false)");
    }
    expect(await schemaVersion()).toEqual({ migrations: base, ledger: base });
    const baseCatalog = await catalog();
    const baseRows = await rows();

    await applyMigrationsThrough(pool, head);
    expect(await schemaVersion()).toEqual({ migrations: head, ledger: head });
    const headCatalog = await catalog();
    const headDirectors = await directors();
    expect(headDirectors).toEqual(realDirector
      ? [{ company_id: 'humanizar', tenant_id: 'Steven', principal_alias: 'argos', delivery_source_only: false, enabled: false,
        room_id: 'grp.steven', role: 'agent' }]
      : [{ company_id: 'humanizar', tenant_id: 'Steven', principal_alias: 'context-director', delivery_source_only: true, enabled: false,
        room_id: 'grp.steven', role: 'context_broker' }]);

    // Each down refuses while a later migration is still applied and leaves the schema untouched.
    const client = await pool.connect();
    try {
      for (const version of versions.slice(0, -1)) {
        await client.query('BEGIN');
        await expect(client.query(await downSql(version))).rejects.toThrow(
          `cannot downgrade schema ${version.slice(0, 3)} while a later migration is present`);
        await client.query('ROLLBACK');
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await catalog()).toEqual(headCatalog);

    await rollBackOneByOne(versions);
    expect(await catalog()).toEqual(baseCatalog);
    expect(await rows()).toEqual(baseRows);
    expect(await contextDirectorAgents()).toEqual([]);

    await applyMigrationsThrough(pool, head);
    expect(await schemaVersion()).toEqual({ migrations: head, ledger: head });
    expect(await catalog()).toEqual(headCatalog);
    expect(await directors()).toEqual(headDirectors);
    expect(await contextDirectorAgents()).toEqual(realDirector ? [] : ['context-director']);
  });

  it('removes only the source-only director 063 registered and keeps argos and its memberships', async () => {
    await pool.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES('Steven','argos','codex',false)");
    await applyMigrationsThrough(pool, head);
    const argos = (await pool.query(`SELECT to_jsonb(agent) AS agent FROM agents agent WHERE tenant_id='Steven' AND alias='argos'`)).rows;
    const argosMemberships = (await pool.query(`SELECT to_jsonb(member) AS member FROM memberships member
      WHERE tenant_id='Steven' AND alias='argos' ORDER BY room_id`)).rows;
    // A registration under 063 adds its own source-only director next to the real one of Humanizar.
    await pool.query(`SELECT * FROM cauce_register_company('second@example.test','Second','$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==',
      'second','Second')`);
    expect((await directors()).map(row => row.principal_alias)).toEqual(['argos', 'context-director']);
    const versions = await bundle();
    for (const version of [...versions].reverse().slice(0, 3)) await pool.query(await downSql(version));
    expect(await schemaVersion()).toEqual({ migrations: '062_authority_read_guard.sql', ledger: '062_authority_read_guard.sql' });
    expect((await pool.query("SELECT company_id,principal_alias FROM company_system_principals WHERE kind='director' ORDER BY 1")).rows)
      .toEqual([{ company_id: 'humanizar', principal_alias: 'argos' }]);
    expect(await contextDirectorAgents()).toEqual([]);
    expect((await pool.query("SELECT 1 FROM memberships WHERE alias LIKE 'context-director%'")).rows).toEqual([]);
    expect((await pool.query("SELECT 1 FROM role_policies WHERE role='context_broker'")).rows).toEqual([]);
    expect((await pool.query(`SELECT to_jsonb(agent) AS agent FROM agents agent WHERE tenant_id='Steven' AND alias='argos'`)).rows).toEqual(argos);
    expect((await pool.query(`SELECT to_jsonb(member) AS member FROM memberships member
      WHERE tenant_id='Steven' AND alias='argos' ORDER BY room_id`)).rows).toEqual(argosMemberships);
    await applyMigrationsThrough(pool, head);
    expect((await directors()).map(row => row.principal_alias)).toEqual(['argos', 'context-director']);
    expect(await contextDirectorAgents()).toEqual(['context-director']);
  });
});
