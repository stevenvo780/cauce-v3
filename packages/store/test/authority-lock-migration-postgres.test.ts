import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, migrationLockFootprints, withTransaction, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const version = '078_authority_lock_scope.sql';
const source = await readFile(new URL(`../migrations/${version}`, import.meta.url), 'utf8');
const down = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough(version); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  pool = current.adminPool;
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function definition(name: string): Promise<string> {
  return (await pool.query<{ body: string }>('SELECT prosrc AS body FROM pg_proc WHERE proname=$1', [name])).rows[0]?.body ?? '';
}

describe('authority lock migration', () => {
  it('restores the old guards, removes both receipts and reapplies atomically', async () => {
    await withTransaction(pool, client => client.query(down));
    expect(await definition('cauce_lock_owner_guard')).toContain('FOR NO KEY UPDATE OF admin');
    expect(await definition('cauce_lock_authority_read_guard')).toContain('FOR SHARE OF admin');
    expect(await definition('cauce_console_users_owner_guard')).not.toContain('cauce_lock_platform_owner_guard');
    expect(await definition('cauce_lock_platform_owner_guard')).toBe('');
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1 UNION ALL SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rows).toEqual([]);
    await applyMigrationsThrough(pool, version);
    expect(await definition('cauce_lock_owner_guard')).toContain('pg_advisory_xact_lock(783003055,hashtext(p_company))');
    expect(await definition('cauce_lock_authority_read_guard')).not.toContain('FOR SHARE');
    expect((await pool.query('SELECT source_sha256,source_origin FROM schema_migration_ledger WHERE version=$1', [version])).rows)
      .toEqual([{ source_sha256: createHash('sha256').update(source).digest('hex'), source_origin: 'applied-atomically' }]);
  });

  it.each(['later', 'missing', 'digest'])('refuses an unsafe down with %s receipt state', async state => {
    if (state === 'later') {
      await pool.query("INSERT INTO schema_migrations(version) VALUES('999_authority_guard.sql')");
    } else if (state === 'missing') {
      await pool.query('DELETE FROM schema_migration_ledger WHERE version=$1', [version]);
    } else {
      await pool.query("UPDATE schema_migration_ledger SET source_sha256=repeat('0',64) WHERE version=$1", [version]);
    }
    await expect(withTransaction(pool, client => client.query(down))).rejects.toMatchObject({ code: 'P0001' });
    expect(await definition('cauce_lock_platform_owner_guard')).toContain('pg_advisory_xact_lock(783003078,0)');
  });

  it('replays the helper grants and never grants execute to PUBLIC', async () => {
    await pool.query('REVOKE EXECUTE ON FUNCTION cauce_lock_platform_owner_guard() FROM cauce_runtime,cauce_platform');
    await pool.query('SELECT cauce_apply_runtime_grants()');
    expect((await pool.query<{ runtime: boolean; platform: boolean; public: boolean }>(
      `SELECT has_function_privilege('cauce_runtime','cauce_lock_platform_owner_guard()','EXECUTE') AS runtime,
        has_function_privilege('cauce_platform','cauce_lock_platform_owner_guard()','EXECUTE') AS platform,
        EXISTS(SELECT 1 FROM pg_proc p,aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) grant_row
          WHERE p.oid='cauce_lock_platform_owner_guard()'::regprocedure AND grant_row.grantee=0
            AND grant_row.privilege_type='EXECUTE') AS public`,
    )).rows).toEqual([{ runtime: true, platform: true, public: false }]);
  });

  it('measures the trigger table lock footprint during the up', async () => {
    await withTransaction(pool, client => client.query(down));
    await withTransaction(pool, async client => {
      await client.query(source);
      expect((await client.query(`SELECT relation::regclass::text AS table_name,mode FROM pg_locks WHERE pid=pg_backend_pid() AND granted
        AND locktype='relation' AND mode IN ('ShareLock','ShareRowExclusiveLock','ExclusiveLock','AccessExclusiveLock')`)).rows)
        .toEqual([{ table_name: 'platform_admins', mode: 'ShareRowExclusiveLock' }]);
    });
    expect(migrationLockFootprints[version]).toEqual({ platform_admins: 'SHARE ROW EXCLUSIVE' });
  });

  it.each(['REPEATABLE READ', 'SERIALIZABLE'])('rejects stale writer snapshots at %s isolation', async isolation => {
    const client = await pool.connect();
    try {
      await client.query(`BEGIN ISOLATION LEVEL ${isolation}`);
      await expect(client.query("SELECT cauce_lock_owner_guard('humanizar')")).rejects.toMatchObject({ code: '40001' });
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
