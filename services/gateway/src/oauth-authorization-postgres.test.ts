import { createHash, generateKeyPairSync, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { applyMigrations, applyMigrationsThrough, createPool, lockHumanIdentity, resolveHumanIdentity, CauceRepository, withAbortableTransaction,
  type DatabaseClient, type DatabasePool } from '@cauce/store';
import { waitForBlocked } from '../../../tests/integration/human-identity-resolver-postgres.fixtures.js';
import { PostgresOAuthStore } from './oauth-authorization-store.js';
import { hashPassword } from './password.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { createConsoleCredentialStamp, verifyConsoleCredentialStamp } from './console-credential-stamp.js';
import Fastify from 'fastify';
import { PasswordAuthProvider } from './password-auth.js';
import { createOAuthPasswordSession } from './oauth-password-session.js';
import { createHumanMcpOperationsFactory } from './mcp-operations.js';
import { createHumanPublishAuthority, resolveHumanMcpAuthority } from './human-mcp-authority.js';
import { secretHash, type OAuthAuthorizationRequest, type OAuthPasswordSession } from './oauth-authorization-types.js';
import { OAuthTokens } from './oauth-tokens.js';

const issuer = 'https://cauce.example';
const version = '045_mcp_oauth_authorization.sql';
const previousVersion = '044_human_mcp_identity.sql';
const key = Buffer.alloc(32, 19);
const verify = (stamp: string, current: Parameters<typeof verifyConsoleCredentialStamp>[2]) => verifyConsoleCredentialStamp(key, stamp, current);
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const tokens = new OAuthTokens({ issuer, resource: `${issuer}/mcp`, kid: 'postgres-fixture', signingKey: privateKey });
const pools: DatabasePool[] = [];
let container: StartedTestContainer | undefined;
let admin: DatabasePool | undefined;
let serverUrl: string;
const context = () => ({ signal: new AbortController().signal, deadlineMs: Date.now() + 10_000 });
const upPath = new URL('../../../packages/store/migrations/045_mcp_oauth_authorization.sql', import.meta.url);
const downPath = new URL('../../../packages/store/migrations/down/045_mcp_oauth_authorization.sql', import.meta.url);

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

async function database(apply = true): Promise<DatabasePool> {
  if (!admin) throw new Error('OAuth disposable database is not initialized');
  const name = `cauce_test_oauth_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE cauce_test_oauth_template`);
  const url = new URL(serverUrl); url.pathname = `/${name}`;
  const pool = createPool(url.href, { max: 12 }); pools.push(pool);
  if (apply) await applyMigrations(pool);
  return pool;
}

