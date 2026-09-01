import { preparePostgresSuite } from '../../packages/store/test/postgres-suite.js';
import { randomBytes, randomUUID } from 'node:crypto';
import { applyMigrations } from '@cauce/store';
import { PostgresOidcSessionStore, type OidcSession, type PendingOidcLogin } from '../../services/gateway/src/oidc-bff.js';
import { afterAll, describe, expect, it } from 'vitest';
import { startTestDatabase, type TestDatabase } from '../helpers/postgres.js';

describe('migration 006 OIDC session DDL', () => {
  let database: TestDatabase | undefined;
  let databaseStarted = false;

  preparePostgresSuite(import.meta.url, async () => {
    database = await startTestDatabase();
    databaseStarted = true;
  });

  afterAll(async () => {
    if (!databaseStarted) return;
    if (!database) return;
    await database.pool.end();
    await database.container.stop();
  });

  it('is idempotently migration-owned and exposes the complete Telegram/OIDC shape', async () => {
    if (!database) throw new Error('PostgreSQL test database did not start');
    await applyMigrations(database.pool);
    const migration = await database.pool.query<{ version: string }>(
      `SELECT version FROM schema_migrations WHERE version=$1`,
      ['006_oidc_sessions_and_telegram_effect_safety.sql']
    );
    expect(migration.rows).toEqual([{ version: '006_oidc_sessions_and_telegram_effect_safety.sql' }]);
    const columns = await database.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name,is_nullable FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='gateway_oidc_sessions'
       ORDER BY column_name`
    );
    expect(columns.rows).toEqual(expect.arrayContaining([
      { column_name: 'encrypted_payload', is_nullable: 'NO' },
      { column_name: 'expires_at', is_nullable: 'NO' },
      { column_name: 'key_hash', is_nullable: 'NO' },
      { column_name: 'kind', is_nullable: 'NO' },
      { column_name: 'updated_at', is_nullable: 'NO' }
    ]));
    const telegramColumns = await database.pool.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name,is_nullable FROM information_schema.columns
       WHERE table_schema=current_schema() AND table_name='telegram_egress_effects'
         AND column_name IN ('chunk_count','diagnostic','diagnosed_at','replay_count','replayed_at')
       ORDER BY column_name`
    );
    expect(telegramColumns.rows).toEqual(expect.arrayContaining([
      { column_name: 'chunk_count', is_nullable: 'NO' },
      { column_name: 'diagnostic', is_nullable: 'YES' },
      { column_name: 'diagnosed_at', is_nullable: 'YES' },
      { column_name: 'replay_count', is_nullable: 'NO' },
      { column_name: 'replayed_at', is_nullable: 'YES' }
    ]));
  });

  it('stores only encrypted payloads and atomically consumes login state', async () => {
    if (!database) throw new Error('PostgreSQL test database did not start');
    const store = new PostgresOidcSessionStore(database.pool, randomBytes(32));
    await store.ready();
    const id = `login-${randomUUID()}`;
    const login: PendingOidcLogin = {
      state: `state-${randomUUID()}`,
      nonce: `nonce-${randomUUID()}`,
      codeVerifier: `verifier-${randomUUID()}`,
      returnTo: '/',
      expiresAt: Date.now() + 60_000
    };
    await store.putLogin(id, login);
    const persisted = await database.pool.query<{ key_hash: Buffer; encrypted_payload: Buffer }>(
      `SELECT key_hash,encrypted_payload FROM gateway_oidc_sessions WHERE kind='login'`
    );
    expect(persisted.rows).toHaveLength(1);
    expect(persisted.rows[0]?.key_hash.byteLength).toBe(32);
    const ciphertext = persisted.rows[0]?.encrypted_payload.toString('utf8') ?? '';
    expect(ciphertext).not.toContain(login.state);
    expect(ciphertext).not.toContain(login.codeVerifier);

    const consumed = await Promise.all([store.takeLogin(id), store.takeLogin(id)]);
    expect(consumed.filter(Boolean)).toEqual([login]);
  });

  it('authenticates durable session ciphertext and rejects database tampering', async () => {
    if (!database) throw new Error('PostgreSQL test database did not start');
    const store = new PostgresOidcSessionStore(database.pool, randomBytes(32));
    const id = `session-${randomUUID()}`;
    const session: OidcSession = {
      subject: 'operator-1',
      principal: {
        tenant_id: 'Steven',
        alias: 'kant',
        session_id: 'oidc-session',
        channel: 'console',
        roles: ['operator'],
        permissions: ['route', 'read', 'control']
      },
      accessToken: 'server-side-access',
      accessExpiresAt: Date.now() + 60_000,
      refreshToken: 'server-side-refresh',
      idToken: 'server-side-id',
      csrfToken: 'browser-csrf',
      createdAt: Date.now(),
      expiresAt: Date.now() + 120_000
    };
    await store.putSession(id, session);
    expect(await store.getSession(id)).toEqual(session);
    await database.pool.query(
      `UPDATE gateway_oidc_sessions
       SET encrypted_payload=set_byte(encrypted_payload,28,get_byte(encrypted_payload,28)#1)
       WHERE kind='session'`
    );
    await expect(store.getSession(id)).rejects.toThrow('failed authentication');
  });
});
