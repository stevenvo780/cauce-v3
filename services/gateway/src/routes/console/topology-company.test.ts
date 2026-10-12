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

const PASSWORD = 'topology-company-fixture-password';
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
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [people.leon]);
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
const tenantIds = (response: LightMyRequestResponse): string[] =>
  response.json<{ tenants: { id: string }[] }>().tenants.map(row => row.id);

describe('console topology under the session company', () => {
  it('follows the platform switch and never shows the other company to its owner', async () => {
    const steven = await login('steven@example.test');
    const home = await request(steven, 'GET', '/v3/console/topology');
    expect(home.statusCode).toBe(200);
    expect(tenantIds(home)).not.toContain('PraxisHub');
    const switched = await post(steven, '/v3/auth/session/company', { company_id: 'praxis' });
    expect(switched.statusCode).toBe(200);
    const raw = switched.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw ?? '']).find(value => value.startsWith('__Host-cauce_session='))?.split(';', 1)[0] ?? '';
    const praxis = { cookie, csrf: steven.csrf };
    const acting = await request(praxis, 'GET', '/v3/console/topology');
    expect(acting.statusCode).toBe(200);
    expect(tenantIds(acting)).toEqual(['PraxisHub', 'PraxisTeam']);
    await admin.query("INSERT INTO rooms(id,tenant_id,enabled) VALUES('off-room','PraxisTeam',false)");
    await admin.query("INSERT INTO rooms(id,tenant_id,enabled,retired_at,retired_enabled) VALUES('gone-room','PraxisTeam',false,now(),true)");
    await admin.query("INSERT INTO tenants(id,company_id,enabled) VALUES('PraxisOff','praxis',false)");
    await admin.query("INSERT INTO rooms(id,tenant_id) VALUES('off-tenant-room','PraxisOff')");
    const topo = await request(praxis, 'GET', '/v3/console/topology');
    const listed = topo.json<{ tenants: { id: string; rooms: { id: string }[] }[] }>().tenants
      .flatMap(tenant => tenant.rooms.map(room => ({ tenant_id: tenant.id, room_id: room.id })));
    expect(listed.map(room => room.room_id)).not.toContain('gone-room');
    expect(listed.map(room => room.room_id)).toContain('off-room');
    const geometry = { x: 1, y: 2, width: 10, height: 8, parts: [] };
    const everything = await request(praxis, 'PUT', '/v3/console/office/layout',
      { expected_version: 0, rooms: listed.map(room => ({ ...room, ...geometry })) });
    expect(everything.statusCode).toBe(403);
    expect(everything.json<{ message: string }>().message).toMatch(/La sala PraxisTeam\/off-room|La sala PraxisOff\/off-tenant-room/u);
    const fresh = await request(praxis, 'GET', '/v3/console/office/layout');
    const { version, available } = fresh.json<{ version: number; available: { tenant_id: string; room_id: string }[] }>();
    const savable = new Set(available.map(room => JSON.stringify([room.tenant_id, room.room_id])));
    const rooms = listed.filter(room => savable.has(JSON.stringify([room.tenant_id, room.room_id]))).map(room => ({ ...room, ...geometry }));
    expect(rooms.map(room => room.room_id).sort()).toEqual(['company-praxis', 'company-team']);
    const saved = await request(praxis, 'PUT', '/v3/console/office/layout', { expected_version: version, rooms });
    expect(saved.statusCode).toBe(200);
    expect(tenantIds(await request(await login('miguel@example.test'), 'GET', '/v3/console/topology'))).not.toContain('PraxisHub');
    const own = tenantIds(await request(await login('leon@example.test'), 'GET', '/v3/console/topology'));
    expect(own).toContain('PraxisHub');
    expect(own).not.toContain('Steven');
  });
});
