import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../../packages/store/src/seed-dev-cli.js';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { PasswordAuthProvider } from './password-auth.js';
import { hashPassword } from './password.js';
import { buildTestGateway } from './test-support/gateway-doubles.js';

const PASSWORD = 'context-http-fixture-password'; const ORIGIN = 'http://localhost';
let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>; let app: FastifyInstance;
let passwordHash: string | undefined; let cookie: string; let csrf: string; let provider: PasswordAuthProvider;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl);
  passwordHash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  await current.adminPool.query('UPDATE console_users SET password_hash=$1', [passwordHash]);
  provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 19) });
  app = await buildTestGateway({ pool, authProvider: provider });
  const login = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN },
    payload: { email: 'context_alpha@dev.example', password: PASSWORD } });
  expect(login.statusCode).toBe(200);
  const headers = login.headers['set-cookie']; const header = Array.isArray(headers) ? headers[0] : headers;
  if (!header) throw new Error('session cookie unavailable');
  cookie = header.split(';', 1)[0] ?? ''; csrf = login.json<{ csrf_token: string }>().csrf_token;
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const base = '/v3/console/context/agents/ContextAlpha/director';
const files = [{ path: 'context/mission.md', content: 'Scoped mission.' }];
function request(method: 'GET' | 'PUT' | 'POST', suffix = '', payload?: Record<string, unknown>, headers: Record<string, string> = {}): Promise<LightMyRequestResponse> {
  return app.inject({ method, url: base + suffix, headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf, ...headers },
    ...(payload === undefined ? {} : { payload }) });
}
const write = (expected = 0, content = files) => request('PUT', '', { expected_version: expected, source: 'ui', files: content });

describe('versioned context HTTP authority with real PostgreSQL and signed human sessions', () => {
  it('requires both same-origin and exact session CSRF for every mutation', async () => {
    for (const [method, suffix, payload] of [
      ['PUT', '', { expected_version: 0, source: 'ui', files }], ['POST', '/restore', { expected_version: 0, version: 1 }],
      ['POST', '/sync/retry', {}], ['POST', '/apply', {}],
    ] as const) {
      expect((await request(method, suffix, payload, { 'x-csrf-token': '' })).statusCode).toBe(403);
      expect((await request(method, suffix, payload, { origin: 'https://untrusted.example' })).statusCode).toBe(403);
    }
    expect((await request('GET')).json()).toMatchObject({ version: 0, applied_version: 0 });
    expect((await current?.adminPool.query('SELECT count(*)::integer AS count FROM agent_context_versions'))?.rows).toEqual([{ count: 0 }]);
  });
  it('persists CAS history, paginated reads, diffs and restore through the real human writer', async () => {
    expect((await write()).statusCode).toBe(202);
    expect((await write(0)).statusCode).toBe(409);
    expect((await write(1, [{ path: 'context/mission.md', content: 'Changed mission.' }])).statusCode).toBe(202);
    expect((await request('GET', '/history')).json()).toMatchObject({ entries: [{ version: 2 }, { version: 1 }], next_cursor: null });
    expect((await request('GET', '/history?before=2')).json()).toMatchObject({ entries: [{ version: 1 }] });
    expect((await request('GET', '/diff?from=1&to=2')).json()).toMatchObject({ from: 1, to: 2,
      files: [{ path: 'context/mission.md', before: 'Scoped mission.', after: 'Changed mission.', change: 'modified' }] });
    const restored = await request('POST', '/restore', { expected_version: 2, version: 1 });
    expect(restored.statusCode).toBe(202);
    expect(restored.json()).toMatchObject({ desired_version: 3, applied_version: 0 });
    expect(restored.json<{ files: { path: string; content: string }[] }>().files).toEqual(expect.arrayContaining(files));
    expect((await request('GET', '/status')).json()).toMatchObject({ version: 3, application: { state: 'pending' } });
  });
  it('returns unavailable apply explicitly and never invents applied state without a runtime', async () => {
    await write();
    const result = await request('POST', '/apply', {});
    expect(result.statusCode).toBe(503);
    expect(result.json()).toMatchObject({ error: 'context_runtime_unavailable', snapshot: { version: 1, applied_version: 0 } });
  });
  it('starts apply asynchronously, returns 202 before runtime completion and refuses an unacknowledged sink return', async () => {
    await app.close();
    let finish: (value: { version: number; digest: string }) => void = () => { throw new Error('runtime did not start'); };
    let started: (value: { version: number; digest: string }) => void = () => undefined;
    const called = new Promise<{ version: number; digest: string }>(resolve => { started = resolve; });
    app = await buildTestGateway({ pool, authProvider: provider, contextVersion: { runtime: { apply: async version => {
      started({ version: version.version, digest: version.digest });
      return new Promise(resolve => { finish = resolve; });
    } } } });
    await app.ready();
    await write();
    const result = await request('POST', '/apply', {});
    expect(result.statusCode).toBe(202);
    expect(result.json()).toMatchObject({ desired_version: 1, applied_version: 0, operation: { state: 'pending', version: 1 } });
    const consumed = await called;
    expect((await request('GET', '/status')).json()).toMatchObject({ applied_version: 0, application: { state: 'pending' } });
    finish(consumed);
    await app.close();
    expect((await pool.query('SELECT applied_version::integer FROM agent_context_state')).rows).toEqual([{ applied_version: 0 }]);
    expect((await pool.query('SELECT applied_at,apply_error FROM agent_context_outbox')).rows)
      .toEqual([{ applied_at: null, apply_error: 'context_runtime_verification_failed' }]);
  });
  it('isolates the other company and revalidates revoked human authority on every request', async () => {
    const other = await app.inject({ method: 'GET', url: '/v3/console/context/agents/ContextBeta/director', headers: { cookie } });
    expect(other.statusCode).toBe(404);
    expect((await write(0, [{ path: 'context/auth.json', content: 'Unavailable' }])).statusCode).toBe(400);
    await current?.adminPool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [fixtures[0]?.human_id]);
    expect((await request('GET')).statusCode).toBe(403);
    expect((await write()).statusCode).toBe(403);
    expect((await current?.adminPool.query('SELECT count(*)::integer AS count FROM agent_context_versions'))?.rows).toEqual([{ count: 0 }]);
  });
});
