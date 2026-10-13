import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, migrationSourcesForApply, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

export interface DownTarget { version: string; marker: string; kind: 'table' | 'function'; lockTable?: string }

const CATALOG = `SELECT line FROM (
  SELECT format('relation %s %s acl=%s',c.relname,c.relkind,(SELECT string_agg(format('%s:%s',
    CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,e.privilege_type),','
      ORDER BY CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,e.privilege_type)
    FROM aclexplode(COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))) e)) AS line
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f','S')
  UNION ALL SELECT format('column %s.%s %s %s %s %s %s',c.relname,a.attname,format_type(a.atttypid,a.atttypmod),
    a.attnotnull,a.attgenerated,pg_get_expr(d.adbin,d.adrelid),NULLIF(a.attacl::text,'{}'))
    FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid LEFT JOIN pg_attrdef d ON d.adrelid=a.attrelid AND d.adnum=a.attnum
    WHERE c.relnamespace='public'::regnamespace AND a.attnum>0 AND NOT a.attisdropped
  UNION ALL SELECT format('constraint %s %s %s',conrelid::regclass,conname,pg_get_constraintdef(oid))
    FROM pg_constraint WHERE connamespace='public'::regnamespace
  UNION ALL SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i JOIN pg_class c ON c.oid=i.indrelid
    WHERE c.relnamespace='public'::regnamespace
  UNION ALL SELECT format('trigger %s %s %s',t.tgrelid::regclass,t.tgenabled,pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
  UNION ALL SELECT format('function %s %s %s %s %s acl=%s',p.oid::regprocedure,p.prosecdef,p.provolatile,p.proconfig,md5(p.prosrc),
    (SELECT string_agg(format('%s:%s',CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,e.privilege_type),','
      ORDER BY CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,e.privilege_type)
      FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) e))
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT format('schema acl=%s',(SELECT string_agg(format('%s:%s',
    CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,e.privilege_type),','
      ORDER BY CASE WHEN e.grantee=0 THEN 'PUBLIC' ELSE e.grantee::regrole::text END,e.privilege_type)
    FROM aclexplode(COALESCE(n.nspacl,acldefault('n',n.nspowner))) e)) FROM pg_namespace n WHERE n.nspname='public'
) entries ORDER BY 1`;

export async function downSql(version: string): Promise<string> {
  return readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
}

export async function downSnapshot(pool: DatabasePool) {
  const catalog = (await pool.query<{ line: string }>(CATALOG)).rows.map(row => row.line);
  const ledger = (await pool.query(`SELECT COALESCE(m.version,l.version) AS version,m.version IS NOT NULL AS migration,
    l.source_sha256,l.source_origin FROM schema_migrations m FULL JOIN schema_migration_ledger l USING(version) ORDER BY 1`)).rows;
  const tables = (await pool.query<{ name: string }>(`SELECT relname AS name FROM pg_class
    WHERE relnamespace='public'::regnamespace AND relkind IN ('r','p') AND NOT relispartition
      AND relname NOT IN ('schema_migrations','schema_migration_ledger') ORDER BY 1`)).rows;
  const rows: Record<string, string[]> = {};
  for (const { name } of tables) {
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) throw new Error('unexpected table identifier');
    rows[name] = (await pool.query<{ hash: string }>(`SELECT md5(to_jsonb(entry)::text) AS hash FROM public.${name} entry ORDER BY 1`))
      .rows.map(row => row.hash);
  }
  return { catalog, ledger, rows };
}

export async function rejectDown(pool: DatabasePool, version: string, message?: string): Promise<void> {
  const before = await downSnapshot(pool);
  const attempt = pool.query(await downSql(version));
  if (message === undefined) await expect(attempt).rejects.toMatchObject({ code: 'P0001' });
  else await expect(attempt).rejects.toThrow(message);
  expect(await downSnapshot(pool)).toEqual(before);
}

async function markerExists(pool: DatabasePool, target: DownTarget): Promise<boolean> {
  const functionName = target.kind === 'table' ? 'to_regclass' : 'to_regprocedure';
  return (await pool.query<{ exists: boolean }>(`SELECT ${functionName}($1) IS NOT NULL AS exists`, [`public.${target.marker}`]))
    .rows[0]?.exists === true;
}

