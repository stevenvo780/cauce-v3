import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const version = '037_console_publish_intent_indexes.sql';
const upPath = new URL(`../migrations/${version}`, import.meta.url);
const downPath = new URL(`../migrations/down/${version}`, import.meta.url);
const version038 = '038_cauce_text_items_ok_search_path.sql';
const down038Path = new URL(`../migrations/down/${version038}`, import.meta.url);
const indexNames = [
  'audit_events_console_publish_key_037_idx',
  'audit_events_console_publish_nonce_037_idx',
  'audit_events_console_publish_rate_037_idx',
  'audit_events_console_publish_head_037_idx',
] as const;

let database: TestDatabase;
let pool: DatabasePool;
let up: string;
let down: string;
let down038: string;

async function existingIndexes(): Promise<string[]> {
  const result = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE schemaname='public' AND indexname=ANY($1::text[])
      ORDER BY indexname`,
    [[...indexNames]],
  );
  return result.rows.map((row) => row.indexname);
}

async function ensureUp(): Promise<void> {
  if ((await existingIndexes()).length === 0) await pool.query(up);
  await pool.query(
    `INSERT INTO schema_migrations(version) VALUES($1) ON CONFLICT DO NOTHING`, [version],
  );
  await pool.query(
    `INSERT INTO schema_migration_ledger(version,source_sha256,source_origin)
     VALUES($1,$2,'applied-atomically')
     ON CONFLICT(version) DO UPDATE SET
       source_sha256=EXCLUDED.source_sha256,
       source_origin=EXCLUDED.source_origin`,
    [version, createHash('sha256').update(up).digest('hex')],
  );
}

async function migrationApplied(migrationVersion: string): Promise<boolean> {
  const result = await pool.query(
    `SELECT 1 FROM schema_migrations WHERE version=$1`, [migrationVersion],
  );
  return result.rowCount === 1;
}

async function removeLatestTextItemsSearchPath(): Promise<void> {
  if (!await migrationApplied(version038)) return;
  await pool.query(down038);
  await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [version038]);
}

async function seedScaleHistory(): Promise<void> {
  await pool.query(
    `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
     SELECT 'Steven','kant','message.publish','allow',
            jsonb_build_object('unrelated_sequence',sequence)
       FROM generate_series(1,10000) AS sequence`,
  );
  await pool.query(
    `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
     SELECT 'Steven','kant','console.publish.prepare','allow',jsonb_build_object(
       'version',1,
       'idempotency_key','console:scale-' || sequence,
       'semantic_hash',lpad(to_hex(sequence),64,'0'),
       'conversation_hash',repeat('c',64),
       'intent_nonce_hash',lpad(to_hex(sequence+100),64,'0'),
       'operator_scope_hash',repeat('a',64)
     )
       FROM generate_series(1,32) AS sequence`,
  );
  await pool.query(
    `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
     VALUES(
       'Steven','kant','console.publish.head','allow',
       jsonb_build_object(
         'version',1,
         'operator_scope_hash',repeat('a',64),
         'conversation_hash',repeat('c',64),
         'sequence',1,
         'intents','[]'::jsonb
       )
     )`,
  );
  await pool.query('ANALYZE audit_events');
}

async function explainWithGenericPlan(
  name: string,
  statement: string,
  parameters: readonly string[],
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(`SET LOCAL enable_seqscan=off`);
    await client.query(`SET LOCAL plan_cache_mode='force_generic_plan'`);
    await client.query(`PREPARE ${name} AS ${statement}`);
    const literals = parameters.map((value) => `'${value.replaceAll("'", "''")}'`).join(',');
    const result = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (COSTS OFF) EXECUTE ${name}(${literals})`,
    );
    await client.query('ROLLBACK');
    return result.rows.map((row) => row['QUERY PLAN']).join('\n');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

beforeAll(async () => {
  [up, down, down038] = await Promise.all([
    readFile(upPath, 'utf8'),
    readFile(downPath, 'utf8'),
    readFile(down038Path, 'utf8'),
  ]);
  database = await startTestDatabase();
  pool = database.pool;
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await removeLatestTextItemsSearchPath();
  await ensureUp();
});

afterEach(async () => {
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await ensureUp();
  await applyMigrations(pool);
});

afterAll(async () => {
  await pool.end();
  await database.container.stop();
});

describe('migration 037 bounded console publish-intent journal indexes', () => {
  it('installs the exact partial expression indexes used by literal journal queries', async () => {
    const definitions = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname,indexdef FROM pg_indexes
        WHERE schemaname='public' AND indexname=ANY($1::text[])
        ORDER BY indexname`,
      [[...indexNames]],
    );
    expect(definitions.rows.map((row) => row.indexname).sort())
      .toEqual([...indexNames].sort());
    const encoded = definitions.rows.map((row) => row.indexdef).join('\n');
    expect(encoded).toContain("(metadata ->> 'idempotency_key'::text)");
    expect(encoded).toContain("(metadata ->> 'operator_scope_hash'::text)");
    expect(encoded).toContain("(metadata ->> 'intent_nonce_hash'::text)");
    expect(encoded).toContain("(metadata ->> 'conversation_hash'::text)");
    expect(encoded).toContain('created_at DESC');
    expect(encoded).toContain("action = 'console.publish.prepare'::text");
    expect(encoded).toContain("action = 'console.publish.head'::text");
    expect(encoded).toContain("'console.publish.confirm'::text");
    expect(encoded).toContain("'console.publish.expire'::text");
  });

  it('uses bounded journal indexes with a generic plan despite large unrelated history', async () => {
    await seedScaleHistory();
    const keyPlan = await explainWithGenericPlan(
      'console_key_037',
      `SELECT action,metadata FROM audit_events
        WHERE tenant_id=$1 AND actor_alias=$2
          AND metadata->>'idempotency_key'=$3
          AND action IN (
            'console.publish.prepare','console.publish.confirm','console.publish.expire'
          )
        ORDER BY id LIMIT 4`,
      ['Steven', 'kant', 'console:scale-20'],
    );
    expect(keyPlan).toContain('audit_events_console_publish_key_037_idx');

    const noncePlan = await explainWithGenericPlan(
      'console_nonce_037',
      `SELECT metadata FROM audit_events
        WHERE tenant_id=$1 AND actor_alias=$2
          AND action='console.publish.prepare'
          AND metadata->>'operator_scope_hash'=$3
          AND metadata->>'intent_nonce_hash'=$4
        ORDER BY id DESC LIMIT 2`,
      ['Steven', 'kant', 'a'.repeat(64), '0'.repeat(62) + '78'],
    );
    expect(noncePlan).toContain('audit_events_console_publish_nonce_037_idx');

    const ratePlan = await explainWithGenericPlan(
      'console_rate_037',
      `WITH recent AS MATERIALIZED (
         SELECT created_at FROM audit_events
          WHERE tenant_id=$1 AND actor_alias=$2
            AND action='console.publish.prepare'
            AND metadata->>'operator_scope_hash'=$3
            AND created_at>now()-interval '24 hours'
          ORDER BY created_at DESC,id DESC LIMIT $5
       )
       SELECT created_at FROM recent
        WHERE created_at>now()-interval '10 minutes'
        OFFSET $4 LIMIT 1`,
      ['Steven', 'kant', 'a'.repeat(64), '59', '200'],
    );
    expect(ratePlan).toContain('audit_events_console_publish_rate_037_idx');

    const headPlan = await explainWithGenericPlan(
      'console_head_037',
      `SELECT metadata FROM audit_events
        WHERE tenant_id=$1 AND actor_alias=$2
          AND action='console.publish.head'
          AND metadata->>'operator_scope_hash'=$3
          AND metadata->>'conversation_hash'=$4
        ORDER BY id DESC LIMIT 2`,
      ['Steven', 'kant', 'a'.repeat(64), 'c'.repeat(64)],
    );
    expect(headPlan).toContain('audit_events_console_publish_head_037_idx');
  });

  it('round-trips only before journal use and preserves unrelated audit evidence', async () => {
    await pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
       VALUES('Steven','kant','message.publish','allow','{"unrelated":true}'::jsonb)`,
    );
    const before = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events`,
    );
    await pool.query(down);
    expect(await existingIndexes()).toEqual([]);
    expect((await pool.query(
      `SELECT 1 FROM schema_migrations WHERE version=$1`, [version],
    )).rowCount).toBe(0);
    expect((await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM audit_events`,
    )).rows).toEqual(before.rows);

    await ensureUp();
    expect((await existingIndexes()).sort()).toEqual([...indexNames].sort());
  });

  it('refuses destructive down after the first console journal write', async () => {
    await seedScaleHistory();
    await expect(pool.query(down)).rejects.toThrow(/after console publish journal use/u);
    expect((await existingIndexes()).sort()).toEqual([...indexNames].sort());
  });

  it('refuses downgrade while a later migration is recorded', async () => {
    await pool.query(`INSERT INTO schema_migrations(version) VALUES('999_future.sql')`);
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    expect((await existingIndexes()).sort()).toEqual([...indexNames].sort());
  });

  it('refuses downgrade from a drifted atomic source ledger', async () => {
    await pool.query(
      `UPDATE schema_migration_ledger SET source_sha256=repeat('b',64) WHERE version=$1`,
      [version],
    );
    await expect(pool.query(down)).rejects.toThrow(/ledger state/u);
    expect((await existingIndexes()).sort()).toEqual([...indexNames].sort());
  });

  it('rejects a first upgrade that would have to invent a head for existing prepares', async () => {
    await pool.query(down);
    await pool.query(
      `INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
       VALUES(
         'Steven','kant','console.publish.prepare','allow',
         '{"version":1,"idempotency_key":"console:orphan"}'::jsonb
       )`,
    );
    await expect(pool.query(up)).rejects.toThrow(/empty console publish-intent journal/u);
    expect(await existingIndexes()).toEqual([]);
    await pool.query(`DELETE FROM audit_events WHERE action='console.publish.prepare'`);
  });
});
