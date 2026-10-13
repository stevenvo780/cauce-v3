import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetOperationSchema, type FleetCapability, type FleetOperationRequest } from '@cauce/protocol';
import { applyMigrations, createPool, lockFleetRevision, type DatabasePool, type FleetOperationClaim, type RegisteredCompany } from '@cauce/store';
import { preparePostgresSuite } from '../../../../packages/store/test/postgres-suite.js';
import { esBaseDePruebas, provisionTestLogin, startTestCaseDatabase, startTestDatabase, TEST_RUNTIME_LOGIN,
  type EmptyTestDatabase, type TestDatabase } from '../../../../tests/helpers/postgres.js';
import { configuredFleetGateway, configuredFleetRepository, FleetHostUnavailableError } from './gateway-config.js';
import { HostCapabilityRegistry } from './host-channel.capabilities.js';
import { registerHostChannelRoutes } from './host-channel.routes.js';
import { channelCapabilities, channelCompany, channelCreate, channelHost, channelPost, companySource, type ChannelHost } from './host-channel.fixtures.js';

const kinds = ['start', 'stop', 'retire', 'restore', 'purge'] as const;
const capability: FleetCapability = { available: true, actions: ['create', 'update', ...kinds], placements: [{ host_id: 'legacy',
  modes: ['container'], runtime_users: ['dev'], systemd_users: [], home_roots: ['/home/dev'], state_roots: ['/home/dev/.cauce'],
  runtimes: [{ provider: 'codex', harness_id: 'codex', mode: 'container', runtime_user: 'dev',
    home_directory: '/home/dev', state_root: '/home/dev/.cauce', container_prefix: 'cauce-' }] }] };
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let app: FastifyInstance;
let directory: string;
let north: RegisteredCompany;
let south: RegisteredCompany;
let host: ChannelHost;
let environment: NodeJS.ProcessEnv;
preparePostgresSuite(import.meta.url, async () => {
  if (!process.env.CAUCE_TEST_DATABASE_URL) database = await startTestDatabase();
}, 120_000);

