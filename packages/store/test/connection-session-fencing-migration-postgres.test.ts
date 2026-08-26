import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations, inspectMigrationIntegrity, type DatabasePool,
} from '../src/index.js';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const upPath = new URL('../migrations/031_connection_session_fencing.sql', import.meta.url);
const downPath = new URL('../migrations/down/031_connection_session_fencing.sql', import.meta.url);
const version031 = '031_connection_session_fencing.sql';
const laterVersions = [
  '032_terminal_session_claim_fencing.sql',
  '033_terminal_browser_owner_fencing.sql',
  '034_terminal_relay_instance_fencing.sql',
  '035_agent_profile_runtime_adoption.sql',
  '036_shadow_router_target_phase.sql',
] as const;

let database: TestDatabase;
let pool: DatabasePool;
let up: string;
let down: string;
let laterDown: string[];

beforeAll(async () => {
  [up, down, laterDown] = await Promise.all([
    readFile(upPath, 'utf8'),
    readFile(downPath, 'utf8'),
    Promise.all(laterVersions.map((version) => readFile(
      new URL(`../migrations/down/${version}`, import.meta.url), 'utf8',
    ))),
  ]);
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
  // Migration 031 can only be rolled back before any later schema. Exercise that real state,
  // rather than deleting ledger rows while leaving 032-036 objects installed.
  await pool.query('TRUNCATE TABLE terminal_sessions');
  for (let index = laterVersions.length - 1; index >= 0; index -= 1) {
    const version = laterVersions[index]!;
    const recorded = await pool.query(
      'SELECT 1 FROM schema_migrations WHERE version=$1', [version],
    );
    if (recorded.rowCount === 1) await pool.query(laterDown[index]!);
  }
});

afterEach(async () => {
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  const tokenColumn = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='connection_leases'
          AND column_name='connection_token'
     ) AS exists`,
  );
  // Rebuild through the canonical migrator so the DDL, schema_migrations and atomic source
  // ledger are restored as one contract. Manual up+INSERT here used to leave 031-036 applied
  // without their source hashes, contaminating a reusable cauce_test database after a green run.
  if (tokenColumn.rows[0]?.exists === true) {
    await pool.query(down);
  } else {
    await pool.query('DELETE FROM schema_migrations WHERE version=$1', [version031]);
  }
  await applyMigrations(pool);
  const client = await pool.connect();
  try {
    const integrity = await inspectMigrationIntegrity(client);
    const latest = integrity.entries.filter((entry) => entry.version >= version031);
    const expectedVersions = [version031, ...laterVersions];
    expect(latest).toHaveLength(expectedVersions.length);
    for (const version of expectedVersions) {
      expect(latest.find((entry) => entry.version === version)).toMatchObject({
        version,
        applied: true,
        sourceOrigin: 'applied-atomically',
        verificationMethod: 'atomic-ledger-v1',
      });
    }
  } finally {
    client.release();
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
  return result.rows[0]!.connection_token;
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
    await pool.query(up);
    await pool.query(
      `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`, [version031],
    );
    const restored = await pool.query<{ token_present: boolean }>(
      `SELECT connection_token IS NOT NULL AS token_present
         FROM connection_leases WHERE tenant_id='Steven' AND alias='pre-031'`,
    );
    expect(restored.rows[0]?.token_present).toBe(true);
  });

  it('refuses downgrade while a later migration is recorded and leaves schema intact', async () => {
    await pool.query(
      `INSERT INTO schema_migrations(version) VALUES('999_future.sql') ON CONFLICT DO NOTHING`,
    );
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    const stillPresent = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='connection_leases'
            AND column_name='connection_token'
       ) AS exists`,
    );
    expect(stillPresent.rows[0]?.exists).toBe(true);
  });
});
