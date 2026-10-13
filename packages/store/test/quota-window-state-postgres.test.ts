import type { QuotaSampleRequest } from '@cauce/protocol';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let repository: CauceRepository;
let clock: number;
type Window = QuotaSampleRequest['providers'][number]['windows'][number];
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabaseThrough('057_quota_environments.sql'); });
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.adminPool; repository = new CauceRepository(pool);
  clock = Date.now() - 60_000;
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref)
    VALUES('quota-first','codex','quota-first','Steven','env_path','CAUCE_TEST_QUOTA_FIRST_PATH'),
      ('quota-second','codex','quota-second','Steven','env_path','CAUCE_TEST_QUOTA_SECOND_PATH')`);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const time = (offset: number) => new Date(clock + offset).toISOString();
const window = (model: string | null = null, account = 'quota-first', overrides: Partial<Window> = {}): Window => ({
  group_key: 'default', window_key: 'week', model, account_id: account, remaining_percent: 60, ...overrides,
});
const sample = (offset: number, windows: Window[], host = 'quota-rotation'): QuotaSampleRequest => ({
  host, captured_at: time(offset), schema_version: 2, providers: [{
    provider: 'codex', ok: true, available: true, available_groups: [], limiting_groups: [], windows,
  }],
});
async function state() {
  return (await pool.query<{ model: string | null; account_id: string; remaining_percent: string; captured_at: Date }>(
    'SELECT model,account_id,remaining_percent,captured_at FROM quota_window_state ORDER BY model,account_id',
  )).rows;
}
async function historyCount(): Promise<number> {
  return (await pool.query<{ count: number }>('SELECT count(*)::integer AS count FROM quota_window_samples')).rows[0]?.count ?? 0;
}

describe('quota window identity replacement with PostgreSQL', () => {
  it('replaces model and account identities while keeping every historical sample', async () => {
    await repository.recordQuotaSample('Steven', 'kant', sample(1, [window()]));
    await repository.recordQuotaSample('Steven', 'kant', sample(2, [window('model-a')]));
    await repository.recordQuotaSample('Steven', 'kant', sample(3, [window('model-b', 'quota-second')]));
    await repository.recordQuotaSample('Steven', 'kant', sample(4, [window(null, 'quota-second')]));
    expect(await state()).toEqual([{ model: null, account_id: 'quota-second', remaining_percent: '60.00', captured_at: new Date(time(4)) }]);
    expect(await historyCount()).toBe(4);
  });

  it.each([false, true])('preserves simultaneous models with distinct observation times, reversed=%s', async reversed => {
    const windows = [window('model-a', 'quota-first', { observed_at: time(1) }), window('model-b', 'quota-first', { observed_at: time(10) })];
    await repository.recordQuotaSample('Steven', 'kant', sample(11, reversed ? windows.reverse() : windows));
    expect((await state()).map(row => row.model)).toEqual(['model-a', 'model-b']);
    const updated = [window('model-a', 'quota-first', { observed_at: time(5), remaining_percent: 55 }),
      window('model-b', 'quota-first', { observed_at: time(11), remaining_percent: 45 })];
    await repository.recordQuotaSample('Steven', 'kant', sample(12, reversed ? updated.reverse() : updated));
    expect((await state()).map(row => [row.model, row.remaining_percent, row.captured_at.toISOString()]))
      .toEqual([['model-a', '55.00', time(5)], ['model-b', '45.00', time(11)]]);
    await repository.recordQuotaSample('Steven', 'kant', sample(13, [window('model-c')]));
    expect((await state()).map(row => row.model)).toEqual(['model-c']);
    expect(await historyCount()).toBe(5);
  });

  it('does not reintroduce a replaced identity from an older or equal-time observation', async () => {
    await repository.recordQuotaSample('Steven', 'kant', sample(3, [window('model-b', 'quota-second')]));
    await repository.recordQuotaSample('Steven', 'kant', sample(2, [window('model-a')]));
    await repository.recordQuotaSample('Steven', 'kant', sample(4, [window(null, 'quota-first', { observed_at: time(3) })]));
    expect((await state()).map(row => [row.model, row.account_id])).toEqual([['model-b', 'quota-second']]);
    expect(await historyCount()).toBe(3);
  });

  it('keeps current state on an empty error report and rejects a stale exhaustion side effect', async () => {
    await repository.recordQuotaSample('Steven', 'kant', sample(3, [window('model-b', 'quota-second')]));
    const failed = sample(4, []); const provider = failed.providers[0];
    if (!provider) throw new Error('provider absent');
    provider.ok = false;
    await repository.recordQuotaSample('Steven', 'kant', failed);
    const stale = await repository.recordQuotaSample('Steven', 'kant', sample(2, [window(null, 'quota-first', {
      remaining_percent: 0, reset_at: new Date(Date.now() + 3_600_000).toISOString(),
    })]));
    expect(stale.paused_accounts).toEqual([]);
    expect((await state()).map(row => [row.model, row.account_id])).toEqual([['model-b', 'quota-second']]);
    expect((await pool.query<{ paused_until: Date | null }>("SELECT paused_until FROM provider_accounts WHERE id='quota-first'")).rows[0]?.paused_until).toBeNull();
  });

  it('isolates replacement by tenant, host, group and window', async () => {
    const first = window('model-a');
    await repository.recordQuotaSample('Steven', 'kant', sample(1, [first, { ...first, group_key: 'other' }, { ...first, window_key: 'session' }]));
    await repository.recordQuotaSample('Steven', 'kant', sample(1, [first], 'other-host'));
    await repository.recordQuotaSample('Miguel', 'janus', sample(1, [first]));
    await repository.recordQuotaSample('Steven', 'kant', sample(2, [window('model-b')]));
    expect((await state()).map(row => row.model)).toEqual(['model-a', 'model-a', 'model-a', 'model-a', 'model-b']);
  });

  it('serializes overlapping ingestions and rejects a prelocked caller without a deadlock', async () => {
    const writer = await pool.connect();
    const caller = await pool.connect();
    let pending: Promise<unknown> | undefined;
    try {
      await writer.query('BEGIN');
      await repository.recordQuotaSample('Steven', 'kant', sample(3, [window('model-b', 'quota-second')]), writer);
      await caller.query('BEGIN');
      await caller.query("SELECT * FROM provider_accounts WHERE id='quota-first' FOR SHARE");
      await expect(repository.recordQuotaSample('Steven', 'kant', sample(2, [window()]), caller))
        .rejects.toMatchObject({ code: 'conflict' });
      await caller.query('ROLLBACK');
      pending = repository.recordQuotaSample('Steven', 'kant', sample(2, [window()]));
      await expect.poll(async () => (await pool.query<{ waiting: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM pg_locks WHERE locktype='advisory' AND classid=783003013 AND NOT granted) AS waiting`,
      )).rows[0]?.waiting).toBe(true);
      await writer.query('COMMIT');
      await pending;
      expect((await state()).map(row => [row.model, row.account_id])).toEqual([['model-b', 'quota-second']]);
      expect(await historyCount()).toBe(2);
    } finally {
      await caller.query('ROLLBACK'); await writer.query('ROLLBACK');
      await pending?.catch(() => undefined);
      caller.release(); writer.release();
    }
  });

  it('rolls back every legacy write when the old five-column upsert fails after migration 057', async () => {
    await repository.recordQuotaSample('Steven', 'kant', sample(1, [window('model-a')]));
    const before = await state();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const collection = (await client.query<{ id: string }>(`INSERT INTO quota_collections
        (host,collector_tenant,collector_alias,captured_at,schema_version) VALUES('quota-rotation','Steven','kant',$1,1) RETURNING id`, [time(2)])).rows[0];
      if (!collection) throw new Error('legacy collection absent');
      await client.query("INSERT INTO quota_provider_reports(collection_id,provider,ok) VALUES($1,'codex',true)", [collection.id]);
      await client.query(`INSERT INTO quota_window_samples(collection_id,host,provider,group_key,window_key,captured_at,remaining_percent)
        VALUES($1,'quota-rotation','codex','default','week',$2,25)`, [collection.id, time(2)]);
      await expect(client.query(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,captured_at,remaining_percent)
        VALUES('Steven','quota-rotation','codex','default','week',$1,25)
        ON CONFLICT (collector_tenant,host,provider,group_key,window_key) DO UPDATE SET captured_at=EXCLUDED.captured_at`, [time(2)]))
        .rejects.toMatchObject({ code: '42P10' });
      await client.query('ROLLBACK');
      expect(await state()).toEqual(before);
      expect(await historyCount()).toBe(1);
      expect((await pool.query('SELECT 1 FROM quota_collections WHERE id=$1', [collection.id])).rowCount).toBe(0);
      expect((await pool.query('SELECT 1 FROM quota_provider_reports WHERE collection_id=$1', [collection.id])).rowCount).toBe(0);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
