import { readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { applyMigrationsThrough } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestDatabaseThrough, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { requireValue } from './helpers.js';

let database: TestDatabase | undefined;
const version = '073_harness_definitions_seed.sql';
const seeded = [
  { id: 'fake2', display_name: 'Fake QA 2', capabilities: ['messages.receive', 'ack.timeline'] },
  { id: 'grok', display_name: 'Grok', capabilities: ['messages.receive', 'jobs.interactive', 'jobs.batch'] },
  { id: 'muse', display_name: 'Muse Code', capabilities: ['messages.receive', 'jobs.interactive', 'jobs.batch'] },
];
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('070_agent_quota_operations.sql'); }, 120_000);
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
describe('harness definitions seed migration', () => {
  it('seeds the descriptor harnesses without a reader row missing, reverses and reapplies', async () => {
    const pool = requireValue(database, 'database').adminPool;
    expect((await pool.query("SELECT id FROM harness_definitions WHERE id IN ('grok','muse','fake2')")).rows).toEqual([]);
    await applyMigrationsThrough(pool, version);
    expect((await pool.query('SELECT id,display_name,capabilities FROM harness_definitions ORDER BY id')).rows)
      .toEqual(expect.arrayContaining(seeded));
    expect((await pool.query('SELECT id FROM harness_definitions ORDER BY id')).rows.map(row => row.id))
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
