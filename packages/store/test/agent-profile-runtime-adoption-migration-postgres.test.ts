import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const version = '035_agent_profile_runtime_adoption.sql';
const upPath = new URL(`../migrations/${version}`, import.meta.url);
const downPath = new URL(`../migrations/down/${version}`, import.meta.url);
const version037 = '037_console_publish_intent_indexes.sql';
const down037Path = new URL(`../migrations/down/${version037}`, import.meta.url);
const version038 = '038_cauce_text_items_ok_search_path.sql';
const down038Path = new URL(`../migrations/down/${version038}`, import.meta.url);
const document = {
  name: 'AGENTS.md', path: '/home/dev/.codex/AGENTS.md', sha: 'a'.repeat(64),
} as const;

let database: TestDatabase;
let pool: DatabasePool;
let up: string;
let down: string;
let down037: string;
let down038: string;

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists', [name],
  );
  return result.rows[0]?.exists === true;
}

async function ensureUp(): Promise<void> {
  if (!await tableExists('agent_profile_runtime_expectations')) await pool.query(up);
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

async function consolePublishIndexesExist(): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    `SELECT to_regclass('public.audit_events_console_publish_key_037_idx') IS NOT NULL AS exists`,
  );
  return result.rows[0]?.exists === true;
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

async function removeLatestConsolePublishIndexes(): Promise<void> {
  if (await consolePublishIndexesExist()) await pool.query(down037);
  else await pool.query(`DELETE FROM schema_migrations WHERE version=$1`, [version037]);
}

async function seedProfile(): Promise<number> {
  await pool.query(`
    INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,
      container_name,runtime_user,home_directory,state_directory
    ) VALUES(
      'Steven','argos','claude','Argos',true,
      'ws-argos','dev','/home/dev','/home/dev/.cauce/argos'
    ) ON CONFLICT(tenant_id,alias) DO UPDATE SET enabled=true;
    INSERT INTO agent_profiles(tenant_id,alias,role_summary)
      VALUES('Steven','argos','Runtime profile migration fixture')
      ON CONFLICT(tenant_id,alias) DO NOTHING;
  `);
  const result = await pool.query<{ revision: string | number }>(
    `SELECT revision FROM agent_profiles WHERE tenant_id='Steven' AND alias='argos'`,
  );
  return Number(result.rows[0]?.revision);
}

async function seedDelivery(): Promise<string> {
  const messageId = randomUUID();
  const deliveryId = randomUUID();
  await pool.query(
    `INSERT INTO messages(
       id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane,priority
     ) VALUES($1,$2,$3,'Steven','grp.steven','kant',$4::jsonb,'interactive',0)`,
    [messageId, randomUUID(), `profile-migration-${randomUUID()}`, JSON.stringify({ text: 'test' })],
  );
  await pool.query(
    `INSERT INTO deliveries(id,message_id,recipient_tenant,recipient_alias)
       VALUES($1,$2,'Steven','argos')`,
    [deliveryId, messageId],
  );
  return deliveryId;
}

