import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, migrationSourcesForApply, registerCompany, type DatabasePool, type RegisteredCompany } from '../src/index.js';
import { closeTestDatabase, startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase,
  type TestDatabase } from '../../../tests/helpers/postgres.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';

const version = '079_host_enrollment_compatibility.sql';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let north: RegisteredCompany;
let south: RegisteredCompany;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('078_authority_lock_scope.sql'); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(requireValue(database, 'database')); pool = current.adminPool;
  const passwordHash = '$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==';
  north = await registerCompany(current.pool, { email: 'north@example.test', name: 'North', passwordHash, company: { slug: 'north', name: 'North' } });
  south = await registerCompany(current.pool, { email: 'south@example.test', name: 'South', passwordHash, company: { slug: 'south', name: 'South' } });
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { await closeTestDatabase(database); });
async function down() { return readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'); }
async function invitation(company = north, displayName = 'Computer', notes = '') {
  return requireValue((await pool.query<{ id: string }>(`INSERT INTO fleet_host_enrollments
    (company_id,host_id,display_name,notes,invited_by,token_hash,nonce,expires_at)
    VALUES($1,'shared-host',$2,$3,$4,encode(gen_random_bytes(32),'hex'),encode(gen_random_bytes(32),'hex'),now()+interval '10 minutes') RETURNING id`,
  [company.company.id, displayName, notes, company.user.id])).rows[0], 'invitation').id;
}
async function markers() {
  return (await pool.query<{ version: string }>(`SELECT version FROM schema_migrations WHERE version=$1
    UNION ALL SELECT version FROM schema_migration_ledger WHERE version=$1`, [version])).rows;
}

describe('host enrollment compatibility migration', () => {
  it('aligns database metadata limits while retaining existing invitations and isolates pending uniqueness by company', async () => {
    const id = await invitation(north, 'n'.repeat(80), 'x'.repeat(500));
    const before = (await pool.query('SELECT * FROM fleet_host_enrollments WHERE id=$1', [id])).rows;
    await applyMigrationsThrough(pool, version);
    expect((await pool.query('SELECT * FROM fleet_host_enrollments WHERE id=$1', [id])).rows).toEqual(before);
    await expect(invitation(north)).rejects.toMatchObject({ code: '23505' });
    await expect(invitation(south, 'n'.repeat(81))).rejects.toMatchObject({ code: '23514' });
    await expect(invitation(south, 'Valid', 'x'.repeat(501))).rejects.toMatchObject({ code: '23514' });
    await expect(invitation(south)).resolves.toBeTypeOf('string');
    expect((await pool.query('SELECT company_id FROM fleet_host_enrollments ORDER BY company_id')).rows)
      .toEqual([{ company_id: 'north' }, { company_id: 'south' }]);
  });

  it.each([['n'.repeat(81), ''], ['Valid', 'x'.repeat(501)], [' ', '']])(
    'refuses incompatible legacy metadata without truncating or deleting it', async (name, notes) => {
      await invitation(north, name, notes);
      const before = (await pool.query('SELECT * FROM fleet_host_enrollments')).rows;
      await expect(applyMigrationsThrough(pool, version)).rejects.toThrow('resolve host invitations exceeding fleet host limits');
      expect((await pool.query('SELECT * FROM fleet_host_enrollments')).rows).toEqual(before);
      expect(await markers()).toEqual([]);
      expect((await pool.query("SELECT to_regclass('fleet_host_enrollments_pending_host') IS NOT NULL AS present")).rows).toEqual([{ present: true }]);
    });

  it('binds the rollback to the exact atomic up hash and rejects later or inconsistent ledger state', async () => {
    await applyMigrationsThrough(pool, version);
    const source = requireValue((await migrationSourcesForApply()).find(value => value.version === version), '079 migration');
    const rollback = await down();
    expect(rollback).toContain(source.sourceSha256);
    expect((await pool.query('SELECT source_sha256,source_origin FROM schema_migration_ledger WHERE version=$1', [version])).rows)
      .toEqual([{ source_sha256: source.sourceSha256, source_origin: 'applied-atomically' }]);
    const client = await pool.connect();
    try {
      for (const [statement, message] of [
        ["INSERT INTO schema_migrations(version) VALUES('080_later.sql')", 'later migration is present'],
        ["ALTER TABLE schema_migration_ledger DROP CONSTRAINT schema_migration_ledger_version_fkey; INSERT INTO schema_migration_ledger(version,source_sha256,source_origin) VALUES('080_later.sql',repeat('0',64),'applied-atomically')", 'later migration is present'],
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
    expect(await markers()).toEqual([{ version }, { version }]);
  });

  it('refuses rollback with cross-company pending collisions and preserves both invitations', async () => {
    await applyMigrationsThrough(pool, version); await invitation(north); await invitation(south);
    const before = (await pool.query('SELECT * FROM fleet_host_enrollments ORDER BY company_id')).rows;
    await expect(pool.query(await down())).rejects.toThrow('resolve cross-company pending host invitations before reverting');
    expect((await pool.query('SELECT * FROM fleet_host_enrollments ORDER BY company_id')).rows).toEqual(before);
    expect(await markers()).toEqual([{ version }, { version }]);
  });

  it('preserves compatible rows through down/up and restores both metadata limits and global uniqueness', async () => {
    const id = await invitation(); await applyMigrationsThrough(pool, version);
    const before = (await pool.query('SELECT * FROM fleet_host_enrollments WHERE id=$1', [id])).rows;
    await pool.query(await down());
    expect(await markers()).toEqual([]);
    expect((await pool.query('SELECT * FROM fleet_host_enrollments WHERE id=$1', [id])).rows).toEqual(before);
    await expect(invitation(south)).rejects.toMatchObject({ code: '23505' });
    await pool.query('UPDATE fleet_host_enrollments SET display_name=$2,notes=$3 WHERE id=$1', [id, 'n'.repeat(120), 'x'.repeat(2000)]);
    await pool.query('UPDATE fleet_host_enrollments SET display_name=$2,notes=$3 WHERE id=$1', [id, 'Computer', '']);
    await applyMigrationsThrough(pool, version);
    expect((await pool.query('SELECT * FROM fleet_host_enrollments WHERE id=$1', [id])).rows).toEqual(before);
    expect(await markers()).toEqual([{ version }, { version }]);
  });

  it('holds both advisory locks during rollback and restores the caller lock timeout', async () => {
    await applyMigrationsThrough(pool, version);
    const client = await pool.connect(); const observer = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='1234ms'"); await client.query(await down());
      expect((await client.query('SHOW lock_timeout')).rows).toEqual([{ lock_timeout: '1234ms' }]);
      expect((await observer.query('SELECT pg_try_advisory_xact_lock(783003003) AS global,pg_try_advisory_xact_lock(783003079) AS migration')).rows)
        .toEqual([{ global: false, migration: false }]);
    } finally { await client.query('ROLLBACK'); client.release(); observer.release(); }
  });

  it('bounds rollback table-lock waits without changing the schema or ledger', async () => {
    await applyMigrationsThrough(pool, version);
    const holder = await pool.connect(); const rollback = await down();
    try {
      await holder.query('BEGIN'); await holder.query('SELECT count(*) FROM fleet_host_enrollments');
      const started = Date.now();
      await expect(pool.query(rollback)).rejects.toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await markers()).toEqual([{ version }, { version }]);
    expect((await pool.query("SELECT to_regclass('fleet_host_enrollments_pending_company_host') IS NOT NULL AS present")).rows).toEqual([{ present: true }]);
  });
});
