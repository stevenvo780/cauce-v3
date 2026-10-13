import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('056_company_office.sql'); });
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.adminPool;
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const targets = [
  { version: '057_quota_environments.sql', previous: '056_company_office.sql', table: 'quota_environments', lock: 783_003_057 },
  { version: '060_space_backups.sql', previous: '059_host_enrollment.sql', table: 'space_backups', lock: 783_003_060 },
];
async function down(version: string): Promise<string> {
  return readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
}
async function ledger(version: string) {
  return (await pool.query<{ version: string | null; source_sha256: string | null; source_origin: string | null }>(
    `SELECT migration.version,ledger.source_sha256,ledger.source_origin FROM schema_migrations migration
    FULL JOIN schema_migration_ledger ledger USING(version) WHERE COALESCE(migration.version,ledger.version)=$1`, [version])).rows;
}
async function schema(): Promise<string[]> {
  return (await pool.query<{ line: string }>(`SELECT line FROM (
    SELECT format('column %s.%s %s %s',table_name,column_name,data_type,column_default) AS line
      FROM information_schema.columns WHERE table_schema='public'
    UNION ALL SELECT format('constraint %s %s',conname,pg_get_constraintdef(oid)) FROM pg_constraint WHERE connamespace='public'::regnamespace
    UNION ALL SELECT pg_get_indexdef(indexrelid) FROM pg_index WHERE indrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace)
  ) entries ORDER BY 1`)).rows.map(row => row.line);
}
async function rejectDown(version: string, message: string): Promise<void> {
  const before = await schema(); const records = await ledger(version);
  await expect(pool.query(await down(version))).rejects.toThrow(message);
  expect(await schema()).toEqual(before); expect(await ledger(version)).toEqual(records);
}

describe.each(targets)('safe down for $version with PostgreSQL', target => {
  it('applies, rolls back completely and reapplies with matching schema and ledger', async () => {
    await applyMigrationsThrough(pool, target.previous); const original = await schema();
    await applyMigrationsThrough(pool, target.version); const migrated = await schema(); const records = await ledger(target.version);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='300ms'");
      await client.query(await down(target.version));
      expect((await client.query<{ value: string }>("SELECT current_setting('lock_timeout') AS value")).rows[0]?.value).toBe('300ms');
      await client.query('COMMIT');
    } finally { await client.query('ROLLBACK'); client.release(); }
    expect(await schema()).toEqual(original); expect(await ledger(target.version)).toEqual([]);
    if (target.version === '060_space_backups.sql') {
      await pool.query(await down(target.version));
      expect(await schema()).toEqual(original); expect(await ledger(target.version)).toEqual([]);
    }
    await applyMigrationsThrough(pool, target.version);
    expect(await schema()).toEqual(migrated); expect(await ledger(target.version)).toEqual(records);
  });

  it.each(['schema_migrations', 'schema_migration_ledger'])('refuses a later migration present only in %s', async table => {
    await applyMigrationsThrough(pool, target.version);
    if (table === 'schema_migrations') await pool.query("INSERT INTO schema_migrations(version) VALUES('999_later.sql')");
    else {
      await pool.query('ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_version_fkey');
      await pool.query("INSERT INTO schema_migration_ledger(version,source_sha256,source_origin) VALUES('999_later.sql',repeat('a',64),'applied-atomically')");
    }
    await rejectDown(target.version, `cannot downgrade schema ${target.version.slice(0, 3)} while a later migration is present`);
  });

  it.each(['missing-migration', 'missing-ledger', 'missing-both', 'changed-hash'])('refuses an inconsistent ledger: %s', async mutation => {
    await applyMigrationsThrough(pool, target.version);
    if (mutation === 'missing-migration') await pool.query('ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_version_fkey');
    if (mutation === 'missing-migration' || mutation === 'missing-both') await pool.query('DELETE FROM schema_migrations WHERE version=$1', [target.version]);
    if (mutation === 'missing-ledger' || mutation === 'missing-both') await pool.query('DELETE FROM schema_migration_ledger WHERE version=$1', [target.version]);
    if (mutation === 'changed-hash') await pool.query("UPDATE schema_migration_ledger SET source_sha256=repeat('a',64) WHERE version=$1", [target.version]);
    await rejectDown(target.version, `cannot downgrade schema ${target.version.slice(0, 3)} from an inconsistent atomic ledger state`);
  });

  it.each(['global', 'own', 'table'])('bounds the %s lock wait and leaves the schema intact', async kind => {
    await applyMigrationsThrough(pool, target.version); const before = await schema(); const records = await ledger(target.version);
    const holder = await pool.connect(); const runner = await pool.connect();
    try {
      await holder.query('BEGIN');
      if (kind === 'table') await holder.query(`SELECT count(*) FROM ${target.table}`);
      else await holder.query('SELECT pg_advisory_xact_lock($1::bigint)', [kind === 'global' ? 783_003_003 : target.lock]);
      await runner.query('BEGIN'); await runner.query("SET LOCAL lock_timeout='200ms'");
      const started = Date.now();
      await expect(runner.query(await down(target.version))).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(3_000);
      await runner.query('ROLLBACK'); await holder.query('ROLLBACK');
      expect(await schema()).toEqual(before); expect(await ledger(target.version)).toEqual(records);
    } finally { await runner.query('ROLLBACK'); await holder.query('ROLLBACK'); runner.release(); holder.release(); }
  });
});