async function exclusiveCase(): Promise<EmptyTestDatabase> {
  const external = process.env.CAUCE_TEST_ADMIN_DATABASE_URL ?? process.env.CAUCE_TEST_DATABASE_URL;
  if (!external) {
    if (!database) throw new Error('test database absent');
    const owned = await startTestCaseDatabase(database);
    const runtimeUrl = await provisionTestLogin(owned.adminPool, owned.adminUrl, TEST_RUNTIME_LOGIN, 'cauce_runtime');
    const runtimePool = createPool(runtimeUrl);
    return { ...owned, pool: runtimePool, url: runtimeUrl, close: async () => { await runtimePool.end(); await owned.close(); } };
  }
  if (!esBaseDePruebas(external)) throw new Error('disposable test database required');
  const server = createPool(external);
  const name = `cauce_test_gateway_transport_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(external); target.pathname = `/${name}`;
  try {
    await server.query(`CREATE DATABASE ${name} TEMPLATE cauce_test_plantilla`);
    const adminPool = createPool(target.toString());
    try {
      await applyMigrations(adminPool);
      const runtime = new URL(target);
      runtime.username = TEST_RUNTIME_LOGIN;
      runtime.password = createHash('sha256').update(`${TEST_RUNTIME_LOGIN}\n${target.username}:${target.password}@${target.host}`).digest('hex');
      const runtimePool = createPool(runtime.toString());
      return { pool: runtimePool, adminPool, url: runtime.toString(), adminUrl: target.toString(), close: async () => {
        await Promise.all([runtimePool.end(), adminPool.end()]);
        const cleanup = createPool(external);
        try { await cleanup.query(`DROP DATABASE ${name}`); } finally { await cleanup.end(); }
      } };
    } catch (error) {
      await adminPool.end(); await server.query(`DROP DATABASE ${name}`); throw error;
    }
  } finally { await server.end(); }
}

beforeEach(async () => {
  current = await exclusiveCase(); pool = current.pool;
  expect((await pool.query<{ login: string; runtime: boolean; superuser: boolean }>(`SELECT current_user AS login,
    pg_has_role(current_user,'cauce_runtime','MEMBER') AS runtime,rolsuper AS superuser FROM pg_roles WHERE rolname=current_user`)).rows[0])
    .toEqual({ login: TEST_RUNTIME_LOGIN, runtime: true, superuser: false });
  north = await channelCompany(pool, 'transportnorth'); south = await channelCompany(pool, 'transportsouth');
  host = await channelHost(pool, north);
  await channelHost(pool, south);
  app = Fastify(); registerHostChannelRoutes(app, pool);
  expect((await channelPost(app, host, channelCapabilities())).statusCode).toBe(200);
  await pool.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('legacy',$1,'Legacy'),('controller',$1,'Controller')", [north.company.id]);
  directory = await mkdtemp('/var/tmp/cauce-gateway-transport-');
  const filename = join(directory, 'api.json');
  await writeFile(filename, JSON.stringify({ version: 1, controller_host: 'controller', hosts: [
    { host_id: 'controller', socket_path: join(directory, 'controller.sock') },
    { host_id: 'legacy', socket_path: join(directory, 'legacy.sock') },
  ] }), { mode: 0o600 });
  environment = { CAUCE_FLEET_API_CONFIG_FILE: filename, CAUCE_FLEET_CONTROLLER_HOST: 'controller' };
});
afterEach(async () => { await app.close(); await current?.close(); current = undefined; await rm(directory, { recursive: true, force: true }); });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function binding() {
  const gateway = await configuredFleetGateway(pool, capability, environment, { hostCapabilityRegistry: new HostCapabilityRegistry(pool) });
  if (!gateway.fleetOperationsRepository) throw new Error('fleet binding absent');
  return gateway.fleetOperationsRepository;
}
async function durable(company: RegisteredCompany, hostId: string, alias = 'worker'): Promise<void> {
  await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')", [company.hub.id, alias]);
  await pool.query(`INSERT INTO agents(tenant_id,alias,company_id,runtime_key,harness_id,host_id,runtime_mode,container_name,
    runtime_user,home_directory,state_directory,systemd_user,primary_room_id,primary_account_id,enabled,lifecycle_state)
    VALUES($1,$2,$3,$2,'codex',$4,'container',$5,'dev','/home/dev',$6,'stev','office',$7,false,'draft')`,
  [company.hub.id, alias, company.company.id, hostId, `cauce-${alias}`, `/home/dev/.cauce/${alias}`, `${company.company.id}-account`]);
}
function lifecycle(kind: typeof kinds[number], company = north, alias = 'worker'): FleetOperationRequest {
  const request = { target: { resource: 'agent' as const, tenant_id: company.hub.id, alias },
    expected_revision: 0, idempotency_key: `transport-${kind}-${alias}` };
  return kind === 'purge' ? { ...request, kind, parameters: { confirm_alias: alias } } : { ...request, kind, parameters: {} };
}
const subject = () => `console:${north.user.id}`;
async function waitingForFleetRevision(): Promise<void> {
  for (let attempt = 0; attempt < 400; attempt++) {
    const waiting = (await current?.adminPool.query<{ n: number }>(`SELECT count(*)::int AS n FROM pg_locks
      WHERE locktype='advisory' AND classid=0 AND objid=783003004 AND NOT granted`))?.rows[0]?.n;
    if (waiting) return;
    await delay(25);
  }
  throw new Error('the console operation never waited for the fleet revision lock');
}

describe('mixed legacy and signed host lifecycle transport', () => {
  it.each(kinds)('routes %s from the durable enrolled placement through its signed host', async kind => {
    await durable(north, host.host_id);
    if (kind === 'restore') await pool.query("UPDATE agents SET retired_at=now(),lifecycle_state='retired' WHERE tenant_id=$1 AND alias='worker'", [north.hub.id]);
    const repository = await binding(); const request = lifecycle(kind);
    expect(await repository.preview(north.hub.id, 'owner', request, subject())).toMatchObject({ can_apply: true });
    const operation = FleetOperationSchema.parse(await repository.enqueue(north.hub.id, 'owner', request, subject()));
    expect((await pool.query<{ executor_host: string }>('SELECT executor_host FROM fleet_operations WHERE id=$1', [operation.id])).rows[0]?.executor_host).toBe(host.host_id);
    const response = await channelPost(app, host, { resource: 'fleet_operation', action: 'claim' });
    expect(response.statusCode).toBe(200);
    const claim = response.json<{ claim: FleetOperationClaim }>().claim;
    expect(claim.operation.id).toBe(operation.id);
    const prepared = await channelPost(app, host, { resource: 'fleet_operation', action: 'prepare',
      claim: { operation_id: operation.id, claim_token: claim.claim_token, epoch: claim.epoch } });
    expect(prepared.statusCode, prepared.body).toBe(200);
    expect(prepared.json<{ snapshot: { agents: { host_id: string }[] } }>().snapshot.agents[0]?.host_id).toBe(host.host_id);
  });
  it.each(kinds)('keeps %s on the approved legacy coordinator', async kind => {
    await durable(north, 'legacy');
    const repository = await binding(); const request = lifecycle(kind);
    expect(await repository.preview(north.hub.id, 'owner', request, subject())).toMatchObject({ can_apply: true });
    const operation = FleetOperationSchema.parse(await repository.enqueue(north.hub.id, 'owner', request, subject()));
    expect((await pool.query<{ executor_host: string }>('SELECT executor_host FROM fleet_operations WHERE id=$1', [operation.id])).rows[0]?.executor_host).toBe('controller');
    expect((await channelPost(app, host, { resource: 'fleet_operation', action: 'claim' })).json()).toEqual({ claim: null });
  });
  it.each(kinds)('rejects %s outside the company or without an enrolled transport', async kind => {
    await durable(south, `${south.company.id}-host`, 'foreign-worker');
    await pool.query("INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES('unenrolled',$1,'Unenrolled')", [north.company.id]);
    await durable(north, 'unenrolled');
    const repository = await binding();
    for (const request of [lifecycle(kind, south, 'foreign-worker'), lifecycle(kind)]) {
      await expect(repository.preview(north.hub.id, 'owner', request, subject())).rejects.toMatchObject({
        code: request.target.tenant_id === south.hub.id ? 'forbidden' : 'conflict',
      });
      await expect(repository.enqueue(north.hub.id, 'owner', request, subject())).rejects.toMatchObject({
        code: request.target.tenant_id === south.hub.id ? 'forbidden' : 'conflict',
      });
    }
    expect((await pool.query('SELECT 1 FROM fleet_operations')).rowCount).toBe(0);
  });
  it('keeps placement, account and start availability checks before selecting a signed transport', async () => {
    const repository = await binding(); const create = channelCreate(north, host, 'new-worker');
    if (create.kind !== 'create') throw new Error('create fixture absent');
    for (const parameters of [
      { ...create.parameters, placement: { ...create.parameters.placement, state_directory: '/tmp/new-worker' } },
      { ...create.parameters, primary_account_id: `${south.company.id}-account` },
    ]) await expect(repository.preview(north.hub.id, 'owner', { ...create, parameters }, subject())).rejects.toMatchObject({ code: 'forbidden' });
    await durable(north, host.host_id);
    await pool.query("UPDATE fleet_hosts SET controller_status='unreachable',controller_seen_at=now() WHERE host_id=$1", [host.host_id]);
    await expect(repository.preview(north.hub.id, 'owner', lifecycle('start'), subject())).rejects.toBeInstanceOf(FleetHostUnavailableError);
    expect(await repository.preview(north.hub.id, 'owner', lifecycle('stop'), subject())).toMatchObject({ can_apply: true });
  });
  it('resumes a signed operation from its persisted request and explicit company authority', async () => {
    const { repository, failed } = await failedCreate();
    const scoped = repository.forAuthority?.(companySource(north)); if (!scoped) throw new Error('company binding absent');
    await expect(scoped.resume(north.hub.id, 'owner', failed.id, failed.version, subject())).resolves.toMatchObject({ status: 'queued' });
    const claimed = await channelPost(app, host, { resource: 'fleet_operation', action: 'claim' });
    expect(claimed.statusCode).toBe(200);
    expect(claimed.json<{ claim: FleetOperationClaim }>().claim.operation.id).toBe(failed.id);
  });
  it.each(['human', 'account', 'host'] as const)('rejects resume after current %s authority is revoked', async revoked => {
    const { repository, failed } = await failedCreate();
    const foreign = repository.forAuthority?.(companySource(south)); if (!foreign) throw new Error('company binding absent');
    await expect(foreign.resume(north.hub.id, 'owner', failed.id, failed.version, subject())).rejects.toMatchObject({ code: 'forbidden' });
    if (revoked === 'human') await pool.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [north.user.id]);
    else if (revoked === 'account') await pool.query('UPDATE provider_accounts SET enabled=false WHERE id=$1', [`${north.company.id}-account`]);
    else await pool.query('UPDATE fleet_host_identities SET enabled=false WHERE host_id=$1', [host.host_id]);
    await expect(repository.resume(north.hub.id, 'owner', failed.id, failed.version, subject())).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query<{ status: string }>('SELECT status FROM fleet_operations WHERE id=$1', [failed.id])).rows[0]?.status).toBe('failed');
  });
  it.each(['preview', 'enqueue'] as const)('%s takes the fleet revision lock before the agent row a worker is updating', async call => {
    await durable(north, host.host_id);
    const repository = await binding();
    const worker = await pool.connect();
    try {
      await worker.query('BEGIN'); await lockFleetRevision(worker);
      const pending = repository[call](north.hub.id, 'owner', lifecycle('start'), subject());
      pending.catch(() => undefined);
      await waitingForFleetRevision();
      await worker.query("SET LOCAL lock_timeout='5s'");
      await worker.query("UPDATE agents SET lifecycle_state='draft' WHERE tenant_id=$1 AND alias='worker'", [north.hub.id]);
      await worker.query('COMMIT');
      expect(await pending).toMatchObject(call === 'preview' ? { can_apply: true } : { status: 'queued' });
    } finally { await worker.query('ROLLBACK').catch(() => undefined); worker.release(); }
  });
  it('keeps a resumed legacy operation on its approved coordinator', async () => {
    await durable(north, 'legacy');
    const repository = await binding(); const operation = FleetOperationSchema.parse(await repository.enqueue(north.hub.id, 'owner', lifecycle('start'), subject()));
    const controller = await configuredFleetRepository(pool, environment);
    const claim = await controller.claim('legacy-worker', 'controller'); if (!claim) throw new Error('legacy claim absent');
    expect(claim.operation.id).toBe(operation.id);
    await controller.prepare(claim);
    const failed = await controller.fail(claim, { code: 'STEP_FAILED', retryable: true });
    expect(FleetOperationSchema.parse(await repository.resume(north.hub.id, 'owner', failed.id, failed.version, subject())).status).toBe('queued');
    expect((await pool.query<{ executor_host: string }>('SELECT executor_host FROM fleet_operations WHERE id=$1', [failed.id])).rows[0]?.executor_host).toBe('controller');
  });
});

async function failedCreate() {
  const repository = await binding();
  const operation = FleetOperationSchema.parse(await repository.enqueue(north.hub.id, 'owner', channelCreate(north, host, 'resumed-worker'), subject()));
  const response = await channelPost(app, host, { resource: 'fleet_operation', action: 'claim' });
  expect(response.statusCode).toBe(200);
  const claim = response.json<{ claim: FleetOperationClaim }>().claim;
  expect(claim.operation.id).toBe(operation.id);
  const fence = { operation_id: operation.id, claim_token: claim.claim_token, epoch: claim.epoch };
  const prepared = await channelPost(app, host, { resource: 'fleet_operation', action: 'prepare', claim: fence });
  expect(prepared.statusCode, prepared.body).toBe(200);
  const failure = await channelPost(app, host, { resource: 'fleet_operation', action: 'fail', claim: fence, error: { code: 'STEP_FAILED', retryable: true } });
  expect(failure.statusCode).toBe(200);
  return { repository, failed: FleetOperationSchema.parse(failure.json()) };
}
