import { readFile } from 'node:fs/promises';
import { preparePostgresSuite } from './postgres-suite.js';
import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, CauceRepository, StoreError, type DatabasePool } from '../src/index.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let databaseStarted = false;
let pool: DatabasePool;
let repository: CauceRepository;

const SHA = 'c'.repeat(64);
const OTHER = 'd'.repeat(64);

function blob(overrides: Partial<Parameters<CauceRepository['registerBlob']>[0]> = {}) {
  return {
    sha256: SHA, bytes: 1_500_000_000, mediaType: 'video/mp4', name: 'demo.mp4',
    tenantId: 'Steven', createdBy: 'zeus', ...overrides,
  };
}

preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  databaseStarted = true;
  pool = database.pool;
  repository = new CauceRepository(pool);
}, 120_000);

afterAll(async () => {
  if (!databaseStarted) return;
  await pool.end();
  await database.container.stop();
});

beforeEach(async () => {
  await resetTestDatabase(pool);
  await pool.query('DELETE FROM blobs');
});

describe('blobs repository', () => {
  it('registers a blob and reads its metadata back by digest, touching last_used_at', async () => {
    const registered = await repository.registerBlob(blob());
    expect(registered.sha256).toBe(SHA);
    expect(registered.bytes).toBe(1_500_000_000);
    await pool.query(`UPDATE blobs SET last_used_at=now()-interval '2 days' WHERE sha256=$1`, [SHA]);
    const found = await repository.findBlob(SHA);
    expect(found?.media_type).toBe('video/mp4');
    expect(found?.name).toBe('demo.mp4');
    expect(found?.tenant_id).toBe('Steven');
    expect(found?.created_by).toBe('zeus');
    expect(Date.now() - found!.last_used_at.getTime()).toBeLessThan(60_000);
  });

  it('answers nothing for a digest nobody registered', async () => {
    expect(await repository.findBlob(OTHER)).toBeUndefined();
  });

  it('is idempotent for the same bytes and refuses a different size under the same digest', async () => {
    const first = await repository.registerBlob(blob());
    const again = await repository.registerBlob(blob({ createdBy: 'argos' }));
    expect(again.created_at.getTime()).toBe(first.created_at.getTime());
    expect(again.created_by).toBe('zeus');
    await expect(repository.registerBlob(blob({ bytes: 7 }))).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.registerBlob(blob({ bytes: 7 }))).rejects.toBeInstanceOf(StoreError);
  });

  it('lists blobs unused since a cutoff, oldest first, and forgets one', async () => {
    await repository.registerBlob(blob());
    await repository.registerBlob(blob({ sha256: OTHER, name: 'otro.bin', mediaType: 'application/octet-stream' }));
    await pool.query(`UPDATE blobs SET last_used_at=now()-interval '40 days' WHERE sha256=$1`, [SHA]);
    const stale = await repository.staleBlobs(new Date(Date.now() - 30 * 86_400_000), 10);
    expect(stale.map((entry) => entry.sha256)).toEqual([SHA]);
    expect(await repository.forgetBlob(SHA)).toBe(true);
    expect(await repository.forgetBlob(SHA)).toBe(false);
    expect(await repository.findBlob(OTHER)).toBeDefined();
  });

  it('has a down migration that removes the table and an up that recreates it', async () => {
    const down = await readFile(new URL('../migrations/down/042_blobs.sql', import.meta.url), 'utf8');
    await pool.query(down);
    const gone = await pool.query(`SELECT to_regclass('public.blobs') AS relation`);
    expect(gone.rows[0]?.relation).toBeNull();
    await applyMigrations(pool);
    const back = await pool.query(`SELECT to_regclass('public.blobs') AS relation`);
    expect(back.rows[0]?.relation).toBe('blobs');
  });
});