describe('backup rows and quota metadata preserved on rollback refusal', () => {
  it('preserves legacy quota state and history through the complete 057 up/down/up cycle', async () => {
    const collection = (await pool.query<{ id: string }>(`INSERT INTO quota_collections(host,collector_tenant,collector_alias,captured_at,schema_version)
      VALUES('legacy-quota','Steven','kant',now(),1) RETURNING id`)).rows[0];
    if (!collection) throw new Error('legacy collection absent');
    await pool.query(`INSERT INTO quota_window_samples(collection_id,host,provider,group_key,window_key,captured_at,remaining_percent,model)
      SELECT id,host,'codex','default','week',captured_at,65,'legacy-model' FROM quota_collections WHERE id=$1`, [collection.id]);
    await pool.query(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,collection_id,captured_at,remaining_percent,model)
      SELECT collector_tenant,host,'codex','default','week',id,captured_at,65,'legacy-model' FROM quota_collections WHERE id=$1`, [collection.id]);
    const observations = async () => (await pool.query<{ model: string; captured_at: Date; remaining_percent: string }>(
      `SELECT model,captured_at,remaining_percent FROM quota_window_state
      UNION ALL SELECT model,captured_at,remaining_percent FROM quota_window_samples ORDER BY 1,2,3`)).rows;
    const before = await observations(); const version = '057_quota_environments.sql';
    await applyMigrationsThrough(pool, version); await pool.query(await down(version));
    expect(await observations()).toEqual(before);
    await pool.query(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,captured_at)
      VALUES('Steven','legacy-quota','codex','default','week',now())
      ON CONFLICT (collector_tenant,host,provider,group_key,window_key) DO UPDATE SET model=quota_window_state.model`);
    await applyMigrationsThrough(pool, version);
    expect(await observations()).toEqual(before);
  });

  it.each(['pending', 'running', 'ready', 'failed'])('refuses to erase a %s backup including expired rows', async status => {
    const version = '060_space_backups.sql'; await applyMigrationsThrough(pool, version);
    await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','backup-worker')");
    const human = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES('backup@example.invalid','backup@example.invalid',$1,'Backup fixture','operator','Steven','backup-worker') RETURNING id`,
    ['$scrypt$' + 'x'.repeat(48)])).rows[0];
    if (!human) throw new Error('backup requester absent');
    await pool.query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('backup-host','Backup host','humanizar')");
    await pool.query(`INSERT INTO space_backups(company_id,tenant_id,alias,host_id,requested_by,idempotency_key,agent_snapshot,policy_sha256,
      status,received_bytes,bytes,sha256,manifest_sha256,expires_at)
      VALUES('humanizar','Steven','backup-worker','backup-host',$1,'backup-rollback','{}',repeat('a',64),$2,1,1,repeat('b',64),repeat('c',64),now()-interval '1 day')`,
    [human.id, status]);
    const before = (await pool.query('SELECT * FROM space_backups')).rows;
    await rejectDown(version, 'space backups must be exported before rollback');
    expect((await pool.query('SELECT * FROM space_backups')).rows).toEqual(before);
  });

  it.each(['identity', 'canonical', 'report'])('refuses to erase quota %s metadata', async kind => {
    const version = '057_quota_environments.sql'; await applyMigrationsThrough(pool, version);
    await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref)
      VALUES('rollback-account','codex','rollback-fixture','Steven','env_path','CAUCE_TEST_ROLLBACK_PATH')`);
    if (kind === 'identity') await pool.query("UPDATE provider_accounts SET quota_identity_hash=repeat('a',64)");
    if (kind === 'canonical') await pool.query("UPDATE provider_accounts SET canonical_account_id='rollback-account'");
    if (kind === 'report') {
      const collection = (await pool.query<{ id: string }>(`INSERT INTO quota_collections(host,collector_tenant,collector_alias,captured_at,schema_version)
        VALUES('rollback-fixture','Steven','kant',now(),2) RETURNING id`)).rows[0];
      await pool.query("INSERT INTO quota_provider_reports(collection_id,provider,ok,account_id) VALUES($1,'codex',true,'rollback-account')", [collection?.id]);
    }
    const accounts = (await pool.query('SELECT * FROM provider_accounts')).rows;
    const reports = (await pool.query('SELECT * FROM quota_provider_reports')).rows;
    await rejectDown(version, 'quota environments or richer observations must be exported before rollback');
    expect((await pool.query('SELECT * FROM provider_accounts')).rows).toEqual(accounts);
    expect((await pool.query('SELECT * FROM quota_provider_reports')).rows).toEqual(reports);
  });
});
