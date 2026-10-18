import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigLeafMutation } from '@cauce/protocol';
import {
  ConfigurationRepository, lockCompanyAuthority, withTransaction,
  type ConfigurationAuthorityResolver, type ConfigurationCapabilities, type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let repository: ConfigurationRepository;
let actors: CompanyIsolationFixture & { zeus: string; isa: string; reader: string };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

async function person(tenant: string, alias: string, permissions = ['read', 'control']): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Fixture','operator',$4,$5)`, [id, `${id}@example.test`, '$scrypt$' + 'x'.repeat(48), tenant, alias]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,$2,$3,$4)`, [id, tenant, alias, permissions]);
  return id;
}

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  const seeded = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [seeded.leon]);
  await admin.query(`UPDATE memberships SET role='operator' WHERE (tenant_id,alias) IN (('Isa','salva'),('Miguel','janus'))`);
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES('Steven','company-humanizar','zeus','operator')`);
  const zeus = await person('Steven', 'zeus');
  await admin.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('humanizar',$1,'admin','platform',$2)`,
    [zeus, seeded.steven]);
  actors = { ...seeded, zeus, isa: await person('Isa', 'salva'), reader: await person('Isa', 'salva', ['read']) };
  repository = new ConfigurationRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function as(tenant: string, alias: string, humanId?: string, requestedCompany?: string): ConfigurationAuthorityResolver {
  return (client: DatabaseClient) => lockCompanyAuthority(client, { tenant, alias,
    ...(humanId === undefined ? {} : { humanId }), ...(requestedCompany === undefined ? {} : { requestedCompany }) });
}
const leon = (): ConfigurationAuthorityResolver => as('PraxisHub', 'company_admin', actors.leon);
const miguel = (): ConfigurationAuthorityResolver => as('Miguel', 'janus', actors.miguel);
function rows(snapshot: Record<string, unknown>, key: string): Record<string, unknown>[] {
  return snapshot[key] as Record<string, unknown>[];
}
function capability(snapshot: Record<string, unknown>, resource: string): unknown {
  return (snapshot.capabilities as ConfigurationCapabilities).resources.find(entry => entry.resource === resource);
}

class ControlProbe extends ConfigurationRepository {
  count(client: DatabaseClient, company: string) { return this.controlState(client, company); }
}

