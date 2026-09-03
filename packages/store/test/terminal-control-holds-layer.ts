import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabasePool } from '../src/index.js';

const version = '040_terminal_control_holds.sql';
const upPath = new URL(`../migrations/${version}`, import.meta.url);
const downPath = new URL(`../migrations/down/${version}`, import.meta.url);
let upSource: string | undefined;
let downSource: string | undefined;

async function readUp(): Promise<string> {
  upSource ??= await readFile(upPath, 'utf8');
  return upSource;
}

async function readDown(): Promise<string> {
  downSource ??= await readFile(downPath, 'utf8');
  return downSource;
}

async function isApplied(pool: DatabasePool): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
  return result.rowCount === 1;
}

/**
 * One layer helper per migration (sibling of `secret-handoff-layer.ts`): every `down/` from 031 on
 * refuses to run while a later migration is recorded, so a suite reverting its own peels this first.
 * Call it AFTER removing any `999_future.sql` marker (it sorts above `040_`, so a stray one makes this fail naming 040 for an unrelated cause); `TRUNCATE TABLE terminal_sessions` is CASCADE already. */
export async function removeTerminalControlHoldsLayer(pool: DatabasePool): Promise<void> {
  if (!await isApplied(pool)) return;
  await pool.query('TRUNCATE TABLE terminal_control_holds');
  // This rewrite DISARMS the guard the down migration enforces (`harness_rw` rows must block a
  // downgrade); admissible only while nothing writes that mode. The first suite seeding a writable
  // session must peel the layer itself or see its row silently turned into `harness` here.
  await pool.query(`UPDATE terminal_sessions SET mode='harness' WHERE mode='harness_rw'`);
  await pool.query(await readDown());
}

/** Puts the layer back, ledger row included, for the suites that rebuild the head by hand. */
export async function restoreTerminalControlHoldsLayer(pool: DatabasePool): Promise<void> {
  const source = await readUp();
  await pool.query(source);
  await pool.query(
    'INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [version],
  );
  await pool.query(
    `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
     VALUES($1,$2,'applied-atomically')
     ON CONFLICT(version) DO UPDATE SET
       source_sha256=EXCLUDED.source_sha256,
       source_origin=EXCLUDED.source_origin`,
    [version, createHash('sha256').update(source).digest('hex')],
  );
}
