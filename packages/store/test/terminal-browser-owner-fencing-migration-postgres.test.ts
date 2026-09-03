import { preparePostgresSuite } from './postgres-suite.js';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '../src/index.js';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import {
  removeSecretHandoffLayer, restoreSecretHandoffLayer,
} from './secret-handoff-layer.js';
import {
  removeTerminalControlHoldsLayer, restoreTerminalControlHoldsLayer,
} from './terminal-control-holds-layer.js';

const upPath = new URL('../migrations/033_terminal_browser_owner_fencing.sql', import.meta.url);
const downPath = new URL('../migrations/down/033_terminal_browser_owner_fencing.sql', import.meta.url);
const version = '033_terminal_browser_owner_fencing.sql';
const up034Path = new URL('../migrations/034_terminal_relay_instance_fencing.sql', import.meta.url);
const down034Path = new URL('../migrations/down/034_terminal_relay_instance_fencing.sql', import.meta.url);
const version034 = '034_terminal_relay_instance_fencing.sql';
const up035Path = new URL('../migrations/035_agent_profile_runtime_adoption.sql', import.meta.url);
const down035Path = new URL('../migrations/down/035_agent_profile_runtime_adoption.sql', import.meta.url);
const version035 = '035_agent_profile_runtime_adoption.sql';
const up037Path = new URL('../migrations/037_console_publish_intent_indexes.sql', import.meta.url);
const down037Path = new URL('../migrations/down/037_console_publish_intent_indexes.sql', import.meta.url);
const version037 = '037_console_publish_intent_indexes.sql';
const up038Path = new URL('../migrations/038_cauce_text_items_ok_search_path.sql', import.meta.url);
const down038Path = new URL('../migrations/down/038_cauce_text_items_ok_search_path.sql', import.meta.url);
const version038 = '038_cauce_text_items_ok_search_path.sql';
const relayInstanceId = 'a'.repeat(64);

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let up: string;
let down: string;
let up034: string;
let down034: string;
let up035: string;
let down035: string;
let up037: string;
let down037: string;
let up038: string;
let down038: string;

preparePostgresSuite(import.meta.url, async () => {
  [up, down, up034, down034, up035, down035, up037, down037, up038, down038] = await Promise.all([
    readFile(upPath, 'utf8'),
    readFile(downPath, 'utf8'),
    readFile(up034Path, 'utf8'),
    readFile(down034Path, 'utf8'),
    readFile(up035Path, 'utf8'),
    readFile(down035Path, 'utf8'),
    readFile(up037Path, 'utf8'),
    readFile(down037Path, 'utf8'),
    readFile(up038Path, 'utf8'),
    readFile(down038Path, 'utf8'),
  ]);
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 120_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
  // terminal_sessions intentionally is not part of the shared reset helper yet; migration tests
  // own their disposable rows explicitly so test order cannot turn a drain guard red or green.
  await pool.query(`TRUNCATE TABLE terminal_sessions CASCADE`);
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await removeTerminalControlHoldsLayer(pool);
  await removeSecretHandoffLayer(pool);
  await removeLatestTextItemsSearchPathFix();
  await removeLatestConsolePublishIndexes();
  await removeLatestProfileLayer();
});

afterEach(async () => {
  if (!databaseStarted) return;
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await pool.query(`TRUNCATE TABLE terminal_sessions CASCADE`);
  await restoreLatestSchema();
});

async function columnExists(column: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='terminal_sessions' AND column_name=$1
     ) AS exists`,
    [column],
  );
  return result.rows[0]?.exists === true;
}

async function markApplied(appliedVersion: string): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`,
    [appliedVersion],
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
  if (!await columnExists('request_id')) {
    await pool.query(up);
  }
  await markApplied(version);
  if (!await columnExists('relay_instance_id')) {
    await pool.query(up034);
  }
  await markApplied(version034);
  if (!await profileLayerExists()) {
    await pool.query(up035);
  }
  await markApplied(version035);
  if (!await consolePublishIndexesExist()) await pool.query(up037);
  await markApplied(version037);
  await pool.query(
    `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
     VALUES($1,$2,'applied-atomically')
     ON CONFLICT(version) DO UPDATE SET
       source_sha256=EXCLUDED.source_sha256,
       source_origin=EXCLUDED.source_origin`,
    [version037, createHash('sha256').update(up037).digest('hex')],
  );
  await pool.query(up038);
  await markApplied(version038);
  await pool.query(
    `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
     VALUES($1,$2,'applied-atomically')
     ON CONFLICT(version) DO UPDATE SET
       source_sha256=EXCLUDED.source_sha256,
       source_origin=EXCLUDED.source_origin`,
    [version038, createHash('sha256').update(up038).digest('hex')],
  );
  await restoreSecretHandoffLayer(pool);
  await restoreTerminalControlHoldsLayer(pool);
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

