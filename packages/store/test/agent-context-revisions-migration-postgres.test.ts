import { preparePostgresSuite } from './postgres-suite.js';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, type DatabasePool } from '../src/index.js';
import {
  resetTestDatabase, startTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const version = '041_agent_context_revisions.sql';
const upPath = new URL(`../migrations/${version}`, import.meta.url);
const downPath = new URL(`../migrations/down/${version}`, import.meta.url);
const laterDownPath = new URL('../migrations/down/042_blobs.sql', import.meta.url);

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let up: string;
let down: string;
let laterDown: string;

async function tableExists(name: string): Promise<boolean> {
  const result = await pool.query<{ exists: boolean }>(
    'SELECT to_regclass($1) IS NOT NULL AS exists', [name],
  );
  return result.rows[0]?.exists === true;
}

async function ensureUp(): Promise<void> {
  if (!await tableExists('agent_profile_revisions')) await pool.query(up);
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

async function clearJournal(): Promise<void> {
  await pool.query('TRUNCATE TABLE agent_profile_revisions, agent_document_revisions');
}

async function seedAgent(): Promise<void> {
  await pool.query(`
    INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,
      container_name,runtime_user,home_directory,state_directory
    ) VALUES(
      'Steven','argos','claude','Argos',true,
      'ws-argos','dev','/home/dev','/home/dev/.cauce/argos'
    ) ON CONFLICT(tenant_id,alias) DO UPDATE SET enabled=true
  `);
}

async function insertProfile(summary: string): Promise<void> {
  await pool.query(
    `INSERT INTO agent_profiles(tenant_id,alias,role_summary) VALUES('Steven','argos',$1)`,
    [summary],
  );
}

interface JournalRow {
  operation: string;
  revision: string;
  role_summary: string | null;
  actor_tenant: string | null;
  actor_alias: string | null;
}

async function journal(): Promise<JournalRow[]> {
  const result = await pool.query<JournalRow>(
    `SELECT operation,revision::text,role_summary,actor_tenant,actor_alias
       FROM agent_profile_revisions ORDER BY id`,
  );
  return result.rows;
}

preparePostgresSuite(import.meta.url, async () => {
  [up, down, laterDown] = await Promise.all([
    readFile(upPath, 'utf8'), readFile(downPath, 'utf8'), readFile(laterDownPath, 'utf8'),
  ]);
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
}, 120_000);

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await ensureUp();
  await clearJournal();
  await seedAgent();
});

afterEach(async () => {
  if (!databaseStarted) return;
  await pool.query(`DELETE FROM schema_migrations WHERE version='999_future.sql'`);
  await ensureUp();
  await clearJournal();
  await applyMigrations(pool);
});

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

