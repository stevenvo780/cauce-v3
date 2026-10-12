import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetEvidence, FleetStepName } from '@cauce/protocol';
import { applyMigrations, ConfigurationRepository, createPool, FleetOperationsRepository, withTransaction,
  type ContextVersion, type DatabasePool, type RegisteredCompany } from '../src/index.js';
import { ContextVersionStore, lockContextTarget, persistContextVersionInTransaction, readContextVersion } from '../src/context-version.js';
import { aggregateHostEvidence } from '../src/repository/fleet-operation-hosts.js';
import { DeliveryContextRuntimeSink } from '../../../services/gateway/src/context-version-runtime.js';
import { channelCompany, channelHost, companySource, type ChannelHost } from '../../../services/gateway/src/fleet/host-channel.fixtures.js';
import { esBaseDePruebas, provisionTestLogin, startTestCaseDatabase, startTestDatabase, TEST_RUNTIME_LOGIN,
  type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { downsThrough } from './migration-downs.fixtures.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let admin: DatabasePool; let company: RegisteredCompany; let host: ChannelHost;
let configuration: ConfigurationRepository; let fleet: FleetOperationsRepository;
const broker = 'context-director';
const helper = 'cauce_ensure_context_director_anchor(text,text,text,bigint,text)';
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
  const server = createPool(external); const name = `cauce_test_director_anchor_${randomUUID().replaceAll('-', '')}`;
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

async function revision(): Promise<number> {
  return Number((await pool.query<{ revision: string }>('SELECT COALESCE(max(id),0)::text AS revision FROM config_revisions')).rows[0]?.revision);
}
beforeEach(async () => {
  current = await exclusiveCase(); pool = current.pool; admin = current.adminPool;
  expect((await pool.query("SELECT pg_has_role(current_user,'cauce_runtime','MEMBER') AS runtime")).rows).toEqual([{ runtime: true }]);
  company = await channelCompany(pool, 'anchor-test'); host = await channelHost(pool, company);
  configuration = new ConfigurationRepository(pool);
  await configuration.apply(company.hub.id, 'owner', { resource: 'batch', action: 'apply', mutations: [
    { resource: 'room', action: 'create', tenant_id: company.hub.id, id: 'governance', value: { enabled: true } },
    { resource: 'membership', action: 'create', tenant_id: company.hub.id, room_id: 'governance', alias: 'owner', value: { role: 'operator', enabled: true } },
    { resource: 'membership', action: 'delete', tenant_id: company.hub.id, room_id: 'office', alias: 'owner' },
  ] }, false, await revision(), companySource(company));
  fleet = new FleetOperationsRepository(pool, { controllerHost: host.host_id, coordinatorEnabled: true, coordinatorHosts: [host.host_id] });
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function readyAgent(alias: string, room: string, createRoom = true): Promise<void> {
  await configuration.apply(company.hub.id, 'owner', { resource: 'batch', action: 'apply', mutations: [
    ...(createRoom ? [{ resource: 'room' as const, action: 'create' as const, tenant_id: company.hub.id, id: room, value: { enabled: true } }] : []),
    { resource: 'agent', action: 'create', tenant_id: company.hub.id, alias, value: { enabled: false, harness_id: 'codex' } },
    { resource: 'membership', action: 'create', tenant_id: company.hub.id, room_id: room, alias, value: { role: 'agent', enabled: false } },
    { resource: 'agent', action: 'update', tenant_id: company.hub.id, alias, value: { primary_room_id: room } },
  ] }, false, await revision(), companySource(company));
  await admin.query(`UPDATE agents SET runtime_key=$2,host_id=$3,runtime_mode='container',container_name='cauce-'||$2,runtime_user='dev',
    home_directory='/home/dev',state_directory='/home/dev/.cauce/'||$2,systemd_user='stev',lifecycle_state='ready',enabled=true
    WHERE tenant_id=$1 AND alias=$2`, [company.hub.id, alias, host.host_id]);
  await admin.query('UPDATE memberships SET enabled=true WHERE tenant_id=$1 AND alias=$2', [company.hub.id, alias]);
}
async function context(alias: string, tenant = company.hub.id, expected = 0): Promise<ContextVersion> {
  const result = await new ContextVersionStore(pool).write(companySource(company), tenant, alias,
    { expected_version: expected, source: 'ui', files: [{ path: 'context/mission.md', content: `Anchor continuity ${String(expected + 1)}.` }] });
  return withTransaction(pool, client => readContextVersion(client,
    { company_id: company.company.id, tenant_id: tenant, alias }, result.version));
}
async function anchor(version: ContextVersion) {
  return (await pool.query<{ tenant_id: string; alias: string; room_id: string }>(
    'SELECT * FROM cauce_ensure_context_director_anchor($1,$2,$3,$4,$5)',
    [version.company_id, version.tenant_id, version.alias, version.version, version.digest])).rows;
}
async function assertPublishedWithoutConsumption(version: ContextVersion): Promise<void> {
  await expect(new DeliveryContextRuntimeSink(pool, 20).apply(version)).rejects.toThrow('consumed-turn evidence');
  expect((await pool.query(`SELECT delivery.status FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id
    WHERE message.auth_channel='context-broker' AND delivery.recipient_tenant=$1 AND delivery.recipient_alias=$2`,
  [version.tenant_id, version.alias])).rows).toEqual([{ status: 'pending' }]);
  expect((await pool.query('SELECT applied_at FROM agent_context_outbox WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4',
    [version.company_id, version.tenant_id, version.alias, version.version])).rows).toEqual([{ applied_at: null }]);
}
async function transition(kind: 'retire' | 'purge'): Promise<void> {
  const subject = `console:${company.user.id}`;
  const request = { kind, target: { resource: 'room' as const, tenant_id: company.hub.id, room_id: 'office' }, parameters: {},
    expected_revision: await revision(), idempotency_key: `anchor-${kind}` };
  expect((await fleet.preview(company.hub.id, 'owner', request, subject)).can_apply).toBe(true);
  const operation = await fleet.enqueue(company.hub.id, 'owner', request, subject); const claim = await fleet.claim('anchor-test', host.host_id);
  if (!claim) throw new Error('group claim absent'); expect(claim.operation.id).toBe(operation.id);
  const prepared = await fleet.prepare(claim);
  const proof: Partial<Record<FleetStepName, FleetEvidence>> = { stop: { stopped_verified: true }, revoke: { revocation_verified: true },
    purge: { stopped_verified: true, revocation_verified: true }, artifacts: { artifact_sha256: 'a'.repeat(64) } };
  for (const step of prepared.operation.steps.filter(value => value.status !== 'succeeded')) {
    const evidence = proof[step.name]; if (!evidence) throw new Error('unexpected group step'); await fleet.startStep(claim, step.name);
    for (const slice of await fleet.hostSlices(claim)) await fleet.completeHostStep(claim, step.name, slice.host_id, slice.target_sha256, evidence);
    await fleet.completeStep(claim, step.name, aggregateHostEvidence(step.name, await fleet.hostReceipts(claim, step.name)));
  }
  expect((await fleet.settle(claim)).status).toBe('succeeded');
}
async function branchVersion(): Promise<ContextVersion> {
  const tenant = 'anchor-branch'; const alias = 'branch-worker';
  await admin.query('INSERT INTO tenants(id,company_id,is_hub) VALUES($1,$2,false)', [tenant, company.company.id]);
  await admin.query("INSERT INTO rooms(tenant_id,id) VALUES($1,'branch-room')", [tenant]);
  await admin.query("INSERT INTO agents(tenant_id,alias,harness_id,enabled) VALUES($1,$2,'codex',false)", [tenant, alias]);
  await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'branch-room',$2,'agent')", [tenant, alias]);
  await admin.query(`UPDATE agents SET runtime_key=$2,host_id=$3,runtime_mode='container',container_name='cauce-'||$2,runtime_user='dev',
    home_directory='/home/dev',state_directory='/home/dev/.cauce/'||$2,systemd_user='stev',primary_room_id='branch-room',
    lifecycle_state='ready',enabled=true WHERE tenant_id=$1 AND alias=$2`, [tenant, alias, host.host_id]);
  await admin.query('INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route) VALUES($1,$2,true,true)', [company.hub.id, tenant]);
  return context(alias, tenant);
}
async function humanVersion(): Promise<{ version: ContextVersion; humanId: string }> {
  const alias = 'human-target'; const tenant = company.hub.id;
  await admin.query('INSERT INTO agents(tenant_id,alias,enabled) VALUES($1,$2,false)', [tenant, alias]);
  await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'governance',$2,'operator')", [tenant, alias]);
  const human = (await admin.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES('target@example.test','target@example.test',$1,'Human target','operator',$2,$3) RETURNING id`, ['$scrypt$' + 'x'.repeat(48), tenant, alias])).rows[0];
  if (!human) throw new Error('human target absent');
  await admin.query("INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions) VALUES($1,$2,$3,'operator',ARRAY['read','control'])",
    [human.id, tenant, alias]);
  return { version: await context(alias), humanId: human.id };
}

describe('source-only director anchor continuity', () => {
  it.each(['retire', 'purge'] as const)('publishes after %s of the original room and creation of a new room and agent', async kind => {
    await readyAgent('baseline-worker', 'office', false); await transition(kind);
    await readyAgent('next-worker', 'next-office'); const version = await context('next-worker');
    await assertPublishedWithoutConsumption(version);
    expect((await pool.query(`SELECT room.enabled,room.retired_at IS NOT NULL AS retired,room.purged_at IS NOT NULL AS purged
      FROM rooms room WHERE room.tenant_id=$1 AND room.id='office'`, [company.hub.id])).rows)
      .toEqual([{ enabled: false, retired: true, purged: kind === 'purge' }]);
    expect((await pool.query("SELECT role,enabled FROM memberships WHERE tenant_id=$1 AND room_id='office' AND alias=$2", [company.hub.id, broker])).rows)
      .toEqual([{ role: 'context_broker', enabled: true }]);
  });
  it.each(['retire', 'purge'] as const)('keeps a broker-only group free of runtime targets during %s and publishes to a later agent', async kind => {
    await transition(kind);
    expect((await pool.query(`SELECT metadata->'fenced_targets' AS targets FROM fleet_operation_events
      WHERE event='step_completed' AND metadata ? 'fenced_targets' ORDER BY id`)).rows).toEqual([{ targets: [] }]);
    expect((await pool.query('SELECT 1 FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2', [company.hub.id, broker])).rows).toEqual([]);
    await readyAgent('later-consumer', 'later-office'); await assertPublishedWithoutConsumption(await context('later-consumer'));
  });
  it('creates only a route-only anchor when no source room is active, then prefers a new ordinary room', async () => {
    const version = await branchVersion();
    await admin.query('UPDATE rooms SET enabled=false WHERE tenant_id=$1', [company.hub.id]);
    await admin.query(`INSERT INTO rooms(tenant_id,id,enabled,retired_at,retired_enabled,purged_at)
      VALUES($1,'context-anchor',false,now(),true,now())`, [company.hub.id]);
    await assertPublishedWithoutConsumption(version);
    const first = (await anchor(version))[0]; if (!first) throw new Error('anchor absent');
    expect(first).toEqual({ tenant_id: company.hub.id, alias: broker, room_id: 'context-anchor-1' });
    expect((await pool.query('SELECT alias,role,enabled FROM memberships WHERE tenant_id=$1 AND room_id=$2', [company.hub.id, first.room_id])).rows)
      .toEqual([{ alias: broker, role: 'context_broker', enabled: true }]);
    expect((await pool.query('SELECT 1 FROM acl_edges WHERE from_tenant=$1 AND to_tenant<>$2', [company.hub.id, version.tenant_id])).rows).toEqual([]);
    await admin.query("INSERT INTO rooms(tenant_id,id) VALUES($1,'later-room')", [company.hub.id]);
    await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'later-room','owner','operator')", [company.hub.id]);
    expect(await anchor(version)).toEqual([{ tenant_id: company.hub.id, alias: broker, room_id: 'later-room' }]);
    expect((await pool.query('SELECT enabled FROM rooms WHERE tenant_id=$1 AND id=$2', [company.hub.id, first.room_id])).rows).toEqual([{ enabled: true }]);
    expect((await pool.query("SELECT enabled,purged_at IS NOT NULL AS purged FROM rooms WHERE tenant_id=$1 AND id='context-anchor'", [company.hub.id])).rows)
      .toEqual([{ enabled: false, purged: true }]);
  });
  it('serializes concurrent repair without duplicate anchors and keeps broker SQL mutations denied', async () => {
    const version = await branchVersion(); await admin.query('UPDATE rooms SET enabled=false WHERE tenant_id=$1', [company.hub.id]);
    const rows = await Promise.all(Array.from({ length: 6 }, () => anchor(version)));
    expect(new Set(rows.flat().map(row => row.room_id)).size).toBe(1);
    expect((await pool.query("SELECT count(*)::int AS n FROM rooms WHERE tenant_id=$1 AND enabled", [company.hub.id])).rows).toEqual([{ n: 1 }]);
    await expect(pool.query('UPDATE memberships SET role=$3 WHERE tenant_id=$1 AND alias=$2', [company.hub.id, broker, 'operator']))
      .rejects.toMatchObject({ code: '42501' });
    expect((await pool.query("SELECT bool_and(role='context_broker') AS route_only FROM memberships WHERE tenant_id=$1 AND alias=$2", [company.hub.id, broker])).rows)
      .toEqual([{ route_only: true }]);
  });
  it('shares the context writer lock and rechecks the desired version after a concurrent writer commits', async () => {
    await readyAgent('locked-worker', 'locked-room'); const version = await context('locked-worker');
    const writer = await admin.connect();
    try {
      await writer.query('BEGIN'); await lockContextTarget(writer, version);
      await persistContextVersionInTransaction(writer, version, { humanId: company.user.id, homeTenant: company.hub.id, alias: 'owner' }, 1,
        [{ path: 'context/mission.md', content: 'Committed replacement.' }], 'ui');
      const result = anchor(version).then(rows => ({ rows }), (error: unknown) => ({ error }));
      await expect.poll(async () => Number((await admin.query<{ n: string }>(`SELECT count(*)::text AS n FROM pg_stat_activity
        WHERE datname=current_database() AND query LIKE 'SELECT * FROM cauce_ensure_context_director_anchor%' AND wait_event='advisory'`)).rows[0]?.n)).toBe(1);
      await writer.query('COMMIT'); expect(await result).toMatchObject({ error: { code: '22023' } });
      expect((await pool.query("SELECT 1 FROM memberships WHERE tenant_id=$1 AND alias=$2 AND room_id<>'office'", [company.hub.id, broker])).rows).toEqual([]);
    } finally { await writer.query('ROLLBACK'); writer.release(); }
  });
  it('rejects stale versions, altered digests, missing outboxes and cross-company targets before membership changes', async () => {
    await readyAgent('scope-worker', 'scope-room'); const version = await context('scope-worker');
    const before = (await pool.query('SELECT * FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [company.hub.id, broker])).rows;
    const foreign = await channelCompany(pool, 'anchor-foreign');
    for (const value of [{ ...version, digest: 'a'.repeat(64) }, { ...version, company_id: foreign.company.id }, { ...version, tenant_id: foreign.hub.id }])
      await expect(anchor(value)).rejects.toMatchObject({ code: '22023' });
    await context('scope-worker', company.hub.id, 1); await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
    const latest = await withTransaction(pool, client => readContextVersion(client, version, 2));
    await admin.query('DELETE FROM agent_context_outbox WHERE company_id=$1 AND tenant_id=$2 AND alias=$3', [company.company.id, company.hub.id, version.alias]);
    await expect(anchor(latest)).rejects.toMatchObject({ code: '22023' });
    expect((await pool.query('SELECT * FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [company.hub.id, broker])).rows).toEqual(before);
  });
  it('rejects disabled targets and a source-only broker as recipient without inventing a consumer', async () => {
    await readyAgent('disabled-worker', 'disabled-room'); const version = await context('disabled-worker');
    await admin.query('UPDATE agents SET enabled=false WHERE tenant_id=$1 AND alias=$2', [company.hub.id, version.alias]);
    await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
    const sourceVersion = await context(broker); await expect(anchor(sourceVersion)).rejects.toMatchObject({ code: '22023' });
    await expect(pool.query('INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,$2,$3)',
      [randomUUID(), company.hub.id, broker])).rejects.toMatchObject({ code: '42501' });
    expect((await pool.query("SELECT 1 FROM messages WHERE auth_channel='context-broker'")).rows).toEqual([]);
    expect((await pool.query('SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias=$2', [company.hub.id, broker])).rows).toEqual([]);
  });
  it('publishes pending context to a durable active human without enabling a runtime or acknowledging consumption', async () => {
    const { version } = await humanVersion(); await assertPublishedWithoutConsumption(version);
    expect((await pool.query('SELECT enabled,runtime_key,host_id FROM agents WHERE tenant_id=$1 AND alias=$2', [version.tenant_id, version.alias])).rows)
      .toEqual([{ enabled: false, runtime_key: null, host_id: null }]);
  });
  it('rejects revoked humans, mismatched identity aliases, roles and companies before repairing a source', async () => {
    const { version, humanId } = await humanVersion();
    const before = (await pool.query('SELECT * FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [company.hub.id, broker])).rows;
    await admin.query('UPDATE console_users SET active=false WHERE id=$1', [humanId]);
    await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
    await admin.query('UPDATE console_users SET active=true WHERE id=$1', [humanId]);
    await admin.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [humanId]);
    await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
    await admin.query('UPDATE human_tenant_memberships SET enabled=true,revoked_at=NULL,actor_alias=$2 WHERE human_id=$1', [humanId, 'owner']);
    await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
    await admin.query("UPDATE human_tenant_memberships SET actor_alias=$2,role='reader',permissions=ARRAY['read'] WHERE human_id=$1", [humanId, version.alias]);
    await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
    await admin.query("UPDATE human_tenant_memberships SET role='operator',permissions=ARRAY['read','control'] WHERE human_id=$1", [humanId]);
    const foreign = await channelCompany(pool, 'anchor-human-foreign');
    await expect(anchor({ ...version, company_id: foreign.company.id })).rejects.toMatchObject({ code: '22023' });
    expect((await pool.query('SELECT * FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [company.hub.id, broker])).rows).toEqual(before);
    expect((await pool.query("SELECT 1 FROM messages WHERE auth_channel='context-broker'")).rows).toEqual([]);
  });
  it('requires the source-only registration, route-only policy and enabled source company', async () => {
    await readyAgent('authority-worker', 'authority-room'); const version = await context('authority-worker');
    await admin.query('UPDATE company_system_principals SET delivery_source_only=false WHERE company_id=$1', [company.company.id]);
    await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
    await admin.query('UPDATE company_system_principals SET delivery_source_only=true WHERE company_id=$1', [company.company.id]);
    await admin.query('UPDATE agents SET host_id=$3 WHERE tenant_id=$1 AND alias=$2', [company.hub.id, broker, host.host_id]);
    await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
    await admin.query('UPDATE agents SET host_id=NULL WHERE tenant_id=$1 AND alias=$2', [company.hub.id, broker]);
    await admin.query("UPDATE role_policies SET allow_control=true WHERE role='context_broker'");
    await expect(anchor(version)).rejects.toMatchObject({ code: '23514' });
    await expect(new DeliveryContextRuntimeSink(pool, 20).apply(version)).rejects.toMatchObject({ code: '23514' });
    await admin.query("UPDATE role_policies SET allow_control=false WHERE role='context_broker'");
    await admin.query(`REVOKE EXECUTE ON FUNCTION ${helper} FROM cauce_runtime`);
    await expect(new DeliveryContextRuntimeSink(pool, 20).apply(version)).rejects.toMatchObject({ code: '42501' });
    await admin.query(`GRANT EXECUTE ON FUNCTION ${helper} TO cauce_runtime`);
    await admin.query('UPDATE companies SET enabled=false WHERE id=$1', [company.company.id]);
    await expect(anchor(version)).rejects.toMatchObject({ code: '22023' });
  });
  it('grants only runtime and platform execution and rolls back without changing guards or anchor history', async () => {
    const permissions = (await pool.query<{ runtime: boolean; platform: boolean; observer: boolean }>(`SELECT
      has_function_privilege('cauce_runtime',$1,'EXECUTE') AS runtime,has_function_privilege('cauce_platform',$1,'EXECUTE') AS platform,
      has_function_privilege('cauce_observer',$1,'EXECUTE') AS observer`, [helper])).rows;
    expect(permissions).toEqual([{ runtime: true, platform: true, observer: false }]);
    expect((await pool.query(`SELECT 1 FROM pg_proc procedure,LATERAL aclexplode(procedure.proacl) privilege
      WHERE procedure.oid=$1::regprocedure AND privilege.grantee=0 AND privilege.privilege_type='EXECUTE'`, [helper])).rows).toEqual([]);
    await expect(withTransaction(admin, async client => { await client.query('SET LOCAL ROLE cauce_observer');
      await client.query('SELECT * FROM cauce_ensure_context_director_anchor($1,$2,$3,$4,$5)',
        [company.company.id, company.hub.id, broker, 1, 'a'.repeat(64)]); })).rejects.toMatchObject({ code: '42501' });
    const version = await branchVersion(); await admin.query('UPDATE rooms SET enabled=false WHERE tenant_id=$1', [company.hub.id]);
    await assertPublishedWithoutConsumption(version);
    const before = (await pool.query('SELECT * FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [company.hub.id, broker])).rows;
    const downs = await downsThrough('064_company_context_anchor.sql');
    await withTransaction(admin, async client => { for (const down of downs) await client.query(down); });
    expect((await pool.query('SELECT to_regprocedure($1) AS helper', [helper])).rows).toEqual([{ helper: null }]);
    await expect(pool.query('UPDATE memberships SET enabled=false WHERE tenant_id=$1 AND alias=$2', [company.hub.id, broker])).rejects.toMatchObject({ code: '42501' });
    expect((await pool.query('SELECT * FROM memberships WHERE tenant_id=$1 AND alias=$2 ORDER BY room_id', [company.hub.id, broker])).rows).toEqual(before);
    expect((await pool.query("SELECT count(*)::int AS n FROM messages WHERE auth_channel='context-broker'")).rows).toEqual([{ n: 1 }]);
  });
});