async function migrationApplied(migrationVersion: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM schema_migrations WHERE version=$1`, [migrationVersion],
  );
  return result.rowCount === 1;
}

async function removeLatestTextItemsSearchPathFix(): Promise<void> {
  if (!await migrationApplied(version038)) return;
  await pool.query(down038);
  await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [version038]);
}

async function seedSession(input: {
  sid?: string;
  requestId?: string;
  ticketDigest?: Buffer;
  requestDigest?: Buffer;
  ownerDigest?: Buffer;
  generation?: string;
  closed?: boolean;
} = {}): Promise<{
  sid: string;
  requestId: string;
  ticketDigest: Buffer;
  requestDigest: Buffer;
  ownerDigest: Buffer;
}> {
  const sid = input.sid ?? randomUUID();
  const requestId = input.requestId ?? randomUUID();
  const ticketDigest = input.ticketDigest ?? randomBytes(32);
  const requestDigest = input.requestDigest ?? randomBytes(32);
  const ownerDigest = input.ownerDigest ?? randomBytes(32);
  await pool.query(
    `INSERT INTO terminal_sessions(
       id,operator_id,attributed,console_subject,tenant_id,alias,container,generation,image_id,
       runtime_user,mode,ticket_sha256,reason,issued_at,expires_at,closed_at,
       request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
       relay_instance_id,relay_boot_id
     ) VALUES(
       $1,'operator',true,'Steven:kant','Steven','jarvis','claw','generation','sha256:image',
       'claw','shell',$2,'browser owner migration test',now(),now()+interval '1 minute',
       CASE WHEN $7::boolean THEN now() ELSE NULL::timestamptz END,$3,$4,$5,$6::bigint,
       CASE WHEN $7::boolean THEN NULL::text ELSE $8::text END,NULL::uuid
     )`,
    [
      sid, ticketDigest, requestId, requestDigest, ownerDigest,
      input.generation ?? '1', input.closed ?? false, relayInstanceId,
    ],
  );
  return { sid, requestId, ticketDigest, requestDigest, ownerDigest };
}

describe('migration 033 terminal browser owner fencing', () => {
  it('enforces non-null 32-byte digests, a positive generation and globally unique request ids', async () => {
    const seeded = await seedSession();
    const columns = await pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name,is_nullable
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='terminal_sessions'
          AND column_name IN (
            'request_id','request_sha256','browser_owner_sha256','browser_owner_generation'
          )
        ORDER BY column_name`,
    );
    expect(columns.rows).toHaveLength(4);
    expect(columns.rows.every((column) => column.is_nullable === 'NO')).toBe(true);

    await expect(seedSession({ requestId: seeded.requestId })).rejects.toMatchObject({ code: '23505' });
    await expect(seedSession({ requestDigest: randomBytes(31) })).rejects.toMatchObject({ code: '23514' });
    await expect(seedSession({ ownerDigest: randomBytes(33) })).rejects.toMatchObject({ code: '23514' });
    await expect(seedSession({ generation: '0' })).rejects.toMatchObject({ code: '23514' });
  });

  it('serializes concurrent takeover CAS and rejects a delayed DELETE from the losing generation', async () => {
    const seeded = await seedSession();
    const ownerA = randomBytes(32);
    const ownerB = randomBytes(32);
    const takeover = (digest: Buffer) => pool.query<{ browser_owner_generation: string }>(
      `UPDATE terminal_sessions
          SET browser_owner_sha256=$2,
              browser_owner_generation=browser_owner_generation+1
        WHERE id=$1 AND request_id=$3 AND browser_owner_generation=1
          AND revoked_at IS NULL AND closed_at IS NULL
        RETURNING browser_owner_generation::text`,
      [seeded.sid, digest, seeded.requestId],
    );

    const [left, right] = await Promise.all([takeover(ownerA), takeover(ownerB)]);
    expect([left.rowCount, right.rowCount].sort()).toEqual([0, 1]);
    const winner = left.rowCount === 1 ? ownerA : ownerB;
    const current = await pool.query<{
      generation: string;
      owner_matches: boolean;
    }>(
      `SELECT browser_owner_generation::text AS generation,
              browser_owner_sha256=$2 AS owner_matches
         FROM terminal_sessions WHERE id=$1`,
      [seeded.sid, winner],
    );
    expect(current.rows[0]).toEqual({ generation: '2', owner_matches: true });

    const staleDelete = await pool.query(
      `UPDATE terminal_sessions SET revoked_at=now()
        WHERE id=$1 AND request_id=$2 AND browser_owner_generation=1
          AND browser_owner_sha256=$3 AND revoked_at IS NULL AND closed_at IS NULL`,
      [seeded.sid, seeded.requestId, seeded.ownerDigest],
    );
    expect(staleDelete.rowCount).toBe(0);
    const winningDelete = await pool.query(
      `UPDATE terminal_sessions SET revoked_at=now()
        WHERE id=$1 AND request_id=$2 AND browser_owner_generation=2
          AND browser_owner_sha256=$3 AND revoked_at IS NULL AND closed_at IS NULL`,
      [seeded.sid, seeded.requestId, winner],
    );
    expect(winningDelete.rowCount).toBe(1);
  });

  it('round-trips only backfill-equivalent closed history and refuses real ownership history', async () => {
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    const ticketDigest = randomBytes(32);
    const sid = randomUUID();
    await seedSession({
      sid,
      requestId: sid,
      ticketDigest,
      requestDigest: ticketDigest,
      ownerDigest: ticketDigest,
      generation: '1',
      closed: true,
    });
    await pool.query(down034);
    try {
      await pool.query(down);
      const absent = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='terminal_sessions'
            AND column_name IN (
              'request_id','request_sha256','browser_owner_sha256','browser_owner_generation'
            )`,
      );
      expect(absent.rows[0]?.count).toBe('0');

      await pool.query(up);
      await markApplied(version);
      await pool.query(`UPDATE terminal_sessions SET closed_at=now() WHERE id=$1`, [sid]);
      await pool.query(
        `UPDATE terminal_sessions
            SET browser_owner_generation=2,
                browser_owner_sha256=$2
          WHERE id=$1`,
        [sid, randomBytes(32)],
      );
      await expect(pool.query(down)).rejects.toThrow(/ownership history/u);
    } finally {
      await restoreLatestSchema();
    }
  });

  it('takes ACCESS EXCLUSIVE before its drain guard so a concurrent opener cannot slip through', async () => {
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    await pool.query(down034);
    const writer = await pool.connect();
    const downgrade = await pool.connect();
    let writerOpen = false;
    try {
      await writer.query('BEGIN');
      writerOpen = true;
      await writer.query('LOCK TABLE terminal_sessions IN ROW EXCLUSIVE MODE');
      const downgradePid = await downgrade.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
      const pending = downgrade.query(down);

      let waiting = false;
      for (let attempt = 0; attempt < 100; attempt += 1) {
        const state = await pool.query<{ waiting: boolean }>(
          `SELECT wait_event_type='Lock' AS waiting FROM pg_stat_activity WHERE pid=$1`,
          [downgradePid.rows[0]?.pid],
        );
        waiting = state.rows[0]?.waiting === true;
        if (waiting) break;
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);

      const sid = randomUUID();
      const digest = randomBytes(32);
      await writer.query(
        `INSERT INTO terminal_sessions(
           id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
           ticket_sha256,reason,issued_at,expires_at,
           request_id,request_sha256,browser_owner_sha256,browser_owner_generation
         ) VALUES(
           $1,'operator',true,'Steven:kant','Steven','jarvis','claw','claw','shell',
           $2,'concurrent browser owner migration test',now(),now()+interval '1 minute',
           $1,$2,$2,1
         )`,
        [sid, digest],
      );
      await writer.query('COMMIT');
      writerOpen = false;

      await expect(pending).rejects.toThrow(/browser-owned terminal session remains open/u);
      const intact = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count
           FROM information_schema.columns
          WHERE table_schema='public' AND table_name='terminal_sessions'
            AND column_name IN (
              'request_id','request_sha256','browser_owner_sha256','browser_owner_generation'
            )`,
      );
      expect(intact.rows[0]?.count).toBe('4');
    } finally {
      if (writerOpen) await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      downgrade.release();
      await pool.query(`TRUNCATE TABLE terminal_sessions CASCADE`);
      await restoreLatestSchema();
    }
  });
});