function intercept(pool: DatabasePool, before?: (sql: string, client: DatabaseClient) => Promise<unknown>,
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

async function seed(pool: DatabasePool, binding = true) {
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
    // Igual que el relleno de 044: membresía desde console_users y ningún vínculo externo.
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
  const store = new PostgresOAuthStore(pool, issuer, verify);
  await store.createRequest(request, context());
  return { userId, bindingId, alias, session, request, store, passwordChangedAtUs: user.password_changed_at_us };
}

async function counts(pool: DatabasePool) {
  const result = await pool.query<{ requests: string; grants: string; codes: string; tokens: string }>(`SELECT
    (SELECT count(*) FROM cauce_oauth_requests)::text AS requests,
    (SELECT count(*) FROM cauce_oauth_grants)::text AS grants,
    (SELECT count(*) FROM cauce_oauth_codes)::text AS codes,
    (SELECT count(*) FROM cauce_oauth_tokens)::text AS tokens`);
  return result.rows[0];
}

async function consent(f: Awaited<ReturnType<typeof seed>>) {
  return f.store.consent(f.request.idHash, f.request.browserHash, f.session, ['cauce.read', 'cauce.publish'], context());
}
function exchangeInput(f: Awaited<ReturnType<typeof seed>>, code: string) {
  return { codeHash: secretHash(code), clientId: f.request.clientId, redirectUri: f.request.redirectUri, resource: tokens.resource, challenge: f.request.challenge };
}
async function authorized(pool: DatabasePool) {
  const f = await seed(pool); const result = await consent(f);
  if (!result.code) throw new Error('fixture consent did not issue a code');
  const input = exchangeInput(f, result.code);
  const issued = await f.store.exchange(input, value => tokens.issue(value), context());
  return { ...f, input, issued };
}

async function transaction(client: DatabaseClient, work: () => Promise<void>) {
  await client.query('BEGIN');
  try { await work(); await client.query('COMMIT'); }
  catch (error) { await client.query('ROLLBACK'); throw error; }
}
async function pid(client: DatabaseClient) {
  const value = (await client.query<{ pid: number }>('SELECT pg_backend_pid() AS pid')).rows[0]?.pid;
  if (!value) throw new Error('missing fixture backend PID'); return value;
}
function barrier() {
  let release: () => void = () => undefined;
  const promise = new Promise<void>(resolve => { release = resolve; }); return { promise, release };
}

 describe.sequential('OAuth durable PostgreSQL authority', () => {
  it('applies four empty tables and its checksum atomically, leaving 044 unchanged', async () => {
    const pool = await database(false);
    const broken = intercept(pool, async sql => sql.includes('CREATE DOMAIN cauce_oauth_scopes') ? `${sql}\nSELECT 1/0;` : undefined);
    await expect(applyMigrations(broken)).rejects.toThrow('division by zero');
    expect((await pool.query('SELECT to_regclass(\'cauce_oauth_grants\') AS name')).rows[0]).toEqual({ name: null });
    expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rowCount).toBe(0);
    await applyMigrations(pool);
    expect(await counts(pool)).toEqual({ requests: '0', grants: '0', codes: '0', tokens: '0' });
    await pool.query('TRUNCATE cauce_oauth_requests,cauce_oauth_grants,cauce_oauth_codes,cauce_oauth_tokens');
    expect(await counts(pool)).toEqual({ requests: '0', grants: '0', codes: '0', tokens: '0' });
    const rows = (await pool.query<{ version: string; source_sha256: string }>('SELECT version,source_sha256 FROM schema_migration_ledger WHERE version=ANY($1)', [[version, previousVersion]])).rows;
    for (const row of rows) {
      const source = await readFile(new URL(`../../../packages/store/migrations/${row.version}`, import.meta.url));
      expect(row.source_sha256).toBe(createHash('sha256').update(source).digest('hex'));
    }
    expect(rows).toHaveLength(2);
  });

  it('enforces scope, hash, challenge, stamp and TTL constraints and immutable authority', async () => {
    const pool = await database(); const f = await authorized(pool);
    for (const invalid of ['{}', '{cauce.admin}', '{cauce.read,cauce.read}']) {
      await expect(pool.query('SELECT $1::cauce_oauth_scopes', [invalid])).rejects.toThrow();
    }
    for (const [column, value] of [['id_hash', 'not-a-hash'], ['challenge', 'short']]) {
      await expect(pool.query(`INSERT INTO cauce_oauth_requests SELECT ${column === 'id_hash' ? '$1' : "repeat('f',64)"},browser_hash,client_id,client_name,redirect_uri,resource,scopes,${column === 'challenge' ? '$1' : 'challenge'},state,created_at,expires_at,NULL FROM cauce_oauth_requests LIMIT 1`, [value])).rejects.toThrow();
    }
    await expect(pool.query(`INSERT INTO cauce_oauth_grants SELECT gen_random_uuid(),human_id,issuer,resource,client_id,redirect_uri,scopes,binding_id,binding_revision,membership_revision,tenant_id,actor_alias,'invalid',created_at,expires_at,NULL FROM cauce_oauth_grants`)).rejects.toThrow();
    await expect(pool.query(`INSERT INTO cauce_oauth_requests SELECT repeat('a',64),browser_hash,client_id,client_name,redirect_uri,resource,scopes,challenge,state,created_at,created_at+interval '5 minutes 1 microsecond',NULL FROM cauce_oauth_requests LIMIT 1`)).rejects.toThrow();
    await expect(pool.query('UPDATE cauce_oauth_grants SET credential_stamp=$1', ['z'.repeat(43)])).rejects.toThrow('immutable');
    await expect(pool.query('UPDATE cauce_oauth_codes SET consumed_at=NULL')).rejects.toThrow('immutable');
    await expect(pool.query('TRUNCATE cauce_oauth_requests,cauce_oauth_grants,cauce_oauth_codes,cauce_oauth_tokens')).rejects.toThrow('approved');
    await expect(pool.query('DELETE FROM cauce_oauth_grants')).rejects.toThrow('retention');
    expect(await f.store.validate(f.issued.identity)).toBe(true);
  });

  it('stores the original stamp and rejects a changed password with the same timestamp at every durable entry', async () => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code');
    const original = (await pool.query<{ credential_stamp: string }>('SELECT credential_stamp FROM cauce_oauth_grants')).rows[0]?.credential_stamp;
    expect(original).toBe(f.session.credentialStamp);
    const pending = exchangeInput(f, approved.code);
    const issued = await f.store.exchange(pending, value => tokens.issue(value), context());
    const second = { ...f.request, idHash: secretHash(randomUUID()) };
    await f.store.createRequest(second, context());
    const secondConsent = await f.store.consent(second.idHash, second.browserHash, f.session, ['cauce.read'], context());
    if (!secondConsent.code) throw new Error('missing unused code');
    const unused = exchangeInput(f, secondConsent.code);
    const next = { ...f.request, idHash: secretHash(randomUUID()) };
    await f.store.createRequest(next, context());
    await pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [f.userId, '$scrypt$' + 'replacement-fixture'.repeat(4)]);
    const user = await new PostgresConsoleUserStore(pool).findById(f.userId);
    expect(user?.password_changed_at_us).toBe(f.passwordChangedAtUs);
    await expect(f.store.consent(next.idHash, next.browserHash, f.session, ['cauce.read'], context())).rejects.toThrow();
    await expect(f.store.exchange(unused, value => tokens.issue(value), context())).rejects.toThrow();
    expect(await f.store.validate(issued.identity)).toBe(false);
    const authorize = createHumanPublishAuthority(issued.identity, { humanId: f.userId, tenantId: 'Steven', actorAlias: f.alias }, new AbortController().signal,
      { lock: lockHumanIdentity, verifyCredentialStamp: verify });
    await expect(withAbortableTransaction(pool, new AbortController().signal, async client => { await authorize(client); await client.query("INSERT INTO cauce_oauth_tokens VALUES(gen_random_uuid(),$1,clock_timestamp(),clock_timestamp()+interval '1 minute',NULL)", [issued.identity.grantId]); })).rejects.toThrow();
    expect(await counts(pool)).toEqual({ requests: '3', grants: '2', codes: '2', tokens: '1' });
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes WHERE code_hash=$1', [unused.codeHash])).rows[0]?.consumed_at).toBeNull();
  });

  it('uses the exact stamp returned by real PasswordAuth for a same-second PostgreSQL login', async () => {
    const pool = await database(); const f = await seed(pool);
    const originalUser = await new PostgresConsoleUserStore(pool).findById(f.userId);
    if (!originalUser) throw new Error('missing login fixture user');
    const loginNow = originalUser.password_changed_at;
    const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: key, now: () => loginNow,
      fallback: { name: 'fixture', mode: 'production', authenticateHttp: async () => { throw new Error('unexpected fallback'); }, authenticateHello: async () => { throw new Error('unexpected fallback'); } } });
    const app = Fastify(); app.post('/login', (request, reply) => provider.login(request, reply));
    const read = createOAuthPasswordSession({ provider });
    app.get('/oauth/continue', async request => {
      const original = await provider.verifiedConsoleSession(request);
      const session = await read(request);
      expect(session.credentialStamp).toBe(original?.credentialStamp);
      expect(session.issuedAt).toBe(Math.floor(originalUser.password_changed_at / 1000));
      return f.store.consent(f.request.idHash, f.request.browserHash, session, ['cauce.read'], context());
    });
    try {
      const user = await new PostgresConsoleUserStore(pool).findById(f.userId);
      const login = await app.inject({ method: 'POST', url: '/login', payload: { email: user?.email, password: 'fixture-only-passphrase' } });
      expect(login.statusCode).toBe(200);
      const response = await app.inject({ url: '/oauth/continue', headers: { cookie: String(login.headers['set-cookie']).split(';')[0] ?? '' } });
      expect(response.statusCode).toBe(200);
      expect((await counts(pool))?.grants).toBe('1');
    } finally { await app.close(); }
  });

  it('distinguishes the binding-owner FK from namespace, subject and tenant validation under locks', async () => {
    const pool = await database(); const f = await authorized(pool); const other = await seed(pool);
    const insert = `INSERT INTO cauce_oauth_grants SELECT $1,human_id,issuer,resource,client_id,redirect_uri,scopes,$2,binding_revision,membership_revision,tenant_id,actor_alias,credential_stamp,created_at,expires_at,NULL FROM cauce_oauth_grants WHERE id=$3`;
    await expect(pool.query(insert, [randomUUID(), other.bindingId, f.issued.identity.grantId])).rejects.toMatchObject({ code: '23503' });
    for (const [namespace, subject] of [['https://wrong.example', f.userId], [issuer, 'wrong-subject']]) {
      const wrong = randomUUID();
      await pool.query(`INSERT INTO human_external_identities(id,human_id,provider,namespace,subject)
        VALUES($1,$2,'oauth',$3,$4)`, [wrong, f.userId, namespace, subject]);
      const incoherent = randomUUID(); await pool.query(insert, [incoherent, wrong, f.issued.identity.grantId]);
      const bad = { ...f.issued.identity, grantId: incoherent, tokenId: randomUUID() };
      await pool.query(`INSERT INTO cauce_oauth_tokens(id,grant_id,created_at,expires_at) VALUES($1,$2,clock_timestamp(),$3)`, [bad.tokenId, incoherent, new Date(bad.expiresAt * 1000)]);
      expect(await f.store.validate(bad)).toBe(false);
      expect((await pool.query('SELECT id FROM cauce_oauth_grants WHERE id=$1', [incoherent])).rowCount).toBe(1);
    }
    await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Isa',$1)", [f.alias]);
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,'Isa',$2,'operator',ARRAY['read','route'])`, [f.userId, f.alias]);
    const wrongTenant = randomUUID();
    await pool.query(`INSERT INTO cauce_oauth_grants SELECT $1,human_id,issuer,resource,client_id,redirect_uri,scopes,binding_id,binding_revision,membership_revision,'Isa',actor_alias,credential_stamp,created_at,expires_at,NULL FROM cauce_oauth_grants WHERE id=$2`, [wrongTenant, f.issued.identity.grantId]);
    const bad = { ...f.issued.identity, grantId: wrongTenant, tokenId: randomUUID() };
    await pool.query(`INSERT INTO cauce_oauth_tokens(id,grant_id,created_at,expires_at) VALUES($1,$2,clock_timestamp(),$3)`, [bad.tokenId, wrongTenant, new Date(bad.expiresAt * 1000)]);
    expect(await f.store.validate(bad)).toBe(false);
  });

  it.each(['human_external_identities', 'human_tenant_memberships'])('never revives grants when %s reuses a revision, including a new store', async table => {
    const pool = await database(); const f = await authorized(pool);
    const where = table === 'human_external_identities' ? 'id=$1' : 'human_id=$1';
    const id = table === 'human_external_identities' ? f.bindingId : f.userId;
    await pool.query(`UPDATE ${table} SET enabled=false,revoked_at=clock_timestamp(),revision=1 WHERE ${where}`, [id]);
    expect(await f.store.validate(f.issued.identity)).toBe(false);
    await expect(pool.query(`UPDATE ${table} SET enabled=true,revoked_at=NULL,revision=1 WHERE ${where}`, [id])).rejects.toThrow('cannot decrease');
    await pool.query(`UPDATE ${table} SET enabled=true,revoked_at=NULL WHERE ${where}`, [id]);
    expect((await pool.query<{ revision: string }>(`SELECT revision::text FROM ${table} WHERE ${where}`, [id])).rows[0]?.revision).toBe('3');
    expect(await new PostgresOAuthStore(pool, issuer, verify).validate(f.issued.identity)).toBe(false);
  });

  it('takes account then binding locks before membership, and checks expiration after waiting', async () => {
    const pool = await database(); const f = await seed(pool); const locker = await pool.connect(); const observer = await pool.connect();
    let workerPid = 0; const entered = barrier();
    const wrapped = intercept(pool, async (sql, client) => {
      if (sql.includes('FROM human_external_identities') && sql.includes('FOR SHARE')) { workerPid = await pid(client); entered.release(); }
    });
    await locker.query('BEGIN'); await locker.query('SELECT id FROM human_external_identities WHERE id=$1 FOR UPDATE', [f.bindingId]);
    const shortSession = { ...f.session, expiresAt: (Date.now() + 250) / 1000 };
    const operation = new PostgresOAuthStore(wrapped, issuer, verify).consent(f.request.idHash, f.request.browserHash, shortSession, ['cauce.read'], context());
    const rejected = expect(operation).rejects.toThrow();
    try {
      await entered.promise; await waitForBlocked(observer, workerPid);
      await observer.query('BEGIN');
      await observer.query("SELECT human_id FROM human_tenant_memberships WHERE human_id=$1 FOR UPDATE NOWAIT", [f.userId]);
      await observer.query('ROLLBACK');
      await observer.query('SELECT pg_sleep(0.3)'); await locker.query('COMMIT'); await rejected;
      expect(await counts(pool)).toEqual({ requests: '1', grants: '0', codes: '0', tokens: '0' });
    } finally { await locker.query('ROLLBACK'); await observer.query('ROLLBACK'); locker.release(); observer.release(); }
  });

  it('serializes two consents and two code exchanges into one durable result each', async () => {
    const pool = await database(); const f = await seed(pool);
    const approved = await Promise.allSettled([consent(f), consent(f)]);
    expect(approved.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    const success = approved.find(value => value.status === 'fulfilled');
    if (success?.status !== 'fulfilled' || !success.value.code) throw new Error('missing successful consent');
    const input = exchangeInput(f, success.value.code);
    const results = await Promise.allSettled([f.store.exchange(input, value => tokens.issue(value), context()), f.store.exchange(input, value => tokens.issue(value), context())]);
    expect(results.filter(value => value.status === 'fulfilled')).toHaveLength(1);
    expect(await counts(pool)).toEqual({ requests: '1', grants: '1', codes: '1', tokens: '1' });
  });

  it('publishes and reads a real MCP receipt with the local grant, then blocks a stale stamp before business effects', async () => {
    const pool = await database(); const f = await authorized(pool);
    await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled) VALUES('Steven','grp.steven',$1,'operator',true)`, [f.alias]);
    const repository = new CauceRepository(pool);
    const factory = createHumanMcpOperationsFactory({ repository, pool,
      identityStore: { resolve: (identity, signal) => resolveHumanIdentity(pool, identity, signal), lock: lockHumanIdentity, verifyCredentialStamp: verify },
      priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined });
    const operations = await factory.forRequest(f.issued.identity, new AbortController().signal);
    const command = { request_key: randomUUID(), room_id: 'grp.steven', recipients: [{ tenant_id: 'Steven' as const, alias: 'argos' }], body: { text: 'OAuth disposable MCP fixture' } };
    const published = await operations.submit(command);
    const receipt = await operations.receipt(published.message_id);
    expect(receipt.message_id).toBe(published.message_id);
    expect(receipt.deliveries).toHaveLength(1);
    const durable = await pool.query(`SELECT (SELECT count(*) FROM messages)::int AS messages,
      (SELECT count(*) FROM human_message_initiators)::int AS initiators,(SELECT count(*) FROM deliveries)::int AS deliveries`);
    expect(durable.rows[0]).toEqual({ messages: 1, initiators: 1, deliveries: 1 });
    await pool.query('UPDATE console_users SET password_hash=$2 WHERE id=$1', [f.userId, '$scrypt$' + 'fixture-rotation'.repeat(5)]);
    await expect(operations.submit({ ...command, request_key: randomUUID() })).rejects.toThrow();
    await expect(operations.receipt(published.message_id)).rejects.toThrow();
    expect((await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM messages')).rows[0]?.count).toBe(1);
  });

  it.each(['request', 'code', 'grant'] as const)('rejects %s expiration while waiting on the corresponding row lock', async kind => {
    const pool = await database(); const f = await seed(pool); const modified = intercept(pool, async sql => {
      if (kind === 'request') return sql.replace("at+interval '5 minutes'", "at+interval '250 milliseconds'");
      if (kind === 'code') return sql.replace("at+interval '60 seconds'", "at+interval '250 milliseconds'");
      return sql.replace("at+interval '8 hours'", "at+interval '250 milliseconds'");
    });
    const store = new PostgresOAuthStore(modified, issuer, verify);
    const request = { ...f.request, idHash: secretHash(randomUUID()) };
    await store.createRequest(request, context());
    const approved = kind === 'request' ? undefined : await store.consent(request.idHash, request.browserHash, f.session, ['cauce.read'], context());
    const grant = kind === 'grant' ? (await pool.query<{ id: string }>('SELECT id FROM cauce_oauth_grants LIMIT 1')).rows[0]?.id : undefined;
    const locker = await pool.connect(); const observer = await pool.connect();
    const entered = barrier(); let workerPid = 0;
    const wrapped = intercept(pool, async (sql, client) => {
      const target = kind === 'request' ? 'FROM cauce_oauth_requests WHERE' : kind === 'code' ? 'SELECT challenge FROM cauce_oauth_codes' : 'FROM cauce_oauth_grants g';
      if (sql.includes(target) && sql.includes('FOR ')) { workerPid = await pid(client); entered.release(); }
    });
    const table = kind === 'request' ? 'cauce_oauth_requests' : kind === 'code' ? 'cauce_oauth_codes' : 'cauce_oauth_grants';
    const column = kind === 'request' ? 'id_hash' : kind === 'code' ? 'code_hash' : 'id';
    const id = kind === 'request' ? request.idHash : kind === 'code' ? secretHash(approved?.code ?? '') : grant;
    await locker.query('BEGIN'); await locker.query(`SELECT ${column} FROM ${table} WHERE ${column}=$1 FOR UPDATE`, [id]);
    const waitingStore = new PostgresOAuthStore(wrapped, issuer, verify);
    const work = kind === 'request' ? waitingStore.consent(request.idHash, request.browserHash, f.session, ['cauce.read'], context())
      : waitingStore.exchange(exchangeInput(f, approved?.code ?? ''), value => tokens.issue(value), context());
    const rejection = expect(work).rejects.toThrow();
    try {
      await entered.promise; await waitForBlocked(observer, workerPid); await observer.query('SELECT pg_sleep(0.3)');
      await locker.query('COMMIT'); await rejection;
      expect((await counts(pool))?.tokens).toBe('0');
      if (kind === 'request') expect((await counts(pool))?.grants).toBe('0');
    } finally { await locker.query('ROLLBACK'); locker.release(); observer.release(); }
  });

  it.each(['before checkout', 'during lock', 'after insert'])('aborts consent %s without partial durable rows', async point => {
    const pool = await database(); const f = await seed(pool); const controller = new AbortController();
    const signal = { signal: controller.signal, deadlineMs: Date.now() + 10_000 };
    if (point === 'before checkout') controller.abort();
    const wrapped = intercept(pool, async sql => { if (point === 'during lock' && sql.includes('FOR SHARE')) controller.abort(); },
      async sql => { if (point === 'after insert' && sql.includes('INSERT INTO cauce_oauth_codes')) controller.abort(); });
    await expect(new PostgresOAuthStore(wrapped, issuer, verify).consent(f.request.idHash, f.request.browserHash, f.session, ['cauce.read'], signal)).rejects.toMatchObject({ name: 'AbortError' });
    expect(await counts(pool)).toEqual({ requests: '1', grants: '0', codes: '0', tokens: '0' });
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_requests')).rows[0]?.consumed_at).toBeNull();
  });

  it.each(['consent', 'exchange'] as const)('cancels %s while PostgreSQL confirms the worker is blocked on a lock', async operation => {
    const pool = await database(); const f = await seed(pool);
    const approved = operation === 'exchange' ? await consent(f) : undefined;
    const grantId = operation === 'exchange' ? (await pool.query<{ id: string }>('SELECT id FROM cauce_oauth_grants')).rows[0]?.id : undefined;
    const controller = new AbortController(); const entered = barrier(); let workerPid = 0;
    const wrapped = intercept(pool, async (sql, client) => {
      const target = operation === 'consent' ? 'FROM human_external_identities' : 'FROM cauce_oauth_grants g';
      if (sql.includes(target) && sql.includes('FOR SHARE')) { workerPid = await pid(client); entered.release(); }
    });
    const locker = await pool.connect(); const observer = await pool.connect(); await locker.query('BEGIN');
    if (operation === 'consent') await locker.query('SELECT id FROM human_external_identities WHERE id=$1 FOR UPDATE', [f.bindingId]);
    else await locker.query('SELECT id FROM cauce_oauth_grants WHERE id=$1 FOR UPDATE', [grantId]);
    const store = new PostgresOAuthStore(wrapped, issuer, verify); const signal = { signal: controller.signal, deadlineMs: Date.now() + 10_000 };
    const work = operation === 'consent' ? store.consent(f.request.idHash, f.request.browserHash, f.session, ['cauce.read'], signal)
      : store.exchange(exchangeInput(f, approved?.code ?? ''), value => tokens.issue(value), signal);
    const rejected = expect(work).rejects.toMatchObject({ name: 'AbortError' });
    try {
      await entered.promise; await waitForBlocked(observer, workerPid); controller.abort(); await rejected;
      expect((await counts(pool))?.tokens).toBe('0');
      if (operation === 'consent') expect((await counts(pool))?.grants).toBe('0');
      else expect((await observer.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes')).rows[0]?.consumed_at).toBeNull();
    } finally { await locker.query('ROLLBACK'); locker.release(); observer.release(); }
  });

  it.each(['before checkout', 'after insert'] as const)('aborts exchange %s without consuming its code', async point => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code'); const controller = new AbortController();
    if (point === 'before checkout') controller.abort();
    const wrapped = intercept(pool, undefined, async sql => { if (sql.includes('INSERT INTO cauce_oauth_tokens')) controller.abort(); });
    await expect(new PostgresOAuthStore(wrapped, issuer, verify).exchange(exchangeInput(f, approved.code), value => tokens.issue(value),
      { signal: controller.signal, deadlineMs: Date.now() + 10_000 })).rejects.toMatchObject({ name: 'AbortError' });
    expect((await counts(pool))?.tokens).toBe('0');
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes')).rows[0]?.consumed_at).toBeNull();
  });

  it('determines a failed COMMIT by observing rollback and allows the unconsumed code to retry', async () => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code'); const input = exchangeInput(f, approved.code);
    const wrapped = intercept(pool, async sql => { if (sql === 'COMMIT') throw new Error('fixture commit was not sent'); });
    await expect(new PostgresOAuthStore(wrapped, issuer, verify).exchange(input, value => tokens.issue(value), context())).rejects.toThrow('not sent');
    expect((await counts(pool))?.tokens).toBe('0');
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes')).rows[0]?.consumed_at).toBeNull();
    await expect(f.store.exchange(input, value => tokens.issue(value), context())).resolves.toHaveProperty('identity');
  });

  it('rolls back signing failure and observes a confirmed commit after a lost response', async () => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code'); const input = exchangeInput(f, approved.code);
    await expect(f.store.exchange(input, () => { throw new Error('fixture signing failure'); }, context())).rejects.toThrow('signing failure');
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_codes')).rows[0]?.consumed_at).toBeNull();
    const controller = new AbortController();
    const wrapped = intercept(pool, undefined, async sql => { if (sql === 'COMMIT') controller.abort(); });
    const issued = await new PostgresOAuthStore(wrapped, issuer, verify).exchange(input, value => tokens.issue(value), { signal: controller.signal, deadlineMs: Date.now() + 10_000 });
    expect(issued.identity.grantId).toBeDefined();
    expect(await counts(pool)).toEqual({ requests: '1', grants: '1', codes: '1', tokens: '1' });
    await expect(f.store.exchange(input, value => tokens.issue(value), context())).rejects.toThrow('invalid_grant');
  });

  it.each(['down first', 'insert first'])('serializes INSERT/down with locks before checking emptiness: %s', async order => {
    const pool = await database(); const down = await readFile(downPath, 'utf8');
    const split = down.indexOf('DO $$'); const prefix = down.slice(0, split); const rest = down.slice(split);
    const request: OAuthAuthorizationRequest = { idHash: secretHash(randomUUID()), browserHash: secretHash(randomUUID()), clientId: 'https://client.example/doc', clientName: 'Fixture',
      redirectUri: 'https://client.example/callback', resource: tokens.resource, scopes: ['cauce.read'], challenge: 'x'.repeat(43), state: null };
    const client = await pool.connect(); const observer = await pool.connect();
    const reached = barrier(); const resume = barrier(); let workerPid = 0;
    const wrapped = intercept(pool, async (sql, connection) => {
      if (sql.includes('INSERT INTO cauce_oauth_requests')) { workerPid = await pid(connection); if (order === 'down first') reached.release(); }
    }, async sql => { if (order === 'insert first' && sql.includes('INSERT INTO cauce_oauth_requests')) { reached.release(); await resume.promise; } });
    const store = new PostgresOAuthStore(wrapped, issuer, verify);
    await client.query('BEGIN');
    try {
      if (order === 'down first') {
        await client.query(prefix);
        const insertion = store.createRequest(request, context()); const rejected = expect(insertion).rejects.toThrow();
        await reached.promise; await waitForBlocked(observer, workerPid);
        await client.query(rest); await client.query('COMMIT'); await rejected;
        expect((await observer.query<{ name: string | null }>("SELECT to_regclass('cauce_oauth_requests') AS name")).rows[0]?.name).toBeNull();
      } else {
        const insertion = store.createRequest(request, context()); await reached.promise;
        const downPid = await pid(client); const locking = client.query(prefix);
        await waitForBlocked(observer, downPid); resume.release(); await insertion; await locking;
        await expect(client.query(rest)).rejects.toThrow('data-retention'); await client.query('ROLLBACK');
        expect(await counts(pool)).toEqual({ requests: '1', grants: '0', codes: '0', tokens: '0' });
      }
    } finally { resume.release(); await client.query('ROLLBACK'); client.release(); observer.release(); }
  });

  it('observes an uncertain COMMIT through another connection and rejects replay', async () => {
    const pool = await database(); const f = await seed(pool); const approved = await consent(f);
    if (!approved.code) throw new Error('missing code'); const input = exchangeInput(f, approved.code);
    const wrapped = intercept(pool, undefined, async sql => { if (sql === 'COMMIT') throw new Error('fixture lost commit acknowledgement'); });
    await expect(new PostgresOAuthStore(wrapped, issuer, verify).exchange(input, value => tokens.issue(value), context())).rejects.toThrow('lost commit acknowledgement');
    expect(await counts(pool)).toEqual({ requests: '1', grants: '1', codes: '1', tokens: '1' });
    await expect(f.store.exchange(input, value => tokens.issue(value), context())).rejects.toThrow('invalid_grant');
  });

  it('does not grant runtime DELETE, TRUNCATE or DDL privileges through the migration', async () => {
    const pool = await database();
    await pool.query('CREATE ROLE oauth_fixture_runtime');
    try {
      await pool.query('GRANT SELECT,INSERT,UPDATE ON cauce_oauth_requests,cauce_oauth_grants,cauce_oauth_codes,cauce_oauth_tokens TO oauth_fixture_runtime');
      const result = await pool.query<{ insert: boolean; delete: boolean; truncate: boolean; owner: boolean }>(`SELECT
        has_table_privilege('oauth_fixture_runtime','cauce_oauth_grants','INSERT') AS insert,
        has_table_privilege('oauth_fixture_runtime','cauce_oauth_grants','DELETE') AS delete,
        has_table_privilege('oauth_fixture_runtime','cauce_oauth_grants','TRUNCATE') AS truncate,
        tableowner='oauth_fixture_runtime' AS owner FROM pg_tables WHERE tablename='cauce_oauth_grants'`);
      expect(result.rows[0]).toEqual({ insert: true, delete: false, truncate: false, owner: false });
    } finally { await pool.query('DROP OWNED BY oauth_fixture_runtime'); await pool.query('DROP ROLE oauth_fixture_runtime'); }
  });

  it('creates the local binding at consent and resolves a fresh console user end to end without manual inserts', async () => {
    const pool = await database(); const f = await seed(pool, false);
    expect((await pool.query('SELECT 1 FROM human_external_identities WHERE human_id=$1', [f.userId])).rowCount).toBe(0);
    const approved = await consent(f);
    if (!approved.code) throw new Error('missing code');
    const binding = (await pool.query<{ namespace: string; subject: string; enabled: boolean }>(
      'SELECT namespace,subject,enabled FROM human_external_identities WHERE human_id=$1', [f.userId])).rows;
    expect(binding).toEqual([{ namespace: issuer, subject: f.userId, enabled: true }]);
    const issued = await f.store.exchange(exchangeInput(f, approved.code), value => tokens.issue(value), context());
    expect(issued.identity.subject).toBe(f.userId);
    expect(await f.store.validate(issued.identity)).toBe(true);
    const authority = await resolveHumanMcpAuthority({ pool }, issued.identity, new AbortController().signal);
    expect(authority).toMatchObject({ userId: f.userId, scopes: ['cauce.read', 'cauce.publish'],
      principal: { tenant_id: 'Steven', alias: f.alias, operator_id: `console:${f.userId}`, channel: 'human-mcp' } });
    const second = { ...f.request, idHash: secretHash(randomUUID()) };
    await f.store.createRequest(second, context());
    expect((await f.store.consent(second.idHash, second.browserHash, f.session, ['cauce.read'], context())).code).toBeDefined();
    expect((await pool.query('SELECT 1 FROM human_external_identities WHERE human_id=$1', [f.userId])).rowCount).toBe(1);
  });

  it('refuses consent for a revoked or foreign binding and leaves no grant behind', async () => {
    const pool = await database(); const revoked = await seed(pool, false); const foreign = await seed(pool, false);
    await pool.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject,enabled,revoked_at)
      VALUES ($1::uuid,'oauth',$2,$1::text,false,clock_timestamp())`, [revoked.userId, issuer]);
    await pool.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject)
      VALUES ($1,'oauth',$2,$3)`, [revoked.userId, issuer, foreign.userId]);
    for (const f of [revoked, foreign]) await expect(consent(f)).rejects.toThrow('access_denied');
    expect((await counts(pool))?.grants).toBe('0');
    expect((await pool.query<{ consumed_at: Date | null }>('SELECT consumed_at FROM cauce_oauth_requests WHERE consumed_at IS NOT NULL')).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM human_external_identities WHERE human_id=$1', [foreign.userId])).rowCount).toBe(0);
  });

  it('persists dynamic clients, reads them back and purges only stale never-granted registrations past the soft cap', async () => {
    const pool = await database(); const f = await seed(pool);
    const registered = await f.store.registerClient({ clientName: 'Inspector', redirectUris: ['http://localhost/oauth/callback'],
      grantTypes: ['authorization_code', 'refresh_token'] }, context());
    expect(registered.clientId).toMatch(/^cauce-dcr-/u);
    expect(await f.store.registeredClient(registered.clientId, context())).toEqual({ clientId: registered.clientId,
      clientName: 'Inspector', redirectUris: ['http://localhost/oauth/callback'] });
    expect(await f.store.registeredClient('cauce-dcr-00000000-0000-4000-8000-000000000000', context())).toBeUndefined();
    await expect(pool.query("INSERT INTO cauce_oauth_clients(id,client_id,metadata) VALUES (gen_random_uuid(),'https://x.example/c','{}')")).rejects.toThrow();
    await pool.query(`INSERT INTO cauce_oauth_clients(id,client_id,metadata,created_at)
      SELECT gen_random_uuid(),'cauce-dcr-'||gen_random_uuid(),'{"redirect_uris":["http://localhost/cb"]}',clock_timestamp()-interval '2 days'
      FROM generate_series(1,1000)`);
    const used = (await pool.query<{ client_id: string }>('SELECT client_id FROM cauce_oauth_clients WHERE client_id<>$1 ORDER BY created_at LIMIT 1', [registered.clientId])).rows[0]?.client_id;
    await consent(f);
    await pool.query(`INSERT INTO cauce_oauth_grants SELECT gen_random_uuid(),human_id,issuer,resource,$1,redirect_uri,scopes,binding_id,binding_revision,
      membership_revision,tenant_id,actor_alias,credential_stamp,created_at,expires_at,NULL FROM cauce_oauth_grants LIMIT 1`, [used]);
    await f.store.registerClient({ clientName: null, redirectUris: ['https://app.example/cb'], grantTypes: ['authorization_code'] }, context());
    const remaining = (await pool.query<{ total: number; kept: boolean; fresh: boolean }>(`SELECT count(*)::int AS total,
      bool_or(client_id=$1) AS kept,bool_or(client_id=$2) AS fresh FROM cauce_oauth_clients`, [used, registered.clientId])).rows[0];
    expect(remaining).toEqual({ total: 902, kept: true, fresh: true });
  });

  it('drops only empty OAuth tables atomically and preserves the human ledger', async () => {
    const pool = await database(); const client = await pool.connect();
    try { await transaction(client, async () => { await client.query(await readFile(downPath, 'utf8')); }); }
    finally { client.release(); }
    expect((await pool.query("SELECT to_regclass('cauce_oauth_grants') AS oauth,to_regclass('human_external_identities') AS human")).rows[0]).toEqual({ oauth: null, human: 'human_external_identities' });
  });
});
