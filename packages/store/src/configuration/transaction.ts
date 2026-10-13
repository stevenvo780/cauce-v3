import { randomUUID } from 'node:crypto';
import { withTransaction, type DatabaseClient, type DatabasePool } from '../db.js';
import { databaseError } from './shared.js';

export async function withBoundConfigurationTransaction<T>(pool: DatabasePool, client: DatabaseClient | undefined,
  work: (client: DatabaseClient) => Promise<T>): Promise<T> {
  if (client === undefined) {
    try { return await withTransaction(pool, work); }
    catch (error) { databaseError(error); }
  }
  const savepoint = `configuration_${randomUUID().replaceAll('-', '')}`;
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await work(client);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    return result;
  } catch (error) {
    await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
    await client.query(`RELEASE SAVEPOINT ${savepoint}`);
    databaseError(error);
  }
}
