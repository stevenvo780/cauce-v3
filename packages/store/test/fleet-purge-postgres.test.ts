import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationRepository, FleetOperationsRepository, withTransaction, type DatabasePool } from '../src/index.js';
import { purgeFleetTarget } from '../src/repository/fleet-operation-lifecycle.js';
import type { FleetOperationRow } from '../src/repository/fleet-operation-contracts.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { finishPurge, messageFixture, preparePurge, profileAdoptionFixture, purgeFixture, purgeRequest } from './fleet-purge-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database missing');
  current = await startTestCaseDatabase(database); pool = current.pool; await purgeFixture(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('fleet purge with preserved historical identities', () => {
  it('previews owned configuration removal and historical preservation without blocking a retired agent', async () => {
    await messageFixture(pool);
    const preview = await new FleetOperationsRepository(pool).preview('Steven', 'purge_operator', purgeRequest());
    expect(preview.can_apply).toBe(true);
    expect(preview.dependencies).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: 'purge.delete.agent_profiles', blocking: false }),
      expect.objectContaining({ type: 'purge.delete.agent_account_bindings', blocking: false }),
      expect.objectContaining({ type: 'purge.preserve.messages', blocking: false }),
      expect.objectContaining({ type: 'purge.preserve.memberships', blocking: false }),
    ]));
    expect((await pool.query("SELECT 1 FROM agent_profiles WHERE tenant_id='Steven' AND alias='purge_agent'")).rowCount).toBe(1);
  });
  it('purges owned configuration atomically and hides its tombstone while retaining messages and audit', async () => {
    const message = await messageFixture(pool);
    await profileAdoptionFixture(pool, message);
    const { repo, claim } = await preparePurge(pool); await finishPurge(repo, claim);
    expect((await pool.query(`SELECT enabled,lifecycle_state,purged_at IS NOT NULL AS purged,runtime_key,
      primary_room_id,harness_id,primary_account_id FROM agents WHERE tenant_id='Steven' AND alias='purge_agent'`)).rows[0])
      .toEqual({ enabled: false, lifecycle_state: 'retired', purged: true, runtime_key: 'purge-steven', primary_room_id: null, harness_id: null, primary_account_id: null });
    for (const table of ['agent_profiles', 'agent_profile_runtime_expectations', 'agent_profile_runtime_adoptions',
      'alias_routing_ceiling', 'egress_destinations', 'agent_appearances']) {
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE tenant_id='Steven' AND alias='purge_agent'`)).rowCount).toBe(0);
    }
    expect((await pool.query("SELECT 1 FROM agent_account_bindings WHERE tenant_id='Steven' AND agent_alias='purge_agent'")).rowCount).toBe(0);
    expect((await pool.query("SELECT room_id,enabled,retired_at IS NOT NULL AS retired FROM memberships WHERE tenant_id='Steven' AND alias='purge_agent'")).rows)
      .toEqual([{ room_id: 'purge-owned', enabled: false, retired: true }]);
    expect((await pool.query('SELECT 1 FROM messages WHERE id=$1', [message])).rowCount).toBe(1);
    expect((await pool.query<{ status: string }>('SELECT status FROM deliveries WHERE message_id=$1', [message])).rows[0]?.status).toBe('done');
    expect((await pool.query('SELECT 1 FROM audit_events WHERE message_id=$1', [message])).rowCount).toBe(1);
    expect((await pool.query<{ operation: string }>("SELECT operation FROM agent_profile_revisions WHERE tenant_id='Steven' AND alias='purge_agent' ORDER BY id DESC LIMIT 1")).rows[0]?.operation).toBe('delete');
    const audit = (await pool.query<{ adoption: Record<string, unknown>[] }>(`SELECT metadata->'deleted_configuration'->'agent_profile_runtime_adoptions' AS adoption
      FROM fleet_operation_events WHERE operation_id=$1 AND metadata->>'step'='purge_scope'`, [claim.operation.id])).rows[0];
    expect(audit?.adoption).toEqual([expect.objectContaining({ tenant_id: 'Steven', alias: 'purge_agent', revision: 1,
      generation: 'purge-generation', instance_id: 'purge-instance', epoch: 1, attempt: 1,
      documents: [{ name: 'AGENTS.md', path: '/home/dev/AGENTS.md', sha: 'b'.repeat(64) }] })]);
    expect((await pool.query("SELECT 1 FROM agent_profiles WHERE tenant_id='Isa' AND alias='purge_agent'")).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM provider_accounts WHERE id='purge-account'")).rowCount).toBe(1);
    const snapshot = await new ConfigurationRepository(pool).get('Steven', 'purge_operator');
    const retired = snapshot.retired as { agents: Record<string, unknown>[]; memberships: Record<string, unknown>[] };
    for (const rows of [snapshot.agents, snapshot.memberships, retired.agents, retired.memberships] as Record<string, unknown>[][]) {
      expect(rows.some(value => value.tenant_id === 'Steven' && value.alias === 'purge_agent')).toBe(false);
    }
    expect(retired.agents.some(value => value.tenant_id === 'Isa' && value.alias === 'purge_agent')).toBe(true);
    expect((await repo.get('Steven', 'purge_operator', claim.operation.id)).status).toBe('succeeded');
  });
  it('blocks active work including outgoing deliveries while preserving completed history', async () => {
    const message = await messageFixture(pool, 'pending');
    await pool.query("UPDATE deliveries SET recipient_alias='another_agent' WHERE message_id=$1", [message]);
    const repo = new FleetOperationsRepository(pool);
    const preview = await repo.preview('Steven', 'purge_operator', purgeRequest());
    expect(preview.can_apply).toBe(false);
    expect(preview.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'purge.blocked.deliveries', blocking: true })]));
    await expect(repo.enqueue('Steven', 'purge_operator', purgeRequest())).rejects.toMatchObject({ code: 'conflict' });
  });
  it('requires verified stop and revoke before deleting any owned configuration', async () => {
    const { claim } = await preparePurge(pool);
    const row = (await pool.query<FleetOperationRow>('SELECT * FROM fleet_operations WHERE id=$1', [claim.operation.id])).rows[0];
    if (!row) throw new Error('operation row missing');
    await expect(withTransaction(pool, client => purgeFleetTarget(client, row))).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT 1 FROM agent_profiles WHERE tenant_id='Steven' AND alias='purge_agent'")).rowCount).toBe(1);
  });
  it('rejects every activation of a purged identity and never reserves the alias again', async () => {
    const { repo, claim } = await preparePurge(pool); await finishPurge(repo, claim);
    for (const kind of ['restore', 'start'] as const) await expect(repo.enqueue('Steven', 'purge_operator', {
      kind, parameters: {}, target: { resource: 'agent', tenant_id: 'Steven', alias: 'purge_agent' },
      expected_revision: 2, idempotency_key: `reactivate-${kind}`,
    })).rejects.toMatchObject({ code: 'conflict' });
    await expect(new ConfigurationRepository(pool).apply('Steven', 'purge_operator', { resource: 'agent', action: 'create',
      tenant_id: 'Steven', alias: 'purge_agent', value: {} }, false, 2)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT 1 FROM fleet_runtime_identities WHERE tenant_id='Steven' AND alias='purge_agent'")).rowCount).toBe(1);
  });
  it('rolls back all deletion and purge audit if any configuration removal fails', async () => {
    const { repo, claim } = await preparePurge(pool);
    await pool.query(`CREATE FUNCTION reject_test_binding_delete() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      RAISE EXCEPTION 'isolated binding failure'; END; $$;
      CREATE TRIGGER reject_test_binding_delete BEFORE DELETE ON agent_account_bindings FOR EACH ROW EXECUTE FUNCTION reject_test_binding_delete()`);
    await expect(finishPurge(repo, claim)).rejects.toThrow('isolated binding failure');
    expect((await pool.query("SELECT 1 FROM agent_profiles WHERE tenant_id='Steven' AND alias='purge_agent'")).rowCount).toBe(1);
    expect((await pool.query<{ purged_at: Date | null }>("SELECT purged_at FROM agents WHERE tenant_id='Steven' AND alias='purge_agent'")).rows[0]?.purged_at).toBeNull();
    expect((await pool.query("SELECT 1 FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'purge_scope'", [claim.operation.id])).rowCount).toBe(0);
  });
  it('purges a used room without deleting its agent or message anchors', async () => {
    const message = await messageFixture(pool);
    const target = { resource: 'room', tenant_id: 'Steven', room_id: 'purge-owned' } as const;
    const { repo, claim } = await preparePurge(pool, target); await finishPurge(repo, claim);
    expect((await pool.query("SELECT enabled,purged_at IS NOT NULL AS purged FROM rooms WHERE id='purge-owned'")).rows[0])
      .toEqual({ enabled: false, purged: true });
    expect((await pool.query("SELECT primary_room_id,purged_at FROM agents WHERE tenant_id='Steven' AND alias='purge_agent'")).rows[0])
      .toEqual({ primary_room_id: null, purged_at: null });
    expect((await pool.query('SELECT 1 FROM messages WHERE id=$1', [message])).rowCount).toBe(1);
    expect((await pool.query("SELECT 1 FROM agent_profiles WHERE tenant_id='Steven' AND alias='purge_agent'")).rowCount).toBe(1);
    await expect(repo.enqueue('Steven', 'purge_operator', { kind: 'restore', target, parameters: {}, expected_revision: 2,
      idempotency_key: 'restore-purged-room' })).rejects.toMatchObject({ code: 'conflict' });
    const snapshot = await new ConfigurationRepository(pool).get('Steven', 'purge_operator');
    expect(JSON.stringify([snapshot.rooms, snapshot.memberships, snapshot.retired])).not.toContain('purge-owned');
  });
  it('purges a tenant and its owned runtime configuration while preserving historical routing anchors', async () => {
    await pool.query("INSERT INTO tenants(id,display_name) VALUES('PurgeTenant','Retired client')");
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('purge-tenant-room','PurgeTenant')");
    await pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('PurgeTenant','purge-tenant-room','client_agent','agent')");
    await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,runtime_key,primary_room_id,host_id,runtime_mode,
      container_name,runtime_user,home_directory,state_directory,systemd_user)
      VALUES('PurgeTenant','client_agent','codex',false,'purge-client','purge-tenant-room','purge-host','container','purge-client','dev','/home/dev','/home/dev/.cauce','stev')`);
    await pool.query("INSERT INTO agent_profiles(tenant_id,alias,purpose) VALUES('PurgeTenant','client_agent','Client history')");
    const message = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES(gen_random_uuid(),'client-history','PurgeTenant','purge-tenant-room','client_agent','{}','interactive') RETURNING id`)).rows[0];
    const target = { resource: 'tenant', tenant_id: 'PurgeTenant' } as const;
    const { repo, claim } = await preparePurge(pool, target); await finishPurge(repo, claim);
    expect((await pool.query("SELECT enabled,purged_at IS NOT NULL AS purged FROM tenants WHERE id='PurgeTenant'")).rows[0])
      .toEqual({ enabled: false, purged: true });
    expect((await pool.query("SELECT 1 FROM agent_profiles WHERE tenant_id='PurgeTenant'")).rowCount).toBe(0);
    expect((await pool.query<{ purged: boolean }>("SELECT purged_at IS NOT NULL AS purged FROM agents WHERE tenant_id='PurgeTenant'")).rows[0]?.purged).toBe(true);
    expect((await pool.query('SELECT 1 FROM messages WHERE id=$1', [message?.id])).rowCount).toBe(1);
    await expect(repo.enqueue('Steven', 'purge_operator', { kind: 'restore', target, parameters: {}, expected_revision: 2,
      idempotency_key: 'restore-purged-tenant' })).rejects.toMatchObject({ code: 'conflict' });
    const snapshot = await new ConfigurationRepository(pool).get('Steven', 'purge_operator');
    expect(JSON.stringify([snapshot.tenants, snapshot.rooms, snapshot.agents, snapshot.memberships, snapshot.retired])).not.toContain('PurgeTenant');
    expect((await pool.query("SELECT 1 FROM agent_profiles WHERE tenant_id='Isa' AND alias='purge_agent'")).rowCount).toBe(1);
  });
  it('rejects new membership configuration under a purged group', async () => {
    await messageFixture(pool);
    const { repo, claim } = await preparePurge(pool, { resource: 'room', tenant_id: 'Steven', room_id: 'purge-owned' });
    await finishPurge(repo, claim);
    await expect(new ConfigurationRepository(pool).apply('Steven', 'purge_operator', { resource: 'membership', action: 'create',
      tenant_id: 'Steven', room_id: 'purge-owned', alias: 'new_draft', value: { role: 'agent', enabled: false } }, false, 2))
      .rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT 1 FROM memberships WHERE room_id='purge-owned' AND alias='new_draft'")).rowCount).toBe(0);
  });
  it('blocks a live lease but permits its preserved expired identity', async () => {
    await pool.query(`INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until)
      VALUES('Steven','purge_agent','isolated-lease',1,clock_timestamp()+interval '1 hour')`);
    const repo = new FleetOperationsRepository(pool);
    expect((await repo.preview('Steven', 'purge_operator', purgeRequest())).can_apply).toBe(false);
    await pool.query("UPDATE connection_leases SET lease_until=clock_timestamp()-interval '1 second' WHERE alias='purge_agent'");
    const preview = await repo.preview('Steven', 'purge_operator', purgeRequest());
    expect(preview.can_apply).toBe(true);
    expect(preview.dependencies).toEqual(expect.arrayContaining([expect.objectContaining({ type: 'purge.preserve.connection_leases', blocking: false })]));
  });
});
