import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, migrationLockFootprints, migrationLockModes, migrationSourcesForApply,
  type MigrationLockMode } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { closeTestDatabase, startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase,
  type TestDatabase } from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
const version = '070_agent_quota_operations.sql';
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('069_diagnostic_frontier_indexes.sql'); }, 120_000);
beforeEach(async () => { current = await startTestCaseDatabase(requireValue(database, 'database')); });
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { await closeTestDatabase(database); });
async function down() { return readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'); }
async function at070() {
  const target = requireValue(current, 'case database');
  await applyMigrationsThrough(target.adminPool, version);
  return target;
}
describe('agent quota operations migration', () => {
  it('measures the exact locks and reverses then reapplies the new durable tables', async () => {
    const pool = requireValue(current, 'case database').adminPool;
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

  it('refuses later migrations and inconsistent atomic ledgers without dropping durable tables', async () => {
    const { adminPool: pool } = await at070();
    const rollback = await down();
    const client = await pool.connect();
    try {
      for (const [statement, message] of [
        ["INSERT INTO schema_migrations(version) VALUES('071_later.sql')", 'later migration is present'],
        ["INSERT INTO schema_migrations(version) VALUES('071_later.sql'); INSERT INTO schema_migration_ledger(version,source_sha256,source_origin) VALUES('071_later.sql',repeat('0',64),'applied-atomically')", 'later migration is present'],
        [`DELETE FROM schema_migration_ledger WHERE version='${version}'`, 'atomic ledger state'],
        [`DELETE FROM schema_migrations WHERE version='${version}'`, 'atomic ledger state'],
        [`DELETE FROM schema_migrations WHERE version='${version}'; DELETE FROM schema_migration_ledger WHERE version='${version}'`, 'atomic ledger state'],
        [`UPDATE schema_migration_ledger SET source_sha256=repeat('0',64) WHERE version='${version}'`, 'atomic ledger state'],
        [`ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_source_origin_check; UPDATE schema_migration_ledger SET source_origin='legacy-unverified' WHERE version='${version}'`, 'atomic ledger state'],
      ] as const) {
        await client.query('BEGIN');
        await client.query(statement);
        await expect(client.query(rollback)).rejects.toThrow(message);
        await client.query('ROLLBACK');
      }
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    expect((await pool.query("SELECT to_regclass('agent_quota_operations') AS operations,to_regclass('agent_quota_observations') AS observations")).rows)
      .toEqual([{ operations: 'agent_quota_operations', observations: 'agent_quota_observations' }]);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([{ version }]);
  });

  it.each(['pending', 'running', 'done', 'failed'])('refuses to discard a %s durable operation', async status => {
    const target = await at070(); const pool = target.adminPool;
    const identity = requireValue((await seedSyntheticCompanyContexts(target.adminUrl))[0], 'owner');
    await pool.query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('zz-canary-quota','Quota',$1)", [identity.company_id]);
    await pool.query(`INSERT INTO agent_quota_operations(company_id,tenant_id,alias,host_id,requested_by,expected_revision,
      idempotency_key,agent_snapshot,status,claim_token,worker_id,lease_until,receipt,result)
      VALUES($1,$2,$3,'zz-canary-quota',$4,0,'zz-canary-operation','{}',$5,gen_random_uuid(),'zz_worker',now()+interval '1 minute','{}','{}')`,
    [identity.company_id, identity.tenant_id, identity.alias, identity.human_id, status]);
    const before = (await pool.query('SELECT * FROM agent_quota_operations')).rows;
    await expect(pool.query(await down())).rejects.toThrow('export agent quota operations before reverting');
    expect((await pool.query('SELECT * FROM agent_quota_operations')).rows).toEqual(before);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([{ version }]);
  });

  it('takes both advisory locks and restores the caller lock timeout after a successful rollback', async () => {
    const { adminPool: pool } = await at070();
    const client = await pool.connect(); const observer = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='1234ms'");
      await client.query(await down());
      expect((await client.query('SHOW lock_timeout')).rows).toEqual([{ lock_timeout: '1234ms' }]);
      expect((await observer.query('SELECT pg_try_advisory_xact_lock(783003003) AS global,pg_try_advisory_xact_lock(783003070) AS migration')).rows)
        .toEqual([{ global: false, migration: false }]);
    } finally { await client.query('ROLLBACK'); client.release(); observer.release(); }
  });

  it('bounds destructive table waits to five seconds without dropping rows or ledger entries', async () => {
    const { adminPool: pool } = await at070(); const reader = await pool.connect();
    try {
      await reader.query('BEGIN'); await reader.query('SELECT count(*) FROM agent_quota_operations');
      const started = Date.now();
      await expect(pool.query(await down())).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_900);
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally { await reader.query('ROLLBACK'); reader.release(); }
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([{ version }]);
    expect((await pool.query("SELECT to_regclass('agent_quota_operations') AS operations")).rows).toEqual([{ operations: 'agent_quota_operations' }]);
  });
});
