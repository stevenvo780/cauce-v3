import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../../packages/store/test/postgres-suite.js';
import { seedCompanyIsolation } from '../../../../../packages/store/test/companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../console-users.js';
import { hashPassword } from '../../password.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import { buildTestGateway } from '../../test-support/gateway-doubles.js';

const PASSWORD = 'company-create-fixture-password';
const ORIGIN = 'http://localhost';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let admin: DatabasePool;
let hash: string | undefined;
let app: FastifyInstance;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); admin = current.adminPool;
  hash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await seedCompanyIsolation(admin);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query('UPDATE console_users SET password_hash=$1', [hash]);
  app = await buildTestGateway({ pool: current.pool,
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(current.pool), signingKey: Buffer.alloc(32, 43) }) });
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function signIn(email: string, role: string): Promise<{ cookie: string; csrf: string }> {
  const login = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const raw = login.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : [raw ?? '']).find(value => value.startsWith('__Host-cauce_session='))?.split(';', 1)[0] ?? '';
  const state = await app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie } });
  expect(state.json()).toMatchObject({ authority: { role } });
  return { cookie, csrf: login.json<{ csrf_token: string }>().csrf_token };
}

async function create(email: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  const { cookie, csrf } = await signIn(email, email.startsWith('steven') ? 'platform_admin' : 'company_owner');
  return app.inject({ method: 'POST', url: '/v3/console/companies', payload, headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf } });
}

const owner = (slug: string, email = `${slug}@example.test`) =>
  ({ email, name: 'Dueña nueva', password: 'contraseña-larga-1', company: { name: 'Empresa nueva', slug } });

async function companies(): Promise<string[]> {
  return (await admin.query<{ id: string }>('SELECT id FROM companies ORDER BY id')).rows.map(row => row.id);
}

describe('POST /v3/console/companies', () => {
  it('refuses a company owner with 403 and creates nothing', async () => {
    const before = await companies();
    const refused = await create('miguel@example.test', owner('acme'));
    expect(refused.statusCode).toBe(403);
    expect(await companies()).toEqual(before);
    expect((await admin.query('SELECT 1 FROM console_users WHERE email=$1', ['acme@example.test'])).rowCount).toBe(0);
  });

  it('lets the platform create a company with a slug public registration reserves, and answers in Spanish', async () => {
    expect((await create('steven@example.test', owner('support'))).statusCode).toBe(201);
    expect(await companies()).toContain('support');
    const taken = await create('steven@example.test', owner('support', 'otra@example.test'));
    expect(taken.statusCode).toBe(409);
    expect(taken.json()).toEqual({ error: 'conflict',
      message: 'No se pudo completar el registro: el correo o el identificador de empresa ya están en uso.' });
    const invalid = await create('steven@example.test', owner('con_guion_bajo'));
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json<{ message: string }>().message).toContain('identificador de empresa');
  });
});