describe('migration 041 context journal', () => {
  /**
   * The reason 028's `agent_profiles_manage_revision` could not be reused: it is BEFORE UPDATE,
   * so the birth of a profile — the very first version anyone would want to diff against — would
   * leave no row at all.
   */
  it('records the creation of a profile, not only its later edits', async () => {
    await insertProfile('primera versión');
    expect(await journal()).toEqual([
      {
        operation: 'insert', revision: '1', role_summary: 'primera versión',
        actor_tenant: null, actor_alias: null,
      },
    ]);
  });

  it('records update and delete, and skips an update that touches none of the seven fields', async () => {
    await insertProfile('primera versión');
    await pool.query(
      `UPDATE agent_profiles SET role_summary='segunda versión'
        WHERE tenant_id='Steven' AND alias='argos'`,
    );
    // `applied_revision` advances on every runtime ACK; a journal that anotated each one would be
    // unreadable, and that advance already has its own audit_events row.
    await pool.query(
      `UPDATE agent_profiles SET applied_revision=2 WHERE tenant_id='Steven' AND alias='argos'`,
    );
    await pool.query(`DELETE FROM agent_profiles WHERE tenant_id='Steven' AND alias='argos'`);
    expect((await journal()).map((row) => [row.operation, row.revision, row.role_summary])).toEqual([
      ['insert', '1', 'primera versión'],
      ['update', '2', 'segunda versión'],
      ['delete', '2', 'segunda versión'],
    ]);
  });

  it('takes the actor from the session settings and leaves NULL when none is declared', async () => {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL cauce.actor_tenant='Steven'`);
      await client.query(`SET LOCAL cauce.actor_alias='kant'`);
      await client.query(
        `INSERT INTO agent_profiles(tenant_id,alias,role_summary)
           VALUES('Steven','argos','con actor')`,
      );
      await client.query('COMMIT');
    } finally {
      client.release();
    }
    await pool.query(
      `UPDATE agent_profiles SET role_summary='sin actor'
        WHERE tenant_id='Steven' AND alias='argos'`,
    );
    expect((await journal()).map((row) => [row.actor_tenant, row.actor_alias])).toEqual([
      ['Steven', 'kant'],
      [null, null],
    ]);
  });

  /**
   * The journal outlives the row it describes. A foreign key with ON DELETE CASCADE would delete
   * exactly the evidence this table exists to keep, which is the contrast 026:173 draws on purpose.
   */
  it('survives the removal of the agent it describes', async () => {
    await insertProfile('lo que fue');
    await pool.query(`DELETE FROM agents WHERE tenant_id='Steven' AND alias='argos'`);
    const rows = await journal();
    expect(rows.map((row) => row.operation)).toEqual(['insert', 'delete']);
    expect(rows[0]?.role_summary).toBe('lo que fue');
  });

  /** No column can hold a document body: the digest shape is upheld by the base, not by a caller. */
  it('refuses a document revision whose fingerprint is not a canonical digest', async () => {
    const insert = (sha: string | null, path = '/home/dev/CLAUDE.md') => pool.query(
      `INSERT INTO agent_document_revisions(tenant_id,alias,kind,path,sha256,bytes)
         VALUES('Steven','argos','directive',$1,$2,10)`,
      [path, sha],
    );
    await expect(insert('# CLAUDE.md\n\nun cuerpo entero de documento')).rejects.toMatchObject({
      code: '23514',
    });
    await expect(insert('A'.repeat(64))).rejects.toMatchObject({ code: '23514' });
    await expect(insert('a'.repeat(63))).rejects.toMatchObject({ code: '23514' });
    await expect(insert('a'.repeat(64), 'CLAUDE.md')).rejects.toMatchObject({ code: '23514' });
    await expect(insert(null)).resolves.toBeDefined();
    await expect(insert('a'.repeat(64))).resolves.toBeDefined();
  });

  it('refuses down while a later migration is recorded', async () => {
    await pool.query(`INSERT INTO schema_migrations(version) VALUES('999_future.sql')`);
    await expect(pool.query(down)).rejects.toThrow(/later migration/u);
    expect(await tableExists('agent_profile_revisions')).toBe(true);
  });

  it('refuses down after evidence and round-trips only while the journal is empty', async () => {
    // 042 sits above 041: it is lowered first so the guard under test is the evidence one.
    await pool.query(laterDown);
    await insertProfile('prueba que no se tira');
    await expect(pool.query(down)).rejects.toThrow(/context journal evidence/u);
    expect(await tableExists('agent_profile_revisions')).toBe(true);

    await clearJournal();
    await pool.query(down);
    expect(await tableExists('agent_profile_revisions')).toBe(false);
    expect(await tableExists('agent_document_revisions')).toBe(false);
    const leftovers = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM pg_proc
        WHERE proname='cauce_agent_profile_context_journal'`,
    );
    expect(leftovers.rows).toEqual([{ count: '0' }]);
    // With the trigger gone the profile path still works; the journal is additive, never load-bearing.
    await pool.query(
      `UPDATE agent_profiles SET role_summary='sin diario'
        WHERE tenant_id='Steven' AND alias='argos'`,
    );
    await pool.query(`DELETE FROM agent_profiles WHERE tenant_id='Steven' AND alias='argos'`);
    await ensureUp();
    expect(await tableExists('agent_profile_revisions')).toBe(true);
  });
});
