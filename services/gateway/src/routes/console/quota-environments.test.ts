import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { generateKeyPairSync, sign } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, HostEnrollmentRepository, QuotaOperationsRepository, hostEnrollmentMessage, lockCompanyAuthority, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../../packages/store/test/postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from '../../../../../packages/store/test/companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../../tests/helpers/postgres.js';
import { PostgresConsoleUserStore } from '../../console-users.js';
import { hashPassword } from '../../password.js';
import { PasswordAuthProvider } from '../../password-auth.js';
import { buildTestGateway } from '../../test-support/gateway-doubles.js';
import { channelCapabilities, channelPost } from '../../fleet/host-channel.fixtures.js';

const PASSWORD = 'quota-company-fixture-password';
const ORIGIN = 'http://localhost';
let database: TestDatabase;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let admin: DatabasePool; let people: CompanyIsolationFixture;
let hash: string | undefined; let app: FastifyInstance;
let clock: number;
let quotaOptions: { approvedHostIds: string[]; providers: 'codex'[]; now: () => Date };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  hash ??= await hashPassword(PASSWORD, { cost: 1_024, blockSize: 8, parallelism: 1 });
  people = await seedCompanyIsolation(admin);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query('UPDATE console_users SET password_hash=$1', [hash]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [people.leon]);
  const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(pool), signingKey: Buffer.alloc(32, 47) });
  clock = Date.now();
  quotaOptions = { approvedHostIds: ['humanizar-host','praxis-host'], providers: ['codex'], now: () => new Date(clock) };
  app = await buildTestGateway({ pool, authProvider: provider, repository: new CauceRepository(pool),
    quotaEnvironments: quotaOptions });
});
afterEach(async () => { await app.close(); await current?.close(); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
interface Session { cookie: string; csrf: string }
async function login(email: string): Promise<Session> {
  const response = await app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: ORIGIN }, payload: { email, password: PASSWORD } });
  expect(response.statusCode).toBe(200);
  const raw = response.headers['set-cookie'];
  const header = (Array.isArray(raw) ? raw : raw === undefined ? [] : [raw]).find(value => value.startsWith('__Host-cauce_session='));
  return { cookie: header?.split(';', 1)[0] ?? '', csrf: response.json<{ csrf_token: string }>().csrf_token };
}
function mutation(session: Session, method: 'POST' | 'PATCH', url: string, payload: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({ method, url, payload, headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf } });
}
async function accounts(session: Session): Promise<{ accounts: { id: string; version: number }[] }> {
  const response = await app.inject({ method: 'GET', url: '/v3/console/quota-accounts', headers: { cookie: session.cookie } });
  expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store'); return response.json();
}
function read(session: Session, resource: 'quota-accounts' | 'quota-environments'): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'GET', url: `/v3/console/${resource}`, headers: { cookie: session.cookie } });
}
function remove(session: Session, id: string, query: string, payload?: Record<string, unknown>): Promise<LightMyRequestResponse> {
  return app.inject({ method: 'DELETE', url: `/v3/console/quota-environments/${id}?${query}`, ...payload === undefined ? {} : { payload },
    headers: { cookie: session.cookie, origin: ORIGIN, 'x-csrf-token': session.csrf } });
}
async function createEnvironment(session: Session, authenticate = true): Promise<{ id: string; version: number }> {
  const response = await mutation(session, 'POST', '/v3/console/quota-environments', {
    account_id: 'humanizar-account', host_id: 'humanizar-host', label: 'Automatic refresh', idempotency_key: 'http-refresh-environment',
  });
  expect(response.statusCode).toBe(200);
  const { id } = response.json<{ environment: { id: string } }>().environment;
  const worker = new QuotaOperationsRepository(pool);
  const creation = await worker.claim('worker', 'humanizar-host');
  if (!creation) throw new Error('fixture create operation missing');
  await worker.finish(creation, { runtime_verified: true });
  if (authenticate) {
    expect((await mutation(session, 'POST', `/v3/console/quota-environments/${id}/actions`, {
      action: 'authenticate', consent: true, expected_version: 2, idempotency_key: 'http-refresh-authentication',
    })).statusCode).toBe(200);
    const authentication = await worker.claim('worker', 'humanizar-host');
    if (!authentication) throw new Error('fixture authentication operation missing');
    await worker.finish(authentication, { authenticated_verified: true, account_identity: 'humanizar-external' });
  }
  return { id, version: authenticate ? 3 : 2 };
}
const queryCount = async () => Number((await admin.query<{ count: string }>(
  "SELECT count(*)::text AS count FROM quota_environment_operations WHERE action='query'",
)).rows[0]?.count);