beforeAll(async () => {
  [up, down, down037, down038] = await Promise.all([
    readFile(upPath, 'utf8'),
    readFile(downPath, 'utf8'),
    readFile(down037Path, 'utf8'),
    readFile(down038Path, 'utf8'),
  ]);
  database = await startTestDatabase();
  pool = database.pool;
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await removeLatestTextItemsSearchPath();
  await removeLatestConsolePublishIndexes();
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

describe('migration 035 durable runtime adoption invariants', () => {
  it.each([
    { label: 'not an array', documents: {} },
    { label: 'empty', documents: [] },
    { label: 'unknown key', documents: [{ ...document, bytes: 10 }] },
    { label: 'relative path', documents: [{ ...document, path: 'AGENTS.md' }] },
    { label: 'name and basename disagree', documents: [{ ...document, name: 'TOOLS.md' }] },
    { label: 'non-canonical hash', documents: [{ ...document, sha: 'A'.repeat(64) }] },
    { label: 'duplicate name', documents: [document, { ...document, path: '/tmp/AGENTS.md' }] },
    { label: 'duplicate path', documents: [document, { ...document, name: 'TOOLS.md' }] },
  ])('rejects malformed document evidence at the database boundary: $label', async ({ documents }) => {
    const revision = await seedProfile();
    await expect(pool.query(
      `INSERT INTO agent_profile_runtime_expectations(
         tenant_id,alias,revision,generation,documents
       ) VALUES('Steven','argos',$1,'generation-a',$2::jsonb)`,
      [revision, JSON.stringify(documents)],
    )).rejects.toMatchObject({ constraint: 'agent_profile_runtime_expectations_documents_valid' });
  });

  it('requires direct adoption writes to match the current expectation and one delivery exactly once', async () => {
    const revision = await seedProfile();
    const deliveryId = await seedDelivery();
    await pool.query(
      `INSERT INTO agent_profile_runtime_expectations(
         tenant_id,alias,revision,generation,documents
       ) VALUES('Steven','argos',$1,'generation-a',$2::jsonb)`,
      [revision, JSON.stringify([document])],
    );
    const insertAdoption = (generation: string, documents: unknown, id = deliveryId) => pool.query(
      `INSERT INTO agent_profile_runtime_adoptions(
         tenant_id,alias,revision,generation,documents,delivery_id,attempt,instance_id,epoch
       ) VALUES('Steven','argos',$1,$2,$3::jsonb,$4,1,'adapter-a',1)`,
      [revision, generation, JSON.stringify(documents), id],
    );

    await expect(insertAdoption('generation-b', [document])).rejects.toMatchObject({
      constraint: 'agent_profile_runtime_adoptions_expectation',
    });
    await expect(insertAdoption('generation-a', [{ ...document, sha: 'b'.repeat(64) }]))
      .rejects.toMatchObject({ constraint: 'agent_profile_runtime_adoptions_expectation' });
    await expect(insertAdoption('generation-a', [document])).resolves.toBeDefined();

    await pool.query(
      `UPDATE agent_profile_runtime_expectations SET generation='generation-b'
        WHERE tenant_id='Steven' AND alias='argos'`,
    );
    await expect(insertAdoption('generation-b', [document])).rejects.toMatchObject({
      constraint: 'agent_profile_runtime_adoptions_delivery_id_key',
    });
  });

  it('refuses destructive down after any evidence and round-trips only while unused', async () => {
    const revision = await seedProfile();
    await pool.query(
      `INSERT INTO agent_profile_runtime_expectations(
         tenant_id,alias,revision,generation,documents
       ) VALUES('Steven','argos',$1,'generation-a',$2::jsonb)`,
      [revision, JSON.stringify([document])],
    );
    await expect(pool.query(down)).rejects.toThrow(/runtime profile evidence has been recorded/u);
    expect(await tableExists('agent_profile_runtime_expectations')).toBe(true);

    await pool.query(`DELETE FROM agent_profile_runtime_expectations`);
    await pool.query(down);
    expect(await tableExists('agent_profile_runtime_expectations')).toBe(false);
    expect(await tableExists('agent_profile_runtime_adoptions')).toBe(false);
    const functions = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_proc
        WHERE proname IN (
          'cauce_profile_runtime_documents_valid',
          'cauce_profile_runtime_adoption_matches_expectation'
        )`,
    );
    expect(functions.rows).toEqual([{ count: '0' }]);

    await ensureUp();
    expect(await tableExists('agent_profile_runtime_expectations')).toBe(true);
  });

  it('refuses down while a later migration is recorded', async () => {
    await pool.query(`INSERT INTO schema_migrations(version) VALUES('999_future.sql')`);
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    expect(await tableExists('agent_profile_runtime_expectations')).toBe(true);
  });
});
