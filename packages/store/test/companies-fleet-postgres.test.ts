import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FleetCapability, FleetOperationRequest, FleetTarget } from '@cauce/protocol';
import { FleetOperationsRepository, providerAccountConsentSql, withTransaction, type DatabasePool } from '../src/index.js';
import { assertFleetAuthority } from '../src/repository/fleet-operation-authority.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { AuthorizationError, type Principal } from '../../../services/gateway/src/auth.js';
import { assertFleetProviderAccount } from '../../../services/gateway/src/console/fleet-capability.js';
import { requireHubControl } from '../../../services/gateway/src/console/fleet-hosts.routes.js';
import { seedCompanyActors } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
  await seedCompanyActors(pool);
  await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('company-empty','Steven'),('praxis-empty','PraxisHub')");
  await pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,shared_with_pool,enabled)
    VALUES('humanizar-pool','codex','company-pool','Steven','env_path','CAUCE_TEST_POOL_PATH',true,true),
          ('praxis-own','codex','praxis-own','PraxisHub','env_path','CAUCE_TEST_PRAXIS_PATH',false,true)`);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const humanizarTargets: FleetTarget[] = [
  { resource: 'tenant', tenant_id: 'Steven' },
  { resource: 'room', tenant_id: 'Steven', room_id: 'company-humanizar' },
  { resource: 'agent', tenant_id: 'Steven', alias: 'company_admin' },
];
function retire(target: FleetTarget): FleetOperationRequest {
  return { kind: 'retire', target, expected_revision: 0, idempotency_key: `company-retire-${target.tenant_id}`, parameters: {} };
}
function create(tenant: string, room: string, account: string): FleetOperationRequest {
  return { kind: 'create', target: { resource: 'agent', tenant_id: tenant, alias: 'new_agent' }, expected_revision: 0,
    idempotency_key: `company-create-${tenant}`, parameters: { runtime_key: 'new-agent', harness_id: 'codex',
      primary_room_id: room, primary_account_id: account, memberships: [{ room_id: room, role: 'agent' }],
      placement: { host_id: 'company-host', mode: 'container', runtime_user: 'dev', container_name: 'company-runtime',
        home_directory: '/home/dev', state_directory: '/home/dev/.cauce/new-agent' } } };
}
function principal(tenant: string): Principal {
  return { tenant_id: tenant, alias: 'company_admin', session_id: 'company-session', channel: 'console',
    roles: ['operator'], permissions: ['read', 'control'] };
}

describe('fleet administration scoped to the actor company', () => {
  it('keeps hub fleet authority inside the actor company for every target kind', async () => {
    for (const target of humanizarTargets) {
      for (const control of [true, false]) {
        await expect(withTransaction(pool, client => assertFleetAuthority(client, 'PraxisHub', 'company_admin', target, control)))
          .rejects.toMatchObject({ code: 'forbidden' });
        await withTransaction(pool, client => assertFleetAuthority(client, 'Steven', 'company_admin', target, control));
      }
    }
    await withTransaction(pool, client => assertFleetAuthority(client, 'PraxisHub', 'company_admin',
      { resource: 'agent', tenant_id: 'PraxisTeam', alias: 'team_agent' }));
  });
  it('refuses previews, enqueues and listings of lifecycle operations on another company', async () => {
    const repository = new FleetOperationsRepository(pool, { controllerHost: 'company-host' });
    const foreign = retire({ resource: 'room', tenant_id: 'Steven', room_id: 'company-empty' });
    await expect(repository.preview('PraxisHub', 'company_admin', foreign)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.enqueue('PraxisHub', 'company_admin', foreign)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.list('PraxisHub', 'company_admin', foreign.target)).rejects.toMatchObject({ code: 'forbidden' });
    expect((await repository.preview('Steven', 'company_admin', foreign)).steps).toContain('revoke');
    const own = retire({ resource: 'room', tenant_id: 'PraxisHub', room_id: 'praxis-empty' });
    expect((await repository.preview('PraxisHub', 'company_admin', own)).steps).toContain('revoke');
    expect((await pool.query('SELECT id FROM fleet_operations')).rows).toEqual([]);
  });
  it('reserves runtime placement on installation hosts to the legacy company', async () => {
    const repository = new FleetOperationsRepository(pool);
    await expect(repository.preview('PraxisHub', 'company_admin', create('PraxisTeam', 'company-team', 'praxis-own')))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/legacy company/u) as unknown });
  });
  it('admits pool accounts only for consumers of the payer company', async () => {
    const consent = async (account: string, tenant: string): Promise<boolean | undefined> => (await pool.query<{ consent: boolean }>(
      `SELECT ${providerAccountConsentSql('provider_accounts', '$2')} AS consent FROM provider_accounts WHERE id=$1`, [account, tenant])).rows[0]?.consent;
    expect(await consent('humanizar-pool', 'Isa')).toBe(true);
    expect(await consent('humanizar-pool', 'PraxisTeam')).toBe(false);
    expect(await consent('praxis-own', 'PraxisHub')).toBe(true);
    expect(await consent('praxis-own', 'PraxisTeam')).toBe(false);
    const catalog: FleetCapability = { available: true, actions: ['create'], placements: [{ host_id: 'company-host', modes: ['container'],
      runtime_users: ['dev'], systemd_users: [], home_roots: ['/home/dev'], state_roots: ['/home/dev/.cauce'],
      runtimes: [{ mode: 'container', harness_id: 'codex', provider: 'codex', runtime_user: 'dev', home_directory: '/home/dev',
        state_root: '/home/dev/.cauce', container_name: 'company-runtime' }] }] };
    await assertFleetProviderAccount(pool, catalog, create('Isa', 'grp.isa', 'humanizar-pool'));
    await expect(assertFleetProviderAccount(pool, catalog, create('PraxisTeam', 'company-team', 'humanizar-pool')))
      .rejects.toMatchObject({ code: 'forbidden' });
  });
  it('lists and changes installation hosts only as the legacy company hub', async () => {
    await requireHubControl(pool, principal('Steven'));
    await expect(requireHubControl(pool, principal('PraxisHub'))).rejects.toBeInstanceOf(AuthorizationError);
  });
});