describe('configuration scoped to the acting company', () => {
  it('shows owners their whole company, the switched platform the other one and operators only their tenant', async () => {
    const steven = await repository.get('Steven', 'kant', as('Steven', 'kant', actors.steven));
    expect(rows(steven, 'tenants').map(row => row.id)).toEqual(expect.arrayContaining(['Isa', 'Miguel', 'Steven']));
    expect(rows(steven, 'tenants').some(row => String(row.id).startsWith('Praxis'))).toBe(false);
    const praxis = await repository.get('PraxisHub', 'company_admin', leon());
    expect(rows(praxis, 'tenants').map(row => row.id)).toEqual(['PraxisHub', 'PraxisTeam']);
    expect(rows(praxis, 'rooms').map(row => row.tenant_id)).toEqual(['PraxisHub', 'PraxisTeam']);
    expect(rows(praxis, 'provider_accounts')).toEqual([expect.objectContaining({ id: 'praxis-account', external_account_id: 'praxis-external' })]);
    const switched = await repository.get('Steven', 'kant', as('Steven', 'kant', actors.steven, 'praxis'));
    expect(rows(switched, 'tenants').map(row => row.id)).toEqual(['PraxisHub', 'PraxisTeam']);
    expect(switched.capabilities).toMatchObject({ actor: { tenant_id: 'Steven', company_id: 'praxis', platform_override: true } });
    const isa = await repository.get('Isa', 'salva', as('Isa', 'salva', actors.isa));
    expect(rows(isa, 'tenants').map(row => row.id)).toEqual(['Isa']);
    expect(rows(isa, 'provider_accounts')).toEqual([expect.objectContaining({ id: 'humanizar-account', external_account_id: null })]);
    const team = await repository.get('PraxisTeam', 'team_agent');
    expect(rows(team, 'tenants').map(row => row.id)).toEqual(['PraxisTeam']);
    expect(rows(team, 'agents').map(row => row.tenant_id)).toEqual(['PraxisTeam']);
  });

  it('publishes the capabilities of every role without a hub scope', async () => {
    const roles: [string, Record<string, unknown>, Record<string, unknown>][] = [];
    for (const [name, tenant, alias, resolver] of [
      ['platform', 'Steven', 'kant', as('Steven', 'kant', actors.steven)], ['owner', 'Miguel', 'janus', miguel()],
      ['admin', 'Steven', 'zeus', as('Steven', 'zeus', actors.zeus)], ['operator', 'Isa', 'salva', as('Isa', 'salva', actors.isa)],
      ['reader', 'Isa', 'salva', as('Isa', 'salva', actors.reader)], ['hub agent', 'Steven', 'kant', undefined],
    ] as const) {
      const snapshot = await repository.get(tenant, alias, resolver);
      expect(JSON.stringify(snapshot.capabilities)).not.toContain('hub');
      roles.push([name, (snapshot.capabilities as ConfigurationCapabilities).actor, Object.fromEntries(['provider_account', 'chain_policy',
        'fleet_host', 'room', 'agent', 'harness'].map(resource => [resource, capability(snapshot, resource)]))]);
    }
    const scopes = Object.fromEntries(roles.map(([name, actor, resources]) => [name, [actor.role, actor.can_control,
      ...Object.values(resources).map(entry => { const { actions, scope } = entry as { actions: string[]; scope: string }; return `${scope}:${actions.join('+')}`; })]]));
    expect(scopes).toEqual({
      platform: ['platform_admin', true, 'company:create+update+delete', 'platform:update', 'platform:create+update+delete',
        'company:create+update+delete+retire+restore', 'company:create+update+delete', 'none:'],
      owner: ['company_owner', true, 'company:create+update+delete', 'none:', 'company:update+delete',
        'company:create+update+delete+retire+restore', 'company:create+update+delete', 'none:'],
      admin: ['company_admin', true, 'none:', 'none:', 'company:update+delete',
        'company:create+update+delete+retire+restore', 'company:create+update+delete', 'none:'],
      operator: ['tenant_operator', true, 'none:', 'none:', 'none:', 'tenant:create+update+delete+retire+restore', 'none:', 'none:'],
      reader: ['reader', false, 'none:', 'none:', 'none:', 'none:', 'none:', 'none:'],
      'hub agent': ['tenant_operator', true, 'none:', 'none:', 'none:', 'tenant:create+update+delete+retire+restore', 'none:', 'none:'],
    });
  });

  it('rejects foreign mutations and dependency previews before writing a batch', async () => {
    const foreign = { resource: 'room' as const, action: 'create' as const, tenant_id: 'Steven', id: 'foreign-room', value: { enabled: true } };
    await expect(repository.apply('PraxisHub', 'company_admin', foreign, false, 0, leon())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.getDependencies('PraxisHub', 'company_admin', { ...foreign, action: 'delete' }, 0, leon()))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.apply('PraxisHub', 'company_admin', { resource: 'batch', action: 'apply', mutations: [
      { ...foreign, tenant_id: 'PraxisHub', id: 'own-room' }, foreign,
    ] }, false, 0, leon())).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query("SELECT id FROM rooms WHERE id IN ('foreign-room','own-room')")).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM config_revisions')).rows).toEqual([]);
  });

  it('denies every foreign tenant, payer, account, host and unlinked peer across resources', async () => {
    const foreign: ConfigLeafMutation[] = [
      { resource: 'tenant', action: 'update', id: 'Isa', value: { display_name: 'Foreign' } },
      { resource: 'room', action: 'retire', tenant_id: 'Steven', id: 'company-humanizar' },
      { resource: 'membership', action: 'create', tenant_id: 'Steven', room_id: 'company-humanizar', alias: 'company_admin', value: { role: 'operator' } },
      { resource: 'acl_edge', action: 'create', from_tenant: 'Steven', to_tenant: 'Isa', value: {} },
      { resource: 'acl_edge', action: 'create', from_tenant: 'PraxisHub', to_tenant: 'Steven', value: {} },
      { resource: 'egress_destination', action: 'create', tenant_id: 'Steven', alias: 'company_admin', handle: 'foreign.channel',
        value: { adapter: 'telegram', channel: 'company', conversation_id: '1', conversation_kind: 'dm' } },
      { resource: 'agent', action: 'update', tenant_id: 'Steven', alias: 'company_admin', value: { display_name: 'Foreign' } },
      { resource: 'agent', action: 'update', tenant_id: 'PraxisHub', alias: 'company_admin', value: { host_id: 'humanizar-host' } },
      { resource: 'provider_account', action: 'create', id: 'praxis-foreign-payer', value: { provider: 'codex', external_account_id: 'praxis-foreign',
        payer_tenant_id: 'Steven', credential_ref_kind: 'env_path', credential_ref: 'CAUCE_TEST_FOREIGN_PATH' } },
      { resource: 'provider_account', action: 'update', id: 'humanizar-account', value: { label: 'Foreign' } },
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Steven', alias: 'company_admin', account_id: 'humanizar-account' },
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'PraxisHub', alias: 'company_admin', account_id: 'humanizar-account' },
      { resource: 'agent_account_binding', action: 'create', tenant_id: 'PraxisHub', agent_alias: 'company_admin', account_id: 'humanizar-account', value: { priority: 0 } },
    ];
    for (const mutation of foreign) {
      await expect(repository.apply('PraxisHub', 'company_admin', mutation, true, 0, leon()), mutation.resource).rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.getDependencies('PraxisHub', 'company_admin', mutation, 0, leon()), mutation.resource).rejects.toMatchObject({ code: 'forbidden' });
    }
    const zeus = as('Steven', 'zeus', actors.zeus);
    await expect(repository.apply('Steven', 'zeus', { resource: 'provider_account', action: 'update', id: 'humanizar-account',
      value: { label: 'Administrator' } }, true, 0, zeus)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await repository.apply('Steven', 'zeus', { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'Isa',
      alias: 'salva', account_id: 'humanizar-account' }, true, 0, zeus)).dry_run).toBe(true);
    await expect(repository.apply('Isa', 'salva', { resource: 'room', action: 'create', tenant_id: 'Miguel', id: 'beside', value: {} },
      true, 0, as('Isa', 'salva', actors.isa))).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query('SELECT id FROM config_revisions')).rows).toEqual([]);
    expect((await pool.query("SELECT label FROM provider_accounts WHERE id='humanizar-account'")).rows).toEqual([{ label: null }]);
  });

  it('writes an ACL edge from its own side towards a linked company only', async () => {
    const edge: ConfigLeafMutation = { resource: 'acl_edge', action: 'create', from_tenant: 'PraxisHub', to_tenant: 'Steven',
      value: { enabled: true, allow_route: true } };
    await expect(repository.apply('PraxisHub', 'company_admin', edge, false, 0, leon())).rejects.toMatchObject({ code: 'forbidden' });
    await admin.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [actors.steven]);
    const created = await repository.apply('PraxisHub', 'company_admin', edge, false, 0, leon());
    expect(created.applied).toBe(true);
    const steven = await repository.get('Steven', 'kant', as('Steven', 'kant', actors.steven));
    expect(rows(steven, 'acl_edges')).toContainEqual(expect.objectContaining({ from_tenant: 'PraxisHub', to_tenant: 'Steven' }));
    await expect(repository.apply('Steven', 'kant', { resource: 'acl_edge', action: 'delete', from_tenant: 'PraxisHub', to_tenant: 'Steven' },
      false, undefined, as('Steven', 'kant', actors.steven))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('creates tenants in the acting company, including batches, deletion inverses and a platform switch', async () => {
    const created = await repository.apply('PraxisHub', 'company_admin', { resource: 'batch', action: 'apply', mutations: [
      { resource: 'tenant', action: 'create', id: 'PraxisNew', value: { display_name: 'New' } },
      { resource: 'room', action: 'create', tenant_id: 'PraxisNew', id: 'company-new-room', value: {} },
    ] }, false, 0, leon());
    expect((await pool.query("SELECT company_id FROM tenants WHERE id='PraxisNew'")).rows).toEqual([{ company_id: 'praxis' }]);
    await repository.rollback('PraxisHub', 'company_admin', created.revision, false, created.revision, leon());
    const own = await repository.apply('PraxisHub', 'company_admin', { resource: 'tenant', action: 'create', id: 'PraxisEmpty', value: {} }, false,
      undefined, leon());
    const removed = await repository.apply('PraxisHub', 'company_admin', { resource: 'tenant', action: 'delete', id: 'PraxisEmpty' }, false,
      own.revision, leon());
    await repository.rollback('PraxisHub', 'company_admin', removed.revision, false, removed.revision, leon());
    expect((await pool.query("SELECT company_id FROM tenants WHERE id='PraxisEmpty'")).rows).toEqual([{ company_id: 'praxis' }]);
    await repository.apply('Steven', 'kant', { resource: 'tenant', action: 'create', id: 'PraxisBySwitch', value: {} }, false, undefined,
      as('Steven', 'kant', actors.steven, 'praxis'));
    expect((await pool.query("SELECT company_id FROM tenants WHERE id='PraxisBySwitch'")).rows).toEqual([{ company_id: 'praxis' }]);
  });

  it('keeps harnesses and role policies out of the API and chain policies on the platform', async () => {
    const steven = as('Steven', 'kant', actors.steven);
    for (const [tenant, alias, resolver] of [['Steven', 'kant', steven], ['Miguel', 'janus', miguel()], ['PraxisHub', 'company_admin', leon()]] as const) {
      await expect(repository.apply(tenant, alias, { resource: 'harness', action: 'update', id: 'codex', value: { display_name: 'Edited' } },
        false, undefined, resolver)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.apply(tenant, alias, { resource: 'role_policy', action: 'update', role: 'operator', value: { allow_notify: true } },
        false, undefined, resolver)).rejects.toMatchObject({ code: 'forbidden' });
    }
    const chain: ConfigLeafMutation = { resource: 'chain_policy', action: 'update', id: 'default', value: { max_fanout_per_turn: 7 } };
    await expect(repository.apply('Miguel', 'janus', chain, false, undefined, miguel())).rejects.toMatchObject({ code: 'forbidden' });
    const applied = await repository.apply('Steven', 'kant', chain, false, undefined, steven);
    expect((await pool.query('SELECT scope,company_id,actor_human_id::text FROM config_revisions WHERE id=$1', [applied.revision])).rows)
      .toEqual([{ scope: 'platform', company_id: null, actor_human_id: actors.steven }]);
    expect((await pool.query("SELECT display_name FROM harness_definitions WHERE id='codex'")).rows).not.toEqual([{ display_name: 'Edited' }]);
  });

  it('protects the last hub control within each company', async () => {
    await expect(repository.apply('PraxisHub', 'company_admin', { resource: 'membership', action: 'retire', tenant_id: 'PraxisHub',
      room_id: 'company-praxis', alias: 'company_admin' }, false, 0, leon())).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT enabled FROM memberships WHERE room_id='company-praxis'")).rows).toEqual([{ enabled: true }]);
  });

  it('counts only active owners whose home membership still controls', async () => {
    const probe = new ControlProbe(pool);
    const owners = async (company: string) => (await withTransaction(pool, client => probe.count(client, company))).owner_count;
    expect([await owners('humanizar'), await owners('praxis')]).toEqual([2, 1]);
    await admin.query("UPDATE memberships SET role='agent' WHERE tenant_id='Miguel' AND alias='janus'");
    expect(await owners('humanizar')).toBe(1);
    await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
    await admin.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1", [actors.miguel]);
    expect(await owners('humanizar')).toBe(1);
    await admin.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [actors.leon]);
    expect(await owners('praxis')).toBe(0);
  });

  it('keeps the last owner control even when another runtime still controls the hub', async () => {
    await admin.query("INSERT INTO rooms(id,tenant_id) VALUES('spare-control','PraxisHub')");
    await admin.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory)
      VALUES('PraxisHub','spare_control',true,'codex','spare-fixture','dev','/home/dev','/home/dev/.cauce')`);
    await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES('PraxisHub','spare-control','spare_control','operator')`);
    const platform = as('Steven', 'kant', actors.steven, 'praxis');
    await expect(repository.apply('Steven', 'kant', { resource: 'room', action: 'retire', tenant_id: 'PraxisHub',
      id: 'company-praxis' }, false, 0, platform)).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT enabled FROM rooms WHERE tenant_id='PraxisHub' AND id='company-praxis'")).rows)
      .toEqual([{ enabled: true }]);
  });

  it('keeps a membership whose room id is purged only in another company', async () => {
    await admin.query(`INSERT INTO rooms(id,tenant_id) VALUES('grp.shared','Steven');
      INSERT INTO rooms(id,tenant_id,enabled,retired_at,retired_enabled,purged_at) VALUES('grp.shared','PraxisHub',false,now(),true,now());
      INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.shared','company_admin','agent')`);
    const steven = await repository.get('Steven', 'kant', as('Steven', 'kant', actors.steven));
    expect(rows(steven, 'memberships')).toContainEqual(expect.objectContaining({ tenant_id: 'Steven', room_id: 'grp.shared', alias: 'company_admin' }));
  });

  it('revalidates ownership after waiting for a concurrent configuration writer', async () => {
    const blocker = await pool.connect();
    await blocker.query('BEGIN'); await blocker.query('SELECT pg_advisory_xact_lock(783_003_004)');
    const attempt = repository.apply('PraxisHub', 'company_admin', { resource: 'room', action: 'create', tenant_id: 'ConcurrentForeign',
      id: 'company-concurrent-room', value: {} }, false, undefined, leon()).then(() => 'applied', (error: unknown) => error);
    try {
      await expect.poll(async () => (await pool.query(`SELECT 1 FROM pg_stat_activity
        WHERE wait_event='advisory' AND query='SELECT pg_advisory_xact_lock_shared($1::bigint)'`)).rowCount, { timeout: 5000 }).toBe(1);
      await admin.query("INSERT INTO tenants(id,company_id) VALUES('ConcurrentForeign','humanizar')");
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect(await attempt).toMatchObject({ code: 'forbidden' });
    expect((await pool.query("SELECT id FROM rooms WHERE id='company-concurrent-room'")).rows).toEqual([]);
  });
});
