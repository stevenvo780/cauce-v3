import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPool, FleetOperationsRepository, withTransaction, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { channelCapabilities, channelCompany, channelCreate, channelHost, channelPost } from './host-channel.fixtures.js';
import { registerHostChannelRoutes } from './host-channel.routes.js';
import { createFleetProviderAuthRouter } from './auth-router.js';
import { AgentProviderAuthBroker } from './agent-provider-auth-broker.js';
import { registerAgentProviderAuthHostRoute } from './agent-provider-auth-route.js';
import { enrolledAgentAuthFixture } from './agent-provider-auth.fixtures.js';
import { access, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredFleetGateway } from './gateway-config.js';
import { HostCapabilityRegistry } from './host-channel.capabilities.js';
import * as providerAuthBinding from '../console/provider-auth-binding.js';
import * as hostProviderAuth from './host-provider-auth.js';
import { ProviderAuthError } from '../console/provider-auth.contracts.js';
import { randomUUID } from 'node:crypto';
import type { ProviderAuthDependencies } from '../console/provider-auth.types.js';
import { recoverAgentAuthSession } from './agent-provider-auth-recovery.js';

let database: TestDatabase; let current: EmptyTestDatabase; let pool: DatabasePool; let app: FastifyInstance;
let router: ReturnType<typeof createFleetProviderAuthRouter> | undefined;
let local: Awaited<ReturnType<typeof enrolledAgentAuthFixture>> | undefined;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabase();
  process.stdout.write(`E2E fixture database: ${database.container.getId()}\n`);
});
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = current.pool;
  if (process.env.CAUCE_TEST_RUNTIME_ROLE === '1') {
    expect((await pool.query<{ runtime: boolean }>("SELECT pg_has_role(current_user,'cauce_runtime','MEMBER') AS runtime")).rows[0]?.runtime).toBe(true);
  }
  app = Fastify(); registerHostChannelRoutes(app, pool);
});
afterEach(async () => { await router?.shutdown(); await app.close(); await local?.hostRuntime.shutdown();
  if (local) await rm(local.directory, { recursive: true, force: true }); await current.close(); router = undefined; local = undefined; vi.restoreAllMocks(); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });

