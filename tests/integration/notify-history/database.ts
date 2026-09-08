import { randomUUID } from 'node:crypto';
import { applyMigrations, createPool, type DatabasePool } from '@cauce/store';

export function requireTestDatabaseUrl(): string {
  const value = process.env.CAUCE_TEST_DATABASE_URL;
  if (!value) throw new Error('CAUCE_TEST_DATABASE_URL is absent; real PostgreSQL E2E was not executed.');
  const url = new URL(value);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)
    || !/^cauce_test(?:_|$)/u.test(decodeURIComponent(url.pathname.slice(1)))
    || process.env.NODE_ENV === 'production') {
    throw new Error('Only an explicit cauce_test PostgreSQL database in a non-production environment is accepted.');
  }
  return value;
}

export async function openIsolatedDatabase(serverUrl: string): Promise<{
  pool: DatabasePool; name: string; close: () => Promise<void>;
}> {
  const admin = createPool(serverUrl, { max: 1, connectionTimeoutMillis: 3000 });
  const name = `cauce_test_notify_${randomUUID().replaceAll('-', '')}`;
  let created = false;
  let pool: DatabasePool | undefined;
  const close = async (): Promise<void> => {
    try {
      if (pool) await pool.end();
      if (created) await admin.query(`DROP DATABASE "${name}"`);
    } finally { await admin.end(); }
  };
  try {
    const result = await admin.query<{ name: string; version: string }>(
      'SELECT current_database() AS name, version() AS version');
    if (result.rows[0]?.name !== decodeURIComponent(new URL(serverUrl).pathname.slice(1))
      || !result.rows[0].version.startsWith('PostgreSQL ')) throw new Error('Test PostgreSQL identity mismatch.');
    await admin.query(`CREATE DATABASE "${name}"`);
    created = true;
    const url = new URL(serverUrl); url.pathname = `/${name}`;
    pool = createPool(url.toString(), { max: 3, connectionTimeoutMillis: 3000 });
    await applyMigrations(pool);
    return { pool, name, close };
  } catch (error) { await close(); throw error; }
}
