import { randomUUID } from 'node:crypto';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { seedCompanyIsolation } from '../../../packages/store/test/companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleSessionRevocations } from './console-session-revocations.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { hashPassword } from './password.js';
import { PasswordAuthProvider, type ConsoleSessionClaims } from './password-auth.js';
import { buildTestGateway } from './test-support/gateway-doubles.js';

const PASSWORD = 'sliding-session-fixture-password';
const KEY = Buffer.alloc(32, 43);
const ORIGIN = 'http://localhost';
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let hash: string | undefined;
let clock = Date.now();
let provider: PasswordAuthProvider;
let app: FastifyInstance;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

function build(): PasswordAuthProvider {
  return new PasswordAuthProvider({
    users: new PostgresConsoleUserStore(pool), signingKey: KEY, now: () => clock,
    sessionTtlMs: DAY, sessionMaxMs: 30 * DAY, sessionRevocations: new PostgresConsoleSessionRevocations(pool),
  });
}

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  hash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await seedCompanyIsolation(admin);
  await admin.query('UPDATE console_users SET password_hash=$1', [hash]);
  clock = Date.now();
  provider = build();
  app = await buildTestGateway({ pool, authProvider: provider });
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

interface Session { cookie: string; csrf: string }

function renewed(response: LightMyRequestResponse): string | undefined {
  const raw = response.headers['set-cookie'];
  const header = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).find(value => value.startsWith('__Host-cauce_session='));
  return header?.split(';', 1)[0];
}
function claims(cookie: string): ConsoleSessionClaims {
  const token = decodeURIComponent(cookie.slice('__Host-cauce_session='.length));
  return JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as ConsoleSessionClaims;
}
async function login(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  return { cookie: renewed(response) ?? '', csrf: response.json<{ csrf_token: string }>().csrf_token };
}
function status(session: Session): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: '/v3/auth/session', headers: { cookie: session.cookie } });
}
async function touch(session: Session): Promise<Session> {
  const response = await status(session);
  expect(response.json<{ authenticated: boolean }>().authenticated).toBe(true);
  const cookie = renewed(response);
  return cookie === undefined ? session : { ...session, cookie };
}

describe('console sliding session against the real store', () => {
  it('stays open for weeks while used each day and asks for login at the 30 day ceiling', async () => {
    let session = await login('miguel@example.test');
    const loginAt = claims(session.cookie).iat * 1_000;
    for (let day = 1; day <= 31; day += 1) {
      clock += DAY - HOUR;
      session = await touch(session);
      expect(claims(session.cookie).iat * 1_000).toBe(loginAt);
      expect(claims(session.cookie).exp * 1_000).toBeLessThanOrEqual(loginAt + 30 * DAY);
    }
    clock = loginAt + 30 * DAY - 1_000;
    session = await touch(session);
    expect(claims(session.cookie).exp * 1_000).toBe(loginAt + 30 * DAY);
    clock = loginAt + 30 * DAY + 1_000;
    const past = await status(session);
    expect(past.json<{ authenticated: boolean }>().authenticated).toBe(false);
    expect(renewed(past)).toBeUndefined();
  });

  it('lets an unused session lapse after the inactivity window and never revives it', async () => {
    const session = await login('miguel@example.test');
    clock += DAY + 1_000;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const lapsed = await status(session);
      expect(lapsed.json<{ authenticated: boolean }>().authenticated).toBe(false);
      expect(renewed(lapsed)).toBeUndefined();
      clock += HOUR;
    }
  });

  it('keeps the acting company of a platform administrator and revalidates it on each slide', async () => {
    let steven = await login('steven@example.test');
    const switched = await app.inject({ method: 'POST', url: '/v3/auth/session/company', payload: { company_id: 'praxis' },
      headers: { cookie: steven.cookie, origin: ORIGIN, 'x-csrf-token': steven.csrf } });
    expect(switched.statusCode).toBe(200);
    steven = { ...steven, cookie: renewed(switched) ?? '' };
    clock += 6 * HOUR;
    steven = await touch(steven);
    expect(claims(steven.cookie).cmp).toBe('praxis');
    const state = (await status(steven)).json<{ authority?: { acting_company: string; platform_override: boolean } }>();
    expect(state.authority).toMatchObject({ acting_company: 'praxis', platform_override: true });
  });

  it('does not slide a session whose person was retired or whose password changed', async () => {
    const retired = await login('miguel@example.test');
    const changed = await login('leon@example.test');
    clock += 6 * HOUR;
    await admin.query("UPDATE console_users SET active=false WHERE email_normalized='miguel@example.test'");
    await admin.query("UPDATE console_users SET password_hash=$1, password_changed_at=now() + interval '1 second' WHERE email_normalized='leon@example.test'", [hash]);
    for (const session of [retired, changed]) {
      const response = await status(session);
      expect(response.json<{ authenticated: boolean }>().authenticated).toBe(false);
      expect(renewed(response)).toBeUndefined();
    }
  });

  it('logout records the session until its ceiling, survives a restart and touches no other session', async () => {
    const first = await login('miguel@example.test');
    const other = await login('miguel@example.test');
    clock += 6 * HOUR;
    const slid = await touch(first);
    const logout = await app.inject({ method: 'POST', url: '/v3/auth/logout',
      headers: { cookie: slid.cookie, origin: ORIGIN, 'x-csrf-token': first.csrf } });
    expect(logout.statusCode).toBe(204);
    const row = (await admin.query<{ sid: string; not_after: Date }>('SELECT sid, not_after FROM console_session_revocations')).rows;
    expect(row).toHaveLength(1);
    expect(row[0]?.sid).toBe(claims(first.cookie).sid);
    expect(row[0]?.not_after.getTime()).toBe(claims(first.cookie).iat * 1_000 + 30 * DAY);

    await app.close();
    provider = build();
    app = await buildTestGateway({ pool, authProvider: provider });
    for (const cookie of [first.cookie, slid.cookie]) {
      const response = await status({ ...first, cookie });
      expect(response.json<{ authenticated: boolean }>().authenticated).toBe(false);
      expect(renewed(response)).toBeUndefined();
    }
    expect((await status(other)).json<{ authenticated: boolean }>().authenticated).toBe(true);
  });

  it('prunes revocations whose ceiling passed more than a day ago', async () => {
    const revocations = new PostgresConsoleSessionRevocations(pool);
    const human = randomUUID();
    await revocations.revoke('expired-session-id-0001', human, Date.now() - 3 * DAY);
    await revocations.revoke('live-session-id-000002', human, Date.now() + DAY);
    await revocations.revoke('live-session-id-000002', human, Date.now() + DAY);
    expect(await revocations.isRevoked('live-session-id-000002')).toBe(true);
    expect((await admin.query('SELECT sid FROM console_session_revocations')).rows).toEqual([{ sid: 'live-session-id-000002' }]);
  });
});
