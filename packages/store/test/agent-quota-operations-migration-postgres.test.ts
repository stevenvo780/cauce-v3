import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, migrationLockFootprints, migrationLockModes, migrationSourcesForApply,
  type MigrationLockMode } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestDatabaseThrough, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';

let database: TestDatabase | undefined;
const version = '070_agent_quota_operations.sql';
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('069_diagnostic_frontier_indexes.sql'); }, 120_000);
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
describe('agent quota operations migration', () => {
  it('measures the exact locks and reverses then reapplies the new durable tables', async () => {
    const pool = requireValue(database, 'database').adminPool;
    const source = requireValue((await migrationSourcesForApply()).find(value => value.version === version), '070 migration');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("CREATE TEMP TABLE before_quota_migration ON COMMIT DROP AS SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace");
      await client.query(source.source);
      const held = await client.query<{ relation: string; mode: string }>(`SELECT COALESCE(owner.relname,c.relname) AS relation,
        upper(regexp_replace(regexp_replace(l.mode,'Lock$',''),'([a-z])([A-Z])','\\1 \\2','g')) AS mode
        FROM pg_locks l JOIN pg_class c ON c.oid=l.relation LEFT JOIN pg_index i ON i.indexrelid=c.oid
        LEFT JOIN pg_class owner ON owner.oid=i.indrelid WHERE l.pid=pg_backend_pid() AND l.locktype='relation' AND l.granted
          AND l.relation IN (SELECT oid FROM before_quota_migration)`);
      const footprint: Record<string, MigrationLockMode> = {};
      for (const lock of held.rows) {
        const rank = (migrationLockModes as readonly string[]).indexOf(lock.mode); if (rank < 0) continue;
        const previous = footprint[lock.relation];
        if (previous === undefined || migrationLockModes.indexOf(previous) < rank) footprint[lock.relation] = lock.mode as MigrationLockMode;
      }
      expect(footprint).toEqual(migrationLockFootprints[version]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    await applyMigrationsThrough(pool, version);
    expect((await pool.query("SELECT to_regclass('agent_quota_operations') AS operations,to_regclass('agent_quota_observations') AS observations")).rows)
      .toEqual([{ operations: 'agent_quota_operations', observations: 'agent_quota_observations' }]);
    await pool.query(await readFile(new URL('../migrations/down/070_agent_quota_operations.sql', import.meta.url), 'utf8'));
    expect((await pool.query("SELECT to_regclass('agent_quota_operations') AS operations,to_regclass('agent_quota_observations') AS observations")).rows)
      .toEqual([{ operations: null, observations: null }]);
    await applyMigrationsThrough(pool, version);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([{ version }]);
  }, 120_000);
});
