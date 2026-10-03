import type { DatabasePool } from '@cauce/store';
import { closeTestDatabase, startTestDatabase } from '../../helpers/postgres.js';

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

export async function openIsolatedDatabase(): Promise<{
  pool: DatabasePool; name: string; containerId?: string; close: () => Promise<void>;
}> {
  if (process.env.NODE_ENV === 'production') throw new Error('Production is not a test database environment.');
  const external = process.env.CAUCE_TEST_DATABASE_URL;
  if (external) requireTestDatabaseUrl();
  const database = await startTestDatabase();
  return {
    pool: database.pool,
    name: decodeURIComponent(new URL(database.url).pathname.slice(1)),
    ...(external ? {} : { containerId: database.container.getId() }),
    close: async () => { await closeTestDatabase(database); },
  };
}
