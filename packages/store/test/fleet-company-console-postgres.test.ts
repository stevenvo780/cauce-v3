import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetOperationRequest } from '@cauce/protocol';
import type { DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { configuredFleetGateway } from '../../../services/gateway/src/fleet/gateway-config.js';
import { buildTestGateway } from '../../../services/gateway/src/test-support/gateway-doubles.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../../services/gateway/src/password-auth.js';
import { hashPassword } from '../../../services/gateway/src/password.js';

const PASSWORD = 'fleet-selected-company-password';
const ORIGIN = 'http://localhost';
const PATH = '/v3/console/fleet/operations';
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
  people = await seedCompanyIsolation(admin);
  hash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await admin.query('UPDATE console_users SET password_hash=$1', [hash]);
  await admin.query("INSERT INTO rooms(id,tenant_id) VALUES('fleet-praxis','PraxisHub'),('fleet-home','Steven')");
  const authProvider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 61) });
  const fleet = await configuredFleetGateway(pool, { available: true, actions: ['retire'], placements: [] },
    { CAUCE_FLEET_CONTROLLER_HOST: 'praxis-host' });
  app = await buildTestGateway({ pool, authProvider, ...fleet });
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
interface Session { cookie: string; csrf: string }
function cookie(response: LightMyRequestResponse): string {
  const raw = response.headers['set-cookie'];
  return (Array.isArray(raw) ? raw : [raw ?? '']).find(value => value.startsWith('__Host-cauce_session='))?.split(';', 1)[0] ?? '';
}
async function login(): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN },
    payload: { email: 'steven@example.test', password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  return { cookie: cookie(response), csrf: response.json<{ csrf_token: string }>().csrf_token };
}
function post(session: Session, url: string, payload: Record<string, unknown>, extra: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'POST', url, payload, headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf, ...extra } });
}
function retire(tenant: string, room: string): FleetOperationRequest {
  return { kind: 'retire', target: { resource: 'room', tenant_id: tenant, room_id: room }, expected_revision: 0,
    idempotency_key: `fleet-selected-${tenant}`, parameters: {} };
}
describe('fleet routes bound to the verified selected company', () => {
  it('carries the signed company switch through preview, enqueue, history, control and durable worker origin', async () => {
    const home = await login();
    const switched = await post(home, '/v3/auth/session/company', { company_id: 'praxis' });
    expect(switched.statusCode).toBe(200);
    const selected = { cookie: cookie(switched), csrf: home.csrf };
    const request = retire('PraxisHub', 'fleet-praxis');
    const unauthorized = await post(home, `${PATH}/preview`, request, { 'x-cauce-company': 'praxis' });
    expect(unauthorized.statusCode).toBe(403);
    expect((await post(selected, `${PATH}/preview`, request)).statusCode).toBe(200);
    expect((await post(selected, `${PATH}/preview`, { ...request, company_id: 'humanizar' })).statusCode).toBe(400);
    const accepted = await post(selected, PATH, request);
    expect(accepted.statusCode).toBe(202);
    const receipt = accepted.json<{ operation_id: string; operation: { actor: unknown } }>();
    expect(receipt.operation.actor).toEqual({ tenant_id: 'Steven', alias: 'kant', actor_subject: `console:${people.steven}` });
    expect((await post(selected, PATH, request)).json<{ operation_id: string }>().operation_id).toBe(receipt.operation_id);
    const own = await post(home, PATH, retire('Steven', 'fleet-home'));
    expect(own.statusCode).toBe(202);
    const read = (session: Session, url: string) => app.inject({ method: 'GET', url, headers: { cookie: session.cookie } });
    expect((await read(selected, `${PATH}/${receipt.operation_id}`)).statusCode).toBe(200);
    expect((await read(home, `${PATH}/${receipt.operation_id}`)).statusCode).toBe(403);
    expect((await read(selected, `${PATH}/recent`)).json<{ operations: { id: string }[] }>().operations.map(row => row.id))
      .toEqual([receipt.operation_id]);
    expect((await read(selected, `${PATH}?resource=room&tenant_id=PraxisHub&room_id=fleet-praxis`)).statusCode).toBe(200);
    expect((await post(selected, `${PATH}/${receipt.operation_id}/cancel`, { expected_version: 0 })).statusCode).toBe(200);
    expect((await pool.query('SELECT company_id,actor_tenant,actor_alias FROM fleet_operations WHERE id=$1', [receipt.operation_id])).rows)
      .toEqual([{ company_id: 'praxis', actor_tenant: 'Steven', actor_alias: 'kant' }]);
    expect((await pool.query('SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND event=\'queued\'', [receipt.operation_id])).rows)
      .toEqual([{ metadata: { acting_company: 'praxis', actor_subject: `console:${people.steven}` } }]);
    await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [people.leon]);
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)', [people.leon]);
    await admin.query('UPDATE console_users SET active=false WHERE id=$1', [people.steven]);
    expect((await post(selected, PATH, request)).statusCode).toBe(401);
  });
});
