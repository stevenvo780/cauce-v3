import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyMigrations, applyMigrationsThrough, migrationSourcesForApply, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import {
  startEmptyTestDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const version043 = '043_blob_tenant_entitlements.sql';
const version044 = '044_human_mcp_identity.sql';
const version045 = '045_mcp_oauth_authorization.sql';
const version046 = '046_human_client_provenance.sql';
const laterVersions = ['047_agent_preferences.sql', '048_ui_fleet_lifecycle.sql', '049_ui_execution_preferences.sql', '050_fleet_hosts.sql', '051_companies.sql'];
const preferenceTables = ['console_agent_favorites', 'agent_appearances'];
const provenanceTables = [
  'human_oauth_client_delegations',
  'human_message_client_provenance',
  'human_client_delegation_operations',
];
const oauthTables = ['cauce_oauth_requests', 'cauce_oauth_grants', 'cauce_oauth_codes',
  'cauce_oauth_tokens', 'cauce_oauth_refresh_tokens', 'cauce_oauth_grant_revocations', 'cauce_oauth_clients'];
let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  console.info(
    `[testcontainers] owned migration-through container name=${database.container.getName()} ` +
    `id=${database.container.getId()}`,
  );
}, 120_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('bounded migration runner', () => {
  it('refuses a historical cutoff on a head database without changing its schema or ledgers', async () => {
    const before = await pool.query<{ version: string; source_sha256: string; source_origin: string }>(
      `SELECT migration.version,ledger.source_sha256,ledger.source_origin
         FROM schema_migrations migration
         JOIN schema_migration_ledger ledger USING(version)
        ORDER BY migration.version`,
    );
    const sources = await migrationSourcesForApply();
    expect(before.rows.map((row) => row.version)).toEqual(sources.map((source) => source.version));
    expect(before.rows.at(-1)?.version).toBe(laterVersions.at(-1));
    const tablesBefore = await pool.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );

    await expect(applyMigrationsThrough(pool, '999_unbundled_cutoff.sql')).rejects.toThrow(
      'migration cutoff is not bundled: 999_unbundled_cutoff.sql',
    );
    await expect(applyMigrationsThrough(pool, version043)).rejects.toThrow(
      /later migration is already applied: 044_human_mcp_identity[.]sql/u,
    );

    await expect(applyMigrationsThrough(pool, version044)).rejects.toThrow(
      /later migration is already applied: 045_mcp_oauth_authorization[.]sql/u,
    );
    await expect(applyMigrationsThrough(pool, version045)).rejects.toThrow(
      /later migration is already applied: 046_human_client_provenance[.]sql/u,
    );
    await expect(applyMigrationsThrough(pool, version046)).rejects.toThrow(
      /later migration is already applied: 047_agent_preferences[.]sql/u,
    );

    const after = await pool.query<{ version: string; source_sha256: string; source_origin: string }>(
      `SELECT migration.version,ledger.source_sha256,ledger.source_origin
         FROM schema_migrations migration
         JOIN schema_migration_ledger ledger USING(version)
        ORDER BY migration.version`,
    );
    const tablesAfter = await pool.query<{ name: string }>(
      `SELECT tablename AS name FROM pg_tables WHERE schemaname='public' ORDER BY tablename`,
    );
    expect(after.rows).toEqual(before.rows);
    expect(tablesAfter.rows).toEqual(tablesBefore.rows);
  });

  it('creates only the requested prefix, then default apply reaches the latest bundled schema', async () => {
    const historical: EmptyTestDatabase = await startEmptyTestDatabase(database.url);
    try {
      await applyMigrationsThrough(historical.pool, version043);
      const sources = await migrationSourcesForApply();
      const cutoffIndex = sources.findIndex((migration) => migration.version === version043);
      expect(cutoffIndex).toBeGreaterThanOrEqual(0);
      const prefix = sources.slice(0, cutoffIndex + 1);
      expect(sources.slice(cutoffIndex + 1).map((migration) => migration.version)).toEqual([
        version044, version045, version046, ...laterVersions,
      ]);
      const versions = await historical.pool.query<{ version: string }>(
        'SELECT version FROM schema_migrations ORDER BY version',
      );
      expect(versions.rows.at(-1)?.version).toBe(version043);
      expect(versions.rows.map((row) => row.version)).toEqual(prefix.map((source) => source.version));
      expect(await relationExists(historical.pool, 'human_tenant_memberships')).toBe(false);
      for (const table of oauthTables) expect(await relationExists(historical.pool, table)).toBe(false);
      for (const table of provenanceTables) expect(await relationExists(historical.pool, table)).toBe(false);
      for (const table of preferenceTables) expect(await relationExists(historical.pool, table)).toBe(false);
      await expectExactLedger(historical.pool, prefix);

      const humanId = randomUUID();
      const alias = `cutoff_${humanId.slice(0, 8)}`;
      await historical.pool.query('INSERT INTO agents(tenant_id,alias) VALUES($1,$2)', ['Steven', alias]);
      await historical.pool.query(
        `INSERT INTO console_users
          (id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
         VALUES($1,$2,$2,$3,'Migration fixture','operator','Steven',$4,true)`,
        [humanId, `${humanId}@example.invalid`, `$scrypt$${'x'.repeat(40)}`, alias],
      );

      await applyMigrations(historical.pool);
      await expectExactLedger(historical.pool, sources);

      const finalVersion = await historical.pool.query<{ version: string }>(
        `SELECT version FROM schema_migrations WHERE version=ANY($1::text[]) ORDER BY version`,
        [[version044, version045, version046, ...laterVersions]],
      );
      expect(finalVersion.rows).toEqual([
        { version: version044 }, { version: version045 }, { version: version046 },
        ...laterVersions.map((version) => ({ version })),
      ]);
      for (const table of oauthTables) expect(await relationExists(historical.pool, table)).toBe(true);
      for (const table of provenanceTables) expect(await relationExists(historical.pool, table)).toBe(true);
      for (const table of preferenceTables) expect(await relationExists(historical.pool, table)).toBe(true);
      const membership = await historical.pool.query<{
        human_id: string; tenant_id: string; actor_alias: string; role: string; permissions: string[];
      }>(
        `SELECT human_id,tenant_id,actor_alias,role,permissions
           FROM human_tenant_memberships WHERE human_id=$1`, [humanId],
      );
      expect(membership.rows).toEqual([{
        human_id: humanId, tenant_id: 'Steven', actor_alias: alias, role: 'operator',
        permissions: ['route', 'read', 'control', 'notify'],
      }]);
      const scopes = await historical.pool.query<{ scopes: string[] }>(
        "SELECT ARRAY['cauce.read','cauce.publish']::cauce_oauth_scopes AS scopes",
      );
      expect(scopes.rows[0]?.scopes).toEqual(['cauce.read', 'cauce.publish']);
      await expect(historical.pool.query(
        "SELECT ARRAY['unknown']::cauce_oauth_scopes",
      )).rejects.toThrow(/cauce_oauth_scopes_check/u);
      const changed = await historical.pool.query<{ revision: string }>(
        `UPDATE human_tenant_memberships SET permissions=ARRAY['read']
          WHERE human_id=$1 RETURNING revision::text`, [humanId],
      );
      expect(changed.rows).toEqual([{ revision: '2' }]);
      await expect(historical.pool.query(
        'UPDATE human_tenant_memberships SET revision=1 WHERE human_id=$1', [humanId],
      )).rejects.toThrow('Human identity revision cannot decrease');
    } finally {
      await historical.close();
    }
  });
});

async function relationExists(targetPool: DatabasePool, name: string): Promise<boolean> {
  const result = await targetPool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists', [`public.${name}`],
  );
  return result.rows[0]?.exists === true;
}

async function expectExactLedger(
  targetPool: DatabasePool,
  sources: Awaited<ReturnType<typeof migrationSourcesForApply>>,
): Promise<void> {
  const result = await targetPool.query<{
    version: string; source_sha256: string; source_origin: string;
  }>(
    `SELECT migration.version,ledger.source_sha256,ledger.source_origin
       FROM schema_migrations migration
       JOIN schema_migration_ledger ledger USING(version)
      ORDER BY migration.version`,
  );
  expect(result.rows).toEqual(sources.map((migration) => ({
    version: migration.version,
    source_sha256: migration.sourceSha256,
    source_origin: 'applied-atomically',
  })));
}
