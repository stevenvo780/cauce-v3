import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, createPool, withTransaction, type DatabasePool } from '../src/index.js';
import { downsThrough } from './migration-downs.fixtures.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { provisionTestLogin, startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let admin: DatabasePool;
let runtime: DatabasePool | undefined;

preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 180_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  admin = current.adminPool;
  runtime = createPool(await provisionTestLogin(admin, current.adminUrl, 'cauce_session_test', 'cauce_runtime'));
});
afterEach(async () => { await runtime?.end(); runtime = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const sid = (): string => randomUUID();

describe('console session revocations (migration 093)', () => {
  it('lets the runtime login record, read and prune revocations but not rewrite them', async () => {
    const pool = runtime as DatabasePool;
    const id = sid();
    await pool.query(`INSERT INTO console_session_revocations(sid,human_id,not_after) VALUES($1,$2,now()+interval '1 day')`, [id, randomUUID()]);
    expect((await pool.query('SELECT sid FROM console_session_revocations WHERE sid=$1', [id])).rowCount).toBe(1);
    await expect(pool.query(`UPDATE console_session_revocations SET not_after=now() WHERE sid=$1`, [id])).rejects.toThrow(/permission denied/);
    await expect(pool.query(`INSERT INTO console_session_revocations(sid,human_id,not_after) VALUES('short',$1,now())`, [randomUUID()]))
      .rejects.toThrow(/check constraint/);
    await pool.query('DELETE FROM console_session_revocations WHERE sid=$1', [id]);
    expect((await pool.query('SELECT sid FROM console_session_revocations')).rowCount).toBe(0);
  });

  it('reverts cleanly and reapplies', async () => {
    const down = (await downsThrough('093_console_session_revocations.sql')).join('\n');
    await withTransaction(admin, client => client.query(down));
    expect((await admin.query("SELECT to_regclass('console_session_revocations') AS name")).rows[0]).toEqual({ name: null });
    expect((await admin.query("SELECT 1 FROM pg_proc WHERE proname='cauce_runtime_grants_093'")).rowCount).toBe(0);
    await applyMigrations(admin);
    expect((await admin.query("SELECT to_regclass('console_session_revocations') AS name")).rows[0]).toEqual({ name: 'console_session_revocations' });
  });
});
