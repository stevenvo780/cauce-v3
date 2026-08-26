import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase,
  startTestDatabase,
  type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const upPath = new URL('../migrations/032_terminal_session_claim_fencing.sql', import.meta.url);
const downPath = new URL('../migrations/down/032_terminal_session_claim_fencing.sql', import.meta.url);
const up033Path = new URL('../migrations/033_terminal_browser_owner_fencing.sql', import.meta.url);
const down033Path = new URL('../migrations/down/033_terminal_browser_owner_fencing.sql', import.meta.url);
const up034Path = new URL('../migrations/034_terminal_relay_instance_fencing.sql', import.meta.url);
const down034Path = new URL('../migrations/down/034_terminal_relay_instance_fencing.sql', import.meta.url);
const up035Path = new URL('../migrations/035_agent_profile_runtime_adoption.sql', import.meta.url);
const down035Path = new URL('../migrations/down/035_agent_profile_runtime_adoption.sql', import.meta.url);
const up036Path = new URL('../migrations/036_shadow_router_target_phase.sql', import.meta.url);
const down036Path = new URL('../migrations/down/036_shadow_router_target_phase.sql', import.meta.url);
const up037Path = new URL('../migrations/037_console_publish_intent_indexes.sql', import.meta.url);
const down037Path = new URL('../migrations/down/037_console_publish_intent_indexes.sql', import.meta.url);
const version032 = '032_terminal_session_claim_fencing.sql';
const version033 = '033_terminal_browser_owner_fencing.sql';
const version034 = '034_terminal_relay_instance_fencing.sql';
const version035 = '035_agent_profile_runtime_adoption.sql';
const version036 = '036_shadow_router_target_phase.sql';
const version037 = '037_console_publish_intent_indexes.sql';
const relayInstanceId = 'a'.repeat(64);
const relayBootId = '11111111-1111-4111-8111-111111111111';

let database: TestDatabase;
let pool: DatabasePool;
let up: string;
let down: string;
let up033: string;
let down033: string;
let up034: string;
let down034: string;
let up035: string;
let down035: string;
let up036: string;
let down036: string;
let up037: string;
let down037: string;

