import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import { seedCompanyIsolation } from '../../../packages/store/test/companies-postgres.fixtures.js';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { oauthLogMessage } from './oauth-request-logging.js';
import { buildGateway } from './app.js';
import { PasswordAuthProvider } from './password-auth.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { hashPassword } from './password.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let gateway: FastifyInstance | undefined;
const password = 'synthetic-device-gateway-password';
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  current = await startTestCaseDatabase(database);
  await seedCompanyIsolation(current.adminPool);
  await current.adminPool.query('UPDATE console_users SET password_hash=$1',
    [await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 })]);
  gateway = await buildGateway({ pool: current.pool, consoleOrigins: ['http://localhost'],
    authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(current.pool), signingKey: Buffer.alloc(32, 47) }) });
}, 180_000);
afterAll(async () => {
  await gateway?.close(); await current?.close();
  if (database) { await database.pool.end(); await database.container.stop(); }
});
const app = () => { if (!gateway) throw new Error('gateway unavailable'); return gateway; };
const admin = () => { if (!current) throw new Error('test database unavailable'); return current.adminPool; };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

async function login() {
  const result = await app().inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: 'http://localhost' },
    payload: { email: 'steven@example.test', password } });
  expect(result.statusCode).toBe(200);
  const raw = result.headers['set-cookie'];
  const cookie = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).map(value => value.split(';')[0]).join('; ');
  return { cookie, origin: 'http://localhost', 'x-csrf-token': result.json<{ csrf_token: string }>().csrf_token };
}

async function pending(ip = '192.0.2.1') {
  const response = await app().inject({ method: 'POST', url: '/v3/auth/device', remoteAddress: ip,
    payload: { client_name: 'zz-canary-device-browser' } });
  expect(response.statusCode).toBe(200);
  return response.json<{ device_code: string; user_code: string; verification_uri: string;
    verification_uri_complete: string; expires_in: number; interval: number }>();
}