describe('enrolled agent provider authentication', () => {
  it('retains the sanitized resource-limit cause when the actual login-stop helper fails', async () => {
    const broker = new AgentProviderAuthBroker(pool); registerAgentProviderAuthHostRoute(app, pool, broker);
    local = await enrolledAgentAuthFixture(pool, app);
    const executable = join(local.directory, 'synthetic-executor.py');
    const source = await readFile(executable, 'utf8');
    await writeFile(executable, source.replace("step=sys.argv[sys.argv.index('--step')+1]",
      "step=sys.argv[sys.argv.index('--step')+1]\n if step=='login-stop':\n  print('fleet effect failed: container resource limits differ from the approved shape',file=sys.stderr)\n  sys.exit(2)"));
    router = createFleetProviderAuthRouter(pool, { hosts: [], enrolled: broker.service });
    const request = await router.resolve(local.actor, local.operation.id);
    const session = await router.start(local.actor, request);
    expect(session).toMatchObject({ status: 'failed', error: 'STOP_UNCONFIRMED', reason: 'CONTAINER_RESOURCE_LIMITS_DRIFT' });
    await expect(router.attach(local.actor, session.session_id, () => undefined)).rejects.toMatchObject({ code: 'SESSION_CONFLICT' });
    const audit = (await pool.query<{ status: unknown }>("SELECT metadata->'provider_auth_status' AS status FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth_status' ORDER BY id DESC LIMIT 1", [local.operation.id])).rows[0];
    expect(audit?.status).toMatchObject({ error: 'STOP_UNCONFIRMED', reason: 'CONTAINER_RESOURCE_LIMITS_DRIFT' });
    const recovered = new AgentProviderAuthBroker(pool);
    try { expect(await recovered.service.get(local.actor, session.session_id)).toEqual(session); }
    finally { await recovered.shutdown(); }
  }, 30_000);
  it.each(['open', 'start', 'verify'])('preserves runtime drift from %s through signed commands, audit and recovery', async phase => {
    const broker = new AgentProviderAuthBroker(pool); registerAgentProviderAuthHostRoute(app, pool, broker);
    local = await enrolledAgentAuthFixture(pool, app);
    router = createFleetProviderAuthRouter(pool, { hosts: [], enrolled: broker.service });
    const request = await router.resolve(local.actor, local.operation.id);
    const rejectBinding = () => vi.spyOn(hostProviderAuth, 'hostProviderLoginConfiguration').mockRejectedValueOnce(new ProviderAuthError('RUNTIME_DRIFT'));
    if (phase === 'open') rejectBinding();
    const session = await router.start(local.actor, request);
    if (phase === 'start') {
      rejectBinding();
      await expect(router.attach(local.actor, session.session_id, () => undefined)).rejects.toMatchObject({ code: 'RUNTIME_DRIFT' });
    } else if (phase === 'verify') {
      await router.attach(local.actor, session.session_id, () => undefined); rejectBinding();
      expect(await router.verify(local.actor, session.session_id)).toMatchObject({ error: 'RUNTIME_DRIFT' });
    }
    const failed = await router.get(local.actor, session.session_id);
    expect(failed).toMatchObject({ status: 'failed', error: 'RUNTIME_DRIFT', cleanup_pending: false });
    const audit = (await pool.query<{ status: unknown }>("SELECT metadata->'provider_auth_status' AS status FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth_status' ORDER BY id DESC LIMIT 1", [local.operation.id])).rows[0];
    expect(audit?.status).toMatchObject({ error: 'RUNTIME_DRIFT' });
    const recovered = new AgentProviderAuthBroker(pool);
    try { expect(await recovered.service.get(local.actor, session.session_id)).toEqual(failed); }
    finally { await recovered.shutdown(); }
  }, 30_000);
  async function ready(options: { ttlMs?: number } = {}) {
    const broker = new AgentProviderAuthBroker(pool, options); registerAgentProviderAuthHostRoute(app, pool, broker);
    local = await enrolledAgentAuthFixture(pool, app); router = createFleetProviderAuthRouter(pool, { hosts: [], enrolled: broker.service });
    const request = await router.resolve(local.actor, local.operation.id);
    const session = await router.start(local.actor, request);
    expect(session.status).toBe('awaiting_login');
    return { broker, local, router, request, session };
  }
  it('cleans a releasing reservation even before its first host binding exists', async () => {
    let dependencies: ProviderAuthDependencies | undefined;
    const createDependencies = providerAuthBinding.createProviderAuthDependencies;
    vi.spyOn(providerAuthBinding, 'createProviderAuthDependencies').mockImplementation((...args) => {
      dependencies = createDependencies(...args); return dependencies;
    });
    const broker = new AgentProviderAuthBroker(pool); registerAgentProviderAuthHostRoute(app, pool, broker);
    local = await enrolledAgentAuthFixture(pool, app);
    router = createFleetProviderAuthRouter(pool, { hosts: [], enrolled: broker.service });
    const request = await router.resolve(local.actor, local.operation.id);
    if (!dependencies) throw new Error('dependencies absent');
    const sessionId = randomUUID();
    const reservation = await dependencies.reserve(local.actor, request, sessionId, new Date(Date.now() + 10_000).toISOString());
    expect((await pool.query(`SELECT 1 FROM fleet_operation_events WHERE operation_id=$1
      AND metadata ? 'agent_provider_auth_scope'`, [local.operation.id])).rowCount).toBe(0);
    await reservation.release();
    expect((await pool.query<{ state: string }>(`SELECT metadata->'provider_auth'->>'state' AS state FROM fleet_operation_events
      WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`, [local.operation.id])).rows[0]?.state).toBe('released');
  }, 30_000);
  it('does not hold a pool connection or operation locks during recovery cleanup', async () => {
    const f = await ready();
    const restricted = createPool(current.url, { max: 1, connectionTimeoutMillis: 1000 });
    let started!: () => void; let finish!: () => void;
    const waiting = new Promise<void>(resolve => { started = resolve; });
    const response = new Promise<void>(resolve => { finish = resolve; });
    const recovering = recoverAgentAuthSession(restricted, f.local.actor, f.session.session_id, async binding => {
      expect(binding.fence.session_id).toBe(f.session.session_id); started(); await response; return true;
    }, true);
    try {
      await waiting;
      await withTransaction(restricted, async client => {
        await client.query('SELECT id FROM fleet_operations WHERE id=$1 FOR UPDATE NOWAIT', [f.local.operation.id]);
        expect((await client.query<{ free: boolean }>('SELECT pg_try_advisory_xact_lock(hashtextextended($1,783003005)) AS free',
          [JSON.stringify([f.request.host_id, f.request.runtime_user, f.request.profile_id])])).rows[0]?.free).toBe(true);
      });
    } finally { finish(); await recovering; await restricted.end(); }
    expect(await recovering).toMatchObject({ status: 'cancelled', cleanup_pending: false });
  }, 30_000);
  it('recovers an unavailable cleanup as a durable unconfirmed stop without releasing its reservation', async () => {
    const f = await ready(); const recovered = new AgentProviderAuthBroker(pool);
    const exchange = vi.spyOn(f.broker, 'exchange').mockImplementation((...args) => recovered.exchange(...args));
    const context = vi.spyOn(f.broker, 'context').mockImplementation((...args) => recovered.context(...args));
    const policy = vi.spyOn(hostProviderAuth, 'readHostProviderAuthPolicy');
    policy.mockRejectedValueOnce(new ProviderAuthError('HOST_UNAVAILABLE', 'CONTAINER_RESOURCE_LIMITS_DRIFT'));
    try {
      const failed = await recovered.service.get(f.local.actor, f.session.session_id);
      expect(failed).toMatchObject({ status: 'failed', error: 'STOP_UNCONFIRMED', cleanup_pending: true,
        reason: 'CONTAINER_RESOURCE_LIMITS_DRIFT' });
      policy.mockRejectedValueOnce(new ProviderAuthError('HOST_UNAVAILABLE'));
      expect(await recovered.service.get(f.local.actor, f.session.session_id)).toMatchObject({
        error: 'STOP_UNCONFIRMED', cleanup_pending: true, reason: 'CONTAINER_RESOURCE_LIMITS_DRIFT' });
      const reservation = (await pool.query<{ reservation: unknown }>("SELECT metadata->'provider_auth' AS reservation FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1", [f.local.operation.id])).rows[0];
      expect(reservation?.reservation).toMatchObject({ state: 'reserved' });
      expect(await recovered.service.cancel(f.local.actor, f.session.session_id)).toMatchObject({ status: 'cancelled', cleanup_pending: false });
    } finally { policy.mockRestore(); exchange.mockRestore(); context.mockRestore(); await recovered.shutdown(); }
  }, 30_000);
  it('recovers a durably cancelled session after replacing the gateway broker', async () => {
    const f = await ready(); await f.router.attach(f.local.actor, f.session.session_id, () => undefined);
    expect(await f.router.cancel(f.local.actor, f.session.session_id)).toMatchObject({ status: 'cancelled', cleanup_pending: false });
    const recovered = new AgentProviderAuthBroker(pool);
    await expect(recovered.service.get(f.local.actor, f.session.session_id)).resolves.toMatchObject({
      session_id: f.session.session_id, status: 'cancelled', cleanup_pending: false });
    await expect(recovered.service.get({ ...f.local.actor, subject: 'console:00000000-0000-4000-8000-000000000000' }, f.session.session_id))
      .rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await recovered.shutdown();
  }, 30_000);
  it('rejects foreign company and changed profile before forwarding typed login commands', async () => {
    const f = await ready(); const foreign = await channelCompany(pool, 'auth-foreign');
    for (const input of [{ ...f.request, account_id: 'foreign-account' }, { ...f.request, profile_id: 'foreign-profile' },
      { ...f.request, runtime_user: 'otheruser' }, { ...f.request, host_id: 'other-host' }]) {
      await expect(f.router.start(f.local.actor, { ...input, request_id: 'changed-scope' })).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    }
    await expect(f.router.resolve({ ...f.local.actor, requestedCompany: foreign.company.id }, f.local.operation.id)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const terminal = await f.router.attach(f.local.actor, f.session.session_id, () => undefined);
    await expect(terminal.input(Buffer.alloc(4097))).rejects.toMatchObject({ code: 'INVALID_REQUEST' });
    expect(await f.router.cancel(f.local.actor, f.session.session_id)).toMatchObject({ status: 'cancelled', cleanup_pending: false });
    await expect(access(join(f.local.directory, f.local.operation.id + '.json'))).rejects.toThrow();
  }, 30_000);
  it('requires functional identity proof and preserves a failed result with confirmed stop', async () => {
    const f = await ready(); await f.router.attach(f.local.actor, f.session.session_id, () => undefined);
    expect(await f.router.verify(f.local.actor, f.session.session_id)).toMatchObject({ status: 'failed', error: 'IDENTITY_MISMATCH', cleanup_pending: false });
    const audit = (await pool.query<{ status: unknown }>("SELECT metadata->'provider_auth_status' AS status FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth_status' ORDER BY id DESC LIMIT 1", [f.local.operation.id])).rows[0];
    expect(audit?.status).toMatchObject({ status: 'failed', error: 'IDENTITY_MISMATCH' });
  }, 30_000);
  it('revokes an operation and confirms real PTY cleanup before releasing its cohort', async () => {
    const f = await ready(); await f.router.attach(f.local.actor, f.session.session_id, () => undefined);
    await f.router.revokeOperation(f.local.operation.id);
    expect(await f.router.get(f.local.actor, f.session.session_id)).toMatchObject({ status: 'failed', error: 'AUTHORITY_REVOKED', cleanup_pending: false });
    await expect(access(join(f.local.directory, f.local.operation.id + '.json'))).rejects.toThrow();
  }, 30_000);
  it('stops the actual local login after the durable operation authority is cancelled', async () => {
    const f = await ready(); const terminal = await f.router.attach(f.local.actor, f.session.session_id, () => undefined);
    const saved = JSON.parse(await readFile(join(f.local.directory, f.local.operation.id + '.json'), 'utf8')) as { processes: { pid: number }[] };
    expect(saved.processes.length).toBeGreaterThan(0);
    await current.adminPool.query('UPDATE fleet_operations SET cancel_requested=true WHERE id=$1', [f.local.operation.id]);
    await expect(terminal.input(Buffer.from('SYNTHETIC_LOGIN_INPUT\n'))).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await f.router.revokeOperation(f.local.operation.id);
    for (const processIdentity of saved.processes) expect(() => process.kill(processIdentity.pid, 0)).toThrow();
    const reservation = (await pool.query<{ reservation: unknown }>("SELECT metadata->'provider_auth' AS reservation FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1", [f.local.operation.id])).rows[0];
    expect(reservation?.reservation).toMatchObject({ state: 'released' });
  }, 30_000);
  it('fences a disabled enrolled host and closes its actual PTY without falling back to legacy', async () => {
    let observedRevocation: (() => void) | undefined;
    const revoked = new Promise<void>(resolve => { observedRevocation = resolve; });
    const createDependencies = providerAuthBinding.createProviderAuthDependencies;
    vi.spyOn(providerAuthBinding, 'createProviderAuthDependencies').mockImplementation((...args) => {
      const dependencies = createDependencies(...args); const authorize = dependencies.authorize.bind(dependencies);
      dependencies.authorize = async (...input) => {
        try { await authorize(...input); } catch (error) { observedRevocation?.(); throw error; }
      };
      return dependencies;
    });
    const f = await ready(); await f.router.attach(f.local.actor, f.session.session_id, () => undefined);
    const saved = JSON.parse(await readFile(join(f.local.directory, f.local.operation.id + '.json'), 'utf8')) as { processes: { pid: number }[] };
    await current.adminPool.query('UPDATE fleet_host_identities SET enabled=false WHERE host_id=$1', [f.local.host.host_id]);
    await expect(f.router.resolve(f.local.actor, f.local.operation.id)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    const revokedAccess = f.broker.service.get(f.local.actor, f.session.session_id).catch((error: unknown) => error);
    await revoked;
    await expect.poll(async () => {
      try { await access(join(f.local.directory, f.local.operation.id + '.json')); return false; } catch { return true; }
    }, { timeout: 5000 }).toBe(true);
    for (const processIdentity of saved.processes) expect(() => process.kill(processIdentity.pid, 0)).toThrow();
    await current.adminPool.query('UPDATE fleet_host_identities SET enabled=true WHERE host_id=$1', [f.local.host.host_id]);
    const failed = await revokedAccess;
    expect(failed).toMatchObject({ status: 'failed', error: 'AUTHORITY_REVOKED', cleanup_pending: false });
    expect(await f.router.get(f.local.actor, f.session.session_id)).toEqual(failed);
    const readStatus = async () => (await pool.query<{ id: string; status: unknown }>("SELECT id,metadata->'provider_auth_status' AS status FROM fleet_operation_events WHERE operation_id=$1 AND metadata->'provider_auth_status'->>'session_id'=$2 ORDER BY id DESC LIMIT 1", [f.local.operation.id, f.session.session_id])).rows[0];
    const durable = await readStatus();
    expect(durable?.status).toMatchObject({ session_id: f.session.session_id, status: 'failed', error: 'AUTHORITY_REVOKED' });
    const reservation = (await pool.query<{ reservation: unknown }>("SELECT metadata->'provider_auth' AS reservation FROM fleet_operation_events WHERE operation_id=$1 AND metadata->'provider_auth'->>'session_id'=$2 ORDER BY id DESC LIMIT 1", [f.local.operation.id, f.session.session_id])).rows[0];
    expect(reservation?.reservation).toMatchObject({ session_id: f.session.session_id, state: 'released' });
    expect(await f.router.cancel(f.local.actor, f.session.session_id)).toEqual(failed);
    expect(await f.router.cancel(f.local.actor, f.session.session_id)).toEqual(failed);
    const recovered = new AgentProviderAuthBroker(pool);
    try { expect(await recovered.service.get(f.local.actor, f.session.session_id)).toEqual(failed); }
    finally { await recovered.shutdown(); }
    expect(await readStatus()).toEqual(durable);
  }, 75_000);
  it('expires the durable session and does not send terminal input after its deadline', async () => {
    const f = await ready({ ttlMs: 2000 }); const terminal = await f.router.attach(f.local.actor, f.session.session_id, () => undefined);
    await expect.poll(async () => (await f.router.get(f.local.actor, f.session.session_id)).status, { timeout: 6000 }).toBe('expired');
    await expect(terminal.input(Buffer.from('SYNTHETIC_LOGIN_INPUT\n'))).rejects.toMatchObject({ code: 'SESSION_EXPIRED' });
    await expect.poll(async () => (await f.router.get(f.local.actor, f.session.session_id)).cleanup_pending, { timeout: 6000 }).toBe(false);
  }, 30_000);
  it('runs a real native PTY through signed HTTP and persists login scope without terminal content', async () => {
    const broker = new AgentProviderAuthBroker(pool); registerAgentProviderAuthHostRoute(app, pool, broker);
    local = await enrolledAgentAuthFixture(pool, app);
    router = createFleetProviderAuthRouter(pool, { hosts: [], enrolled: broker.service });
    const request = await router.resolve(local.actor, local.operation.id);
    const session = await router.start(local.actor, request);
    expect(session).toMatchObject({ status: 'awaiting_login', cleanup_pending: false });
    const ticket = await router.issueSocketTicket(local.actor, session.session_id);
    await router.consumeSocketTicket(local.actor, session.session_id, ticket.ticket);
    await expect(router.consumeSocketTicket(local.actor, session.session_id, ticket.ticket)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    let output = '';
    const terminal = await router.attach(local.actor, session.session_id, bytes => { output += Buffer.from(bytes).toString(); });
    await expect.poll(() => output, { timeout: 5000 }).toContain('True');
    await terminal.resize(100, 30); await terminal.input(Buffer.from('SYNTHETIC_LOGIN_INPUT\n'));
    await expect.poll(() => output, { timeout: 5000 }).toContain('SYNTHETIC_INPUT_ACCEPTED');
    expect(await router.verify(local.actor, session.session_id)).toMatchObject({ status: 'authenticated', cleanup_pending: false });
    const events = (await pool.query<{ metadata: unknown }>('SELECT metadata FROM fleet_operation_events WHERE operation_id=$1', [local.operation.id])).rows;
    expect(JSON.stringify(events)).not.toContain('SYNTHETIC_LOGIN_INPUT'); expect(JSON.stringify(events)).not.toContain('SYNTHETIC_PTY');
    const durable = (await pool.query<{ binding: unknown }>("SELECT metadata->'agent_provider_auth_scope' AS binding FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'agent_provider_auth_scope' ORDER BY id DESC LIMIT 1", [local.operation.id])).rows[0];
    expect(durable?.binding).toMatchObject({ fence: { session_id: session.session_id } });
  }, 30_000);
  it('resolves the real sealed operation outside the legacy socket catalog', async () => {
    const company = await channelCompany(pool, 'enrolled-auth'); const host = await channelHost(pool, company);
    expect((await channelPost(app, host, channelCapabilities())).statusCode).toBe(200);
    const actor = { tenant_id: company.hub.id, alias: 'owner', subject: `console:${company.user.id}` };
    const repository = new FleetOperationsRepository(pool);
    const operation = await repository.enqueue(actor.tenant_id, actor.alias, channelCreate(company, host, 'auth-worker'), actor.subject);
    const claimed = await channelPost(app, host, { resource: 'fleet_operation', action: 'claim' });
    const claim = claimed.json<{ claim: { claim_token: string; epoch: number } }>().claim;
    const fence = { operation_id: operation.id, claim_token: claim.claim_token, epoch: claim.epoch };
    expect((await channelPost(app, host, { resource: 'fleet_operation', action: 'prepare', claim: fence })).statusCode).toBe(200);
    await current.adminPool.query("UPDATE fleet_operations SET status='awaiting_auth' WHERE id=$1", [operation.id]);
    const broker = new AgentProviderAuthBroker(pool);
    const options = { hostCapabilityRegistry: new HostCapabilityRegistry(pool), enrolledProviderAuthService: broker.service };
    const configured = await configuredFleetGateway(pool, { available: false, actions: [], placements: [] }, {}, options);
    expect(configured.providerAuthService).toBeDefined();
    await expect(configured.providerAuthService?.resolve?.(actor, operation.id)).resolves.toMatchObject({ host_id: host.host_id });
    await configured.providerAuthService?.shutdown();
    router = createFleetProviderAuthRouter(pool, { hosts: [{ host_id: 'legacy', socket_path: '/nonexistent/legacy.sock' }], enrolled: broker.service });
    await expect(router.resolve(actor, operation.id)).resolves.toMatchObject({ operation_id: operation.id,
      host_id: host.host_id, account_id: 'enrolled-auth-account', runtime_user: 'dev', profile_id: 'enrolled-auth-account' });
  });
});