describe('quota console routes under a real password session and company authority', () => {
  it('uses fresh signed host/provider capabilities without central presets or stale static fallback', async () => {
    const repository = new HostEnrollmentRepository(pool); const keys = generateKeyPairSync('ed25519');
    const invitation = await repository.invite(client => lockCompanyAuthority(client,
      { tenant: 'Miguel', alias: 'janus', humanId: people.miguel }), { host_id: 'humanizar-cold_quota', display_name: 'New quota computer' });
    await repository.claim(invitation.enrollment_id, { invitation_token: invitation.invitation_token,
      public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), keys.privateKey).toString('base64') });
    const host = { host_id: invitation.host_id, company_id: invitation.company_id, keys };
    const session = await login('miguel@example.test');
    const create = (key: string) => mutation(session,'POST','/v3/console/quota-environments',
      { account_id: 'humanizar-account', host_id: host.host_id, label: 'Signed environment', idempotency_key: key });
    expect((await create('unsigned-host')).statusCode).toBe(409);
    const actions = ['create','authenticate','query','update_cli','delete'];
    expect((await channelPost(app,host,{ ...channelCapabilities(), quota_providers: ['claude'], quota_provider_actions: { claude: actions } })).statusCode).toBe(200);
    expect((await create('wrong-provider')).statusCode).toBe(409);
    quotaOptions.approvedHostIds.push(host.host_id);
    expect((await channelPost(app,host,{ ...channelCapabilities(), quota_provider_actions: {} })).statusCode).toBe(200);
    expect((await create('missing-actions')).statusCode).toBe(409);
    expect((await channelPost(app,host,channelCapabilities())).statusCode).toBe(200);
    const capabilities = await app.inject({ method: 'GET', url: '/v3/console/quota-environments', headers: { cookie: session.cookie } });
    expect(capabilities.json<{ capabilities: { hosts: unknown[] } }>().capabilities.hosts).toContainEqual({
      host_id: host.host_id, display_name: 'New quota computer', providers: ['codex'],
      provider_actions: { codex: ['create','authenticate','query','update_cli','delete'] },
    });
    const created = await create('signed-host'); expect(created.statusCode).toBe(200);
    const environment = created.json<{ environment: { id: string } }>().environment;
    const worker = new QuotaOperationsRepository(pool); const claim = await worker.claim('worker', host.host_id);
    if (!claim) throw new Error('fixture signed creation missing');
    await worker.finish(claim, { runtime_verified: true });
    expect((await channelPost(app,host,{ ...channelCapabilities(), quota_provider_actions: { codex: ['query'] } })).statusCode).toBe(200);
    const restricted = await app.inject({ method: 'GET', url: '/v3/console/quota-environments', headers: { cookie: session.cookie } });
    expect(restricted.json<{ capabilities: { hosts: unknown[] } }>().capabilities.hosts).toContainEqual({
      host_id: host.host_id, display_name: 'New quota computer', providers: ['codex'], provider_actions: { codex: ['query'] },
    });
    expect((await create('missing-create')).statusCode).toBe(409);
    for (const action of ['authenticate','update_cli','delete']) {
      expect((await mutation(session,'POST',`/v3/console/quota-environments/${environment.id}/actions`,
        { action, expected_version: 2, idempotency_key: `missing-${action}`, consent: true })).statusCode).toBe(409);
    }
    expect((await mutation(session,'POST',`/v3/console/quota-environments/${environment.id}/actions`,
      { action: 'query', expected_version: 2, idempotency_key: 'supported-query' })).statusCode).toBe(200);
    expect((await channelPost(app,host,channelCapabilities())).statusCode).toBe(200);
    await admin.query("UPDATE fleet_host_identities SET capabilities_seen_at=now()-interval '121 seconds' WHERE host_id=$1", [host.host_id]);
    expect((await create('stale-host')).statusCode).toBe(409);
    await admin.query('UPDATE fleet_host_identities SET enabled=false,capabilities_seen_at=now() WHERE host_id=$1', [host.host_id]);
    expect((await create('revoked-host')).statusCode).toBe(409);
  });
  it('lets an owner outside the hub register an account without an agent and queue only its own host', async () => {
    const session = await login('miguel@example.test');
    const created = await mutation(session,'POST','/v3/console/quota-accounts', { provider: 'codex', label: 'Personal quota', idempotency_key: 'quota-route' });
    expect(created.statusCode).toBe(200);
    const account = created.json<{ account_id: string }>().account_id;
    expect((await accounts(session)).accounts.map(row => row.id)).toContain(account);
    const environment = await mutation(session,'POST','/v3/console/quota-environments',
      { account_id: account, host_id: 'humanizar-host', label: 'Own environment', idempotency_key: 'quota-route-environment' });
    expect(environment.statusCode).toBe(200); expect(environment.json()).toMatchObject({ operation: { action: 'create', status: 'pending' } });
    const foreign = await mutation(session,'POST','/v3/console/quota-environments',
      { account_id: account, host_id: 'praxis-host', label: 'Foreign environment', idempotency_key: 'quota-route-foreign' });
    expect(foreign.statusCode).toBe(403);
    expect((await accounts(await login('leon@example.test'))).accounts.map(row => row.id)).toEqual(['praxis-account']);
  });
  it('rejects creating a gemini quota account with 400', async () => {
    const session = await login('miguel@example.test');
    const gemini = await mutation(session,'POST','/v3/console/quota-accounts', { provider: 'gemini', label: 'Gemini', idempotency_key: 'quota-gemini' });
    expect(gemini.statusCode).toBe(400);
  });
  it('requires the session CSRF token and rejects arbitrary commands', async () => {
    const session = await login('miguel@example.test');
    const withoutCsrf = await app.inject({ method: 'POST', url: '/v3/console/quota-accounts', headers: { cookie: session.cookie, origin: ORIGIN },
      payload: { provider: 'codex', label: 'Bad', idempotency_key: 'missing-csrf' } });
    expect(withoutCsrf.statusCode).toBe(403);
    const created = await mutation(session,'POST','/v3/console/quota-environments',
      { account_id: 'humanizar-account', host_id: 'humanizar-host', label: 'Typed environment', idempotency_key: 'typed' });
    expect(created.statusCode).toBe(200);
    const id = created.json<{ environment: { id: string } }>().environment.id;
    const action = await mutation(session,'POST',`/v3/console/quota-environments/${id}/actions`,
      { action: 'query', expected_version: 1, idempotency_key: 'shell', command: 'bash' });
    expect(action.statusCode).toBe(400);
  });
  it('allows tenant readers to view their shared account and refuses writes', async () => {
    await admin.query("UPDATE console_users SET role='reader' WHERE id=$1", [people.miguel]);
    await admin.query("UPDATE human_tenant_memberships SET role='reader',permissions=ARRAY['read'] WHERE human_id=$1", [people.miguel]);
    await admin.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('Miguel','janus','humanizar-account','Steven','Steven')`);
    await admin.query("INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority) VALUES('Miguel','janus','humanizar-account',1)");
    const session = await login('miguel@example.test');
    expect((await accounts(session)).accounts.map(row => row.id)).toEqual(['humanizar-account']);
    const write = await mutation(session,'PATCH','/v3/console/quota-accounts/humanizar-account', { expected_version: 1, label: 'Unauthorized' });
    expect(write.statusCode).toBe(403);
  });
  it('refreshes account and environment reads once across concurrent tabs and preserves native observation age', async () => {
    const session = await login('miguel@example.test');
    clock -= 600_001;
    const environment = await createEnvironment(session);
    await new CauceRepository(pool).recordQuotaSample('Steven', 'kant', {
      host: 'http-native-refresh', captured_at: new Date(clock).toISOString(), schema_version: 2,
      providers: [{ provider: 'codex', account_id: 'humanizar-account', ok: true, available: true,
        available_groups: [], limiting_groups: [], windows: [{ group_key: 'default', window_key: 'week',
          account_id: 'humanizar-account', used_percent: 30, observed_at: new Date(clock - 600_001).toISOString(),
          reset_at: new Date(clock + 86_400_000).toISOString() }] }],
    });
    const [accountRead, environmentRead] = await Promise.all([read(session, 'quota-accounts'), read(session, 'quota-environments')]);
    expect(accountRead.statusCode).toBe(200); expect(environmentRead.statusCode).toBe(200);
    expect(accountRead.json()).toMatchObject({ accounts: [{ id: 'humanizar-account', refresh_status: 'updating' }] });
    expect(environmentRead.json()).toMatchObject({
      environments: [{ id: environment.id, refresh_status: 'updating' }],
      refreshes: [{ captured_at: new Date(clock - 600_001).toISOString(), status: 'updating' }],
      operations: [{ action: 'query', status: 'pending' }],
    });
    expect(await queryCount()).toBe(1);
    expect((await read(session, 'quota-accounts')).statusCode).toBe(200);
    expect(await queryCount()).toBe(1);
    const worker = new QuotaOperationsRepository(pool);
    const first = await worker.claim('worker', 'humanizar-host');
    if (!first) throw new Error('fixture automatic query missing');
    expect((await read(session, 'quota-environments')).json()).toMatchObject({ operations: [{ action: 'query', status: 'running' }] });
    const finish = async (claim: typeof first, observed: number, used: number) => worker.finish(claim, {
      captured_at: new Date(clock).toISOString(), provider_report: { provider: 'codex', account_id: 'humanizar-account',
        ok: true, available: true, observed_at: new Date(observed).toISOString(),
        windows: [{ group_key: 'default', window_key: 'week', account_id: 'humanizar-account', used_percent: used,
          reset_at: new Date(clock + 86_400_000).toISOString() }] },
    });
    await finish(first, clock - 600_001, 30);
    expect((await read(session, 'quota-accounts')).json()).toMatchObject({ accounts: [{ refresh_status: 'stale' }] });
    expect(await queryCount()).toBe(1);
    clock += 600_001;
    expect((await read(session, 'quota-environments')).json()).toMatchObject({ environments: [{ refresh_status: 'updating' }] });
    expect(await queryCount()).toBe(2);
    const second = await worker.claim('worker', 'humanizar-host');
    if (!second) throw new Error('fixture next-window query missing');
    await finish(second, clock, 28);
    expect((await read(session, 'quota-accounts')).json()).toMatchObject({
      accounts: [{ id: 'humanizar-account', refresh_status: 'fresh', remaining_percent: 72, observation_status: 'ok' }],
    });
    expect(await queryCount()).toBe(2);
    const foreign = await read(await login('leon@example.test'), 'quota-environments');
    expect(foreign.statusCode).toBe(200); expect(foreign.json()).toMatchObject({ company_id: 'praxis', environments: [], refreshes: [] });
  });
  it.each(['not_authenticated', 'executor_unavailable', 'deleted', 'read_only'] as const)(
    'returns explicit %s status without queuing a query', async status => {
      let session = await login('miguel@example.test');
      const environment = await createEnvironment(session, status !== 'not_authenticated');
      if (status === 'executor_unavailable') await admin.query("UPDATE fleet_hosts SET enabled=false WHERE host_id='humanizar-host'");
      if (status === 'deleted') await admin.query("UPDATE quota_environments SET status='deleted' WHERE id=$1", [environment.id]);
      if (status === 'read_only') {
        await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [people.steven]);
        await admin.query('DELETE FROM company_admins WHERE human_id=$1', [people.steven]);
        await admin.query("UPDATE console_users SET role='reader' WHERE id=$1", [people.steven]);
        await admin.query("UPDATE human_tenant_memberships SET role='reader',permissions=ARRAY['read'] WHERE human_id=$1", [people.steven]);
        session = await login('steven@example.test');
      }
      const accountRead = await read(session, 'quota-accounts');
      const environmentRead = await read(session, 'quota-environments');
      expect(accountRead.statusCode).toBe(200); expect(environmentRead.statusCode).toBe(200);
      expect(accountRead.json()).toMatchObject({ accounts: [{ refresh_status: status }] });
      expect(environmentRead.json()).toMatchObject({ environments: [{ id: environment.id, refresh_status: status }] });
      expect(await queryCount()).toBe(0);
    },
  );
  it('deletes using query parameters with CSRF, version checks, replay and foreign-or-missing 404', async () => {
    const session = await login('miguel@example.test');
    const environment = await createEnvironment(session);
    const query = new URLSearchParams({ expected_version: String(environment.version), idempotency_key: 'http-delete-query' }).toString();
    const withoutCsrf = await app.inject({ method: 'DELETE',
      url: `/v3/console/quota-environments/${environment.id}?${query}`, headers: { cookie: session.cookie, origin: ORIGIN } });
    expect(withoutCsrf.statusCode).toBe(403);
    expect((await remove(session, environment.id, 'expected_version=999&idempotency_key=bad-version')).statusCode).toBe(409);
    const foreign = await login('leon@example.test');
    expect((await remove(foreign, environment.id, query)).statusCode).toBe(404);
    expect((await remove(session, '00000000-0000-4000-8000-000000000000', query)).statusCode).toBe(404);
    const deleted = await remove(session, environment.id, query);
    expect(deleted.statusCode).toBe(200); expect(deleted.json()).toMatchObject({ operation: { action: 'delete', status: 'pending' } });
    const worker = new QuotaOperationsRepository(pool); const claim = await worker.claim('worker', 'humanizar-host');
    if (!claim) throw new Error('fixture deletion operation missing');
    await worker.finish(claim, { stopped_verified: true, profile_removed_verified: true });
    const replay = await remove(session, environment.id, query);
    expect(replay.statusCode).toBe(200); expect(replay.json()).toMatchObject({
      environment: { status: 'deleted' }, operation: { action: 'delete', status: 'done', id: claim.id },
    });
    expect(Number((await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM quota_environment_operations WHERE action='delete'",
    )).rows[0]?.count)).toBe(1);
  });
  it('rejects old DELETE bodies, duplicate query fields and extra input before queuing effects', async () => {
    const session = await login('miguel@example.test'); const environment = await createEnvironment(session);
    const query = 'expected_version=3&idempotency_key=http-delete-invalid';
    expect((await remove(session, environment.id, '', { expected_version: 3, idempotency_key: 'old-body' })).statusCode).toBe(400);
    for (const value of ['', 'expected_version=3', 'expected_version=0&idempotency_key=invalid',
      `${query}&command=bash`, `${query}&expected_version=3`, `${query}&idempotency_key=other`]) {
      expect((await remove(session, environment.id, value)).statusCode).toBe(400);
    }
    expect((await remove(session, environment.id, query, { expected_version: 3 })).statusCode).toBe(400);
    expect(Number((await admin.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM quota_environment_operations WHERE action='delete'",
    )).rows[0]?.count)).toBe(0);
  });
});
