import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabasePool } from '../src/index.js';

const version = '042_blobs.sql';
const upPath = new URL(`../migrations/${version}`, import.meta.url);
const downPath = new URL(`../migrations/down/${version}`, import.meta.url);
let upSource: string | undefined;
let downSource: string | undefined;

async function isApplied(pool: DatabasePool): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
  return result.rowCount === 1;
}

/** 042 is the outermost layer: a suite peeling downwards removes it before 041. */
export async function removeBlobsLayer(pool: DatabasePool): Promise<void> {
  if (!await isApplied(pool)) return;
  downSource ??= await readFile(downPath, 'utf8');
  await pool.query(downSource);
}

export async function restoreBlobsLayer(pool: DatabasePool): Promise<void> {
  upSource ??= await readFile(upPath, 'utf8');
  await pool.query(upSource);
  await pool.query(
    'INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING', [version],
  );
  await pool.query(
    `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
     VALUES($1,$2,'applied-atomically')
     ON CONFLICT(version) DO UPDATE SET
       source_sha256=EXCLUDED.source_sha256,
       source_origin=EXCLUDED.source_origin`,
    [version, createHash('sha256').update(upSource).digest('hex')],
  );
}