beforeAll(async () => {
  [up, down, up033, down033, up034, down034, up035, down035, up036, down036, up037, down037] = await Promise.all([
    readFile(upPath, 'utf8'),
    readFile(downPath, 'utf8'),
    readFile(up033Path, 'utf8'),
    readFile(down033Path, 'utf8'),
    readFile(up034Path, 'utf8'),
    readFile(down034Path, 'utf8'),
    readFile(up035Path, 'utf8'),
    readFile(down035Path, 'utf8'),
    readFile(up036Path, 'utf8'),
    readFile(down036Path, 'utf8'),
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

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`TRUNCATE TABLE terminal_sessions`);
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await removeLatestConsolePublishIndexes();
  await removeLatestShadowPhase();
  await removeLatestProfileLayer();
});

afterEach(async () => {
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await pool.query(`TRUNCATE TABLE terminal_sessions`);
  await restoreLatestSchema();
});

async function markApplied(version: string): Promise<void> {
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`,
    [version],
  );
  const source = new Map<string, string>([
    [version032, up],
    [version033, up033],
    [version034, up034],
    [version035, up035],
    [version036, up036],
    [version037, up037],
  ]).get(version);
  if (source === undefined) throw new Error(`missing migration source for ${version}`);
  await pool.query(
    `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
     VALUES($1,$2,'applied-atomically')
     ON CONFLICT DO NOTHING`,
    [version, createHash('sha256').update(source).digest('hex')],
  );
}

async function terminalColumnExists(column: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='terminal_sessions' AND column_name=$1
     ) AS exists`,
    [column],
  );
  return result.rows[0]?.exists === true;
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
  if (!await terminalColumnExists('relay_claim_epoch')) await pool.query(up);
  await markApplied(version032);
  if (!await terminalColumnExists('request_id')) await pool.query(up033);
  await markApplied(version033);
  if (!await terminalColumnExists('relay_instance_id')) await pool.query(up034);
  await markApplied(version034);
  if (!await profileLayerExists()) await pool.query(up035);
  await markApplied(version035);
  if (!await shadowPhaseExists()) await pool.query(up036);
  await markApplied(version036);
  if (!await consolePublishIndexesExist()) await pool.query(up037);
  await markApplied(version037);
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

async function shadowPhaseExists(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM information_schema.columns
        WHERE table_schema='public' AND table_name='shadow_router_inbox'
          AND column_name='claim_target_started'
     ) AS exists`,
  );
  return result.rows[0]?.exists === true;
}

async function removeLatestShadowPhase(): Promise<void> {
  if (await shadowPhaseExists()) await pool.query(down036);
  else await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [version036]);
}

async function seedSession(claimed = false): Promise<string> {
  const sid = randomUUID();
  await pool.query(
    `INSERT INTO terminal_sessions(
       id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
       ticket_sha256,reason,issued_at,expires_at,consumed_at,
       relay_claim_sha256,relay_claim_epoch,relay_claimed_at,relay_claim_expires_at,
       request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
       relay_instance_id,relay_boot_id
     ) VALUES(
       $1,'operator',true,'Steven:kant','Steven','jarvis','jarvis','claw','shell',
       $2,'migration test',now(),now()+interval '1 minute',
       CASE WHEN $3::boolean THEN now() ELSE NULL::timestamptz END,
       CASE WHEN $3::boolean THEN $4::bytea ELSE NULL::bytea END,
       CASE WHEN $3::boolean THEN 1::bigint ELSE 0::bigint END,
       CASE WHEN $3::boolean THEN now() ELSE NULL::timestamptz END,
       CASE WHEN $3::boolean THEN now()+interval '30 seconds' ELSE NULL::timestamptz END,
       $1,$2,$2,1,$5,
       CASE WHEN $3::boolean THEN $6::uuid ELSE NULL::uuid END
     )`,
    [sid, randomBytes(32), claimed, randomBytes(32), relayInstanceId, relayBootId],
  );
  return sid;
}

async function waitForGlobalMigrationLockHolder(): Promise<number | undefined> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ pid: number }>(
      `SELECT pid
         FROM pg_locks
        WHERE locktype='advisory'
          AND classid=0 AND objid=783003003 AND objsubid=1
          AND granted
        ORDER BY pid
        LIMIT 1`,
    );
    const pid = result.rows[0]?.pid;
    if (pid !== undefined) return pid;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return undefined;
}

async function waitsForGlobalMigrationLock(pid: number): Promise<boolean> {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const result = await pool.query<{ waiting: boolean }>(
      `SELECT EXISTS(
         SELECT 1
           FROM pg_locks
          WHERE pid=$1 AND locktype='advisory'
            AND classid=0 AND objid=783003003 AND objsubid=1
            AND NOT granted
       ) AS waiting`,
      [pid],
    );
    if (result.rows[0]?.waiting === true) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

describe('migration 032 terminal session claim fencing', () => {
  it('accepts legacy unclaimed rows and requires a complete claim tied to consumed_at', async () => {
    await expect(seedSession(false)).resolves.toMatch(/^[0-9a-f-]{36}$/u);

    await expect(pool.query(
      `INSERT INTO terminal_sessions(
         id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
         ticket_sha256,reason,issued_at,expires_at,relay_claim_sha256,relay_claim_epoch,
         relay_claimed_at,relay_claim_expires_at,
         request_id,request_sha256,browser_owner_sha256,browser_owner_generation,
         relay_instance_id,relay_boot_id
       ) VALUES($1,'operator',true,'Steven:kant','Steven','jarvis','jarvis','claw','shell',
                $2,'invalid unconsumed claim',now(),now()+interval '1 minute',$3,1,now(),now()+interval '30 seconds',
                $1,$2,$2,1,$4,$5)`,
      [randomUUID(), randomBytes(32), randomBytes(32), relayInstanceId, relayBootId],
    )).rejects.toThrow(/terminal_sessions_relay_claim_shape/u);

    const sid = await seedSession(true);
    await pool.query(
      `UPDATE terminal_sessions SET closed_at=now(),close_reason='test' WHERE id=$1`,
      [sid],
    );
    const preserved = await pool.query<{
      digest_length: number;
      relay_claim_epoch: string;
    }>(
      `SELECT octet_length(relay_claim_sha256)::int AS digest_length,
              relay_claim_epoch::text
         FROM terminal_sessions WHERE id=$1`,
      [sid],
    );
    expect(preserved.rows[0]).toEqual({ digest_length: 32, relay_claim_epoch: '1' });
  });

  it('round-trips down/up only after claimed sessions are closed', async () => {
    const sid = await seedSession(true);
    // On the latest schema, 032 cannot be removed under its dependent browser-owner fence.
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);

    await pool.query(
      `UPDATE terminal_sessions
          SET closed_at=now(),relay_instance_id=NULL,relay_boot_id=NULL
        WHERE id=$1`,
      [sid],
    );
    await pool.query(down034);
    await pool.query(down033);
    await pool.query(down);
    const absent = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='terminal_sessions'
          AND column_name LIKE 'relay_claim_%'`,
    );
    expect(absent.rows[0]?.count).toBe('0');

    await pool.query(up);
    await markApplied(version032);
    await pool.query(up033);
    await markApplied(version033);
    await pool.query(up034);
    await markApplied(version034);
    await pool.query(up035);
    await markApplied(version035);
    const restored = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='terminal_sessions'
          AND column_name LIKE 'relay_claim_%'`,
    );
    expect(restored.rows[0]?.count).toBe('4');
  });

  it('refuses downgrade while a later migration is recorded', async () => {
    await pool.query(
      `INSERT INTO schema_migrations(version) VALUES('999_future.sql') ON CONFLICT DO NOTHING`,
    );
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    const stillPresent = await pool.query<{ exists: boolean }>(
      `SELECT EXISTS(
         SELECT 1 FROM information_schema.columns
          WHERE table_schema='public' AND table_name='terminal_sessions'
            AND column_name='relay_claim_epoch'
       ) AS exists`,
    );
    expect(stillPresent.rows[0]?.exists).toBe(true);
  });

  it('locks out concurrent claim writers before evaluating the downgrade drain guard', async () => {
    // Exercise 032 in its own historical layer. Later-schema guards are independently covered by
    // the assertion above and by their respective migration suites.
    await pool.query(down034);
    await pool.query(down033);
    const writer = await pool.connect();
    const downgrade = await pool.connect();
    let writerOpen = false;
    try {
      await writer.query('BEGIN');
      writerOpen = true;
      // Ordinary terminal transitions already hold this compatible writer lock. The downgrade's
      // ACCESS EXCLUSIVE must wait here *before* it reads the empty-session guard.
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
      await writer.query(
        `INSERT INTO terminal_sessions(
           id,operator_id,attributed,console_subject,tenant_id,alias,container,runtime_user,mode,
           ticket_sha256,reason,issued_at,expires_at,consumed_at,
           relay_claim_sha256,relay_claim_epoch,relay_claimed_at,relay_claim_expires_at
         ) VALUES(
           $1,'operator',true,'Steven:kant','Steven','jarvis','jarvis','claw','shell',
           $2,'concurrent migration test',now(),now()+interval '1 minute',now(),
           $3,1,now(),now()+interval '30 seconds'
         )`,
        [sid, randomBytes(32), randomBytes(32)],
      );
      await writer.query('COMMIT');
      writerOpen = false;

      await expect(pending).rejects.toThrow(/claimed terminal session remains open/u);
      const intact = await pool.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM information_schema.columns
          WHERE table_schema='public' AND table_name='terminal_sessions'
            AND column_name LIKE 'relay_claim_%'`,
      );
      expect(intact.rows[0]?.count).toBe('4');
    } finally {
      if (writerOpen) await writer.query('ROLLBACK').catch(() => undefined);
      writer.release();
      downgrade.release();
      await pool.query(`TRUNCATE TABLE terminal_sessions`);
      await restoreLatestSchema();
    }
  });
});

