import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, migrationSourcesForApply } from '../src/index.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { closeTestDatabase, startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase,
  type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
const version = '077_agent_quota_expiry.sql';
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('073_harness_definitions_seed.sql'); }, 120_000);
beforeEach(async () => { current = await startTestCaseDatabase(requireValue(database, 'database')); });
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { await closeTestDatabase(database); });
async function down() { return readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'); }
async function at077() {
  const target = requireValue(current, 'case database');
  await applyMigrationsThrough(target.adminPool, version);
  return target;
}
async function operation(status: string, error: string | null = null) {
  const target = requireValue(current, 'case database');
  const identity = requireValue((await seedSyntheticCompanyContexts(target.adminUrl))[0], 'owner');
  await target.adminPool.query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('zz-canary-quota','Quota',$1)", [identity.company_id]);
  return requireValue((await target.adminPool.query<{ id: string }>(`INSERT INTO agent_quota_operations
    (company_id,tenant_id,alias,host_id,requested_by,expected_revision,idempotency_key,agent_snapshot,status,
      claim_token,worker_id,lease_until,receipt,result,error_code,created_at)
    VALUES($1,$2,$3,'zz-canary-quota',$4,0,'zz-canary-operation','{}',$5,
      gen_random_uuid(),'zz_worker',now()+interval '1 minute','{}','{}',$6,now()-interval '10 days') RETURNING id`,
  [identity.company_id, identity.tenant_id, identity.alias, identity.human_id, status, error])).rows[0], 'operation').id;
}
describe('agent quota expiry migration', () => {
  it('backfills a valid deadline, requires it and accepts only bounded failure codes', async () => {
    const id = await operation('pending');
    const { adminPool: pool } = await at077();
    expect((await pool.query(`SELECT id,status,expires_at>now() AND expires_at<=now()+interval '5 minutes' AS valid
      FROM agent_quota_operations WHERE id=$1`, [id])).rows).toEqual([{ id, status: 'pending', valid: true }]);
    expect((await pool.query(`SELECT is_nullable,column_default IS NOT NULL AS has_default FROM information_schema.columns
      WHERE table_schema='public' AND table_name='agent_quota_operations' AND column_name='expires_at'`)).rows)
      .toEqual([{ is_nullable: 'NO', has_default: true }]);
    await expect(pool.query('UPDATE agent_quota_operations SET expires_at=NULL WHERE id=$1', [id])).rejects.toMatchObject({ code: '23502' });
    await pool.query("UPDATE agent_quota_operations SET status='failed',error_code='EXPIRED',lease_until=NULL WHERE id=$1", [id]);
    expect((await pool.query('SELECT status,error_code FROM agent_quota_operations WHERE id=$1', [id])).rows)
      .toEqual([{ status: 'failed', error_code: 'EXPIRED' }]);
    await expect(pool.query("UPDATE agent_quota_operations SET error_code='UNBOUNDED_FAILURE' WHERE id=$1", [id]))
      .rejects.toMatchObject({ code: '23514' });
  });

  it('records the exact up hash in the atomic ledger', async () => {
    const { adminPool: pool } = await at077();
    const source = requireValue((await migrationSourcesForApply()).find(value => value.version === version), '077 migration');
    expect((await pool.query('SELECT source_sha256,source_origin FROM schema_migration_ledger WHERE version=$1', [version])).rows)
      .toEqual([{ source_sha256: source.sourceSha256, source_origin: 'applied-atomically' }]);
    expect(await down()).toContain(source.sourceSha256);
  });

  it.each([false, true])('reverses safely without the operations table when the migration is applied: %s', async applied => {
    const { adminPool: pool } = applied ? await at077() : requireValue(current, 'case database');
    await pool.query('DROP TABLE agent_quota_operations');
    await pool.query(await down());
    expect((await pool.query("SELECT to_regclass('public.agent_quota_operations') AS operations")).rows)
      .toEqual([{ operations: null }]);
    expect((await pool.query(`SELECT version FROM schema_migrations WHERE version=$1
      UNION ALL SELECT version FROM schema_migration_ledger WHERE version=$1`, [version])).rows).toEqual([]);
  });

  it('refuses later migrations and inconsistent atomic ledgers without changing the schema', async () => {
    const { adminPool: pool } = await at077();
    const rollback = await down(); const client = await pool.connect();
    try {
      for (const [statement, message] of [
        ["INSERT INTO schema_migrations(version) VALUES('078_later.sql')", 'later migration is present'],
        ["ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_version_fkey; INSERT INTO schema_migration_ledger(version,source_sha256,source_origin) VALUES('078_later.sql',repeat('0',64),'applied-atomically')", 'later migration is present'],
        ["INSERT INTO schema_migrations(version) VALUES('078_later.sql'); INSERT INTO schema_migration_ledger(version,source_sha256,source_origin) VALUES('078_later.sql',repeat('0',64),'applied-atomically')", 'later migration is present'],
        [`DELETE FROM schema_migration_ledger WHERE version='${version}'`, 'atomic ledger state'],
        [`DELETE FROM schema_migrations WHERE version='${version}'`, 'atomic ledger state'],
        [`DELETE FROM schema_migrations WHERE version='${version}'; DELETE FROM schema_migration_ledger WHERE version='${version}'`, 'atomic ledger state'],
        [`UPDATE schema_migration_ledger SET source_sha256=repeat('0',64) WHERE version='${version}'`, 'atomic ledger state'],
        [`ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_source_origin_check; UPDATE schema_migration_ledger SET source_origin='legacy-unverified' WHERE version='${version}'`, 'atomic ledger state'],
      ] as const) {
        await client.query('BEGIN'); await client.query(statement);
        await expect(client.query(rollback)).rejects.toThrow(message); await client.query('ROLLBACK');
      }
    } finally { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    expect((await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='agent_quota_operations' AND column_name='expires_at'`)).rows)
      .toEqual([{ column_name: 'expires_at' }]);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([{ version }]);
  });

  it.each(['pending', 'running'])('refuses to remove the deadline from a %s operation', async status => {
    const { adminPool: pool } = await at077(); await operation(status);
    const before = (await pool.query('SELECT * FROM agent_quota_operations')).rows;
    await expect(pool.query(await down())).rejects.toThrow('resolve active or expired agent quota operations before reverting');
    expect((await pool.query('SELECT * FROM agent_quota_operations')).rows).toEqual(before);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([{ version }]);
  });

  it('refuses an expired failure that the previous error constraint cannot represent', async () => {
    const { adminPool: pool } = await at077(); await operation('failed', 'EXPIRED');
    const before = (await pool.query('SELECT * FROM agent_quota_operations')).rows;
    await expect(pool.query(await down())).rejects.toThrow('resolve active or expired agent quota operations before reverting');
    expect((await pool.query('SELECT * FROM agent_quota_operations')).rows).toEqual(before);
    expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rows).toEqual([{ version }]);
  });

  it.each(['done', 'failed'])('preserves a compatible %s operation through rollback and reapplication', async status => {
    const { adminPool: pool } = await at077(); const id = await operation(status, status === 'failed' ? 'STEP_FAILED' : null);
    const before = (await pool.query(`SELECT id,status,error_code,receipt,result,created_at FROM agent_quota_operations WHERE id=$1`, [id])).rows;
    await pool.query(await down());
    expect((await pool.query(`SELECT id,status,error_code,receipt,result,created_at FROM agent_quota_operations WHERE id=$1`, [id])).rows).toEqual(before);
    expect((await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='agent_quota_operations' AND column_name='expires_at'`)).rows).toEqual([]);
    expect((await pool.query(`SELECT version FROM schema_migrations WHERE version=$1
      UNION ALL SELECT version FROM schema_migration_ledger WHERE version=$1`, [version])).rows).toEqual([]);
    await expect(pool.query("UPDATE agent_quota_operations SET error_code='EXPIRED' WHERE id=$1", [id])).rejects.toMatchObject({ code: '23514' });
    await applyMigrationsThrough(pool, version);
    expect((await pool.query(`SELECT id,status,error_code,receipt,result,created_at FROM agent_quota_operations WHERE id=$1`, [id])).rows).toEqual(before);
    expect((await pool.query('SELECT expires_at>now() AS valid FROM agent_quota_operations WHERE id=$1', [id])).rows).toEqual([{ valid: true }]);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([{ version }]);
  });

  it('holds both advisory locks and restores the caller timeout after rollback', async () => {
    const { adminPool: pool } = await at077(); const client = await pool.connect(); const observer = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='1234ms'"); await client.query(await down());
      expect((await client.query('SHOW lock_timeout')).rows).toEqual([{ lock_timeout: '1234ms' }]);
      expect((await observer.query('SELECT pg_try_advisory_xact_lock(783003003) AS global,pg_try_advisory_xact_lock(783003077) AS migration')).rows)
        .toEqual([{ global: false, migration: false }]);
    } finally { await client.query('ROLLBACK'); client.release(); observer.release(); }
  });

  it('bounds table-lock waits to five seconds without losing the deadline or atomic ledger', async () => {
    const { adminPool: pool } = await at077(); const reader = await pool.connect();
    try {
      await reader.query('BEGIN'); await reader.query('SELECT count(*) FROM agent_quota_operations');
      const started = Date.now(); await expect(pool.query(await down())).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeGreaterThanOrEqual(4_900); expect(Date.now() - started).toBeLessThan(8_000);
    } finally { await reader.query('ROLLBACK'); reader.release(); }
    expect((await pool.query(`SELECT column_name FROM information_schema.columns
      WHERE table_schema='public' AND table_name='agent_quota_operations' AND column_name='expires_at'`)).rows)
      .toEqual([{ column_name: 'expires_at' }]);
    expect((await pool.query(`SELECT version FROM schema_migrations WHERE version=$1
      UNION ALL SELECT version FROM schema_migration_ledger WHERE version=$1`, [version])).rows).toEqual([{ version }, { version }]);
  }, 10_000);
});
