import { lockClientDeclarationOwner } from '../../../services/gateway/src/client-delegation-control.js';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { GenericContainer, Wait, type StartedTestContainer } from 'testcontainers';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { applyMigrations, applyMigrationsThrough, createPool, CauceRepository, lockHumanIdentity, resolveHumanIdentity,
  type DatabasePool, type DatabaseClient } from '@cauce/store';
import Fastify, { type FastifyInstance } from 'fastify';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { createConsoleCredentialStamp, verifyConsoleCredentialStamp } from '../../../services/gateway/src/console-credential-stamp.js';
import { PasswordAuthProvider, registerPasswordAuth } from '../../../services/gateway/src/password-auth.js';
import { createConsoleSecurityHook } from '../../../services/gateway/src/console-security.js';
import { registerClientDelegationRoutes } from '../../../services/gateway/src/routes/mcp-client-delegations.js';
import { PostgresOAuthStore } from '../../../services/gateway/src/oauth-authorization-store.js';
import { secretHash, type OAuthPasswordSession } from '../../../services/gateway/src/oauth-authorization-types.js';
import { OAuthTokens } from '../../../services/gateway/src/oauth-tokens.js';
import { createHumanMcpOperationsFactory } from '../../../services/gateway/src/mcp-operations.js';
import { buildTestGateway } from '../../../services/gateway/src/test-support/gateway-doubles.js';

export const issuer = 'https://cauce.example';
const key = Buffer.alloc(32, 27);
export const verify = (stamp: string, current: Parameters<typeof verifyConsoleCredentialStamp>[2]) =>
  verifyConsoleCredentialStamp(key, stamp, current);
