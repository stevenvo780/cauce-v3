import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from '../../../../packages/store/test/companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { buildGateway } from '../app.js';
import { PostgresConsoleUserStore } from '../console-users.js';
import { hashPassword } from '../password.js';
import { PasswordAuthProvider } from '../password-auth.js';
import type { PeopleAdminPerson } from './people-admin-schema.js';

const PASSWORD = 'people-company-fixture-password';
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
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES('Steven','company-humanizar','kant','operator') ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role='operator'`);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [people.leon]);
  await admin.query('UPDATE console_users SET password_hash=$1', [hash]);
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 51) });
  app = await buildGateway({ pool, authProvider: provider, repository: new CauceRepository(pool), consoleOrigins: [ORIGIN] });
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

interface Session { cookie: string; csrf: string }
function cookie(response: LightMyRequestResponse): string {
  const raw = response.headers['set-cookie'];
  const header = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).find(value => value.startsWith('__Host-cauce_session='));
  if (!header) throw new Error('session cookie absent');
  return header.split(';', 1)[0] ?? '';
}
async function login(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  return { cookie: cookie(response), csrf: response.json<{ csrf_token: string }>().csrf_token };
}
function headers(session: Session): Record<string, string> {
  return { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf };
}
async function selected(): Promise<Session> {
  const home = await login('steven@example.test');
  const response = await app.inject({ method: 'POST', url: '/v3/auth/session/company', headers: headers(home), payload: { company_id: 'praxis' } });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ authority: { home_company: 'humanizar', acting_company: 'praxis', platform_override: true } });
  return { cookie: cookie(response), csrf: home.csrf };
}

describe('people administration under the signed selected company', () => {
  it('lists the selected company without taking scope from query parameters or headers', async () => {
    const session = await selected();
    const response = await app.inject({ method: 'GET', url: '/v3/console/people?company_id=humanizar',
      headers: { ...headers(session), 'x-cauce-company': 'humanizar' } });
    expect(response.statusCode).toBe(200);
    expect(response.json<{ items: PeopleAdminPerson[] }>().items.map(person => person.id)).toEqual([people.leon]);
  });

  it('creates, updates and revokes in the selected company while auditing the home actor', async () => {
    const session = await selected();
    const created = await app.inject({ method: 'POST', url: '/v3/console/people', headers: headers(session),
      payload: { email: 'selected@example.test', display_name: 'Selected', role: 'reader', tenant_id: 'PraxisTeam',
        alias: 'team_agent', active: true, password: PASSWORD } });
    expect(created.statusCode).toBe(201);
    let person = created.json<PeopleAdminPerson>();
    const updated = await app.inject({ method: 'PATCH', url: `/v3/console/people/${person.id}`, headers: headers(session),
      payload: { expected_revision: person.revision, display_name: 'Selected changed' } });
    expect(updated.statusCode).toBe(200); person = updated.json<PeopleAdminPerson>();
    expect(person.display_name).toBe('Selected changed');
    const retired = await app.inject({ method: 'DELETE', url: `/v3/console/people/${person.id}`, headers: headers(session),
      payload: { expected_revision: person.revision } });
    expect(retired.statusCode).toBe(200); person = retired.json<PeopleAdminPerson>(); expect(person.active).toBe(false);
    const restored = await app.inject({ method: 'POST', url: `/v3/console/people/${person.id}/restore`, headers: headers(session),
      payload: { expected_revision: person.revision } });
    expect(restored.statusCode).toBe(200); expect(restored.json<PeopleAdminPerson>().active).toBe(true);
    expect((await admin.query('SELECT company_id FROM console_users WHERE id=$1', [person.id])).rows).toEqual([{ company_id: 'praxis' }]);
    const audits = (await admin.query(`SELECT tenant_id,actor_alias,company_id,actor_human_id::text,metadata->>'platform_override' AS platform_override
      FROM audit_events WHERE action LIKE 'people.%' ORDER BY id`)).rows;
    expect(audits).toEqual(Array.from({ length: 4 }, () => ({ tenant_id: 'Steven', actor_alias: 'kant', company_id: 'praxis',
      actor_human_id: people.steven, platform_override: 'true' })));
  });

  it('rejects home-company mutations while selected elsewhere without choosing scope from the target', async () => {
    const session = await selected();
    const home = (await admin.query<{ revision: string }>(`SELECT (extract(epoch FROM updated_at)*1000000)::numeric(20,0)::text AS revision
      FROM console_users WHERE id=$1`, [people.miguel])).rows[0];
    const changed = await app.inject({ method: 'PATCH', url: `/v3/console/people/${people.miguel}`, headers: headers(session),
      payload: { expected_revision: home?.revision, display_name: 'Foreign changed' } });
    expect(changed.statusCode).toBe(404);
    const created = await app.inject({ method: 'POST', url: '/v3/console/people', headers: headers(session),
      payload: { email: 'home@example.test', display_name: 'Home', role: 'reader', tenant_id: 'Steven', alias: 'kant', active: true, password: PASSWORD } });
    expect(created.statusCode).toBe(403);
    expect((await admin.query("SELECT id FROM console_users WHERE email_normalized='home@example.test'")).rowCount).toBe(0);
    expect((await admin.query("SELECT id FROM audit_events WHERE action LIKE 'people.%'")).rowCount).toBe(0);
  });

  it('rejects ordinary operators before target or body can determine a company', async () => {
    const id = randomUUID();
    await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,'staff@example.test','staff@example.test',$2,'Staff','operator','PraxisTeam','team_agent')`, [id, hash]);
    await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
      VALUES($1,'PraxisTeam','team_agent',ARRAY['read','control'])`, [id]);
    const session = await login('staff@example.test');
    expect((await app.inject({ method: 'GET', url: '/v3/console/people?company_id=humanizar', headers: headers(session) })).statusCode).toBe(403);
    for (const target of [people.miguel, randomUUID()]) {
      expect((await app.inject({ method: 'PATCH', url: `/v3/console/people/${target}`, headers: headers(session),
        payload: { expected_revision: '1', display_name: 'Forbidden' } })).statusCode).toBe(403);
    }
    expect((await admin.query("SELECT id FROM audit_events WHERE action LIKE 'people.%'")).rowCount).toBe(0);
  });
});
