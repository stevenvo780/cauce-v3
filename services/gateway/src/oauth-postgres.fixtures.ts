import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { applyMigrations, applyMigrationsThrough, createPool, type DatabaseClient, type DatabasePool } from '@cauce/store';
import { PostgresOAuthStore } from './oauth-authorization-store.js';
import { hashPassword } from './password.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { createConsoleCredentialStamp, verifyConsoleCredentialStamp } from './console-credential-stamp.js';
import { secretHash, type OAuthAuthorizationRequest, type OAuthPasswordSession } from './oauth-authorization-types.js';
import { OAuthTokens } from './oauth-tokens.js';

export const issuer = 'https://cauce.example';
const previousVersion = '044_human_mcp_identity.sql';
export const key = Buffer.alloc(32, 19);
export const verify = (stamp: string, current: Parameters<typeof verifyConsoleCredentialStamp>[2]) => verifyConsoleCredentialStamp(key, stamp, current);
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
export const tokens = new OAuthTokens({ issuer, resource: `${issuer}/mcp`, kid: 'postgres-fixture', signingKey: privateKey });
const pools: DatabasePool[] = [];
let container: StartedTestContainer | undefined;
let admin: DatabasePool | undefined;
let serverUrl: string;
export const context = () => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
const upPath = new URL('../../../packages/store/migrations/045_mcp_oauth_authorization.sql', import.meta.url);

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('OAuth fixtures require their own disposable PostgreSQL container');
  const password = randomUUID();
  container = await new GenericContainer('postgres:16-alpine')
    .withEnvironment({ POSTGRES_DB: 'cauce_test_oauth_template', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
    .withExposedPorts(5432).withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .withStartupTimeout(60_000).start();
  const url = new URL(`postgresql://cauce_test:${password}@${container.getHost()}:${String(container.getMappedPort(5432))}/cauce_test_oauth_template`);
  serverUrl = url.href;
  admin = createPool(serverUrl);
  await applyMigrationsThrough(admin, previousVersion);
  const pg = (await admin.query<{ version: string }>('SELECT version() AS version')).rows[0]?.version;
  console.info('OAuth disposable PostgreSQL', pg, 'container', container.getId());
  console.info('OAuth migration SHA256', createHash('sha256').update(await readFile(upPath)).digest('hex'));
}, 90_000);

afterEach(async () => { await Promise.all(pools.splice(0).map(pool => pool.end())); });
afterAll(async () => { if (admin) await admin.end(); if (container) await container.stop(); });

export async function database(apply: boolean | string = true): Promise<DatabasePool> {
  if (!admin) throw new Error('OAuth disposable database is not initialized');
  const name = `cauce_test_oauth_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE cauce_test_oauth_template`);
  const url = new URL(serverUrl); url.pathname = `/${name}`;
  const pool = createPool(url.href, { max: 12 }); pools.push(pool);
  if (typeof apply === 'string') await applyMigrationsThrough(pool, apply);
  else if (apply) await applyMigrations(pool);
  return pool;
}

export function intercept(pool: DatabasePool, before?: (sql: string, client: DatabaseClient) => Promise<unknown>,
  after?: (sql: string, client: DatabaseClient) => Promise<void>): DatabasePool {
  return new Proxy(pool, { get(target, field) {
    if (field === 'connect') return async () => {
      const client = await target.connect();
      return new Proxy(client, { get(connection, property) {
        if (property === 'query') return async (sql: string, values?: unknown[]) => {
          const replacement = await before?.(sql, client);
          const result = await connection.query(typeof replacement === 'string' ? replacement : sql, values);
          await after?.(sql, client);
          return result;
        };
        const member: unknown = Reflect.get(connection, property);
        return typeof member === 'function' ? (member.bind(connection) as unknown) : member;
      } });
    };
    const member: unknown = Reflect.get(target, field);
    return typeof member === 'function' ? (member.bind(target) as unknown) : member;
  } });
}

