import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { ContextVersionStore } from '../src/context-version.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  closeTestDatabase, startEmptyTestDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const previous = '066_runtime_hardening.sql';
const version = '067_context_history_immutable.sql';
const CATALOG = `SELECT line FROM (
  SELECT format('function %s config=%s source=%s acl=%s',p.oid::regprocedure,p.proconfig,md5(p.prosrc),p.proacl) AS line
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace
  UNION ALL SELECT format('trigger %s enabled=%s %s',t.tgrelid::regclass,t.tgenabled,pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
) catalog ORDER BY line`;

let server: TestDatabase | undefined;
const opened: EmptyTestDatabase[] = [];
preparePostgresSuite(import.meta.url, async () => { server = await startTestDatabaseThrough(previous); }, 240_000);
afterAll(async () => {
  for (const database of opened.splice(0).reverse()) await database.close().catch(() => undefined);
  await closeTestDatabase(server);
});

async function at(through: string): Promise<EmptyTestDatabase> {
  if (!server) throw new Error('context history suite was not prepared');
  const database = await startEmptyTestDatabase(server.adminUrl);
  opened.push(database);
  await applyMigrationsThrough(database.adminPool, through);
  return database;
}
async function code(work: Promise<unknown>): Promise<string> {
  try { await work; return 'ok'; } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  }
}
async function catalog(pool: DatabasePool): Promise<string[]> {
  return (await pool.query<{ line: string }>(CATALOG)).rows.map(row => row.line);
}
async function history(database: EmptyTestDatabase): Promise<{ store: ContextVersionStore; write: (expected: number) => Promise<unknown>;
  source: (client: DatabaseClient) => ReturnType<typeof lockCompanyAuthority>; tenant: string; alias: string }> {
  const [target] = await seedSyntheticCompanyContexts(database.adminUrl);
  if (!target) throw new Error('synthetic company is missing');
  const store = new ContextVersionStore(database.adminPool);
  const source = (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: target.tenant_id, alias: 'owner', humanId: target.human_id });
  const write = (expected: number) => store.write(source, target.tenant_id, target.alias,
    { expected_version: expected, source: 'ui', files: [{ path: 'context/mission.md', content: `Mission ${String(expected + 1)}` }] });
  return { store, write, source, tenant: target.tenant_id, alias: target.alias };
}

describe('immutable context history', () => {
  it('refuses UPDATE, DELETE and TRUNCATE of written versions while new versions and restores still append', async () => {
    const empty = await at(version);
    expect(await code(empty.adminPool.query('TRUNCATE agent_context_versions CASCADE'))).toBe('ok');
    const database = await at(version);
    const context = await history(database);
    await context.write(0);
    const before = (await database.adminPool.query('SELECT * FROM agent_context_versions')).rows;
    for (const statement of [`UPDATE agent_context_versions SET actor_alias='forged'`,
      `UPDATE agent_context_versions SET files='[]'::jsonb,digest=repeat('0',64)`, 'DELETE FROM agent_context_versions',
      'TRUNCATE agent_context_versions CASCADE', 'TRUNCATE console_users CASCADE']) {
      expect({ [statement]: await code(database.adminPool.query(statement)) }).toEqual({ [statement]: '55000' });
    }
    expect((await database.adminPool.query('SELECT * FROM agent_context_versions')).rows).toEqual(before);
    await context.write(1);
    const restored = await context.store.restore(context.source, context.tenant, context.alias, { expected_version: 2, version: 1 });
    expect(restored).toMatchObject({ desired_version: 3 });
    expect((await database.adminPool.query<{ version: string; source: string }>(
      'SELECT version,source FROM agent_context_versions ORDER BY version')).rows)
      .toEqual([{ version: '1', source: 'ui' }, { version: '2', source: 'ui' }, { version: '3', source: 'restore' }]);
  });

  it('rolls back to the 066 catalog, makes the history writable again and reapplies the same catalog', async () => {
    const database = await at(version);
    const reference = await at(previous);
    const migrated = await catalog(database.adminPool);
    const down = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
    const context = await history(database);
    await context.write(0);
    await database.adminPool.query(down);
    expect(await catalog(database.adminPool)).toEqual(await catalog(reference.adminPool));
    expect((await database.adminPool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([]);
    expect(await code(database.adminPool.query(`UPDATE agent_context_versions SET actor_alias=actor_alias`))).toBe('ok');
    await expect(database.adminPool.query(down)).resolves.toBeDefined();
    await applyMigrationsThrough(database.adminPool, version);
    expect(await catalog(database.adminPool)).toEqual(migrated);
    expect(await code(database.adminPool.query('DELETE FROM agent_context_versions'))).toBe('55000');
  });

  it('refuses the rollback after a later migration or with an inconsistent ledger without changing the catalog', async () => {
    const database = await at(version);
    const before = await catalog(database.adminPool);
    const down = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
    const client = await database.adminPool.connect();
    try {
      for (const [statement, message] of [
        ["INSERT INTO schema_migrations(version) VALUES('068_later.sql')", 'later migration is present'],
        [`DELETE FROM schema_migration_ledger WHERE version='${version}'`, 'atomic ledger state'],
        [`UPDATE schema_migration_ledger SET source_sha256=repeat('0',64) WHERE version='${version}'`, 'atomic ledger state'],
      ] as const) {
        await client.query('BEGIN');
        await client.query(statement);
        await expect(client.query(down)).rejects.toThrow(message);
        await client.query('ROLLBACK');
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await catalog(database.adminPool)).toEqual(before);
  });
});
