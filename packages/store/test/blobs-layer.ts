import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabasePool } from '../src/index.js';

const versions = ['042_blobs.sql', '043_blob_tenant_entitlements.sql'] as const;

async function isApplied(pool: DatabasePool, version: string): Promise<boolean> {
  const result = await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version]);
  return result.rowCount === 1;
}

/** 043 and 042 sit above 041 and must be removed in descending order. */
export async function removeBlobsLayer(pool: DatabasePool): Promise<void> {
  for (const version of [...versions].reverse()) {
    if (!await isApplied(pool, version)) continue;
    const source = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
    await pool.query(source);
  }
}

export async function restoreBlobsLayer(pool: DatabasePool): Promise<void> {
  for (const version of versions) {
    const source = await readFile(new URL(`../migrations/${version}`, import.meta.url), 'utf8');
    if (!await isApplied(pool, version)) await pool.query(source);
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
}