const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const tokens = new OAuthTokens({ issuer, resource: `${issuer}/mcp`, kid: 'client-provenance-test', signingKey: privateKey });
export const controlOptions = { issuer, resource: tokens.resource, verifyCredentialStamp: verify };
export const signal = () => new AbortController().signal;
const context = () => ({ signal: signal(), deadlineMs: Date.now() + 10000 });
let container: StartedTestContainer | undefined;
let admin: DatabasePool | undefined;
let serverUrl: string;
const pools: DatabasePool[] = [];
const apps: FastifyInstance[] = [];
beforeAll(async () => {
  if (process.env.DOCKER_HOST && !process.env.DOCKER_HOST.startsWith('unix://')) {
    throw new Error('client provenance tests require their own local disposable PostgreSQL');
  }
  const password = randomUUID();
  container = await new GenericContainer('postgres:16-alpine')
    .withLabels({ 'cauce.test.owner': randomUUID(), 'cauce.test.suite': 'human-client-provenance' })
    .withEnvironment({ POSTGRES_DB: 'cauce_test_client_template', POSTGRES_USER: 'cauce_test', POSTGRES_PASSWORD: password })
    .withExposedPorts(5432).withWaitStrategy(Wait.forLogMessage('database system is ready to accept connections', 2))
    .withStartupTimeout(60000).start();
  serverUrl = `postgresql://cauce_test:${password}@${container.getHost()}:${String(container.getMappedPort(5432))}/cauce_test_client_template`;
  admin = createPool(serverUrl);
  await applyMigrations(admin);
  await seedCatalog(admin);
  console.info('Client provenance disposable PostgreSQL', container.getId(), (await admin.query('SELECT version()')).rows[0]);
}, 90000);
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  await Promise.all(pools.splice(0).map(pool => pool.end()));
});
afterAll(async () => { await admin?.end(); await container?.stop(); });
async function seedCatalog(pool: DatabasePool): Promise<void> {
  await pool.query("INSERT INTO agents(tenant_id,alias) VALUES('Steven','kant'),('Steven','argos') ON CONFLICT DO NOTHING");
  await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES
    ('Steven','grp.steven','kant','operator'),('Steven','grp.steven','argos','agent')
    ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET enabled=true,role=EXCLUDED.role`);
}
async function createDatabase(template: 'template0' | 'cauce_test_client_template'): Promise<DatabasePool> {
  if (!admin) throw new Error('fixture database unavailable');
  const name = `cauce_test_client_${randomUUID().replaceAll('-', '')}`;
  await admin.query(`CREATE DATABASE ${name} TEMPLATE ${template}`);
  const url = new URL(serverUrl); url.pathname = `/${name}`;
  const pool = createPool(url.href, { max: 12 }); pools.push(pool); return pool;
}
export async function database(): Promise<DatabasePool> { return createDatabase('cauce_test_client_template'); }
export async function databaseThrough(version: '046_human_client_provenance.sql'): Promise<DatabasePool> {
  const pool = await createDatabase('template0');
  await applyMigrationsThrough(pool, version);
  await seedCatalog(pool);
  return pool;
}
export async function seed(pool: DatabasePool) {
  const humanId = randomUUID(); const alias = 'kant'; const email = `${humanId}@example.invalid`;
  await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias,active)
    VALUES($1,$2,$2,$3,'Fixture human','operator','Steven',$4,true)`,
  [humanId, email, await hashPassword('fixture-only-passphrase', { cost: 1024, blockSize: 8, parallelism: 1 }), alias]);
  await pool.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject)
    VALUES($1::uuid,'oauth',$2,$1::text)`, [humanId, issuer]);
  await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'Steven',$2,'operator',ARRAY['read','route'])`, [humanId, alias]);
  const users = new PostgresConsoleUserStore(pool); const user = await users.findById(humanId);
  if (!user?.password_changed_at_us) throw new Error('missing fixture account');
  const credentialStamp = createConsoleCredentialStamp(key, { userId: humanId, passwordHash: user.password_hash,
    passwordChangedAtUs: user.password_changed_at_us });
  const session: OAuthPasswordSession = { userId: humanId, credentialStamp, csrf: 'c'.repeat(43),
    issuedAt: Math.floor(Date.now() / 1000), expiresAt: Math.floor(Date.now() / 1000) + 3600 };
  const store = new PostgresOAuthStore(pool, issuer, verify);
  return { humanId, alias, email, users, session, store };
}
export async function connection(pool: DatabasePool, owner: Awaited<ReturnType<typeof seed>>,
  clientId = 'https://chatgpt.com/oauth/client.json') {
  const request = { idHash: secretHash(randomUUID()), browserHash: secretHash(randomUUID()), clientId,
    clientName: 'Fixture', redirectUri: 'https://client.example/callback', resource: tokens.resource,
    scopes: ['cauce.read', 'cauce.publish'] as const, challenge: 'x'.repeat(43), state: 'fixture-state' };
  await owner.store.createRequest(request, context());
  const consent = await owner.store.consent(request.idHash, request.browserHash, owner.session, request.scopes, context());
  if (!consent.code) throw new Error('fixture consent failed');
  const issued = await owner.store.exchange({ codeHash: secretHash(consent.code), clientId, redirectUri: request.redirectUri,
    resource: tokens.resource, challenge: request.challenge }, input => tokens.issue(input), context());
  const repository = new CauceRepository(pool);
  const factory = createHumanMcpOperationsFactory({ pool, repository, identityStore: {
    resolve: (id, requestSignal) => resolveHumanIdentity(pool, id, requestSignal), lock: lockHumanIdentity,
    verifyCredentialStamp: verify }, priorityLog: { info: () => undefined, warn: () => undefined }, logRedaction: () => undefined });
  const identity = { ...issued.identity, authorizationServer: 'local' as const };
  const operations = await factory.forRequest(identity, signal());
  return { identity, operations, repository, factory };
}
export async function consoleApp(pool: DatabasePool, owner: Awaited<ReturnType<typeof seed>>, withPublishing = false) {
  const provider = new PasswordAuthProvider({ users: owner.users, signingKey: key });
  const app = withPublishing
    ? await buildTestGateway({ pool, repository: new CauceRepository(pool), authProvider: provider, consoleOrigins: [issuer] })
    : Fastify();
  apps.push(app);
  if (!withPublishing) {
    app.addHook('onRequest', createConsoleSecurityHook({ allowedOrigins: [issuer] }));
    registerPasswordAuth(app, provider);
  }
  registerClientDelegationRoutes(app, pool, provider, controlOptions);
  const login = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: issuer },
    payload: { email: owner.email, password: 'fixture-only-passphrase' } });
  const cookie = login.headers['set-cookie'];
  if (login.statusCode !== 200 || typeof cookie !== 'string') throw new Error('fixture login failed');
  const body = login.json<{ csrf_token: string }>();
  return { app, headers: { origin: issuer, cookie: cookie.split(';')[0] ?? '', 'x-csrf-token': body.csrf_token } };
}
export async function ownedTransaction<T>(pool: DatabasePool, humanId: string, work: (client: DatabaseClient) => Promise<T>) {
  const client = await pool.connect(); await client.query('BEGIN');
  try {
    await lockClientDeclarationOwner(client, humanId, issuer);
    const result = await work(client); await client.query('COMMIT'); return result;
  } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); }
}
