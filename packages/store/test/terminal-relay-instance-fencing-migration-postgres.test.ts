import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { requireValue } from './helpers.js';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { DatabaseClient, DatabasePool } from '../src/index.js';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const version = '034_terminal_relay_instance_fencing.sql';
const upPath = new URL(`../migrations/${version}`, import.meta.url);
const downPath = new URL(`../migrations/down/${version}`, import.meta.url);
const version035 = '035_agent_profile_runtime_adoption.sql';
const up035Path = new URL(`../migrations/${version035}`, import.meta.url);
const down035Path = new URL(`../migrations/down/${version035}`, import.meta.url);
const version037 = '037_console_publish_intent_indexes.sql';
const up037Path = new URL(`../migrations/${version037}`, import.meta.url);
const down037Path = new URL(`../migrations/down/${version037}`, import.meta.url);
const relayInstanceId = 'a'.repeat(64);
const relayBootId = '11111111-1111-4111-8111-111111111111';

let database: TestDatabase;
let pool: DatabasePool;
let up: string;
let down: string;
let up035: string;
let down035: string;
let up037: string;
let down037: string;

beforeAll(async () => {
  [up, down, up035, down035, up037, down037] = await Promise.all([
    readFile(upPath, 'utf8'),
    readFile(downPath, 'utf8'),
    readFile(up035Path, 'utf8'),
    readFile(down035Path, 'utf8'),
    readFile(up037Path, 'utf8'),
    readFile(down037Path, 'utf8'),
  ]);
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  await pool?.end();
  await database?.container.stop();
});

async function columnExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='terminal_sessions'
          AND column_name='relay_instance_id'
     ) AS exists`,
  );
  return result.rows[0]?.exists === true;
}

async function markApplied(): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`,
    [version],
  );
}

async function mark035Applied(): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`,
    [version035],
  );
}

async function profileLayerExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.agent_profile_runtime_expectations') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists === true;
}

async function removeLatestProfileLayer(): Promise<void> {
  if (!await profileLayerExists()) {
    await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [version035]);
    return;
  }
  await pool.query(
    `TRUNCATE TABLE agent_profile_runtime_adoptions, agent_profile_runtime_expectations`,
  );
  await pool.query(down035);
}

async function restoreLatestSchema(): Promise<void> {
  if (!await columnExists()) await pool.query(up);
  await markApplied();
  if (!await profileLayerExists()) await pool.query(up035);
  await mark035Applied();
  if (!await consolePublishIndexesExist()) await pool.query(up037);
  await markConsolePublishIndexesApplied();
}

async function markConsolePublishIndexesApplied(): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`, [version037],
  );
  await pool.query(
    `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
     VALUES($1,$2,'applied-atomically')
     ON CONFLICT(version) DO UPDATE SET
       source_sha256=EXCLUDED.source_sha256,
       source_origin=EXCLUDED.source_origin`,
    [version037, createHash('sha256').update(up037).digest('hex')],
  );
}

async function consolePublishIndexesExist(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.audit_events_console_publish_key_037_idx') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists === true;
}

async function removeLatestConsolePublishIndexes(): Promise<void> {
  if (await consolePublishIndexesExist()) await pool.query(down037);
  else await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [version037]);
}

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query('DELETE FROM terminal_sessions');
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await removeLatestConsolePublishIndexes();
  await removeLatestProfileLayer();
  if (await columnExists()) await pool.query(down);
  else await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [version]);
});

afterEach(async () => {
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await pool.query(`TRUNCATE TABLE terminal_sessions`);
  await restoreLatestSchema();
});

async function seedLegacySession(client: DatabasePool | DatabaseClient, usable: boolean): Promise<string> {
  const sid = randomUUID();
  const ticketDigest = randomBytes(32);
  await client.query(
    `INSERT INTO terminal_sessions(
       id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
       operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
       ticket_sha256,reason,issued_at,expires_at,closed_at
     ) VALUES(
       $1,$1,$2,$2,1,
       'operator',true,'Steven:kant','Steven','jarvis','jarvis','claw','shell',
       $2,'schema 034 migration test',now(),now()+interval '1 minute',
       CASE WHEN $3::boolean THEN NULL::timestamptz ELSE now() END
     )`,
    [sid, ticketDigest, usable],
  );
  return sid;
}

async function seedPinnedSession(
  client: DatabasePool | DatabaseClient,
  options: { claimed?: boolean; closed?: boolean } = {},
): Promise<string> {
  const sid = randomUUID();
  const ticketDigest = randomBytes(32);
  const claimed = options.claimed === true;
  await client.query(
    `INSERT INTO terminal_sessions(
       id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
       operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
       ticket_sha256,reason,issued_at,expires_at,consumed_at,closed_at,
       relay_claim_sha256,relay_claim_epoch,relay_claimed_at,relay_claim_expires_at,
       relay_instance_id,relay_boot_id
     ) VALUES(
       $1,$1,$2,$2,1,
       'operator',true,'Steven:kant','Steven','jarvis','jarvis','claw','shell',
       $2,'schema 034 pinned test',now(),now()+interval '1 minute',
       CASE WHEN $3::boolean THEN now() ELSE NULL::timestamptz END,
       CASE WHEN $4::boolean THEN now() ELSE NULL::timestamptz END,
       CASE WHEN $3::boolean THEN $5::bytea ELSE NULL::bytea END,
       CASE WHEN $3::boolean THEN 1::bigint ELSE 0::bigint END,
       CASE WHEN $3::boolean THEN now() ELSE NULL::timestamptz END,
       CASE WHEN $3::boolean THEN now()+interval '30 seconds' ELSE NULL::timestamptz END,
       $6,CASE WHEN $3::boolean THEN $7::uuid ELSE NULL::uuid END
     )`,
    [sid, ticketDigest, claimed, options.closed === true, randomBytes(32), relayInstanceId, relayBootId],
  );
  return sid;
}

