import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../../packages/store/test/postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from '../../../../../packages/store/test/companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../console-users.js';
import { hashPassword } from '../../password.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import { buildTestGateway } from '../../test-support/gateway-doubles.js';

const PASSWORD = 'status-presence-company-fixture-password';
const ORIGIN = 'http://localhost';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let hash: string | undefined;
let people: CompanyIsolationFixture;
let app: FastifyInstance;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  hash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  people = await seedCompanyIsolation(admin);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query('UPDATE console_users SET password_hash=$1', [hash]);
  await admin.query(`INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until,last_heartbeat_at) VALUES
    ('Steven','kant','kant-live',1,now()+interval '5 minutes',now()),
    ('Miguel','janus','janus-live',1,now()+interval '5 minutes',now()),
    ('PraxisHub','company_admin','hub-live',1,now()+interval '5 minutes',now()),
    ('PraxisTeam','team_agent','team-live',1,now()+interval '5 minutes',now())`);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [people.leon]);
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 43) });
  app = await buildTestGateway({ pool, authProvider: provider, repository: new CauceRepository(pool) });
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

interface Session { cookie: string; csrf: string }

async function login(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).find(value => value.startsWith('__Host-cauce_session='));
  return { cookie: header?.split(';', 1)[0] ?? '', csrf: response.json<{ csrf_token: string }>().csrf_token };
}
function post(session: Session, url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url, payload, headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf } });
}
async function request(session: Session, method: 'GET' | 'PUT', url: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, ...(payload === undefined ? {} : { payload }),
    headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf } });
}

// Humanizar tenants read each other through the company star; none of this reaches Praxis.
const HUMANIZAR = ['Miguel/janus', 'Steven/kant'];
const leases = (response: LightMyRequestResponse): string[] =>
  response.json<{ presence: { tenant_id: string; alias: string; online: boolean }[] }>().presence
    .map(row => `${row.tenant_id}/${row.alias}`).sort();

async function actingIn(session: Session, company: string): Promise<Session> {
  const switched = await post(session, '/v3/auth/session/company', { company_id: company });
  expect(switched.statusCode).toBe(200);
  const raw = switched.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? '']).find(value => value.startsWith('__Host-cauce_session='))?.split(';', 1)[0] ?? '';
  return { cookie, csrf: session.csrf };
}

describe('GET /v3/status presence under the session company', () => {
  it('lists the acting company leases for a platform administrator and nothing of the home company', async () => {
    const steven = await login('steven@example.test');
    const home = await request(steven, 'GET', '/v3/status');
    expect(home.statusCode).toBe(200);
    expect(leases(home)).toEqual(HUMANIZAR);
    const acting = await request(await actingIn(steven, 'praxis'), 'GET', '/v3/status');
    expect(acting.statusCode).toBe(200);
    expect(leases(acting)).toEqual(['PraxisHub/company_admin', 'PraxisTeam/team_agent']);
    expect(acting.json<{ presence: { online: boolean }[] }>().presence.every(row => row.online)).toBe(true);
    const back = await post(await actingIn(steven, 'praxis'), '/v3/auth/session/company', { company_id: null });
    expect(back.statusCode).toBe(200);
    const raw = back.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw ?? '']).find(value => value.startsWith('__Host-cauce_session='))?.split(';', 1)[0] ?? '';
    expect(leases(await request({ cookie, csrf: steven.csrf }, 'GET', '/v3/status'))).toEqual(HUMANIZAR);
  });

  it('keeps retired agents and tenants of the acting company out', async () => {
    await admin.query("UPDATE agents SET enabled=false,retired_at=now(),lifecycle_state='retired' WHERE tenant_id='PraxisTeam' AND alias='team_agent'");
    const acting = await request(await actingIn(await login('steven@example.test'), 'praxis'), 'GET', '/v3/status');
    expect(leases(acting)).toEqual(['PraxisHub/company_admin']);
  });

  it('does not let a non-administrator widen to another company', async () => {
    const miguel = await login('miguel@example.test');
    expect((await post(miguel, '/v3/auth/session/company', { company_id: 'praxis' })).statusCode).toBeGreaterThanOrEqual(400);
    expect(leases(await request(miguel, 'GET', '/v3/status'))).toEqual(HUMANIZAR);
    const leon = await request(await login('leon@example.test'), 'GET', '/v3/status');
    expect(leases(leon)).toEqual(['PraxisHub/company_admin']);
  });
});
