import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabasePool } from '../src/index.js';

const version = '039_secret_handoff.sql';
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
 * Peels only migration 039. Adding a migration means adding its own layer file plus a call here
 * in every suite that reverts below it.
 */
export async function removeSecretHandoffLayer(pool: DatabasePool): Promise<void> {
  if (!await isApplied(pool)) return;
  await pool.query(await readDown());
  await pool.query('DELETE FROM schema_migrations WHERE version=$1', [version]);
}

/**
 * Puts the layer back, ledger row included, for the suites that rebuild the head of the schema by
 * hand: leaving it off hands the next file in the shared database a schema one migration short.
 */
export async function restoreSecretHandoffLayer(pool: DatabasePool): Promise<void> {
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