describe('destructive migrations serialize with applyMigrations', () => {
  it.each([version033, version034, version035, version036, version037])(
    '%s waits behind a successful forward apply and cannot leave the latest schema torn down',
    async (downVersion) => {
      // beforeEach deliberately places the database at schema 034 for the historical migration
      // tests above.  Use the real runner here so its integrity ledger and the latest schema are
      // both exact before introducing concurrency.
      await applyMigrations(pool);
      if (downVersion === version037) {
        // Exercise the appearance CAS, not a no-op forward apply.  037 is the latest migration,
        // so only a pre-lock snapshot can distinguish "explicit down after a no-op" (allowed)
        // from "037 appeared while down was queued" (must be rejected).
        await pool.query(down037);
      }

      const sources: Record<string, string> = {
        [version033]: down033,
        [version034]: down034,
        [version035]: down035,
        [version036]: down036,
        [version037]: down037,
      };
      const source = sources[downVersion];
      if (source === undefined) throw new Error(`missing down source for ${downVersion}`);

      const blocker = await pool.connect();
      const downgrade = await pool.connect();
      let blockerOpen = false;
      let applyOutcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      let downOutcome: Promise<{ ok: true } | { ok: false; error: unknown }> | undefined;
      try {
        // Force the real forward runner to pause *after* it owns the global migration fence.  The
        // down must queue on that same advisory lock, not run ahead and block later on a table.
        await blocker.query('BEGIN');
        blockerOpen = true;
        await blocker.query(downVersion === version037
          ? 'LOCK TABLE audit_events IN ACCESS EXCLUSIVE MODE'
          : 'LOCK TABLE schema_migrations IN ACCESS EXCLUSIVE MODE');
        applyOutcome = applyMigrations(pool).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        expect(await waitForGlobalMigrationLockHolder()).toBeDefined();

        const pidResult = await downgrade.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        const downgradePid = pidResult.rows[0]?.pid;
        if (downgradePid === undefined) throw new Error('downgrade backend has no pid');
        downOutcome = downgrade.query(source).then(
          () => ({ ok: true as const }),
          (error: unknown) => ({ ok: false as const, error }),
        );
        expect(await waitsForGlobalMigrationLock(downgradePid)).toBe(true);

        await blocker.query('COMMIT');
        blockerOpen = false;

        const applied = await applyOutcome;
        expect(applied).toEqual({ ok: true });
        const downgraded = await downOutcome;
        expect(downgraded.ok).toBe(false);
        if (downgraded.ok) throw new Error(`${downVersion} unexpectedly succeeded`);
        expect(downgraded.error).toBeInstanceOf(Error);
        expect((downgraded.error as Error).message).toMatch(
          downVersion === version037 ? /concurrently changed ledger state/u : /later migration/u,
        );

        const versions = await pool.query<{ count: string }>(
          `SELECT count(*)::text AS count
             FROM schema_migrations
            WHERE version = ANY($1::text[])`,
          [[version033, version034, version035, version036, version037]],
        );
        expect(versions.rows[0]?.count).toBe('5');
        await expect(terminalColumnExists('request_id')).resolves.toBe(true);
        await expect(terminalColumnExists('relay_instance_id')).resolves.toBe(true);
        await expect(profileLayerExists()).resolves.toBe(true);
        await expect(shadowPhaseExists()).resolves.toBe(true);
        await expect(consolePublishIndexesExist()).resolves.toBe(true);
      } finally {
        if (blockerOpen) await blocker.query('ROLLBACK').catch(() => undefined);
        if (applyOutcome !== undefined) await applyOutcome;
        if (downOutcome !== undefined) await downOutcome;
        blocker.release();
        downgrade.release();
      }
    },
    120_000,
  );
});
