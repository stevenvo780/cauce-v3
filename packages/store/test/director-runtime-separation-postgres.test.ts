import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigMutation, FleetEvidence, FleetOperationRequest, FleetStepName } from '@cauce/protocol';
import { applyMigrations, CauceRepository, ConfigurationRepository, createPool, FleetOperationsRepository, withTransaction,
  type DatabasePool, type FleetOperationClaim, type RegisteredCompany } from '../src/index.js';
import { CompanyContextCache } from '../src/company-context.js';
import { ContextVersionStore, readContextVersion } from '../src/context-version.js';
import { aggregateHostEvidence, readFleetGroupAgents } from '../src/repository/fleet-operation-hosts.js';
import { DeliveryContextRuntimeSink } from '../../../services/gateway/src/context-version-runtime.js';
import { channelCompany, channelCreate, channelHost, companySource, type ChannelHost } from '../../../services/gateway/src/fleet/host-channel.fixtures.js';
import { esBaseDePruebas, provisionTestLogin, startTestCaseDatabase, startTestDatabase, TEST_RUNTIME_LOGIN,
  type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { downsThrough } from './migration-downs.fixtures.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let company: RegisteredCompany;
let host: ChannelHost;
let fleet: FleetOperationsRepository;
const broker = 'context-director';
const worker = 'physical-worker';
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
  const server = createPool(external);
  const name = `cauce_test_director_runtime_${randomUUID().replaceAll('-', '')}`;
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

async function physicalAgent(value = company, alias = worker, placement = host): Promise<void> {
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office',$2,'agent')
    ON CONFLICT(tenant_id,room_id,alias) DO UPDATE SET role='agent'`, [value.hub.id, alias]);
  const params = [value.hub.id, alias, placement.host_id, `${value.company.id}-${alias}`];
  const updated = await admin.query(`UPDATE agents SET runtime_key=$4,harness_id='codex',host_id=$3,runtime_mode='container',
    container_name='cauce-'||$4,runtime_user='dev',home_directory='/home/dev',state_directory='/home/dev/.cauce/'||$4,
    systemd_user='stev',primary_room_id='office',lifecycle_state='ready',enabled=true WHERE tenant_id=$1 AND alias=$2`, params);
  if (updated.rowCount === 1) return;
  await admin.query(`INSERT INTO agents(tenant_id,alias,runtime_key,harness_id,host_id,runtime_mode,container_name,
    runtime_user,home_directory,state_directory,systemd_user,primary_room_id,lifecycle_state,enabled)
    VALUES($1,$2,$4,'codex',$3,'container','cauce-'||$4,'dev','/home/dev','/home/dev/.cauce/'||$4,'stev','office','ready',true)`, params);
}

beforeEach(async () => {
  current = await exclusiveCase(); pool = current.pool; admin = current.adminPool;
  expect((await pool.query("SELECT pg_has_role(current_user,'cauce_runtime','MEMBER') AS runtime")).rows).toEqual([{ runtime: true }]);
  company = await channelCompany(pool, 'separated'); host = await channelHost(pool, company);
  await physicalAgent();
  await admin.query("INSERT INTO rooms(tenant_id,id) VALUES($1,'governance')", [company.hub.id]);
  await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'governance','owner','operator')", [company.hub.id]);
  await admin.query("DELETE FROM memberships WHERE tenant_id=$1 AND room_id='office' AND alias='owner'", [company.hub.id]);
  fleet = new FleetOperationsRepository(pool, { controllerHost: host.host_id, coordinatorEnabled: true, coordinatorHosts: [host.host_id] });
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function group(kind: 'retire' | 'restore' | 'purge', revision = 0): Extract<FleetOperationRequest, { kind: 'retire' | 'restore' | 'purge' }> {
  return { kind, target: { resource: 'room', tenant_id: company.hub.id, room_id: 'office' }, parameters: {},
    expected_revision: revision, idempotency_key: `source-separation-${kind}` };
}
const subject = () => `console:${company.user.id}`;
async function brokerState(): Promise<unknown> {
  return (await pool.query(`SELECT to_jsonb(agent) AS agent,to_jsonb(member) AS membership FROM agents agent
    JOIN memberships member ON member.tenant_id=agent.tenant_id AND member.alias=agent.alias
    WHERE agent.tenant_id=$1 AND agent.alias=$2`, [company.hub.id, broker])).rows;
}
async function transition(request: FleetOperationRequest): Promise<{ claim: FleetOperationClaim; revision: number }> {
  expect((await fleet.preview(company.hub.id, 'owner', request, subject())).can_apply).toBe(true);
  const operation = await fleet.enqueue(company.hub.id, 'owner', request, subject());
  const claim = await fleet.claim('separation-worker', host.host_id);
  if (!claim) throw new Error('group claim absent');
  expect(claim.operation.id).toBe(operation.id);
  const prepared = await fleet.prepare(claim);
  expect(prepared.fenced_targets.map(target => target.alias)).toEqual([worker]);
  expect(prepared.desired_memberships.map(member => member.alias)).toEqual([worker]);
  expect((await fleet.hostSlices(claim)).flatMap(slice => slice.targets).map(target => target.alias)).toEqual([worker]);
  const proof: Partial<Record<FleetStepName, FleetEvidence>> = {
    stop: { stopped_verified: true }, revoke: { revocation_verified: true },
    purge: { stopped_verified: true, revocation_verified: true }, artifacts: { artifact_sha256: 'a'.repeat(64) },
    admission: { authority_verified: true, artifact_sha256: 'a'.repeat(64) },
  };
  for (const step of prepared.operation.steps.filter(step => step.status !== 'succeeded')) {
    const evidence = proof[step.name]; if (!evidence) throw new Error('unexpected group step');
    await fleet.startStep(claim, step.name);
    for (const slice of await fleet.hostSlices(claim)) {
      await fleet.completeHostStep(claim, step.name, slice.host_id, slice.target_sha256, evidence);
    }
    await fleet.completeStep(claim, step.name, aggregateHostEvidence(step.name, await fleet.hostReceipts(claim, step.name)));
  }
  const settled = await fleet.settle(claim); expect(settled.status).toBe('succeeded');
  if (settled.applied_revision === null) throw new Error('group revision absent');
  return { claim, revision: settled.applied_revision };
}

describe('delivery source director stays separate from physical agents', () => {
  it('omits only source-only principals from editable snapshots, agent API and topology', async () => {
    const repository = new CauceRepository(pool);
    const snapshot = await new ConfigurationRepository(pool).get(company.hub.id, 'owner', companySource(company));
    for (const rows of [snapshot.agents, snapshot.memberships]) {
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ alias: worker })]));
      expect(rows).not.toEqual(expect.arrayContaining([expect.objectContaining({ alias: broker })]));
    }
    const agents = await repository.listAgents(company.hub.id, 'owner');
    expect(agents.items).not.toEqual(expect.arrayContaining([expect.objectContaining({ alias: broker })]));
    expect(await repository.getAgentByIdentity(company.hub.id, broker, company.hub.id, 'owner')).toBeUndefined();
    expect(await repository.authorizeAgentTarget(company.hub.id, 'owner', company.hub.id, broker, 'configure')).toBeUndefined();
    expect(JSON.stringify(await repository.topology(company.hub.id, 'owner'))).not.toContain(broker);
    expect(await repository.principalAccess(company.hub.id, broker)).toEqual({ roles: ['context_broker'], permissions: ['route'] });
    expect(await new CompanyContextCache().read(pool, company.hub.id, broker)).toMatchObject({ company_id: company.company.id, director: true });
  });

  it('rejects direct source-only edits and lifecycle targets with application errors before recording writes', async () => {
    const before = await brokerState();
    const configuration = new ConfigurationRepository(pool);
    const mutations: ConfigMutation[] = [
      { resource: 'agent', action: 'update', tenant_id: company.hub.id, alias: broker, value: { display_name: 'Edited broker' } },
      { resource: 'membership', action: 'update', tenant_id: company.hub.id, room_id: 'office', alias: broker, value: { enabled: false } },
      { resource: 'batch', action: 'apply', mutations: [
        { resource: 'agent', action: 'update', tenant_id: company.hub.id, alias: worker, value: { display_name: 'Changed worker' } },
        { resource: 'membership', action: 'delete', tenant_id: company.hub.id, room_id: 'office', alias: broker },
      ] },
    ];
    for (const mutation of mutations) for (const dryRun of [false, true]) {
      await expect(configuration.apply(company.hub.id, 'owner', mutation, dryRun, 0, companySource(company)))
        .rejects.toMatchObject({ code: 'forbidden', message: 'delivery source principal is not an editable agent' });
    }
    const requests: FleetOperationRequest[] = [channelCreate(company, host, broker),
      ...(['stop', 'retire', 'purge'] as const).map(kind => ({ kind, target: { resource: 'agent' as const, tenant_id: company.hub.id, alias: broker },
        parameters: {}, expected_revision: 0, idempotency_key: `direct-broker-${kind}` }))];
    for (const request of requests) {
      await expect(fleet.enqueue(company.hub.id, 'owner', request, subject())).rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await brokerState()).toEqual(before);
    expect((await pool.query('SELECT 1 FROM config_revisions')).rows).toEqual([]);
    expect((await pool.query('SELECT 1 FROM fleet_operations')).rows).toEqual([]);
    expect((await pool.query("SELECT display_name FROM agents WHERE tenant_id=$1 AND alias=$2", [company.hub.id, worker])).rows).toEqual([{ display_name: null }]);
  });

  it.each([false, true])('enqueues, prepares, retires, restores and purges a group with broker history=%s', async history => {
    const before = await brokerState();
    if (history) {
      const context = new ContextVersionStore(pool);
      await context.write(companySource(company), company.hub.id, worker,
        { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: 'Preserve broker history.' }] });
      const version = await withTransaction(pool, client => readContextVersion(client,
        { company_id: company.company.id, tenant_id: company.hub.id, alias: worker }, 1));
      await expect(new DeliveryContextRuntimeSink(pool, 50).apply(version)).rejects.toThrow('consumed-turn evidence');
      expect((await fleet.preview(company.hub.id, 'owner', group('purge'), subject())).can_apply).toBe(false);
      await admin.query("UPDATE deliveries SET status='done' WHERE recipient_tenant=$1 AND recipient_alias=$2", [company.hub.id, worker]);
    }
    const messages = (await pool.query("SELECT id,actor_alias,body FROM messages WHERE auth_channel='context-broker'")).rows;
    expect(messages).toEqual(history ? [expect.objectContaining({ actor_alias: broker })] : []);
    const retired = await transition(group('retire'));
    expect(await brokerState()).toEqual(before);
    const restored = await transition(group('restore', retired.revision));
    expect(await brokerState()).toEqual(before);
    const preview = await fleet.preview(company.hub.id, 'owner', group('purge', restored.revision), subject());
    expect(preview.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'purge.preserve.memberships' })]));
    await transition(group('purge', restored.revision));
    expect(await brokerState()).toEqual(before);
    expect((await pool.query("SELECT id,actor_alias,body FROM messages WHERE auth_channel='context-broker'")).rows).toEqual(messages);
    expect((await pool.query("SELECT purged_at IS NOT NULL AS purged FROM rooms WHERE tenant_id=$1 AND id='office'", [company.hub.id])).rows).toEqual([{ purged: true }]);
  });

  it('keeps a physical director with the same alias visible and in group scope, including before the flag migration', async () => {
    const physical = await channelCompany(pool, 'physical'); const placement = await channelHost(pool, physical);
    await admin.query('UPDATE company_system_principals SET delivery_source_only=false WHERE company_id=$1', [physical.company.id]);
    await physicalAgent(physical, broker, placement);
    const repository = new CauceRepository(pool);
    expect(await repository.getAgentByIdentity(physical.hub.id, broker, physical.hub.id, 'owner')).toMatchObject({ alias: broker, enabled: true });
    expect(await repository.authorizeAgentTarget(physical.hub.id, 'owner', physical.hub.id, broker, 'configure')).toMatchObject({ alias: broker });
    const snapshot = await new ConfigurationRepository(pool).get(physical.hub.id, 'owner', companySource(physical));
    for (const rows of [snapshot.agents, snapshot.memberships]) {
      expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ alias: broker })]));
    }
    const physicalFleet = new FleetOperationsRepository(pool, { controllerHost: placement.host_id });
    expect((await physicalFleet.preview(physical.hub.id, 'owner', { kind: 'stop',
      target: { resource: 'agent', tenant_id: physical.hub.id, alias: broker }, parameters: {}, expected_revision: 0,
      idempotency_key: 'physical-director-stop' }, `console:${physical.user.id}`)).can_apply).toBe(true);
    const request = { ...group('retire'), target: { resource: 'room' as const, tenant_id: physical.hub.id, room_id: 'office' } };
    expect(await withTransaction(pool, client => readFleetGroupAgents(client, request))).toEqual(expect.arrayContaining([expect.objectContaining({ alias: broker })]));
    const downs = await downsThrough('063_company_registration_director.sql');
    await withTransaction(admin, async client => { for (const down of downs) await client.query(down); });
    expect(await withTransaction(pool, client => readFleetGroupAgents(client, request))).toEqual(expect.arrayContaining([expect.objectContaining({ alias: broker })]));
    expect(await repository.getAgentByIdentity(physical.hub.id, broker, physical.hub.id, 'owner')).toMatchObject({ alias: broker });
  });
});
