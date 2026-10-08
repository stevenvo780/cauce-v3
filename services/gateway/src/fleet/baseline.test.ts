import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createPool, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { trustedFleetBaseline } from './baseline.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('Test database absent');
  current = await startTestCaseDatabase(database);
  pool = createPool(current.url, { max: 1 });
  await pool.query(`INSERT INTO fleet_runtime_identities(runtime_key,tenant_id,alias,baseline,baseline_state)
    VALUES('baseline-legacy','Steven','legacy',true,'{}'),('baseline-new','Miguel','new',false,NULL)`);
});
afterEach(async () => { await pool.end(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
describe('private permanent runtime baseline authority', () => {
  it('overwrites snapshot hints with durable flags and preserves unrelated public fields using one connection', async () => {
    const client = await pool.connect();
    try {
      expect(await trustedFleetBaseline(client, [
        { runtime_key: 'baseline-legacy', tenant_id: 'Steven', alias: 'legacy', fleet_baseline: false, home_directory: '/home/dev' },
        { runtime_key: 'baseline-new', tenant_id: 'Miguel', alias: 'new', fleet_baseline: true },
        { runtime_key: null, tenant_id: 'Steven', alias: 'human', fleet_baseline: true },
      ])).toEqual([
        { runtime_key: 'baseline-legacy', tenant_id: 'Steven', alias: 'legacy', fleet_baseline: true, home_directory: '/home/dev' },
        { runtime_key: 'baseline-new', tenant_id: 'Miguel', alias: 'new', fleet_baseline: false },
        { runtime_key: null, tenant_id: 'Steven', alias: 'human' },
      ]);
    } finally { client.release(); }
  });
  it('rejects foreign alias, tenant, missing identity and identity replacement', async () => {
    const client = await pool.connect();
    try {
      for (const agent of [
        { runtime_key: 'baseline-legacy', tenant_id: 'Miguel', alias: 'legacy' },
        { runtime_key: 'baseline-legacy', tenant_id: 'Steven', alias: 'other' },
        { runtime_key: 'missing', tenant_id: 'Steven', alias: 'legacy', fleet_baseline: false },
      ]) await expect(trustedFleetBaseline(client, [agent])).rejects.toThrow('baseline authority');
    } finally { client.release(); }
    await expect(pool.query("UPDATE fleet_runtime_identities SET baseline=false,baseline_state=NULL WHERE runtime_key='baseline-legacy'"))
      .rejects.toThrow('permanent');
  });
});
