import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, createPool, FleetOperationsRepository, lockCompanyAuthority, withTransaction,
  type CompanyAuthoritySource, type DatabasePool, type FleetOperationClaim } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { esBaseDePruebas, provisionTestLogin, startTestCaseDatabase, startTestDatabase, TEST_RUNTIME_LOGIN,
  type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { createProviderAuthDependencies, loadProviderAuthRoutingScope } from '../console/provider-auth-binding.js';
import { ProviderAuthRequestSchema } from '../console/provider-auth.contracts.js';
import type { ProviderAuthActor, ProviderAuthDependencies, ProviderAuthRequest, ProviderAuthService, ProviderAuthSnapshot } from '../console/provider-auth.types.js';
import { AgentProviderAuthBroker } from './agent-provider-auth-broker.js';
import { startAuthBridge } from './auth-bridge-server.js';
import { createFleetProviderAuthRouter } from './auth-router.js';
import { channelCapabilities, channelCompany, channelCreate, channelHost, channelPost } from './host-channel.fixtures.js';
import { registerHostChannelRoutes } from './host-channel.routes.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let app: FastifyInstance | undefined; let broker: AgentProviderAuthBroker | undefined;
let actor: ProviderAuthActor; let homeCompany: string; let request: ProviderAuthRequest; let snapshot: ProviderAuthSnapshot;
let dependencies: ProviderAuthDependencies; let router: ReturnType<typeof createFleetProviderAuthRouter>;
let calls: string[]; let hostService: ProviderAuthService;
preparePostgresSuite(import.meta.url, async () => {
  if (!process.env.CAUCE_TEST_DATABASE_URL) database = await startTestDatabase();
}, 120_000);

async function exclusiveCase(): Promise<EmptyTestDatabase> {
  const external = process.env.CAUCE_TEST_ADMIN_DATABASE_URL ?? process.env.CAUCE_TEST_DATABASE_URL;
  if (!external) {
    if (!database) throw new Error('test database unavailable');
    const result = await startTestCaseDatabase(database);
    if (result.pool !== result.adminPool) return result;
    const url = await provisionTestLogin(result.adminPool, result.adminUrl, TEST_RUNTIME_LOGIN, 'cauce_runtime');
    const runtime = createPool(url);
    return { ...result, pool: runtime, url, close: async () => { await runtime.end(); await result.close(); } };
  }
  if (!esBaseDePruebas(external)) throw new Error('disposable test database required');
  const server = createPool(external); const name = `cauce_test_auth_platform_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(external); target.pathname = `/${name}`;
  try {
    await server.query(`CREATE DATABASE ${name} TEMPLATE cauce_test_plantilla`);
    const adminPool = createPool(target.toString());
    try {
      await applyMigrations(adminPool);
      const url = await provisionTestLogin(adminPool, target.toString(), TEST_RUNTIME_LOGIN, 'cauce_runtime');
      const runtime = createPool(url);
      return { pool: runtime, adminPool, url, adminUrl: target.toString(), close: async () => {
        await Promise.all([runtime.end(), adminPool.end()]);
        const cleanup = createPool(external);
        try { await cleanup.query(`DROP DATABASE ${name}`); } finally { await cleanup.end(); }
      } };
    } catch (error) { await adminPool.end(); await server.query(`DROP DATABASE ${name}`); throw error; }
  } finally { await server.end(); }
}

beforeEach(async () => {
  current = await exclusiveCase(); pool = current.pool; calls = [];
  expect((await pool.query("SELECT pg_has_role(current_user,'cauce_runtime','MEMBER') AS runtime")).rows).toEqual([{ runtime: true }]);
  const target = await channelCompany(pool, 'auth-platform-target'); const home = await channelCompany(pool, 'auth-platform-home');
  const host = await channelHost(pool, target); homeCompany = home.company.id;
  await current.adminPool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [home.user.id]);
  actor = { tenant_id: home.hub.id, alias: 'owner', subject: `console:${home.user.id}`, requestedCompany: target.company.id };
  const authoritySource: CompanyAuthoritySource = client => lockCompanyAuthority(client, { tenant: actor.tenant_id, alias: actor.alias,
    humanId: home.user.id, requestedCompany: target.company.id });
  expect(await withTransaction(pool, authoritySource)).toMatchObject({ homeCompany, actingCompany: target.company.id, platformOverride: true });
  app = Fastify(); registerHostChannelRoutes(app, pool);
  expect((await channelPost(app, host, channelCapabilities())).statusCode).toBe(200);
  const revision = Number((await pool.query<{ revision: string }>('SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions')).rows[0]?.revision);
  const operation = await new FleetOperationsRepository(pool).forAuthority(authoritySource)
    .enqueue(actor.tenant_id, actor.alias, channelCreate(target, host, 'platform-worker', revision), actor.subject);
  const claimed = await channelPost(app, host, { resource: 'fleet_operation', action: 'claim' });
  expect(claimed.statusCode).toBe(200); const claim = claimed.json<{ claim: FleetOperationClaim }>().claim;
  expect(claim.operation.id).toBe(operation.id);
  const prepared = await channelPost(app, host, { resource: 'fleet_operation', action: 'prepare',
    claim: { operation_id: operation.id, claim_token: claim.claim_token, epoch: claim.epoch } });
  expect(prepared.statusCode).toBe(200);
  await current.adminPool.query("UPDATE fleet_operations SET status='awaiting_auth',worker_id=NULL,claim_token=NULL,lease_expires_at=NULL WHERE id=$1", [operation.id]);
  broker = new AgentProviderAuthBroker(pool);
  if (!broker.service.resolve) throw new Error('enrolled resolver unavailable');
  const resolve = broker.service.resolve.bind(broker.service);
  request = await resolve(actor, operation.id);
  expect((await withTransaction(pool, client => loadProviderAuthRoutingScope(client, actor, operation.id))).sealed.host_id).toBe(host.host_id);
  const physicalHook = async (): Promise<never> => { throw new Error('physical hook forbidden in routing test'); };
  dependencies = createProviderAuthDependencies(pool, async () => ({ provider_id: request.provider_id, account_id: request.account_id,
    profile_id: request.profile_id, harness_id: request.harness_id, host_id: request.host_id, runtime_user: request.runtime_user }),
  { stopAdapter: physicalHook, openLogin: physicalHook, verify: physicalHook, cleanup: physicalHook });
  snapshot = { session_id: randomUUID(), operation_id: operation.id, provider_id: request.provider_id, account_id: request.account_id,
    profile_id: request.profile_id, harness_id: request.harness_id, host_id: request.host_id, runtime_user: request.runtime_user,
    method: 'terminal', status: 'awaiting_login', expires_at: new Date(Date.now() + 300_000).toISOString(), cleanup_pending: false, error: null };
  const record = (action: string, by: ProviderAuthActor) => { expect(by).toEqual(actor); calls.push(action); };
  hostService = {
    resolve,
    start: async (by, input) => { record('start', by); await dependencies.reserve(by, ProviderAuthRequestSchema.parse(input), snapshot.session_id, snapshot.expires_at); return snapshot; },
    get: async by => { record('get', by); return snapshot; }, verify: async by => { record('verify', by); return snapshot; },
    cancel: async by => { record('cancel', by); return snapshot; },
    issueSocketTicket: async by => { record('ticket', by); return { ticket: randomUUID(), expires_at: snapshot.expires_at }; },
    consumeSocketTicket: async by => { record('consume', by); },
    attach: async by => { record('attach', by); return { input: async () => { calls.push('input'); },
      resize: async () => { calls.push('resize'); }, close: async () => { calls.push('close'); } }; },
    revokeOperation: async () => { calls.push('revoke'); }, shutdown: async () => undefined,
  };
  router = createFleetProviderAuthRouter(pool, { hosts: [], enrolled: hostService });
});
afterEach(async () => { await broker?.shutdown(); broker = undefined; await app?.close(); app = undefined; await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function reserve(): Promise<void> {
  await dependencies.reserve(actor, request, snapshot.session_id, snapshot.expires_at);
  expect((await pool.query<{ subject: string }>(`SELECT metadata->'provider_auth'->>'actor_subject' AS subject FROM fleet_operation_events
    WHERE operation_id=$1 AND metadata->'provider_auth'->>'session_id'=$2`, [request.operation_id, snapshot.session_id])).rows)
    .toEqual([{ subject: actor.subject }]);
}
function actions(by: ProviderAuthActor) {
  const id = snapshot.session_id;
  return [() => router.get(by, id), () => router.verify(by, id), () => router.cancel(by, id),
    () => router.issueSocketTicket(by, id), () => router.consumeSocketTicket(by, id, randomUUID()), () => router.attach(by, id, () => undefined)];
}

describe('platform authentication sessions in the selected company', () => {
  it('starts and recovers every session action after a durable reservation outside the home company', async () => {
    expect((await router.resolve(actor, request.operation_id)).host_id).toBe(request.host_id);
    expect(await router.start(actor, request)).toEqual(snapshot);
    for (const action of actions(actor).slice(0, 5)) await action();
    const channel = await router.attach(actor, snapshot.session_id, () => undefined);
    await channel.input(Buffer.from('AUTHORIZED')); await channel.resize(100, 30); await channel.close();
    expect(calls).toEqual(['start', 'get', 'verify', 'cancel', 'ticket', 'consume', 'attach', 'input', 'resize', 'close']);
    expect((await pool.query("SELECT count(*)::int AS n FROM fleet_operation_events WHERE metadata ? 'provider_auth'")).rows).toEqual([{ n: 1 }]);
  });
  it('carries the selected company to a computer configured over a private socket', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'auth-platform-socket-'));
    const socket = join(directory, 'auth.sock'); const policy = { ownerUid: process.geteuid?.() ?? 0 };
    const bridge = await startAuthBridge(socket, hostService, policy);
    const routed = createFleetProviderAuthRouter(pool, { hosts: [{ host_id: request.host_id, socket_path: socket, socket_policy: policy }] });
    try {
      expect((await routed.resolve(actor, request.operation_id)).host_id).toBe(request.host_id);
      expect(await routed.start(actor, request)).toEqual(snapshot);
      expect(await routed.get(actor, snapshot.session_id)).toEqual(snapshot);
      expect(calls).toEqual(['start', 'get']);
    } finally { await routed.shutdown(); await bridge.close(); await rm(directory, { recursive: true, force: true }); }
  });
  it('denies a wrong selected company, home fallback and another subject without contacting the host', async () => {
    await reserve();
    const { requestedCompany: _selected, ...homeActor } = actor;
    for (const by of [{ ...actor, requestedCompany: homeCompany }, homeActor, { ...actor, subject: `console:${randomUUID()}` }])
      for (const action of actions(by)) await expect(action()).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(calls).toEqual([]);
  });
  it('rechecks current platform authority before any reserved session action reaches the host', async () => {
    await reserve();
    await current?.adminPool.query('DELETE FROM platform_admins WHERE human_id=$1', [actor.subject.slice('console:'.length)]);
    for (const action of actions(actor)) await expect(action()).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(calls).toEqual([]);
  });
  it('closes an attached channel on platform revocation before forwarding input or resize', async () => {
    await reserve(); const channel = await router.attach(actor, snapshot.session_id, () => undefined);
    await current?.adminPool.query('DELETE FROM platform_admins WHERE human_id=$1', [actor.subject.slice('console:'.length)]);
    await expect(channel.input(Buffer.from('REVOKED'))).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await expect(channel.resize(100, 30)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    expect(calls).toEqual(['attach', 'close', 'close']);
  });
});
