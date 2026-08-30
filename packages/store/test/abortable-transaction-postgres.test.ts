import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { requireValue } from './helpers.js';
import {
  createPool,
  withAbortableTransaction,
  type DatabasePool,
} from '../src/index.js';
import { startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let observer: DatabasePool;

beforeAll(async () => {
  database = await startTestDatabase();
  observer = database.pool;
  await observer.query(
    `CREATE TABLE IF NOT EXISTS abortable_transaction_probe(
       id integer PRIMARY KEY,
       mutated_at timestamptz NOT NULL DEFAULT now()
     )`,
  );
  await observer.query(`TRUNCATE abortable_transaction_probe`);
}, 120_000);

afterAll(async () => {
  await observer?.query(`DROP TABLE IF EXISTS abortable_transaction_probe`);
  await observer?.end();
  await database?.container.stop();
});

async function waitUntil(check: () => Promise<boolean>, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('condition did not become true before deadline');
}

describe('withAbortableTransaction', () => {
  it('destroys a running PostgreSQL backend, reaps it and prevents every late mutation', async () => {
    const pool = createPool(database.url, {
      max: 1,
      connectionTimeoutMillis: 1_000,
      applicationName: 'cauce-abortable-running-test',
    });
    const controller = new AbortController();
    let publishPid!: (pid: number) => void;
    const pidPromise = new Promise<number>((resolve) => {
      publishPid = resolve;
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on('unhandledRejection', onUnhandled);
    try {
      const operation = withAbortableTransaction(pool, controller.signal, async (client) => {
        const selected = await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid');
        publishPid(requireValue(selected.rows[0], 'selected.rows').pid);
        await client.query('SELECT pg_sleep(30)');
        await client.query(`INSERT INTO abortable_transaction_probe(id) VALUES(1)`);
      });
      const backendPid = await pidPromise;
      const startedAt = Date.now();
      controller.abort();
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
      expect(Date.now() - startedAt).toBeLessThan(2_000);

      await waitUntil(async () => {
        const activity = await observer.query<{ alive: boolean }>(
          `SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE pid=$1) AS alive`,
          [backendPid],
        );
        return activity.rows[0]?.alive === false;
      });
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect((await observer.query<{ count: string }>(
        `SELECT count(*)::text AS count FROM abortable_transaction_probe WHERE id=1`,
      )).rows[0]?.count).toBe('0');

      const endedAt = Date.now();
      await pool.end();
      expect(Date.now() - endedAt).toBeLessThan(2_000);
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      await pool.end().catch(() => undefined);
    }
  }, 30_000);

  it('cancels a queued checkout and destroys the client if the pool grants it later', async () => {
    const pool = createPool(database.url, {
      max: 1,
      connectionTimeoutMillis: 5_000,
      applicationName: 'cauce-abortable-queued-test',
    });
    const held = await pool.connect();
    const controller = new AbortController();
    try {
      const operation = withAbortableTransaction(pool, controller.signal, async () => {
        throw new Error('aborted work must never start');
      });
      controller.abort();
      await expect(operation).rejects.toMatchObject({ name: 'AbortError' });
      held.release();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const endedAt = Date.now();
      await pool.end();
      expect(Date.now() - endedAt).toBeLessThan(2_000);
    } finally {
      try {
        held.release();
      } catch {
        // The successful path already released it.
      }
      await pool.end().catch(() => undefined);
    }
  }, 15_000);
});
