import { preparePostgresSuite } from './postgres-suite.js';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyMigrations,
  expectedLegacy024SchemaSha256,
  inspectMigrationIntegrity,
  migrationSourcesForApply,
  type DatabasePool,
} from '@cauce/store';
import {
  startEmptyTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const version024 = '024_agent_role_templates.sql';
const version028 = '028_canonical_agent_role.sql';
let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('migration source integrity', () => {
  it('derives the 024 contract from a clean database applying exactly through 024', async () => {
    const cleanDatabase = await startEmptyTestDatabase(database.url);
    const cleanPool = cleanDatabase.pool;
    try {
      const through024 = (await migrationSourcesForApply())
        .filter((migration) => migration.version <= version024);
      expect(through024.at(-1)?.version).toBe(version024);
      expect(through024.some((migration) => migration.version > version024)).toBe(false);
      for (const migration of through024) {
        await cleanPool.query(migration.source);
        await cleanPool.query(
          'INSERT INTO schema_migrations(version) VALUES ($1) ON CONFLICT DO NOTHING',
          [migration.version],
        );
      }

      const report = await cleanPool.connect().then(async (client) => {
        try {
          return await inspectMigrationIntegrity(client);
        } finally {
          client.release();
        }
      });
      expect(report.entries.find((entry) => entry.version === version024)).toMatchObject({
        applied: true,
        sourceOrigin: 'undetermined',
        verificationMethod: 'structural-equivalence-v1',
        observedSchemaSha256: expectedLegacy024SchemaSha256,
      });

      await cleanPool.query('DROP INDEX agents_role_template_idx');
      await expect(cleanPool.connect().then(async (client) => {
        try {
          return await inspectMigrationIntegrity(client);
        } finally {
          client.release();
        }
      })).rejects.toThrow(/024_agent_role_templates.*fingerprint mismatch/u);
    } finally {
      await cleanDatabase.close();
    }
  }, 120_000);

  it('fails closed on legacy drift and partial ledgers, then retries without inventing source origin', async () => {
    const ledger = await pool.query<{ version: string; source_sha256: string }>(
      `SELECT version,source_sha256 FROM schema_migration_ledger ORDER BY version`,
    );
    const applied = await pool.query<{ count: string }>('SELECT count(*)::text AS count FROM schema_migrations');
    expect(ledger.rows).toHaveLength(Number(applied.rows[0]?.count));

    // Reproduce production's legacy 024: the version name exists but there is no atomic ledger.
    await pool.query('DELETE FROM schema_migration_ledger WHERE version=$1', [version024]);
    await pool.query('DROP INDEX agents_role_template_idx');
    await expect(applyMigrations(pool)).rejects.toThrow(/024_agent_role_templates.*fingerprint mismatch/u);
    const initialVerification = await pool.query<{ source_origin: string }>(
      'SELECT source_origin FROM schema_migration_verifications WHERE version=$1',
      [version024],
    );
    expect(initialVerification.rows).toHaveLength(0);

    // A repaired exact object permits a retry. It records equivalence and explicitly keeps
    // provenance undetermined; it never backfills the atomic ledger for the legacy row.
    await pool.query(
      `CREATE INDEX agents_role_template_idx
         ON agents (role_template_slug) WHERE role_template_slug IS NOT NULL`,
    );
    await expect(applyMigrations(pool)).resolves.toBeUndefined();
    const verification = await pool.query<{
      source_origin: string;
      verification_method: string;
      bundled_source_sha256: string;
      observed_schema_sha256: string;
    }>(
      `SELECT source_origin,verification_method,bundled_source_sha256,observed_schema_sha256
         FROM schema_migration_verifications WHERE version=$1`,
      [version024],
    );
    expect(verification.rows).toEqual([
      expect.objectContaining({
        source_origin: 'undetermined',
        verification_method: 'structural-equivalence-v1',
      }),
    ]);
    expect(verification.rows[0]?.bundled_source_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(verification.rows[0]?.observed_schema_sha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(await pool.query('SELECT 1 FROM schema_migration_ledger WHERE version=$1', [version024]))
      .toMatchObject({ rows: [] });

    // A dependent migration applied only by name is not grandfathered: ledger absence is fatal.
    const exact028 = ledger.rows.find((row) => row.version === version028)?.source_sha256;
    expect(exact028).toMatch(/^[a-f0-9]{64}$/u);
    await pool.query('DELETE FROM schema_migration_ledger WHERE version=$1', [version028]);
    await expect(applyMigrations(pool)).rejects.toThrow(/028_canonical_agent_role.*without an atomic source ledger/u);

    await pool.query(
      `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
       VALUES ($1,$2,'applied-atomically')`,
      [version028, exact028],
    );
    await pool.query(
      `UPDATE schema_migration_ledger SET source_sha256=$2 WHERE version=$1`,
      [version028, '0'.repeat(64)],
    );
    await expect(applyMigrations(pool)).rejects.toThrow(/028_canonical_agent_role.*differs from its atomic ledger/u);
    await pool.query(
      `UPDATE schema_migration_ledger SET source_sha256=$2 WHERE version=$1`,
      [version028, exact028],
    );

    // Existing verification evidence never masks later object deletion: every retry remeasures.
    await pool.query('DROP TRIGGER agents_role_template_coherence ON agents');
    await expect(applyMigrations(pool)).rejects.toThrow(/024_agent_role_templates.*fingerprint mismatch/u);
    await pool.query(
      `CREATE TRIGGER agents_role_template_coherence
       BEFORE INSERT OR UPDATE ON agents
       FOR EACH ROW EXECUTE FUNCTION cauce_agents_role_template_coherence()`,
    );
    await expect(applyMigrations(pool)).resolves.toBeUndefined();

    const report = await pool.connect().then(async (client) => {
      try {
        return await inspectMigrationIntegrity(client);
      } finally {
        client.release();
      }
    });
    const legacy = report.entries.find((entry) => entry.version === version024);
    expect(legacy).toMatchObject({
      applied: true,
      sourceOrigin: 'undetermined',
      verificationMethod: 'structural-equivalence-v1',
    });
    const source024 = await readFile(
      new URL('../migrations/024_agent_role_templates.sql', import.meta.url),
      'utf8',
    );
    expect(legacy?.sourceSha256).toBe(sha256(source024));
  }, 120_000);
});