export function registerDownSafetyTests(sourceUrl: string, base: string, targets: readonly DownTarget[]): () => DatabasePool {
  let database: TestDatabase | undefined;
  let current: EmptyTestDatabase | undefined;
  const pool = (): DatabasePool => {
    if (!current) throw new Error('case database absent');
    return current.adminPool;
  };
  preparePostgresSuite(sourceUrl, async () => { database = await startTestDatabaseThrough(base); }, 240_000);
  beforeEach(async () => {
    if (!database) throw new Error('test database absent');
    current = await startTestCaseDatabase(database);
  });
  afterEach(async () => { await current?.close(); current = undefined; });
  afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

  describe.each(targets)('safe down for $version with PostgreSQL', target => {
    it('restores its predecessor and caller timeout, then reapplies the same catalog and ledger', async () => {
      const sources = await migrationSourcesForApply();
      const previous = sources[sources.findIndex(source => source.version === target.version) - 1]?.version;
      if (!previous) throw new Error('migration predecessor absent');
      await applyMigrationsThrough(pool(), previous);
      const original = await downSnapshot(pool());
      await applyMigrationsThrough(pool(), target.version);
      const applied = await downSnapshot(pool());
      expect(await markerExists(pool(), target)).toBe(true);
      const client = await pool().connect();
      try {
        await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='200ms'");
        await client.query(await downSql(target.version));
        expect((await client.query('SHOW lock_timeout')).rows).toEqual([{ lock_timeout: '200ms' }]);
        await client.query('COMMIT');
      } finally { await client.query('ROLLBACK'); client.release(); }
      expect(await downSnapshot(pool())).toEqual(original);
      await applyMigrationsThrough(pool(), target.version);
      const reapplied = await downSnapshot(pool());
      expect(reapplied.catalog).toEqual(applied.catalog);
      expect(reapplied.ledger).toEqual(applied.ledger);
    });

    it.each(['missing-migration', 'missing-ledger', 'missing-both', 'changed-hash', 'changed-origin', 'later-ledger'])('refuses %s without changing objects or rows', async mutation => {
      await applyMigrationsThrough(pool(), target.version);
      if (mutation === 'missing-migration') {
        await pool().query('ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_version_fkey');
        await pool().query('DELETE FROM schema_migrations WHERE version=$1', [target.version]);
      }
      if (mutation === 'missing-ledger' || mutation === 'missing-both') {
        await pool().query('DELETE FROM schema_migration_ledger WHERE version=$1', [target.version]);
      }
      if (mutation === 'missing-both') await pool().query('DELETE FROM schema_migrations WHERE version=$1', [target.version]);
      if (mutation === 'changed-hash') {
        await pool().query("UPDATE schema_migration_ledger SET source_sha256=repeat('0',64) WHERE version=$1", [target.version]);
      }
      if (mutation === 'changed-origin') {
        await pool().query('ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_source_origin_check');
        await pool().query("UPDATE schema_migration_ledger SET source_origin='legacy-unverified' WHERE version=$1", [target.version]);
      }
      if (mutation === 'later-ledger') {
        await pool().query('ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_version_fkey');
        await pool().query("INSERT INTO schema_migration_ledger(version,source_sha256,source_origin) VALUES('999_later.sql',repeat('0',64),'applied-atomically')");
      }
      expect(await markerExists(pool(), target)).toBe(true);
      const suffix = mutation === 'later-ledger' ? 'while a later migration is present' : 'from an inconsistent atomic ledger state';
      await rejectDown(pool(), target.version, `cannot downgrade schema ${target.version.slice(0, 3)} ${suffix}`);
    });

    it.each(['global', 'own', ...(target.lockTable ? ['table'] : [])])('respects a 200ms timeout behind the %s lock', async kind => {
      await applyMigrationsThrough(pool(), target.version);
      const before = await downSnapshot(pool());
      const holder = await pool().connect(); const runner = await pool().connect();
      try {
        await holder.query('BEGIN');
        if (kind === 'table') await holder.query(`SELECT count(*) FROM ${target.lockTable}`);
        else await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [kind === 'global' ? 783_003_003 : Number(`783003${target.version.slice(0, 3)}`)]);
        await runner.query('BEGIN');
        await runner.query("SET LOCAL lock_timeout='200ms'; SET LOCAL statement_timeout='3000ms'");
        const started = Date.now();
        await expect(runner.query(await downSql(target.version))).rejects.toMatchObject({ code: '55P03' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(180);
        expect(Date.now() - started).toBeLessThan(2_000);
      } finally {
        await runner.query('ROLLBACK'); await holder.query('ROLLBACK'); runner.release(); holder.release();
      }
      expect(await downSnapshot(pool())).toEqual(before);
    });
  });

  const first = targets[0];
  if (first) {
    it.each(['0', '10s'])(`caps an advisory wait to five seconds for ${first.version} when lock_timeout=%s`, async timeout => {
      await applyMigrationsThrough(pool(), first.version);
      const before = await downSnapshot(pool());
      const holder = await pool().connect(); const runner = await pool().connect();
      try {
        await holder.query('BEGIN'); await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
        await runner.query('BEGIN');
        await runner.query("SELECT set_config('lock_timeout',$1,true),set_config('statement_timeout','7s',true)", [timeout]);
        const started = Date.now();
        await expect(runner.query(await downSql(first.version))).rejects.toMatchObject({ code: '55P03' });
        expect(Date.now() - started).toBeGreaterThanOrEqual(4_800);
        expect(Date.now() - started).toBeLessThan(6_500);
      } finally {
        await runner.query('ROLLBACK'); await holder.query('ROLLBACK'); runner.release(); holder.release();
      }
      expect(await downSnapshot(pool())).toEqual(before);
    });
  }
  return pool;
}