export async function seed(pool: DatabasePool, binding = true) {
  const userId = randomUUID(); const bindingId = randomUUID(); const alias = `fixture_${userId.slice(0, 8)}`;
  await pool.query('INSERT INTO agents(tenant_id,alias) VALUES ($1,$2)', ['Steven', alias]);
  await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active,password_changed_at)
    VALUES ($1,$2,$2,$4,'Fixture','operator','Steven',$3,true,clock_timestamp())`, [userId, `${userId}@example.invalid`, alias, await hashPassword('fixture-only-passphrase', { cost: 1024, blockSize: 8, parallelism: 1 })]);
  if (binding) {
    await pool.query(`INSERT INTO human_external_identities(id,human_id,provider,namespace,subject)
      VALUES ($1,$2::uuid,'oauth',$3,$2::text)`, [bindingId, userId, issuer]);
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES ($1,'Steven',$2,'operator',ARRAY['read','route'])`, [userId, alias]);
  } else {
    // Match the account backfill without an external binding.
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions,enabled,revoked_at)
      SELECT id,tenant_id,alias,role,CASE WHEN role='operator' THEN ARRAY['route','read','control','notify']::text[]
        ELSE ARRAY['read']::text[] END,active,CASE WHEN active THEN NULL ELSE now() END FROM console_users WHERE id=$1`, [userId]);
  }
  const user = await new PostgresConsoleUserStore(pool).findById(userId);
  if (!user?.password_changed_at_us) throw new Error('missing fixture credential snapshot');
  const credentialStamp = createConsoleCredentialStamp(key, { userId, passwordHash: user.password_hash, passwordChangedAtUs: user.password_changed_at_us });
  const session: OAuthPasswordSession = { userId, credentialStamp, csrf: 'c'.repeat(43), issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const request: OAuthAuthorizationRequest = { idHash: secretHash(randomUUID()), browserHash: secretHash(randomUUID()), clientId: 'https://client.example/doc',
    clientName: 'Fixture', redirectUri: 'https://client.example/callback', resource: tokens.resource, scopes: ['cauce.read', 'cauce.publish'], challenge: 'x'.repeat(43), state: 'fixture-state' };
  const store = new PostgresOAuthStore(pool, issuer, verify, { refreshSuccessor: (hash, id) => tokens.refreshSuccessor(hash, id) });
  await store.createRequest(request, context());
  return { userId, bindingId, alias, session, request, store, passwordChangedAtUs: user.password_changed_at_us };
}

export async function counts(pool: DatabasePool) {
  const result = await pool.query<{ requests: string; grants: string; codes: string; tokens: string }>(`SELECT
    (SELECT count(*) FROM cauce_oauth_requests)::text AS requests,
    (SELECT count(*) FROM cauce_oauth_grants)::text AS grants,
    (SELECT count(*) FROM cauce_oauth_codes)::text AS codes,
    (SELECT count(*) FROM cauce_oauth_tokens)::text AS tokens`);
  return result.rows[0];
}

export async function consent(f: Awaited<ReturnType<typeof seed>>) {
  return f.store.consent(f.request.idHash, f.request.browserHash, f.session, ['cauce.read', 'cauce.publish'], context());
}
export function exchangeInput(f: Awaited<ReturnType<typeof seed>>, code: string) {
  return { codeHash: secretHash(code), clientId: f.request.clientId, redirectUri: f.request.redirectUri, resource: tokens.resource, challenge: f.request.challenge };
}
export async function authorized(pool: DatabasePool) {
  const f = await seed(pool); const result = await consent(f);
  if (!result.code) throw new Error('fixture consent did not issue a code');
  const input = exchangeInput(f, result.code);
  const issued = await f.store.exchange(input, value => tokens.issue(value), context());
  return { ...f, input, issued };
}

export async function revoked(pool: DatabasePool, grantId: string) {
  return (await pool.query('SELECT 1 FROM cauce_oauth_grant_revocations WHERE grant_id=$1', [grantId])).rowCount === 1;
}
// Shorten only the replay grace window.
export function shortGrace(pool: DatabasePool) {
  return intercept(pool, async sql => sql.replaceAll("clock_timestamp()-interval '60 seconds'", "clock_timestamp()-interval '200 milliseconds'"));
}