describe('device authorization gateway with real PostgreSQL', () => {
  it('uses the validated requested console Origin when multiple origins are configured', async () => {
    if (!current) throw new Error('test database unavailable');
    const alternate = await buildGateway({ pool: current.pool, consoleOrigins: ['https://canonical.example.invalid', 'https://second.example.invalid'],
      authProvider: new PasswordAuthProvider({ users: new PostgresConsoleUserStore(current.pool), signingKey: Buffer.alloc(32, 73) }) });
    try {
      const result = await alternate.inject({ method: 'POST', url: '/v3/auth/device',
        headers: { origin: 'https://second.example.invalid' }, payload: {} });
      expect(result.statusCode).toBe(200);
      expect(result.json<{ verification_uri: string }>().verification_uri).toBe('https://second.example.invalid/dispositivo');
      const fallback = await alternate.inject({ method: 'POST', url: '/v3/auth/device', payload: {} });
      expect(fallback.statusCode).toBe(200);
      expect(fallback.json<{ verification_uri: string }>().verification_uri).toBe('https://canonical.example.invalid/dispositivo');
      const foreign = await alternate.inject({ method: 'POST', url: '/v3/auth/device', headers: { origin: 'https://foreign.example.invalid' }, payload: {} });
      expect(foreign.statusCode).toBe(403);
    } finally { await alternate.close(); }
  });

  it('issues bounded high entropy codes, hashes only, and safely exposes pending metadata', async () => {
    const codes = await pending();
    expect(codes.device_code.length).toBe(43);
    expect(/^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/u.test(codes.user_code)).toBe(true);
    expect(codes).toMatchObject({ expires_in: 600, interval: 5, verification_uri: 'http://localhost/dispositivo' });
    const row = (await admin().query('SELECT device_code_hash,user_code_hash FROM device_authorizations WHERE device_code_hash=$1',
      [hash(codes.device_code)])).rows[0] as { device_code_hash: string; user_code_hash: string };
    expect(row.device_code_hash === codes.device_code).toBe(false);
    expect(row.user_code_hash === hash(codes.user_code.replaceAll('-', ''))).toBe(true);
    const cookie = await login();
    const view = await app().inject({ method: 'GET', url: `/v3/auth/device/${codes.user_code}`, headers: cookie });
    expect(view.statusCode).toBe(200);
    expect(view.headers['cache-control']).toBe('no-store');
    expect(view.json()).toMatchObject({ client_name: 'zz-canary-device-browser', masked_ip: '192.0.2.*', status: 'pending' });
    expect(view.body.includes(codes.device_code)).toBe(false);
    expect(view.body.includes(codes.user_code)).toBe(false);
  });

  it('rejects missing session, CSRF, missing Origin, and foreign Origin before approval', async () => {
    const codes = await pending('192.0.2.2');
    const session = await login();
    const payload = { user_code: codes.user_code, decision: 'approve' };
    expect((await app().inject({ method: 'GET', url: `/v3/auth/device/${codes.user_code}` })).statusCode).toBe(401);
    expect((await app().inject({ method: 'POST', url: '/v3/auth/device/approve', headers: { origin: session.origin }, payload })).statusCode).toBe(401);
    const { 'x-csrf-token': _csrf, ...withoutCsrf } = session;
    expect((await app().inject({ method: 'POST', url: '/v3/auth/device/approve', headers: withoutCsrf, payload })).statusCode).toBe(403);
    const { origin: _origin, ...withoutOrigin } = session;
    expect((await app().inject({ method: 'POST', url: '/v3/auth/device/approve', headers: withoutOrigin, payload })).statusCode).toBe(403);
    for (const url of ['/v3/auth/device', '/v3/auth/device/token', '/v3/auth/device/approve']) {
      expect((await app().inject({ method: 'POST', url, headers: { ...session, origin: 'https://evil.example.invalid' }, payload })).statusCode).toBe(403);
    }
    const state = (await admin().query('SELECT state FROM device_authorizations WHERE device_code_hash=$1', [hash(codes.device_code)])).rows[0] as { state: string };
    expect(state.state).toBe('pending');
  });

  it('limits creation by real IP, ignores untrusted forwarded addresses, and limits session guesses', async () => {
    for (let index = 0; index < 21; index++) {
      const result = await app().inject({ method: 'POST', url: '/v3/auth/device', remoteAddress: '203.0.113.7',
        headers: { 'x-forwarded-for': `198.51.100.${String(index + 1)}` }, payload: {} });
      expect(result.statusCode).toBe(index < 20 ? 200 : 429);
      if (index === 20) expect(Number(result.headers['retry-after'])).toBeGreaterThan(0);
    }
    await pending('203.0.113.8');
    const session = await login();
    for (let index = 0; index < 21; index++) {
      const result = await app().inject({ method: 'GET', url: '/v3/auth/device/ABCD-EFGH', remoteAddress: '203.0.113.9', headers: session });
      expect(result.statusCode).toBe(index < 20 ? 404 : 429);
    }
  });

  it('limits anonymous token abuse and reports slow_down without consuming the request', async () => {
    const codes = await pending('192.0.2.3');
    const result = await app().inject({ method: 'POST', url: '/v3/auth/device/token', remoteAddress: '203.0.113.10', payload: { device_code: codes.device_code } });
    expect(result.statusCode).toBe(400);
    expect(result.json()).toMatchObject({ error: 'slow_down', interval: 10 });
    for (let index = 0; index < 601; index++) {
      const refused = await app().inject({ method: 'POST', url: '/v3/auth/device/token', remoteAddress: '203.0.113.11', payload: {} });
      expect(refused.statusCode).toBe(index < 600 ? 400 : 429);
    }
  });

  it('redacts device URLs and both code query parameters from request and error messages', () => {
    expect(oauthLogMessage('GET /v3/auth/device/ABCD-EFGH')).toBe('GET /v3/auth/device/[redacted]');
    expect(oauthLogMessage('GET /v3/auth/device/ABCD-EFGH?code=secret')).toBe('GET /v3/auth/device/[redacted]');
    expect(oauthLogMessage('/dispositivo?user_code=secret')).toBe('/dispositivo');
    expect(oauthLogMessage('/v3/auth/device/token?device_code=secret')).toBe('/v3/auth/device/token');
  });
});
