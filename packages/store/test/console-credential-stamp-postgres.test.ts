import { afterAll, beforeEach, describe, expect, it } from 'vitest';
import {
  lockConsoleHuman, StoreError, type ConsoleCredentialSnapshot, type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import { createConsoleCredentialStamp, verifyConsoleCredentialStamp } from '../../../services/gateway/src/console-credential-stamp.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { resetTestDatabase, startTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedIdentity, waitForBlocked } from '../../../tests/integration/human-identity-resolver-postgres.fixtures.js';

let database: TestDatabase | undefined;
let pool: DatabasePool | undefined;

function currentPool(): DatabasePool {
  if (!pool) throw new Error('credential-stamp PostgreSQL fixture is not running');
  return pool;
}

preparePostgresSuite(import.meta.url, async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL !== undefined) {
    throw new Error('credential-stamp tests require their own disposable Testcontainers database');
  }
  database = await startTestDatabase();
  pool = database.pool;
  console.info(`credential-stamp PostgreSQL container ${database.container.getId()}`);
}, 180_000);

beforeEach(async () => {
  await resetTestDatabase(currentPool());
});

afterAll(async () => {
  if (!database || !pool) return;
  try { await pool.end(); } finally { await database.container.stop(); }
});

async function seedCredential(): Promise<{ id: string; alias: string; snapshot: ConsoleCredentialSnapshot }> {
  const account = await seedIdentity(currentPool());
  const row = (await currentPool().query<{
    id: string; password_hash: string; password_changed_at_us: string;
  }>(`SELECT id, password_hash,
      (extract(epoch FROM password_changed_at)*1000000)::numeric(20,0)::text AS password_changed_at_us
    FROM console_users WHERE id=$1`, [account.humanId])).rows[0];
  if (!row) throw new Error('credential-stamp seed row is missing');
  return { id: row.id, alias: account.alias, snapshot: Object.freeze({
    userId: row.id, passwordHash: row.password_hash, passwordChangedAtUs: row.password_changed_at_us,
  }) };
}

async function inTransaction<T>(client: DatabaseClient, action: () => Promise<T>): Promise<T> {
  await client.query('BEGIN');
  try {
    const result = await action();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}

async function connect(): Promise<DatabaseClient> {
  return currentPool().connect();
}

describe('console credential stamp against PostgreSQL', () => {
  it('accepts an unchanged password snapshot without returning its hash', async () => {
    const account = await seedCredential();
    const stamp = createConsoleCredentialStamp(Buffer.alloc(32, 11), account.snapshot);
    const client = await connect();
    try {
      const locked = await inTransaction(client, () => lockConsoleHuman(client, account.id, {
        credentialStamp: stamp,
        verifyCredentialStamp: (value, current) => verifyConsoleCredentialStamp(Buffer.alloc(32, 11), value, current),
      }));
      expect(locked.humanId).toBe(account.id);
      expect(locked.account.actorAlias).toBe(account.alias);
      expect(locked.account).not.toHaveProperty('passwordHash');
      expect(locked.account).not.toHaveProperty('password_hash');
      await expect(inTransaction(client, () => lockConsoleHuman(client, account.id, {
        credentialStamp: stamp,
        verifyCredentialStamp: () => 'truthy-is-not-a-verdict' as unknown as boolean,
      }))).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      client.release();
    }
  });

  it('rejects a hash change even when password_changed_at stays in the same microsecond', async () => {
    const account = await seedCredential();
    const stamp = createConsoleCredentialStamp(Buffer.alloc(32, 12), account.snapshot);
    await currentPool().query('UPDATE console_users SET password_hash=$2 WHERE id=$1',
      [account.id, '$scrypt$replacement-credential-hash-for-same-timestamp']);
    const updated = (await currentPool().query<{ password_changed_at_us: string }>(
      'SELECT (extract(epoch FROM password_changed_at)*1000000)::numeric(20,0)::text AS password_changed_at_us FROM console_users WHERE id=$1',
      [account.id],
    )).rows[0];
    expect(updated?.password_changed_at_us).toBe(account.snapshot.passwordChangedAtUs);
    const client = await connect();
    try {
      await expect(inTransaction(client, () => lockConsoleHuman(client, account.id, {
        credentialStamp: stamp,
        verifyCredentialStamp: (value, current) => verifyConsoleCredentialStamp(Buffer.alloc(32, 12), value, current),
      }))).rejects.toMatchObject({ code: 'forbidden' });
    } finally {
      client.release();
    }
  });

  it('holds the credential row lock through authorization and rejects the old stamp after password change commits', async () => {
    const account = await seedCredential();
    const key = Buffer.alloc(32, 13);
    const stamp = createConsoleCredentialStamp(key, account.snapshot);
    const authority = await connect();
    const updater = await connect();
    const observer = await connect();
    try {
      await authority.query('BEGIN');
      const locked = await lockConsoleHuman(authority, account.id, {
        credentialStamp: stamp,
        verifyCredentialStamp: (value, current) => verifyConsoleCredentialStamp(key, value, current),
      });
      expect(locked.humanId).toBe(account.id);
      const updatePid = (await updater.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
      if (updatePid === undefined) throw new Error('could not read the password updater backend PID');
      const update = updater.query('UPDATE console_users SET password_hash=$2 WHERE id=$1',
        [account.id, '$scrypt$concurrent-password-rotation-fixture']);
      await waitForBlocked(observer, updatePid);
      await authority.query('COMMIT');
      await update;

      await expect(inTransaction(updater, () => lockConsoleHuman(updater, account.id, {
        credentialStamp: stamp,
        verifyCredentialStamp: (value, current) => verifyConsoleCredentialStamp(key, value, current),
      }))).rejects.toBeInstanceOf(StoreError);
    } finally {
      await authority.query('ROLLBACK').catch(() => undefined);
      await updater.query('ROLLBACK').catch(() => undefined);
      observer.release();
      authority.release();
      updater.release();
    }
  });
});
