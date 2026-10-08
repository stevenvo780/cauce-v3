import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { applyMigrations, applyMigrationsThrough, migrationSourcesForApply, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { sha256Hex } from '@cauce/protocol';

const version = '048_ui_fleet_lifecycle.sql';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabaseThrough('046_human_client_provenance.sql');
}, 120_000, ['bundles an additive fleet lifecycle migration']);
beforeEach(async () => {
  if (!database) return;
  current = await startTestCaseDatabase(database); pool = current.pool;
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','legacy-life'),('Steven','same_alias'),('Isa','same_alias')");
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('fleet lifecycle schema', () => {
  it('bundles an additive fleet lifecycle migration', async () => {
    const sources = await migrationSourcesForApply();
    expect(sources.some((source) => source.version === version)).toBe(true);
  });
  it('preserves legacy physical names and constrains retirement admission', async () => {
    await applyMigrationsThrough(pool, version);
    const old = await pool.query<{ alias: string; runtime_key: string }>("SELECT alias,runtime_key FROM agents WHERE alias='legacy-life'");
    expect(old.rows).toEqual([{ alias: 'legacy-life', runtime_key: 'legacy-life' }]);
    const repeated = await pool.query<{ runtime_key: string }>("SELECT runtime_key FROM agents WHERE alias='same_alias'");
    expect(new Set(repeated.rows.map((agent) => agent.runtime_key)).size).toBe(2);
    await pool.query("INSERT INTO tenants(id,enabled) VALUES('LifecycleTest',false)");
    await pool.query("UPDATE tenants SET retired_at=now(),retired_enabled=false WHERE id='LifecycleTest'");
    await expect(pool.query("UPDATE tenants SET enabled=true WHERE id='LifecycleTest'")).rejects.toThrow(/retirement/u);
  });
  it('reserves physical runtime identities after logical deletion', async () => {
    await applyMigrationsThrough(pool, version);
    await pool.query("INSERT INTO agents(tenant_id,alias,runtime_key) VALUES('Steven','lifecycle_draft','lifecycle-draft')");
    await pool.query("DELETE FROM agents WHERE tenant_id='Steven' AND alias='lifecycle_draft'");
    const key = await pool.query("SELECT runtime_key FROM fleet_runtime_identities WHERE runtime_key='lifecycle-draft'");
    expect(key.rowCount).toBe(1);
    await expect(pool.query("INSERT INTO agents(tenant_id,alias,runtime_key) VALUES('Steven','other_draft','lifecycle-draft')")).rejects.toThrow();
  });
  it('refuses destructive downgrade while fleet history is populated', async () => {
    await applyMigrationsThrough(pool, version);
    await pool.query("INSERT INTO agents(tenant_id,alias,runtime_key) VALUES('Steven','new_history','new-history')");
    const down = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
    await expect(pool.query(down)).rejects.toThrow(/preserves fleet history/u);
  });
  it('resolves collisions between a derived key and an existing legacy alias without renaming the legacy runtime', async () => {
    const legacy = `a-b-${sha256Hex('Steven/a_b').slice(0, 16)}`;
    await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','a_b'),('Isa',$1)", [legacy]);
    await applyMigrationsThrough(pool, version);
    const result = await pool.query<{ alias: string; runtime_key: string }>('SELECT alias,runtime_key FROM agents WHERE alias=ANY($1::text[])', [['a_b', legacy]]);
    expect(result.rows.find((row) => row.alias === legacy)?.runtime_key).toBe(legacy);
    expect(new Set(result.rows.map((row) => row.runtime_key)).size).toBe(2);
  });
  it.each(['primary_room_id', 'lifecycle_state', 'runtime_mode', 'systemd_user'] as const)('preserves explicit baseline changes to %s on downgrade', async (field) => {
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('baseline-other','Steven')");
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias) VALUES('Steven','baseline-other','legacy-life')");
    await applyMigrationsThrough(pool, version);
    if (field === 'primary_room_id') {
      await pool.query("UPDATE agents SET primary_room_id=NULL WHERE alias='legacy-life'");
    } else {
      const value = field === 'lifecycle_state' ? 'failed' : field === 'runtime_mode' ? 'native' : 'stev';
      await pool.query(`UPDATE agents SET ${field}=$1 WHERE alias='legacy-life'`, [value]);
    }
    const down = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
    await expect(pool.query(down)).rejects.toThrow(/preserves fleet history/u);
  });
  it('refuses downgrade after a real later migration without changing the schema ledger', async () => {
    await applyMigrations(pool);
    const before = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    const down = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
    await expect(pool.query(down)).rejects.toThrow(/cannot downgrade schema 048 while a later migration is present/u);
    expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual(before.rows);
  });
  it('permits an intact baseline downgrade and can apply the additive schema again', async () => {
    await applyMigrationsThrough(pool, version);
    const down = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
    await pool.query(down);
    expect((await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version])).rowCount).toBe(0);
    await applyMigrationsThrough(pool, version);
    expect((await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version])).rowCount).toBe(1);
  });
});
