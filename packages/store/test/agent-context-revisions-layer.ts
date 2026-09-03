import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { DatabasePool } from '../src/index.js';

const version = '041_agent_context_revisions.sql';
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
 * Sibling of `terminal-control-holds-layer.ts`; 041 is the OUTERMOST layer, so a suite peeling
 * downwards calls this FIRST, and after deleting any `999_future.sql` marker (it sorts above
 * `041_`, so a stray one makes this refuse naming 041 for an unrelated cause). The TRUNCATE
 * disarms the "evidence recorded" gate: admissible only because a scratch journal is scaffolding,
 * so a suite asserting on journal rows must peel the layer before seeding them. */
export async function removeAgentContextRevisionsLayer(pool: DatabasePool): Promise<void> {
  if (!await isApplied(pool)) return;
  await pool.query('TRUNCATE TABLE agent_profile_revisions, agent_document_revisions');
  await pool.query(await readDown());
}

/** Puts the layer back, ledger row included, for the suites that rebuild the head by hand. */
export async function restoreAgentContextRevisionsLayer(pool: DatabasePool): Promise<void> {
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
