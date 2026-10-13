import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { EventEmitter } from 'node:events';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from '../../../packages/store/test/companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { AuthError, AuthorizationError, DevOnlyAuthProvider, HashedTokenFileAuthProvider, validatePrincipal, type Principal } from './auth.js';
import { consoleHumanAccess, type ConsoleHumanAccess } from './console-human-authority.js';
import { consoleUserPrincipal } from './console-user-authority.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { hashPassword } from './password.js';
import { PasswordAuthProvider, signConsoleSession, type ConsoleSessionClaims } from './password-auth.js';
import { buildTestGateway } from './test-support/gateway-doubles.js';

const PASSWORD = 'company-switch-fixture-password';
const KEY = Buffer.alloc(32, 41);
const ORIGIN = 'http://localhost';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let hash: string | undefined;
let people: CompanyIsolationFixture & { team: string };
let provider: PasswordAuthProvider;
let app: FastifyInstance;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

async function person(email: string, tenant: string, alias: string, permissions: string[]): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Fixture','operator',$4,$5)`, [id, email, hash, tenant, alias]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,$2,$3,$4)`, [id, tenant, alias, permissions]);
  return id;
}

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  hash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  const seeded = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [seeded.leon]);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES('Steven','company-humanizar','zeus','operator') ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role='operator'`);
  await admin.query('UPDATE console_users SET password_hash=$1', [hash]);
  people = { ...seeded, team: await person('team@example.test', 'PraxisTeam', 'team_agent', ['read', 'control']) };
  provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: KEY });
  app = await buildTestGateway({ pool, authProvider: provider });
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

interface Session { cookie: string; token: string; csrf: string }

function sessionCookie(response: LightMyRequestResponse): string | undefined {
  const raw = response.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).find(value => value.startsWith('__Host-cauce_session='));
}
function claims(token: string): ConsoleSessionClaims {
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as ConsoleSessionClaims;
}
function session(header: string, csrf: string): Session {
  const token = decodeURIComponent(header.split(';', 1)[0]?.slice('__Host-cauce_session='.length) ?? '');
  return { cookie: `__Host-cauce_session=${token}`, token, csrf };
}
async function login(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  const header = sessionCookie(response);
  if (header === undefined) throw new Error('login returned no session cookie');
  return session(header, response.json<{ csrf_token: string }>().csrf_token);
}
function get(url: string, current: Session): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url, headers: { cookie: current.cookie } });
}
function switchTo(current: Session, company: string | null, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url: '/v3/auth/session/company', payload: { company_id: company },
    headers: { cookie: current.cookie, origin: ORIGIN, 'x-csrf-token': current.csrf, ...headers } });
}
async function switched(current: Session, company: string): Promise<Session> {
  const response = await switchTo(current, company);
  expect(response.statusCode).toBe(200);
  return session(sessionCookie(response) ?? '', current.csrf);
}
async function authority(current: Session): Promise<unknown> {
  const response = await get('/v3/auth/session', current);
  expect(response.statusCode).toBe(200);
  return response.json<{ authority?: unknown }>().authority;
}
function resigned(current: Session, change: Partial<ConsoleSessionClaims>): Session {
  const token = signConsoleSession(KEY, { ...claims(current.token), ...change });
  return { cookie: `__Host-cauce_session=${token}`, token, csrf: current.csrf };
}
function stampless(current: Session): Session {
  const { credential_stamp: _stamp, ...rest } = claims(current.token);
  const token = signConsoleSession(KEY, rest);
  return { cookie: `__Host-cauce_session=${token}`, token, csrf: current.csrf };
}
async function sessionAudits(): Promise<unknown[]> {
  return (await admin.query<Record<string, unknown>>(`SELECT company_id,actor_human_id::text,metadata FROM audit_events
    WHERE action='platform.session.company' ORDER BY id`)).rows;
}
async function humanAccess(current: Session): Promise<ConsoleHumanAccess | undefined> {
  const raw = () => Object.assign(new EventEmitter(), { destroyed: false, complete: true, writableFinished: false });
  return consoleHumanAccess(provider, { headers: { cookie: current.cookie }, raw: raw() } as unknown as FastifyRequest,
    { raw: raw() } as unknown as FastifyReply, 'read');
}
async function seedAcme(): Promise<void> {
  await withTransaction(admin, async (client) => {
    await client.query("INSERT INTO companies(id,name) VALUES('acme','Acme')");
    await client.query("INSERT INTO tenants(id,company_id,is_hub) VALUES('AcmeHub','acme',true)");
    await client.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory)
      VALUES('AcmeHub','acme_owner',true,'codex','acme-fixture','dev','/home/dev','/home/dev/.cauce')`);
    const owner = randomUUID();
    await client.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,'acme@example.test','acme@example.test',$2,'Acme','operator','AcmeHub','acme_owner')`, [owner, hash]);
    await client.query("INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('acme',$1,'owner','import',$1)", [owner]);
  });
}
const STEVEN_HOME = { role: 'platform_admin', scope: 'platform', home_company: 'humanizar', acting_company: 'humanizar', platform_override: false };

describe('console session company authority', () => {
  it('exposes the single resolver decision in the session of each person', async () => {
    expect(await authority(await login('steven@example.test'))).toEqual(STEVEN_HOME);
    expect(await authority(await login('miguel@example.test'))).toEqual({ role: 'company_owner', scope: 'company',
      home_company: 'humanizar', acting_company: 'humanizar', platform_override: false });
    expect(await authority(await login('team@example.test'))).toEqual({ role: 'tenant_operator', scope: 'tenant',
      home_company: 'praxis', acting_company: 'praxis', platform_override: false });
  });

  it('switches a platform administrator into another company without extending the session', async () => {
    const steven = await login('steven@example.test');
    const response = await switchTo(steven, 'praxis');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ authenticated: true, csrf_token: steven.csrf,
      authority: { role: 'platform_admin', acting_company: 'praxis', platform_override: true } });
    const header = sessionCookie(response) ?? '';
    const praxis = session(header, steven.csrf);
    const before = claims(steven.token);
    expect(claims(praxis.token)).toEqual({ ...before, cmp: 'praxis' });
    expect(Number(/Max-Age=(\d+)/u.exec(header)?.[1])).toBeLessThanOrEqual(before.exp - before.iat);
    expect(await authority(praxis)).toMatchObject({ acting_company: 'praxis', platform_override: true });
    const companies = await get('/v3/console/companies', praxis);
    expect(companies.json()).toMatchObject({ home_company: 'humanizar', acting_company: 'praxis',
      companies: [{ id: 'humanizar', state: 'enabled' }, { id: 'praxis', state: 'enabled' }] });
    const back = await switchTo(praxis, null);
    expect(back.statusCode).toBe(200);
    expect(claims(session(sessionCookie(back) ?? '', steven.csrf).token)).toEqual(before);
    expect(await sessionAudits()).toEqual([
      { company_id: 'praxis', actor_human_id: people.steven, metadata: { home_company: 'humanizar', acting_company: 'praxis' } },
      { company_id: 'praxis', actor_human_id: people.steven,
        metadata: { home_company: 'humanizar', acting_company: 'humanizar', previous_company: 'praxis' } },
    ]);
  });

  it('audits a switch between two foreign companies in both of them', async () => {
    await seedAcme();
    const acme = await switched(await switched(await login('steven@example.test'), 'praxis'), 'acme');
    expect(claims(acme.token).cmp).toBe('acme');
    const moved = { home_company: 'humanizar', acting_company: 'acme', previous_company: 'praxis' };
    expect(await sessionAudits()).toEqual([
      { company_id: 'praxis', actor_human_id: people.steven, metadata: { home_company: 'humanizar', acting_company: 'praxis' } },
      { company_id: 'acme', actor_human_id: people.steven, metadata: moved },
      { company_id: 'praxis', actor_human_id: people.steven, metadata: moved },
    ]);
  });

  it('ignores the company claim without the platform role and after it is revoked', async () => {
    const miguel = await login('miguel@example.test');
    const forged = resigned(miguel, { cmp: 'praxis' });
    expect(await authority(forged)).toMatchObject({ role: 'company_owner', acting_company: 'humanizar', platform_override: false });
    expect((await get('/v3/console/companies', forged)).json()).toMatchObject({ acting_company: 'humanizar',
      companies: [{ id: 'humanizar' }] });
    const refused = await switchTo(miguel, 'praxis');
    expect(refused.statusCode).toBe(403);
    expect(sessionCookie(refused)).toBeUndefined();
    const praxis = await switched(await login('steven@example.test'), 'praxis');
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [people.steven]);
    expect(await authority(praxis)).toEqual({ role: 'company_owner', scope: 'company',
      home_company: 'humanizar', acting_company: 'humanizar', platform_override: false });
    expect((await get('/v3/console/companies', praxis)).json()).toMatchObject({ acting_company: 'humanizar', companies: [{ id: 'humanizar' }] });
    expect(await sessionAudits()).toHaveLength(1);
  });

  it('drops the platform role and the claim once the home membership of the administrator stops qualifying', async () => {
    const steven = await login('steven@example.test');
    const praxis = await switched(steven, 'praxis');
    await admin.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1", [people.steven]);
    expect(await authority(praxis)).toMatchObject({ role: 'reader', scope: 'tenant', acting_company: 'humanizar', platform_override: false });
    expect((await switchTo(steven, 'praxis')).statusCode).toBe(403);
    await admin.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [people.steven]);
    expect(await authority(praxis)).toMatchObject({ role: 'none', scope: 'none', acting_company: 'humanizar', platform_override: false });
    expect((await switchTo(praxis, null)).statusCode).toBe(403);
    for (const url of ['/v3/console/companies', '/v3/console/platform/events']) expect((await get(url, praxis)).statusCode).toBe(403);
    expect(await sessionAudits()).toHaveLength(1);
  });

  it('revokes company and platform authority when durable room control is removed', async () => {
    const miguel = await login('miguel@example.test');
    const praxis = await switched(await login('steven@example.test'), 'praxis');
    await admin.query("UPDATE memberships SET role='agent' WHERE (tenant_id,alias) IN (('Steven','kant'),('Miguel','janus'))");
    expect(await authority(miguel)).toMatchObject({ role: 'reader', scope: 'tenant' });
    expect(await authority(praxis)).toMatchObject({ role: 'reader', scope: 'tenant', acting_company: 'humanizar', platform_override: false });
    expect((await get('/v3/console/platform/events', miguel)).statusCode).toBe(403);
    expect((await switchTo(praxis, 'praxis')).statusCode).toBe(403);
  });

  it('refuses the claim of a disabled or retired company instead of acting at home until the session switches back', async () => {
    const steven = await login('steven@example.test');
    const praxis = await switched(steven, 'praxis');
    for (const state of ['disabled', 'retired']) {
      await withTransaction(admin, client => client.query('SELECT cauce_platform_set_company_state($1,$2,$3)', ['praxis', state, people.steven]));
      expect((await get('/v3/auth/session', praxis)).json()).toEqual({ authenticated: false, login_mode: 'password' });
      expect((await get('/v3/console/companies', praxis)).statusCode).toBe(403);
      expect((await switchTo(steven, 'praxis')).statusCode).toBe(403);
    }
    const home = await switchTo(praxis, null);
    expect(home.statusCode).toBe(200);
    const returned = session(sessionCookie(home) ?? '', steven.csrf);
    expect(claims(returned.token).cmp).toBeUndefined();
    expect(await authority(returned)).toEqual(STEVEN_HOME);
  });

  it('scopes a company administrator to its company and refuses a person without authority', async () => {
    const zeus = await person('zeus@example.test', 'Steven', 'zeus', ['read', 'control']);
    await admin.query("INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('humanizar',$1,'admin','platform',$2)",
      [zeus, people.steven]);
    await person('none@example.test', 'Isa', 'salva', ['notify']);
    await withTransaction(admin, client => client.query("SELECT cauce_platform_set_company_state('praxis','enabled',$1)", [people.steven]));
    const administrator = await login('zeus@example.test');
    expect(await authority(administrator)).toEqual({ role: 'company_admin', scope: 'company',
      home_company: 'humanizar', acting_company: 'humanizar', platform_override: false });
    expect((await get('/v3/console/companies', administrator)).json<{ companies: { id: string }[] }>().companies
      .map(company => company.id)).toEqual(['humanizar']);
    expect((await get('/v3/console/platform/events', administrator)).json()).toEqual({ items: [], next_cursor: null });
    expect((await get('/v3/console/platform/events?company=praxis', administrator)).statusCode).toBe(403);
    expect((await switchTo(administrator, 'praxis')).statusCode).toBe(403);
    const none = await login('none@example.test');
    expect(await authority(none)).toMatchObject({ role: 'none', scope: 'none', acting_company: 'humanizar' });
    for (const url of ['/v3/console/companies', '/v3/console/platform/events']) expect((await get(url, none)).statusCode).toBe(403);
    expect((await switchTo(none, null)).statusCode).toBe(403);
    expect(await sessionAudits()).toEqual([]);
  });

  it('requires a credential stamp before any company authority', async () => {
    const legacy = stampless(await login('steven@example.test'));
    expect(await authority(legacy)).toEqual(STEVEN_HOME);
    for (const url of ['/v3/console/companies', '/v3/console/platform/events']) expect((await get(url, legacy)).statusCode).toBe(403);
    const refused = await switchTo(legacy, 'praxis');
    expect(refused.statusCode).toBe(403);
    expect(sessionCookie(refused)).toBeUndefined();
    await expect(humanAccess(legacy)).rejects.toThrow(AuthorizationError);
    expect(await sessionAudits()).toEqual([]);
  });

  it('omits the authority block instead of failing the session while a platform transaction holds the company', async () => {
    const miguel = await login('miguel@example.test');
    const praxis = await switched(await login('steven@example.test'), 'praxis');
    const holder = await admin.connect();
    try {
      await holder.query('BEGIN');
      await holder.query("SELECT 1 FROM companies WHERE id IN ('humanizar','praxis') FOR UPDATE");
      for (const held of [miguel, praxis]) {
        const response = await get('/v3/auth/session', held);
        expect(response.statusCode).toBe(200);
        expect(response.json()).toMatchObject({ authenticated: true, csrf_token: held.csrf });
        expect(response.json()).not.toHaveProperty('authority');
      }
    } finally { await holder.query('ROLLBACK'); holder.release(); }
    expect(await authority(praxis)).toMatchObject({ acting_company: 'praxis', platform_override: true });
  });

  it('requires CSRF, the console origin and a well-formed body on the switch route', async () => {
    const steven = await login('steven@example.test');
    for (const headers of [{ 'x-csrf-token': 'x'.repeat(43) }, { origin: 'https://evil.example' }]) {
      const rejected = await switchTo(steven, 'praxis', headers);
      expect(rejected.statusCode).toBe(403);
      expect(sessionCookie(rejected)).toBeUndefined();
    }
    for (const payload of [{}, { company_id: 'Praxis' }, { company_id: 'praxis', extra: true }]) {
      const invalid = await app.inject({ method: 'POST', url: '/v3/auth/session/company', payload,
        headers: { cookie: steven.cookie, origin: ORIGIN, 'x-csrf-token': steven.csrf } });
      expect(invalid.statusCode).toBe(400);
    }
    expect((await switchTo(steven, 'absent')).statusCode).toBe(403);
    expect((await app.inject({ method: 'POST', url: '/v3/auth/session/company', payload: { company_id: null },
      headers: { origin: ORIGIN } })).statusCode).toBe(401);
    expect(await sessionAudits()).toEqual([]);
  });

  it('never lets a machine principal reach company authority, not even with the identity of a platform administrator', async () => {
    const machine = await buildTestGateway({ pool, authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool),
      signingKey: KEY, fallback: DevOnlyAuthProvider.forTests({ operator: 'Steven/kant' }) }) });
    try {
      for (const [tenant, alias] of [['Steven', 'kant'], ['Miguel', 'janus']] as const) {
        const headers = { 'x-cauce-tenant': tenant, 'x-cauce-alias': alias, origin: ORIGIN };
        for (const url of ['/v3/console/companies', '/v3/console/platform/events']) {
          expect((await machine.inject({ method: 'GET', url, headers })).statusCode).toBe(403);
        }
        const refused = await machine.inject({ method: 'POST', url: '/v3/auth/session/company', headers, payload: { company_id: 'praxis' } });
        expect(refused.statusCode).toBe(401);
        expect(sessionCookie(refused)).toBeUndefined();
      }
    } finally { await machine.close(); }
    expect(await sessionAudits()).toEqual([]);
  });

  it('shows platform events to the platform and to the owners of the company they touch', async () => {
    await withTransaction(admin, client => client.query("SELECT cauce_platform_set_company_state('praxis','enabled',$1)", [people.steven]));
    const events = (current: Session, query = '') => get(`/v3/console/platform/events${query}`, current);
    const steven = await login('steven@example.test');
    expect((await events(steven)).json()).toMatchObject({ items: [{ action: 'company.state', company_id: 'praxis' },
      { action: 'platform_admin.grant', company_id: null, subject_human_id: people.steven }], next_cursor: null });
    expect((await events(steven, '?limit=1')).json()).toMatchObject({ items: [{ action: 'company.state' }], next_cursor: '2' });
    const miguel = await login('miguel@example.test');
    expect((await events(miguel)).json()).toEqual({ items: [], next_cursor: null });
    expect((await events(miguel, '?company=praxis')).statusCode).toBe(403);
    expect((await events(await login('team@example.test'))).statusCode).toBe(403);
    expect((await events(steven, '?limit=0')).statusCode).toBe(422);
  });

  it('resolves the company authority of the verified person inside the caller transaction', async () => {
    const access = await humanAccess(await switched(await login('steven@example.test'), 'praxis'));
    if (access === undefined) throw new Error('console session absent');
    try {
      expect(await withTransaction(pool, client => access.companyAuthority(client))).toEqual({ humanId: people.steven,
        homeTenant: 'Steven', alias: 'kant', homeCompany: 'humanizar', actingCompany: 'praxis',
        role: 'platform_admin', scope: 'platform', platformOverride: true });
      await admin.query("UPDATE human_tenant_memberships SET actor_alias='zeus' WHERE human_id=$1", [people.steven]);
      await expect(withTransaction(pool, client => access.companyAuthority(client))).rejects.toMatchObject({ code: 'conflict' });
    } finally { access.close(); }
  });
});

describe('human authority claims', () => {
  it('binds a person only to the console channel, freezes it and never accepts one from data', async () => {
    const user = { id: people.steven, email: 'steven@example.test', display_name: 'Steven', role: 'operator' as const,
      tenant_id: 'Steven', alias: 'kant', active: true, password_hash: 'unused', password_changed_at: 0 };
    const bound = consoleUserPrincipal(user, 'console:fixture', 'console');
    const validated = validatePrincipal(bound);
    expect(validated).toMatchObject({ human_id: people.steven });
    for (const trusted of [bound, validated]) {
      expect(Object.isFrozen(trusted)).toBe(true);
      expect(() => { Object.assign(trusted, { human_id: people.miguel }); }).toThrow(TypeError);
    }
    expect(consoleUserPrincipal(user, 'mcp:fixture', 'mcp')).not.toHaveProperty('human_id');
    expect(() => validatePrincipal({ ...bound })).toThrow(AuthError);
    const forged: Principal = { tenant_id: 'Miguel', alias: 'janus', session_id: 'mtls', channel: 'mtls', roles: ['agent'],
      permissions: ['route', 'read'], human_id: people.miguel };
    expect(() => validatePrincipal(forged)).toThrow('human claim is not trusted');
    const directory = await mkdtemp(join(tmpdir(), 'cauce-human-claim-'));
    try {
      const token = 'agent-token-with-enough-entropy-for-the-file';
      await writeFile(join(directory, 'identities.json'), JSON.stringify({ version: 1, identities: [{
        token_sha256: createHash('sha256').update(token).digest('hex'),
        expires_at: new Date(Date.now() + 60_000).toISOString(), principal: forged }] }));
      const files = new HashedTokenFileAuthProvider({ path: join(directory, 'identities.json') });
      await expect(files.authenticateHttp({ headers: { authorization: `Bearer ${token}` } } as never)).rejects.toThrow(AuthError);
    } finally { await rm(directory, { recursive: true, force: true }); }
  });

  it('takes the development operator from configuration instead of a built-in identity', async () => {
    const headers = (tenant: string, alias: string) => ({ headers: { 'x-cauce-tenant': tenant, 'x-cauce-alias': alias } }) as never;
    const configured = DevOnlyAuthProvider.forTests({ operator: 'Miguel/janus' });
    expect((await configured.authenticateHttp(headers('Miguel', 'janus'))).roles).toEqual(['operator']);
    expect((await configured.authenticateHttp(headers('Steven', 'kant'))).roles).toEqual(['agent']);
    expect(() => DevOnlyAuthProvider.forTests({ operator: 'Steven' })).toThrow('CAUCE_DEV_OPERATOR');
  });
});