async function waitUntilLockBlocked(pid: number): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const state = await pool.query<{ waiting: boolean }>(
      `SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1`,
      [pid],
    );
    if (state.rows[0]?.waiting === true) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('migration never waited for the terminal_sessions table lock');
}

describe('migration 034 terminal relay instance fencing', () => {
  it('requires a drained pre-034 plane and enforces pinned admission/claim generations', async () => {
    const legacy = await seedLegacySession(pool, true);
    await expect(pool.query(up)).rejects.toThrow(/unpinned terminal session remains usable/u);
    expect(await columnExists()).toBe(false);

    await pool.query(`UPDATE terminal_sessions SET closed_at=now() WHERE id=$1`, [legacy]);
    await pool.query(up);
    await markApplied();

    await expect(seedPinnedSession(pool)).resolves.toMatch(/^[0-9a-f-]{36}$/u);
    await expect(seedPinnedSession(pool, { claimed: true })).resolves.toMatch(/^[0-9a-f-]{36}$/u);
    await expect(pool.query(
      `INSERT INTO terminal_sessions(
         id,request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
         operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
         ticket_sha256,reason,expires_at
       ) VALUES($1,$1,$2,$2,1,'operator',true,'Steven:kant','Steven','jarvis','jarvis',
                'claw','shell',$2,'missing pin',now()+interval '1 minute')`,
      [randomUUID(), randomBytes(32)],
    )).rejects.toThrow(/terminal_sessions_relay_instance_shape/u);
    await expect(pool.query(
      `UPDATE terminal_sessions
          SET relay_instance_id=$1,relay_boot_id=$2
        WHERE id=(SELECT id FROM terminal_sessions WHERE relay_claim_epoch=0 LIMIT 1)`,
      [relayInstanceId, relayBootId],
    )).rejects.toThrow(/terminal_sessions_relay_instance_shape/u);
    await expect(pool.query(
      `UPDATE terminal_sessions SET relay_instance_id=$1
        WHERE id=(SELECT id FROM terminal_sessions WHERE relay_claim_epoch>0 LIMIT 1)`,
      [relayInstanceId.toUpperCase()],
    )).rejects.toThrow(/terminal_sessions_relay_instance_shape/u);
    await expect(pool.query(
      `UPDATE terminal_sessions SET relay_boot_id=$1
        WHERE id=(SELECT id FROM terminal_sessions WHERE relay_claim_epoch>0 LIMIT 1)`,
      ['11111111-1111-1111-8111-111111111111'],
    )).rejects.toThrow(/terminal_sessions_relay_instance_shape/u);
  });

  it('refuses destructive down after routing history, then round-trips before any use', async () => {
    await pool.query(up);
    await markApplied();
    const sid = await seedPinnedSession(pool, { closed: true });
    await expect(pool.query(down)).rejects.toThrow(/relay routing history has been recorded/u);
    expect(await columnExists()).toBe(true);

    await pool.query(`DELETE FROM terminal_sessions WHERE id=$1`, [sid]);
    await pool.query(down);
    expect(await columnExists()).toBe(false);
    await pool.query(up);
    await markApplied();
    expect(await columnExists()).toBe(true);
  });

  it('refuses downgrade while a later migration is recorded', async () => {
    await pool.query(up);
    await markApplied();
    await pool.query(`INSERT INTO schema_migrations(version) VALUES('999_future.sql')`);
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    expect(await columnExists()).toBe(true);
  });

  it('takes ACCESS EXCLUSIVE before the up preflight so a concurrent legacy writer cannot race it', async () => {
    const writer = await pool.connect();
    const migrator = await pool.connect();
    let writerOpen = false;
    try {
      await writer.query('BEGIN');
      writerOpen = true;
      await writer.query('LOCK TABLE terminal_sessions IN ROW EXCLUSIVE MODE');
      const pid = await migrator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pending = migrator.query(up);
      await waitUntilLockBlocked(requireValue(pid.rows[0], 'pid.rows').pid);

      await seedLegacySession(writer, true);
      await writer.query('COMMIT');
      writerOpen = false;

      await expect(pending).rejects.toThrow(/unpinned terminal session remains usable/u);
      expect(await columnExists()).toBe(false);
    } finally {
      if (writerOpen) await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      migrator.release();
    }
  });

  it('takes ACCESS EXCLUSIVE before down guards so a concurrent pinned writer cannot erase history', async () => {
    await pool.query(up);
    await markApplied();
    const writer = await pool.connect();
    const migrator = await pool.connect();
    let writerOpen = false;
    try {
      await writer.query('BEGIN');
      writerOpen = true;
      await writer.query('LOCK TABLE terminal_sessions IN ROW EXCLUSIVE MODE');
      const pid = await migrator.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pending = migrator.query(down);
      await waitUntilLockBlocked(requireValue(pid.rows[0], 'pid.rows').pid);

      await seedPinnedSession(writer, { closed: true });
      await writer.query('COMMIT');
      writerOpen = false;

      await expect(pending).rejects.toThrow(/relay routing history has been recorded/u);
      expect(await columnExists()).toBe(true);
    } finally {
      if (writerOpen) await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      migrator.release();
    }
  });
});
