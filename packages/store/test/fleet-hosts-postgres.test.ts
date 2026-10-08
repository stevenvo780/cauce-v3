import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FleetHostSchema } from '@cauce/protocol';
import {
  ConfigurationRepository, createFleetHost, deleteFleetHost, fleetHostAvailability, listFleetHosts, recordFleetHostStatus,
  updateFleetHost, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function placedAgent(alias: string, hostId: string, lease: 'live' | 'expired' | 'none'): Promise<void> {
  await pool.query(
    `INSERT INTO agents(tenant_id,alias,enabled,host_id,harness_id,container_name,runtime_user,home_directory,state_directory)
     VALUES('Steven',$1,true,$2,'codex','box','dev','/home/dev','/home/dev/.cauce')`, [alias, hostId]);
  if (lease === 'none') return;
  await pool.query(
    `INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until,last_heartbeat_at)
     VALUES('Steven',$1,'i1',1,now() + $2::interval,now() - interval '5 seconds')`,
    [alias, lease === 'live' ? '1 minute' : '-1 minute']);
}

describe('fleet hosts on PostgreSQL', () => {
  it('unions registered, approved and placed hosts with the lease rule', async () => {
    await createFleetHost(pool, { host_id: 'alpha', display_name: 'Alfa', notes: '' });
    await placedAgent('live_one', 'beta', 'live');
    await placedAgent('dead_one', 'gamma', 'expired');
    await placedAgent('mute_one', 'gamma', 'none');
    const hosts = await listFleetHosts(pool, { approvedHostIds: ['delta', 'beta'] });
    for (const host of hosts) expect(FleetHostSchema.parse(host)).toEqual(host);
    expect(hosts.map((host) => host.host_id)).toEqual(['alpha', 'beta', 'delta', 'gamma']);
    const byId = Object.fromEntries(hosts.map((host) => [host.host_id, host]));
    expect(byId.alpha).toMatchObject({ registered: true, approved: false, version: 1, status: 'unknown', status_source: 'none', last_seen_at: null });
    expect(byId.beta).toMatchObject({
      registered: false, approved: true, version: 0, display_name: 'beta', status: 'reachable', status_source: 'agents',
      agents: [{ tenant_id: 'Steven', alias: 'live_one', enabled: true, online: true }],
    });
    expect(byId.beta?.last_seen_at).not.toBeNull();
    expect(byId.delta).toMatchObject({ registered: false, approved: true, status: 'unknown', agents: [] });
    expect(byId.gamma).toMatchObject({ status: 'unreachable', status_source: 'agents' });
    expect(byId.gamma?.agents.map((agent) => agent.online)).toEqual([false, false]);
  });

  it('ignores purged agents', async () => {
    await pool.query("INSERT INTO agents(tenant_id,alias,enabled,host_id,retired_at,purged_at) VALUES('Steven','gone',false,'ghost',now(),now())");
    expect(await listFleetHosts(pool, { approvedHostIds: [] })).toEqual([]);
  });

  it('prefers a fresh controller report and falls back to agents when it is stale', async () => {
    await placedAgent('live_one', 'alpha', 'live');
    await recordFleetHostStatus(pool, 'alpha', 'unreachable');
    expect((await listFleetHosts(pool, { approvedHostIds: [] }))[0]).toMatchObject({ status: 'unreachable', status_source: 'controller', registered: true });
    expect(await fleetHostAvailability(pool, 'alpha')).toEqual({ usable: false, reason: 'unreachable' });
    await pool.query("UPDATE fleet_hosts SET controller_seen_at=now() - interval '91 seconds' WHERE host_id='alpha'");
    expect((await listFleetHosts(pool, { approvedHostIds: [] }))[0]).toMatchObject({ status: 'reachable', status_source: 'agents' });
    expect(await fleetHostAvailability(pool, 'alpha')).toEqual({ usable: true });
  });

  it('keeps a healthy computer usable when all its agents are stopped', async () => {
    await placedAgent('stopped_one', 'alpha', 'expired');
    await placedAgent('mute_one', 'alpha', 'none');
    expect((await listFleetHosts(pool, { approvedHostIds: [] }))[0]).toMatchObject({ status: 'unreachable', status_source: 'agents' });
    expect(await fleetHostAvailability(pool, 'alpha')).toEqual({ usable: true });
    await recordFleetHostStatus(pool, 'alpha', 'reachable');
    await pool.query("UPDATE fleet_hosts SET controller_seen_at=now() - interval '91 seconds' WHERE host_id='alpha'");
    expect(await fleetHostAvailability(pool, 'alpha')).toEqual({ usable: true });
    await recordFleetHostStatus(pool, 'alpha', 'unreachable');
    expect(await fleetHostAvailability(pool, 'alpha')).toEqual({ usable: false, reason: 'unreachable' });
    await pool.query("UPDATE fleet_hosts SET controller_seen_at=now() - interval '91 seconds' WHERE host_id='alpha'");
    expect(await fleetHostAvailability(pool, 'alpha')).toEqual({ usable: true });
  });

  it('derives unknown from agents when none of the placed agents is enabled', async () => {
    await pool.query(
      `INSERT INTO agents(tenant_id,alias,enabled,host_id,harness_id,container_name,runtime_user,home_directory,state_directory)
       VALUES('Steven','off_one',false,'alpha','codex','box','dev','/home/dev','/home/dev/.cauce')`);
    expect((await listFleetHosts(pool, { approvedHostIds: [] }))[0]).toMatchObject({ status: 'unknown', status_source: 'agents' });
  });

  it('blocks a disabled computer even with a fresh reachable report', async () => {
    await recordFleetHostStatus(pool, 'alpha', 'reachable');
    await updateFleetHost(pool, 'alpha', { expected_version: 1, enabled: false });
    expect(await fleetHostAvailability(pool, 'alpha')).toEqual({ usable: false, reason: 'disabled' });
  });

  it('records controller status without touching the operator version and creates the row when missing', async () => {
    await recordFleetHostStatus(pool, 'solo', 'reachable');
    await recordFleetHostStatus(pool, 'solo', 'reachable');
    expect((await listFleetHosts(pool, { approvedHostIds: [] }))[0]).toMatchObject({
      host_id: 'solo', display_name: 'solo', version: 1, status: 'reachable', status_source: 'controller',
    });
    const edited = await updateFleetHost(pool, 'solo', { expected_version: 1, notes: 'rack' });
    await recordFleetHostStatus(pool, 'solo', 'unreachable');
    expect((await listFleetHosts(pool, { approvedHostIds: [] }))[0]).toMatchObject({ version: edited.version, notes: 'rack' });
  });

  it('reports availability: unknown hosts and disabled hosts', async () => {
    expect(await fleetHostAvailability(pool, 'nowhere')).toEqual({ usable: true });
    await createFleetHost(pool, { host_id: 'alpha', display_name: 'Alfa', notes: '' });
    await updateFleetHost(pool, 'alpha', { expected_version: 1, enabled: false });
    expect(await fleetHostAvailability(pool, 'alpha')).toEqual({ usable: false, reason: 'disabled' });
  });

  it('creates, updates and deletes with compare-and-set semantics', async () => {
    const created = await createFleetHost(pool, { host_id: 'alpha', display_name: 'Alfa', notes: 'n' }, ['alpha']);
    expect(created).toMatchObject({ registered: true, approved: true, version: 1, notes: 'n' });
    await expect(createFleetHost(pool, { host_id: 'alpha', display_name: 'Otra', notes: '' })).rejects.toMatchObject({ code: 'conflict' });
    const updated = await updateFleetHost(pool, 'alpha', { expected_version: 1, display_name: 'Alfa 2' });
    expect(updated).toMatchObject({ display_name: 'Alfa 2', notes: 'n', version: 2 });
    await expect(updateFleetHost(pool, 'alpha', { expected_version: 1, notes: 'x' })).rejects.toMatchObject({ code: 'conflict' });
    await expect(updateFleetHost(pool, 'missing', { expected_version: 1, notes: 'x' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteFleetHost(pool, 'alpha', 1)).rejects.toMatchObject({ code: 'conflict' });
    await expect(deleteFleetHost(pool, 'missing', 1)).rejects.toMatchObject({ code: 'not_found' });
    await deleteFleetHost(pool, 'alpha', 2);
    expect(await listFleetHosts(pool, { approvedHostIds: [] })).toEqual([]);
  });

  it('refuses to delete a computer that still has agents', async () => {
    await createFleetHost(pool, { host_id: 'alpha', display_name: 'Alfa', notes: '' });
    await placedAgent('live_one', 'alpha', 'none');
    await expect(deleteFleetHost(pool, 'alpha', 1)).rejects.toThrow(/still has agents/u);
  });

  it('places agents on a host through the registry until the runtime key is assigned', async () => {
    const repo = new ConfigurationRepository(pool);
    const base = { resource: 'agent' as const, tenant_id: 'Steven', alias: 'placed' };
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('lifecycle-admin','Steven')");
    await pool.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory)
      VALUES('Steven','admin',true,'codex','box','dev','/home/dev','/home/dev/.cauce')`);
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','lifecycle-admin','admin','operator')");
    const created = await repo.apply('Steven', 'admin', { ...base, action: 'create', value: { host_id: 'alpha' } }, false, 0);
    expect((await pool.query("SELECT host_id FROM agents WHERE alias='placed'")).rows[0]).toEqual({ host_id: 'alpha' });
    const moved = await repo.apply('Steven', 'admin', { ...base, action: 'update', value: { host_id: 'beta' } }, false, created.revision);
    expect((await pool.query("SELECT host_id FROM agents WHERE alias='placed'")).rows[0]).toEqual({ host_id: 'beta' });
    const cleared = await repo.apply('Steven', 'admin', { ...base, action: 'update', value: { host_id: null } }, false, moved.revision);
    expect((await pool.query("SELECT host_id FROM agents WHERE alias='placed'")).rows[0]).toEqual({ host_id: null });
    await pool.query("UPDATE agents SET host_id='alpha',runtime_key='placed-key' WHERE alias='placed'");
    await expect(repo.apply('Steven', 'admin', { ...base, action: 'update', value: { host_id: 'beta' } }, false, cleared.revision))
      .rejects.toThrow(/fleet operation/u);
    const same = await repo.apply('Steven', 'admin', { ...base, action: 'update', value: { host_id: 'alpha', display_name: 'Same' } }, false, cleared.revision);
    expect(same).toMatchObject({ applied: true });
    await pool.query("UPDATE agents SET host_id=NULL WHERE alias='placed'");
    const recorded = await repo.apply('Steven', 'admin', { ...base, action: 'update', value: { host_id: 'beta' } }, false, same.revision);
    expect((await pool.query("SELECT host_id FROM agents WHERE alias='placed'")).rows[0]).toEqual({ host_id: 'beta' });
    await expect(repo.apply('Steven', 'admin', { ...base, action: 'update', value: { host_id: 'alpha' } }, false, recorded.revision))
      .rejects.toThrow(/fleet operation/u);
    await expect(repo.apply('Steven', 'admin', { ...base, action: 'update', value: { host_id: null } }, false, recorded.revision))
      .rejects.toThrow(/fleet operation/u);
  });

  it('rolls back only while no host is registered', async () => {
    const down = await readFile(new URL('../migrations/down/050_fleet_hosts.sql', import.meta.url), 'utf8');
    await createFleetHost(pool, { host_id: 'alpha', display_name: 'Alfa', notes: '' });
    await expect(pool.query(down)).rejects.toThrow(/populated host schema/u);
    await deleteFleetHost(pool, 'alpha', 1);
    await pool.query(down);
    expect((await pool.query("SELECT to_regclass('fleet_hosts') AS relation")).rows[0]).toEqual({ relation: null });
    expect((await pool.query("SELECT 1 FROM schema_migrations WHERE version='050_fleet_hosts.sql'")).rowCount).toBe(0);
  });
});
