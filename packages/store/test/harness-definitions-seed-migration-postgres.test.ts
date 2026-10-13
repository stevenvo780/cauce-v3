import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { closeTestDatabase, startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase,
  type TestDatabase } from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
const version = '073_harness_definitions_seed.sql';
const seeded = [
  { id: 'fake2', display_name: 'Fake QA 2', capabilities: ['messages.receive', 'ack.timeline'] },
  { id: 'grok', display_name: 'Grok', capabilities: ['messages.receive', 'jobs.interactive', 'jobs.batch'] },
  { id: 'muse', display_name: 'Muse Code', capabilities: ['messages.receive', 'jobs.interactive', 'jobs.batch'] },
];
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('070_agent_quota_operations.sql'); }, 120_000);
beforeEach(async () => { current = await startTestCaseDatabase(requireValue(database, 'database')); });
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { await closeTestDatabase(database); });
describe('harness definitions seed migration', () => {
  it('preserves an operator harness created before the migration when reversing and reapplying', async () => {
    const pool = requireValue(current, 'case database').adminPool;
    const previous = (await pool.query(`INSERT INTO harness_definitions(id,display_name,command,capabilities,enabled,created_at)
      VALUES('grok','Operator Grok','operator-grok','["messages.receive"]'::jsonb,false,now()-interval '1 day') RETURNING *`)).rows;
    await applyMigrationsThrough(pool, version);
    expect((await pool.query("SELECT * FROM harness_definitions WHERE id='grok'")).rows).toEqual(previous);
    await pool.query(await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'));
    expect((await pool.query("SELECT * FROM harness_definitions WHERE id='grok'")).rows).toEqual(previous);
    expect((await pool.query("SELECT id FROM harness_definitions WHERE id IN ('muse','fake2')")).rows).toEqual([]);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([]);
    await applyMigrationsThrough(pool, version);
    expect((await pool.query("SELECT * FROM harness_definitions WHERE id='grok'")).rows).toEqual(previous);
    expect((await pool.query("SELECT id FROM harness_definitions WHERE id IN ('muse','fake2') ORDER BY id")).rows)
      .toEqual([{ id: 'fake2' }, { id: 'muse' }]);
  }, 120_000);

  it('seeds the descriptor harnesses without a reader row missing, reverses and reapplies', async () => {
    const pool = requireValue(current, 'case database').adminPool;
    expect((await pool.query("SELECT id FROM harness_definitions WHERE id IN ('grok','muse','fake2')")).rows).toEqual([]);
    await applyMigrationsThrough(pool, version);
    expect((await pool.query('SELECT id,display_name,capabilities FROM harness_definitions ORDER BY id')).rows)
      .toEqual(expect.arrayContaining(seeded));
    expect((await pool.query<{ id: string }>('SELECT id FROM harness_definitions ORDER BY id')).rows.map(row => row.id))
      .toEqual(['claude', 'codex', 'fake', 'fake2', 'grok', 'hermes', 'muse', 'openclaw', 'opencode']);
    await pool.query("INSERT INTO agents(tenant_id,alias,harness_id) VALUES('Steven','seed-canary','grok')");
    await pool.query(await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'));
    expect((await pool.query("SELECT id FROM harness_definitions WHERE id IN ('grok','muse','fake2') ORDER BY id")).rows)
      .toEqual([{ id: 'grok' }]);
    await pool.query("DELETE FROM agents WHERE tenant_id='Steven' AND alias='seed-canary'");
    await applyMigrationsThrough(pool, version);
    expect((await pool.query("SELECT id FROM harness_definitions WHERE id IN ('grok','muse','fake2') ORDER BY id")).rows)
      .toEqual([{ id: 'fake2' }, { id: 'grok' }, { id: 'muse' }]);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rows).toEqual([{ version }]);
  }, 120_000);
});
