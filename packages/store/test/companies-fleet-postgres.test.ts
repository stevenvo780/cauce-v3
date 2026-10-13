import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sha256Hex, type FleetCapability, type FleetOperationRequest, type FleetTarget } from '@cauce/protocol';
import {
  AgentProfileRepository, FleetOperationsRepository, createFleetHost, deleteFleetHost, listFleetHosts, lockCompanyAuthority,
  providerAccountConsentSql, recordFleetHostStatus, selectAccountForAlias, updateFleetHost, withTransaction,
  type CompanyAuthorityRequest, type DatabasePool, type FleetHostScope,
} from '../src/index.js';
import { assertFleetAuthority } from '../src/repository/fleet-operation-authority.js';
import type { AgentProfileDraftActor } from '../src/repository/agent-profile-draft.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { assertFleetProviderAccount } from '../../../services/gateway/src/console/fleet-capability.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let actors: CompanyIsolationFixture & { zeus: string; isa: string; team: string };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

async function person(tenant: string, alias: string): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Fixture','operator',$4,$5)`, [id, `${id}@example.test`, '$scrypt$' + 'x'.repeat(48), tenant, alias]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,$2,$3,'operator',ARRAY['read','control'])`, [id, tenant, alias]);
  return id;
}

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  const seeded = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [seeded.leon]);
  await admin.query(`UPDATE memberships SET role='operator' WHERE (tenant_id,alias) IN (('Isa','salva'),('Miguel','janus'))`);
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES('Steven','company-humanizar','zeus','operator')`);
  await admin.query("INSERT INTO rooms(id,tenant_id) VALUES('company-empty','Steven'),('praxis-empty','PraxisHub'),('isa-empty','Isa')");
  const zeus = await person('Steven', 'zeus');
  await admin.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('humanizar',$1,'admin','platform',$2)`,
    [zeus, seeded.steven]);
  actors = { ...seeded, zeus, isa: await person('Isa', 'salva'), team: await person('PraxisTeam', 'team_agent') };
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const subject = (id: string): string => `console:${id}`;
function retire(target: FleetTarget, key = `retire-${target.tenant_id}`): FleetOperationRequest {
  return { kind: 'retire', target, expected_revision: 0, idempotency_key: key, parameters: {} };
}
function create(tenant: string, room: string, account: string, host: string, alias = 'new_agent'): Extract<FleetOperationRequest, { kind: 'create' | 'update' }> {
  return { kind: 'create', target: { resource: 'agent', tenant_id: tenant, alias }, expected_revision: 0,
    idempotency_key: `create-${tenant}-${alias}`, parameters: { runtime_key: alias.replaceAll('_', '-'), harness_id: 'codex',
      primary_room_id: room, primary_account_id: account, memberships: [{ room_id: room, role: 'agent' }],
      placement: { host_id: host, mode: 'container', runtime_user: 'dev', container_name: 'company-runtime',
        home_directory: '/home/dev', state_directory: `/home/dev/.cauce/${alias.replaceAll('_', '-')}` } } };
}
function hostScope(request: CompanyAuthorityRequest, approvedHostIds: readonly string[] = []): FleetHostScope {
  return { approvedHostIds, authority: client => lockCompanyAuthority(client, request) };
}
async function allowed(tenant: string, alias: string, target: FleetTarget, control: boolean, human?: string): Promise<boolean> {
  try {
    await withTransaction(pool, client => assertFleetAuthority(client, tenant, alias, target, control, human === undefined ? undefined : subject(human)));
    return true;
  } catch (error) { if ((error as { code?: unknown }).code === 'forbidden') return false; throw error; }
}

