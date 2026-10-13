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

const PASSWORD = 'configuration-company-fixture-password';
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
async function snapshot(session: Session): Promise<{ revision: number; tenants: { id: string }[]; capabilities: { actor: Record<string, unknown> } }> {
  const response = await app.inject({ method: 'GET', url: '/v3/console/config', headers: { cookie: session.cookie } });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('console configuration under the session company authority', () => {
  it('lets an owner outside the hub administer the whole company and nothing else', async () => {
    const miguel = await login('miguel@example.test');
    const before = await snapshot(miguel);
    expect(before.capabilities.actor).toMatchObject({ tenant_id: 'Miguel', role: 'company_owner', scope: 'company', company_id: 'humanizar' });
    expect(before.tenants.map(row => row.id)).toEqual(expect.arrayContaining(['Isa', 'Miguel', 'Steven']));
    const created = await post(miguel, '/v3/console/config/changes', { dry_run: false, expected_revision: before.revision,
      mutation: { resource: 'tenant', action: 'create', id: 'MiguelOwned', value: { display_name: 'Owned' } } });
    expect(created.statusCode).toBe(201);
    const foreign = await post(miguel, '/v3/console/config/changes', { dry_run: true,
      mutation: { resource: 'room', action: 'create', tenant_id: 'PraxisHub', id: 'foreign', value: {} } });
    expect(foreign.statusCode).toBe(403);
    expect((await pool.query("SELECT company_id,actor_human_id::text FROM config_revisions WHERE company_id IS NOT NULL")).rows)
      .toEqual([{ company_id: 'humanizar', actor_human_id: people.miguel }]);
  });

  it('refuses a company administrator the home membership of an owner', async () => {
    await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Isa' AND alias='salva'");
    const isa = (await admin.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES('isa@example.test','isa@example.test',$1,'Isa','operator','Isa','salva') RETURNING id::text`, [hash])).rows[0]?.id;
    await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
      VALUES($1,'Isa','salva',ARRAY['read','control'])`, [isa]);
    await admin.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('humanizar',$1,'admin','platform',$2)`,
      [isa, people.steven]);
    const session = await login('isa@example.test');
    expect((await snapshot(session)).capabilities.actor).toMatchObject({ role: 'company_admin', company_id: 'humanizar' });
    const refused = await post(session, '/v3/console/config/changes', { dry_run: false, mutation: { resource: 'membership',
      action: 'update', tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', value: { enabled: false } } });
    expect(refused.statusCode).toBe(403);
    expect(refused.json<{ error: string; message: string }>()).toMatchObject({ error: 'forbidden',
      message: expect.stringContaining('solo la plataforma el de un dueño') as unknown });
    expect((await pool.query("SELECT enabled FROM memberships WHERE tenant_id='Miguel' AND room_id='grp.miguel' AND alias='janus'")).rows)
      .toEqual([{ enabled: true }]);
    expect((await snapshot(await login('miguel@example.test'))).capabilities.actor).toMatchObject({ role: 'company_owner' });
    expect((await pool.query('SELECT id FROM config_revisions')).rows).toEqual([]);
  });

  it('confines the other company to itself and follows a platform switch', async () => {
    const leon = await snapshot(await login('leon@example.test'));
    expect(leon.tenants.map(row => row.id)).toEqual(['PraxisHub', 'PraxisTeam']);
    const steven = await login('steven@example.test');
    const switched = await post(steven, '/v3/auth/session/company', { company_id: 'praxis' });
    expect(switched.statusCode).toBe(200);
    const raw = switched.headers['set-cookie'];
    const cookie = (Array.isArray(raw) ? raw : [raw ?? '']).find(value => value.startsWith('__Host-cauce_session='))?.split(';', 1)[0] ?? '';
    const praxis = { cookie, csrf: steven.csrf };
    const acting = await snapshot(praxis);
    expect(acting.capabilities.actor).toMatchObject({ tenant_id: 'Steven', role: 'platform_admin', company_id: 'praxis', platform_override: true });
    expect(acting.tenants.map(row => row.id)).toEqual(['PraxisHub', 'PraxisTeam']);
    const room = await post(praxis, '/v3/console/config/changes', { dry_run: false, expected_revision: acting.revision,
      mutation: { resource: 'room', action: 'create', tenant_id: 'PraxisHub', id: 'switched-room', value: {} } });
    expect(room.statusCode).toBe(201);
    expect((await pool.query("SELECT actor_tenant,company_id,platform_override FROM config_revisions WHERE company_id='praxis'")).rows)
      .toEqual([{ actor_tenant: 'Steven', company_id: 'praxis', platform_override: true }]);
  });
});
