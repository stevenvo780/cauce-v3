import { preparePostgresSuite } from './postgres-suite.js';
import { readFile } from 'node:fs/promises';
import { requireValue } from './helpers.js';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrationsThrough, inspectMigrationIntegrity, migrationSourcesForApply, type DatabasePool,
} from '../src/index.js';
import {
  startTestCaseDatabase, startTestDatabaseThrough,
  type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const downPath = new URL('../migrations/down/031_connection_session_fencing.sql', import.meta.url);
const version031 = '031_connection_session_fencing.sql';
const version032 = '032_terminal_session_claim_fencing.sql';
let appliedThrough: string;
let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let current: EmptyTestDatabase | undefined;
let down: string;

preparePostgresSuite(import.meta.url, async () => {
  down = await readFile(downPath, 'utf8');
  database = await startTestDatabaseThrough(version031);
  databaseStarted = true;
  console.info(`[testcontainers] owned schema031-fencing container id=${database.container.getId()}`);
}, 120_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await database.pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  current = await startTestCaseDatabase(database);
  pool = current.pool;
  appliedThrough = version031;
});

afterEach(async () => {
  if (!current) return;
  try {
    const client = await pool.connect();
    try {
      const integrity = await inspectMigrationIntegrity(client);
      const sources = await migrationSourcesForApply();
      for (const source of sources) {
        const applied = source.version <= appliedThrough;
        expect(integrity.entries.find((entry) => entry.version === source.version)).toMatchObject({
          version: source.version, applied,
          sourceOrigin: applied ? 'applied-atomically' : 'pending',
          verificationMethod: applied ? 'atomic-ledger-v1' : 'not-applied',
        });
      }
    } finally {
      client.release();
    }
  } finally {
    await current.close();
    current = undefined;
  }
});

async function seedLease(alias: string): Promise<string> {
  await pool.query(
    `INSERT INTO tenants(id,display_name) VALUES('Steven','Steven') ON CONFLICT DO NOTHING`,
  );
  const result = await pool.query<{ connection_token: string }>(
    `INSERT INTO connection_leases(
       tenant_id,alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at
     ) VALUES('Steven',$1,'instance',1,'[]'::jsonb,now()+interval '1 minute',now(),now())
     RETURNING connection_token::text`,
    [alias],
  );
  return requireValue(result.rows[0], 'result.rows').connection_token;
}

async function seedLegacyLease(alias: string): Promise<void> {
  await pool.query(
    `INSERT INTO connection_leases(
       tenant_id,alias,instance_id,epoch,capabilities,lease_until,last_heartbeat_at,connected_at
     ) VALUES('Steven',$1,'instance',1,'[]'::jsonb,now()+interval '1 minute',now(),now())`,
    [alias],
  );
}

describe('migration 031 connection session fencing', () => {
  it('backfills a non-null opaque token and defaults a distinct token for every new lease', async () => {
    const first = await seedLease('first');
    const second = await seedLease('second');

    expect(first).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).toMatch(/^[0-9a-f-]{36}$/u);
    expect(second).not.toBe(first);
    const column = await pool.query<{ nullable: string; default_value: string | null }>(
      `SELECT is_nullable AS nullable,column_default AS default_value
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='connection_leases'
          AND column_name='connection_token'`,
    );
    expect(column.rows[0]?.nullable).toBe('NO');
    expect(column.rows[0]?.default_value).toContain('gen_random_uuid');
  });

  it('round-trips down/up before later migrations and keeps existing leases fenced', async () => {
    await pool.query(down);
    const absent = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='connection_leases'
            AND column_name='connection_token'
       ) AS exists`,
    );
    expect(absent.rows[0]?.exists).toBe(false);

    await seedLegacyLease('pre-031');
    await applyMigrationsThrough(pool, version031);
    const restored = await pool.query<{ token_present: boolean }>(
      `SELECT connection_token IS NOT NULL AS token_present
         FROM connection_leases WHERE tenant_id='Steven' AND alias='pre-031'`,
    );
    expect(restored.rows[0]?.token_present).toBe(true);
  });

  it('refuses downgrade while a later migration is recorded and leaves schema intact', async () => {
    await applyMigrationsThrough(pool, version032);
    appliedThrough = version032;
    const before = await pool.query('SELECT version FROM schema_migrations ORDER BY version');
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    const stillPresent = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='connection_leases'
            AND column_name='connection_token'
       ) AS exists`,
    );
    expect(stillPresent.rows[0]?.exists).toBe(true);
    expect((await pool.query('SELECT version FROM schema_migrations ORDER BY version')).rows).toEqual(before.rows);
  });
});
