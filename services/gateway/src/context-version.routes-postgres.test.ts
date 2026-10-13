import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentProfileRepository, ContextGitBroker, readContextVersion, type ContextSnapshot, type DatabasePool } from '@cauce/store';
import { seedSyntheticCompanyContexts } from '../../../packages/store/src/seed-dev-cli.js';
import { preparePostgresSuite } from '../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from './console-users.js';
import { PasswordAuthProvider } from './password-auth.js';
import { hashPassword } from './password.js';
import type { Principal } from './auth.js';
import { buildTestGateway, FixedAuthProvider, testPrincipal } from './test-support/gateway-doubles.js';

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
  async function nativeEffects() {
    return Promise.all(['agent_context_state', 'agent_context_versions', 'agent_context_outbox', 'agent_profiles']
      .map(async table => (await pool.query<Record<string, unknown>>(`SELECT * FROM ${table} ORDER BY tenant_id,alias`)).rows)
      .concat([(async () => (await pool.query<Record<string, unknown>>("SELECT * FROM audit_events WHERE action LIKE 'context.%' ORDER BY id")).rows)()]));
  }
  const nativePayload = { base_version: 0, files: [{ path: 'context/notes/local.md', content: 'Local agent note.' }] };
  it('rejects the retired profile source and incompatible native inspection without altering V4 history or adoption', async () => {
    const saved = await write();
    expect(saved.statusCode).toBe(202);
    const snapshot = saved.json<ContextSnapshot>();
    const root = await mkdtemp(join(tmpdir(), 'cauce-v4-source-boundary-'));
    try {
      await promisify(execFile)('git', ['-c', 'core.hooksPath=/dev/null', 'init', '--template=', '--initial-branch=main', root], {
        env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      const client = await pool.connect();
      let commit: string;
      try { commit = await new ContextGitBroker(root).commit(await readContextVersion(client, snapshot, 1)); }
      finally { client.release(); }
      await app.close();
      app = await buildTestGateway({ pool, authProvider: provider,
        contextRepository: { instance_id: 'fixture', repositoryPath: root },
      });
      const before = await nativeEffects();
      const history = (await request('GET', '/history')).json<unknown>();
      const status = (await request('GET', '/status')).json<unknown>();
      const inspected = await app.inject({ method: 'GET',
        url: `/v3/console/tenants/ContextAlpha/agents/director/context/repository/native-inspect?commit=${commit}`, headers: { cookie },
      });
      expect(inspected.statusCode).toBe(422);
      expect(inspected.json()).toMatchObject({ error: 'context_snapshot_unavailable', reason: 'unexpected_files' });
      const profile = await new AgentProfileRepository(pool).readWithPresence('ContextAlpha', 'director');
      const rejected = await app.inject({ method: 'PUT', url: '/v3/console/tenants/ContextAlpha/agents/director/perfil',
        headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf }, payload: {
          expected_revision: profile.revision, reason: 'Import the reviewed Git profile',
          profile: { purpose: 'Retired Git source', role_summary: null, human_brief: null,
            responsibilities: [], restrictions: [], tools: [], operating_rules: [] },
          context_source: { instance_id: 'fixture', commit },
        },
      });
      expect(rejected.statusCode).toBe(400);
      expect(rejected.json()).toMatchObject({ error: 'context_source_retired' });
      expect(await nativeEffects()).toEqual(before);
      expect((await request('GET', '/history')).json<unknown>()).toEqual(history);
      expect((await request('GET', '/status')).json<unknown>()).toEqual(status);
      expect((await request('GET')).json()).toMatchObject({ version: 1, applied_version: 0 });
    } finally { await rm(root, { recursive: true, force: true }); }
  });
  it('rejects native ingest from a signed human session without version, profile, outbox or audit effects', async () => {
    const before = await nativeEffects();
    const result = await app.inject({ method: 'POST', url: '/v3/context/ingest',
      headers: { cookie, origin: ORIGIN, 'x-csrf-token': csrf }, payload: nativePayload });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({ error: 'forbidden' });
    expect(await nativeEffects()).toEqual(before);
  });
  it.each<Partial<Principal>>([
    { roles: ['operator'] }, { roles: ['agent', 'operator'] },
    { roles: ['agent'], operator_id: 'fixture-operator' },
    { roles: ['adapter'], operator_id: 'fixture-operator' }, { roles: [] },
  ])('rejects native ingest from a non-agent principal %j without durable effects', async authority => {
    await app.close();
    const fallback = new FixedAuthProvider(testPrincipal({ tenant_id: 'ContextAlpha', alias: 'director', ...authority }));
    app = await buildTestGateway({ pool, authProvider: new PasswordAuthProvider({
      users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 19), fallback }) });
    const before = await nativeEffects();
    const result = await app.inject({ method: 'POST', url: '/v3/context/ingest', payload: nativePayload });
    expect(result.statusCode).toBe(403);
    expect(result.json()).toMatchObject({ error: 'forbidden' });
    expect(await nativeEffects()).toEqual(before);
  });
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
  it('blocks secrets with 422 and oversized versions with 413, naming the reason and never the value', async () => {
    const secret = `postgres://cauce:${'s3cr3t'.repeat(3)}@db.internal/cauce`;
    const blocked = await write(0, [{ path: 'context/mission.md', content: `Base: ${secret}` }]);
    expect(blocked.statusCode).toBe(422);
    expect(blocked.json()).toMatchObject({ error: 'context_secret_detected', paths: ['context/mission.md'] });
    expect(blocked.body).not.toContain('s3cr3t');
    const large = await write(0, [{ path: 'context/mission.md', content: 'x'.repeat(70_000) }]);
    expect(large.statusCode).toBe(413);
    expect(large.json()).toMatchObject({ error: 'context_harness_limit', max_bytes: 65_536,
      message: expect.stringContaining('exceeds the document limit of the agent harness') as string });
    expect((await current?.adminPool.query('SELECT count(*)::integer AS count FROM agent_context_versions'))?.rows).toEqual([{ count: 0 }]);
    expect((await request('GET')).json()).toMatchObject({ version: 0, versioning: { state: 'current' } });
  });
  it('keeps an unversioned V3 profile edit when the console sends back the profile of its snapshot', async () => {
    expect((await write()).statusCode).toBe(202);
    const profiles = new AgentProfileRepository(pool);
    const profile = await profiles.readWithPresence('ContextAlpha', 'director');
    const purpose = 'Equipo 👨‍👩‍👧 de soporte';
    await profiles.replace({ ...profile.perfil, purpose }, profile.revision, { tenant_id: 'ContextAlpha', alias: 'owner' });
    const snapshot = (await request('GET')).json<{ files: { path: string; content: string }[] }>();
    expect(snapshot).toMatchObject({ version: 1,
      versioning: { state: 'unversioned', reason: 'context_unsafe_text', source: 'profile', paths: ['context/profile.json'] } });
    const resent = await write(1, snapshot.files.map(file => file.path === 'context/mission.md' ? { ...file, content: 'Changed mission.' } : file));
    expect(resent.statusCode).toBe(422);
    expect(resent.json()).toMatchObject({ error: 'context_unsafe_text', paths: ['context/profile.json'] });
    expect((await profiles.read('ContextAlpha', 'director')).purpose).toBe(purpose);
    expect((await request('GET')).json()).toMatchObject({ version: 1, versioning: { state: 'unversioned', paths: ['context/profile.json'] } });
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
  it('counts the attempt of an application still awaiting its ACK when the gateway closes', async () => {
    await app.close();
    let queued!: () => void; const waiting = new Promise<void>(resolve => { queued = resolve; });
    app = await buildTestGateway({ pool, authProvider: provider, contextVersion: { runtime: { apply: async (_version, ready, stop) => {
      ready?.(); queued();
      await new Promise<void>(resolve => { stop?.addEventListener('abort', () => { resolve(); }, { once: true }); });
      throw new Error('context application consumed-turn evidence is unavailable');
    } } } });
    await app.ready();
    await write();
    expect((await request('POST', '/apply', {})).statusCode).toBe(202);
    await waiting;
    await app.close();
    expect((await pool.query('SELECT apply_token,apply_error FROM agent_context_outbox')).rows)
      .toEqual([{ apply_token: null, apply_error: 'context_runtime_verification_failed' }]);
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