describe('fleet authority decided by the company role of a verified person', () => {
  it('grants owners, administrators and the platform their whole company and never the hub alone', async () => {
    const humanizar: FleetTarget[] = [{ resource: 'tenant', tenant_id: 'Steven' }, { resource: 'room', tenant_id: 'Isa', room_id: 'isa-empty' },
      { resource: 'agent', tenant_id: 'Steven', alias: 'kant' }, { resource: 'agent', tenant_id: 'Miguel', alias: 'janus' }];
    const praxis: FleetTarget = { resource: 'agent', tenant_id: 'PraxisTeam', alias: 'team_agent' };
    for (const target of humanizar) {
      expect(await allowed('Steven', 'kant', target, true, actors.steven)).toBe(true);
      expect(await allowed('Miguel', 'janus', target, true, actors.miguel)).toBe(true);
      expect(await allowed('Steven', 'zeus', target, true, actors.zeus)).toBe(true);
      expect(await allowed('PraxisHub', 'company_admin', target, false, actors.leon)).toBe(false);
      expect(await allowed('PraxisTeam', 'team_agent', target, false, actors.team)).toBe(false);
    }
    expect(await allowed('PraxisHub', 'company_admin', praxis, true, actors.leon)).toBe(true);
    expect(await allowed('Steven', 'kant', praxis, false, actors.steven)).toBe(false);
    // Without a verified person the hub alias, and the agent Miguel/janus, stay at tenant authority.
    expect(await allowed('Steven', 'company_admin', { resource: 'agent', tenant_id: 'Steven', alias: 'kant' }, true)).toBe(false);
    expect(await allowed('Steven', 'company_admin', { resource: 'room', tenant_id: 'Steven', room_id: 'company-empty' }, true)).toBe(true);
    expect(await allowed('Steven', 'company_admin', { resource: 'tenant', tenant_id: 'Isa' }, false)).toBe(false);
    expect(await allowed('Miguel', 'janus', { resource: 'agent', tenant_id: 'Miguel', alias: 'janus' }, true)).toBe(false);
    // A tenant operator controls the rooms of its own tenant and reads it, nothing else.
    expect(await allowed('Isa', 'salva', { resource: 'room', tenant_id: 'Isa', room_id: 'isa-empty' }, true, actors.isa)).toBe(true);
    expect(await allowed('Isa', 'salva', { resource: 'tenant', tenant_id: 'Isa' }, false, actors.isa)).toBe(true);
    expect(await allowed('Isa', 'salva', { resource: 'agent', tenant_id: 'Isa', alias: 'salva' }, true, actors.isa)).toBe(false);
    expect(await allowed('Isa', 'salva', { resource: 'room', tenant_id: 'Steven', room_id: 'company-empty' }, true, actors.isa)).toBe(false);
  });

  it('places agents only on computers of the target company and lets Praxis manage its own', async () => {
    const repository = new FleetOperationsRepository(pool, { controllerHost: 'praxis-host' });
    const leon = subject(actors.leon);
    expect((await repository.preview('PraxisHub', 'company_admin', create('PraxisTeam', 'company-team', 'praxis-account', 'praxis-host'), leon)).steps)
      .toContain('runtime');
    await expect(repository.preview('PraxisHub', 'company_admin', create('PraxisTeam', 'company-team', 'praxis-account', 'humanizar-host'), leon))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/another company/u) as unknown });
    await expect(repository.preview('Steven', 'kant', create('Steven', 'company-humanizar', 'humanizar-account', 'praxis-host'), subject(actors.steven)))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.preview('PraxisHub', 'company_admin', create('PraxisTeam', 'company-team', 'praxis-account', 'unregistered-host'), leon))
      .rejects.toMatchObject({ code: 'conflict', message: expect.stringMatching(/registered/u) as unknown });
    await admin.query(`UPDATE agents SET runtime_key='company-admin',runtime_mode='container',systemd_user='dev',container_name='company-runtime',
      state_directory='/home/dev/.cauce/company-admin' WHERE tenant_id='PraxisHub' AND alias='company_admin'`);
    const update: FleetOperationRequest = { ...create('PraxisHub', 'company-praxis', 'praxis-account', 'praxis-host', 'company_admin'),
      kind: 'update', idempotency_key: 'praxis-update' };
    expect((await repository.preview('PraxisHub', 'company_admin', update, leon)).steps).toContain('stop');
    const queued = await repository.enqueue('PraxisHub', 'company_admin', create('PraxisTeam', 'company-team', 'praxis-account', 'praxis-host'), leon);
    expect((await pool.query('SELECT company_id FROM fleet_operations WHERE id=$1', [queued.id])).rows).toEqual([{ company_id: 'praxis' }]);
  });

  it('stops the queued work of an owner whose role is revoked and keeps claiming the other company', async () => {
    const repository = new FleetOperationsRepository(pool);
    const revoked = await repository.enqueue('Miguel', 'janus', create('Steven', 'company-humanizar', 'humanizar-account', 'humanizar-host'),
      subject(actors.miguel));
    const kept = await repository.enqueue('PraxisHub', 'company_admin',
      create('PraxisTeam', 'company-team', 'praxis-account', 'praxis-host', 'praxis_agent'), subject(actors.leon));
    await admin.query("DELETE FROM company_admins WHERE company_id='humanizar' AND human_id=$1", [actors.miguel]);
    expect(await repository.claim('company-worker', 'humanizar-host')).toBeNull();
    expect((await pool.query('SELECT status,error FROM fleet_operations WHERE id=$1', [revoked.id])).rows)
      .toEqual([{ status: 'failed', error: { code: 'AUTHORITY_REVOKED', retryable: false } }]);
    expect((await repository.claim('company-worker', 'praxis-host'))?.operation.id).toBe(kept.id);
  });

  it('binds a platform company switch to the real home person, transaction and durable worker origin', async () => {
    const repository = new FleetOperationsRepository(pool);
    const scoped = repository.forCompany('praxis');
    const request = create('PraxisTeam', 'company-team', 'praxis-account', 'praxis-host');
    const origin = subject(actors.steven);
    expect((await scoped.preview('Steven', 'kant', request, origin)).can_apply).toBe(true);
    const queued = await withTransaction(pool, client => scoped.forTransaction(client).enqueue('Steven', 'kant', request, origin));
    expect(queued.actor).toEqual({ tenant_id: 'Steven', alias: 'kant', actor_subject: origin });
    expect((await scoped.enqueue('Steven', 'kant', request, origin)).id).toBe(queued.id);
    expect((await pool.query('SELECT company_id FROM fleet_operations WHERE id=$1', [queued.id])).rows)
      .toEqual([{ company_id: 'praxis' }]);
    expect((await pool.query('SELECT metadata FROM fleet_operation_events WHERE operation_id=$1 AND event=\'queued\'', [queued.id])).rows)
      .toEqual([{ metadata: { actor_subject: origin, acting_company: 'praxis' } }]);
    const claim = await repository.claim('platform-worker', 'praxis-host');
    if (!claim) throw new Error('selected company claim absent');
    await repository.prepare(claim);
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)', [actors.leon]);
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [actors.steven]);
    expect(await repository.renew(claim)).toBe(false);
    await expect(repository.startStep(claim, 'artifacts')).rejects.toMatchObject({ code: 'forbidden' });
    await expect(scoped.enqueue('Steven', 'kant', request, origin)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('uses only the selected company for history and never accepts its string as authority', async () => {
    const repository = new FleetOperationsRepository(pool);
    const origin = subject(actors.steven);
    const praxis = create('PraxisTeam', 'company-team', 'praxis-account', 'praxis-host', 'switched_agent');
    const own = create('Steven', 'company-humanizar', 'humanizar-account', 'humanizar-host', 'home_agent');
    const source = (client: Parameters<typeof lockCompanyAuthority>[0]) => lockCompanyAuthority(client,
      { tenant: 'Steven', alias: 'kant', humanId: actors.steven, requestedCompany: 'praxis' });
    const selected = repository.forAuthority(source);
    const foreign = await selected.enqueue('Steven', 'kant', praxis, origin);
    const home = await repository.enqueue('Steven', 'kant', own, origin);
    expect((await selected.listRecent('Steven', 'kant', 50, origin)).map(row => row.id)).toEqual([foreign.id]);
    expect((await repository.listRecent('Steven', 'kant', 50, origin)).map(row => row.id)).toEqual([home.id]);
    expect((await selected.get('Steven', 'kant', foreign.id, origin)).id).toBe(foreign.id);
    expect((await selected.list('Steven', 'kant', praxis.target, origin)).map(row => row.id)).toEqual([foreign.id]);
    await expect(repository.enqueue('Steven', 'kant', praxis, origin)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(selected.get('Steven', 'kant', home.id, origin)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.forCompany('praxis').preview('Miguel', 'janus', praxis, subject(actors.miguel)))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.forCompany('praxis').preview('Steven', 'kant', praxis)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(selected.listRecent('Miguel', 'janus', 50, subject(actors.miguel))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(selected.cancel('Steven', 'kant', foreign.id, 0, origin)).resolves.toMatchObject({ status: 'cancelled' });
  });

  it('lists recent operations of the actor company, or of its tenant below company authority', async () => {
    const repository = new FleetOperationsRepository(pool, { controllerHost: 'praxis-host' });
    const seed = async (tenant: string, alias: string, room: string, age: number): Promise<string> => {
      const request = retire({ resource: 'room', tenant_id: tenant, room_id: room }, `recent-${tenant}`);
      return (await admin.query<{ id: string }>(
        `INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,
          idempotency_key,expected_revision,steps,created_at)
         VALUES($1,$2,$3::jsonb,$4,$4,'praxis-host','retire',$5::jsonb,$8,$6,0,'[]'::jsonb,now()-make_interval(secs=>$7)) RETURNING id`,
        [tenant, alias, JSON.stringify(request.target), sha256Hex(request.target), JSON.stringify(request), request.idempotency_key, age,
          sha256Hex(request)])).rows[0]?.id ?? '';
    };
    const own = await seed('PraxisHub', 'company_admin', 'praxis-empty', 30);
    const team = await seed('PraxisTeam', 'team_agent', 'company-team', 10);
    const foreign = await seed('Steven', 'company_admin', 'company-empty', 20);
    const ids = async (tenant: string, alias: string, human?: string) =>
      (await repository.listRecent(tenant, alias, 50, human === undefined ? undefined : subject(human))).map(operation => operation.id);
    expect(await ids('PraxisHub', 'company_admin', actors.leon)).toEqual([team, own]);
    expect(await ids('PraxisTeam', 'team_agent', actors.team)).toEqual([team]);
    expect(await ids('PraxisHub', 'company_admin')).toEqual([own]);
    expect(await ids('Miguel', 'janus', actors.miguel)).toEqual([foreign]);
    expect(await ids('Steven', 'kant', actors.steven)).toEqual([foreign]);
    await expect(repository.list('PraxisHub', 'company_admin', { resource: 'room', tenant_id: 'Steven', room_id: 'company-empty' },
      subject(actors.leon))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.listRecent('PraxisHub', 'company_admin', 0)).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('computers owned by one company', () => {
  const steven = (): CompanyAuthorityRequest => ({ tenant: 'Steven', alias: 'kant', humanId: actors.steven });
  const miguel = (): CompanyAuthorityRequest => ({ tenant: 'Miguel', alias: 'janus', humanId: actors.miguel });
  const leon = (): CompanyAuthorityRequest => ({ tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon });

  it('requires enrolment for owner registration and leaves removal to the platform', async () => {
    await expect(createFleetHost(pool, { host_id: 'owner-host', display_name: 'Owner', notes: '' }, hostScope(miguel())))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(createFleetHost(pool, { host_id: 'admin-host', display_name: 'Admin', notes: '' },
      hostScope({ tenant: 'Steven', alias: 'zeus', humanId: actors.zeus }))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await createFleetHost(pool, { host_id: 'new-host', display_name: 'New', notes: '' }, hostScope(steven())))
      .toMatchObject({ host_id: 'new-host', registered: true });
    await createFleetHost(pool, { host_id: 'leon-host', display_name: 'Leon', notes: '' }, hostScope({ ...steven(), requestedCompany: 'praxis' }));
    expect((await pool.query("SELECT host_id,company_id FROM fleet_hosts WHERE host_id IN ('new-host','leon-host') ORDER BY 1")).rows)
      .toEqual([{ host_id: 'leon-host', company_id: 'praxis' }, { host_id: 'new-host', company_id: 'humanizar' }]);
    expect((await pool.query(`SELECT company_id,actor_human_id::text,metadata->>'platform_override' AS override FROM audit_events
      WHERE action='fleet_host.create' ORDER BY id`)).rows).toEqual([
      { company_id: 'humanizar', actor_human_id: actors.steven, override: 'false' },
      { company_id: 'praxis', actor_human_id: actors.steven, override: 'true' }]);
    await expect(deleteFleetHost(pool, 'new-host', 1, hostScope(miguel()))).rejects.toMatchObject({ code: 'forbidden' });
    await deleteFleetHost(pool, 'new-host', 1, hostScope(steven()));
    await expect(deleteFleetHost(pool, 'leon-host', 1, hostScope(steven()))).rejects.toMatchObject({ code: 'not_found' });
    await expect(deleteFleetHost(pool, 'new-host', 1, hostScope(steven()))).rejects.toMatchObject({ code: 'not_found' });
  });

  it('lets owners list and edit only the computers and agents of their company', async () => {
    const hosts = async (request: CompanyAuthorityRequest, approved: readonly string[] = ['approved-host']) =>
      (await listFleetHosts(pool, hostScope(request, approved))).map(host => [host.host_id, host.agents.map(agent => agent.tenant_id)]);
    expect(await hosts(leon())).toEqual([['praxis-host', ['PraxisHub']]]);
    expect(await hosts(miguel())).toEqual([['humanizar-host', ['Isa', 'Miguel', 'Steven', 'Steven']]]);
    expect(await hosts(steven())).toEqual([['approved-host', []], ['humanizar-host', ['Isa', 'Miguel', 'Steven', 'Steven']]]);
    await expect(listFleetHosts(pool, hostScope({ tenant: 'Isa', alias: 'salva', humanId: actors.isa }))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await updateFleetHost(pool, 'humanizar-host', { expected_version: 1, notes: 'rack' }, hostScope(miguel())))
      .toMatchObject({ notes: 'rack', version: 2 });
    await expect(updateFleetHost(pool, 'praxis-host', { expected_version: 1, enabled: false }, hostScope(miguel())))
      .rejects.toMatchObject({ code: 'not_found' });
    expect(await updateFleetHost(pool, 'praxis-host', { expected_version: 1, enabled: false }, hostScope(leon())))
      .toMatchObject({ enabled: false });
  });

  it('never lets a controller report register a computer once several companies exist', async () => {
    await recordFleetHostStatus(pool, 'unregistered-host', 'reachable');
    await recordFleetHostStatus(pool, 'praxis-host', 'unreachable');
    expect((await pool.query("SELECT host_id,controller_status FROM fleet_hosts WHERE host_id IN ('unregistered-host','praxis-host')")).rows)
      .toEqual([{ host_id: 'praxis-host', controller_status: 'unreachable' }]);
  });
});

describe('accounts and drafts of the fleet plane', () => {
  it('admits pool accounts only for consumers of the payer company', async () => {
    const consent = async (account: string, tenant: string): Promise<boolean | undefined> => (await pool.query<{ consent: boolean }>(
      `SELECT ${providerAccountConsentSql('provider_accounts', '$2')} AS consent FROM provider_accounts WHERE id=$1`, [account, tenant])).rows[0]?.consent;
    expect(await consent('humanizar-account', 'Isa')).toBe(true);
    expect(await consent('humanizar-account', 'PraxisTeam')).toBe(false);
    expect(await consent('praxis-account', 'PraxisTeam')).toBe(true);
    const catalog: FleetCapability = { available: true, actions: ['create'], placements: [{ host_id: 'humanizar-host', modes: ['container'],
      runtime_users: ['dev'], systemd_users: [], home_roots: ['/home/dev'], state_roots: ['/home/dev/.cauce'],
      runtimes: [{ mode: 'container', harness_id: 'codex', provider: 'codex', runtime_user: 'dev', home_directory: '/home/dev',
        state_root: '/home/dev/.cauce', container_name: 'company-runtime' }] }] };
    await assertFleetProviderAccount(pool, catalog, create('Isa', 'grp.isa', 'humanizar-account', 'humanizar-host'));
    await expect(assertFleetProviderAccount(pool, catalog, create('PraxisTeam', 'company-team', 'humanizar-account', 'humanizar-host')))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('selects only accounts of the binding company even if a foreign row slipped past the keys', async () => {
    await admin.query(`ALTER TABLE agent_account_bindings DROP CONSTRAINT agent_account_bindings_account_company_fkey;
      ALTER TABLE alias_routing_ceiling DROP CONSTRAINT alias_routing_ceiling_account_company_fkey`);
    await admin.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant) VALUES
      ('PraxisHub','company_admin','humanizar-account','Steven','PraxisHub'),('PraxisHub','company_admin','praxis-account','PraxisHub','PraxisHub')`);
    await admin.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled) VALUES
      ('PraxisHub','company_admin','humanizar-account',1,true),('PraxisHub','company_admin','praxis-account',2,true)`);
    const selection = await selectAccountForAlias(pool, { tenant_id: 'PraxisHub', alias: 'company_admin', provider: 'codex' });
    expect(selection.candidates.map(candidate => candidate.account_id)).toEqual(['praxis-account']);
    expect(selection.selected?.account_id).toBe('praxis-account');
  });

  it('drafts profiles of any agent of the company as owner and only of its own tenant as operator', async () => {
    await admin.query("UPDATE agents SET enabled=false WHERE (tenant_id,alias) IN (('Steven','zeus'),('Isa','salva'),('PraxisTeam','team_agent'))");
    const profiles = new AgentProfileRepository(pool);
    const actor = (tenant: string, alias: string, humanId: string): AgentProfileDraftActor => ({ tenant_id: tenant, alias,
      subject: subject(humanId), reason: 'Preparar el agente de la empresa',
      humanAuthority: async () => ({ humanId, tenantId: tenant, actorAlias: alias }),
      companyAuthority: client => lockCompanyAuthority(client, { tenant, alias, humanId }) });
    expect(await profiles.canPrepareDraft(actor('Miguel', 'janus', actors.miguel), 'Steven', 'zeus')).toBe(true);
    expect(await profiles.canPrepareDraft(actor('Miguel', 'janus', actors.miguel), 'PraxisTeam', 'team_agent')).toBe(false);
    expect(await profiles.canPrepareDraft(actor('PraxisHub', 'company_admin', actors.leon), 'PraxisTeam', 'team_agent')).toBe(true);
    expect(await profiles.canPrepareDraft(actor('Isa', 'salva', actors.isa), 'Isa', 'salva')).toBe(true);
    expect(await profiles.canPrepareDraft(actor('Isa', 'salva', actors.isa), 'Steven', 'zeus')).toBe(false);
  });
});
