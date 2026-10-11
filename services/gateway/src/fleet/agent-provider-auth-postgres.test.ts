import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationsRepository, type DatabasePool } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { channelCapabilities, channelCompany, channelCreate, channelHost, channelPost } from './host-channel.fixtures.js';
import { registerHostChannelRoutes } from './host-channel.routes.js';
import { createFleetProviderAuthRouter } from './auth-router.js';
import { AgentProviderAuthBroker } from './agent-provider-auth-broker.js';
import { registerAgentProviderAuthHostRoute } from './agent-provider-auth-route.js';
import { enrolledAgentAuthFixture } from './agent-provider-auth.fixtures.js';
import { access, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { configuredFleetGateway } from './gateway-config.js';
import { HostCapabilityRegistry } from './host-channel.capabilities.js';

let database: TestDatabase; let current: EmptyTestDatabase; let pool: DatabasePool; let app: FastifyInstance;
let router: ReturnType<typeof createFleetProviderAuthRouter> | undefined;
let local: Awaited<ReturnType<typeof enrolledAgentAuthFixture>> | undefined;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); });
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = current.pool;
  if (process.env.CAUCE_TEST_RUNTIME_ROLE === '1') {
    expect((await pool.query<{ runtime: boolean }>("SELECT pg_has_role(current_user,'cauce_runtime','MEMBER') AS runtime")).rows[0]?.runtime).toBe(true);
  }
  app = Fastify(); registerHostChannelRoutes(app, pool);
});
afterEach(async () => { await router?.shutdown(); await app.close(); await local?.hostRuntime.shutdown();
  if (local) await rm(local.directory, { recursive: true, force: true }); await current.close(); router = undefined; local = undefined; });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });

describe('enrolled agent provider authentication', () => {
  async function ready(options: { ttlMs?: number } = {}) {
    const broker = new AgentProviderAuthBroker(pool, options); registerAgentProviderAuthHostRoute(app, pool, broker);
    local = await enrolledAgentAuthFixture(pool, app); router = createFleetProviderAuthRouter(pool, { hosts: [], enrolled: broker.service });
    const request = await router.resolve(local.actor, local.operation.id);
    const session = await router.start(local.actor, request);
    expect(session.status).toBe('awaiting_login');
    return { broker, local, router, request, session };
  }
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
    const f = await ready(); await f.router.attach(f.local.actor, f.session.session_id, () => undefined);
    const saved = JSON.parse(await readFile(join(f.local.directory, f.local.operation.id + '.json'), 'utf8')) as { processes: { pid: number }[] };
    await current.adminPool.query('UPDATE fleet_host_identities SET enabled=false WHERE host_id=$1', [f.local.host.host_id]);
    await expect(f.router.resolve(f.local.actor, f.local.operation.id)).rejects.toMatchObject({ code: 'AUTHORITY_REVOKED' });
    await expect.poll(async () => {
      try { await access(join(f.local.directory, f.local.operation.id + '.json')); return false; } catch { return true; }
    }, { timeout: 5000 }).toBe(true);
    for (const processIdentity of saved.processes) expect(() => process.kill(processIdentity.pid, 0)).toThrow();
    await current.adminPool.query('UPDATE fleet_host_identities SET enabled=true WHERE host_id=$1', [f.local.host.host_id]);
    expect(await f.router.cancel(f.local.actor, f.session.session_id)).toMatchObject({ status: 'cancelled', cleanup_pending: false });
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
