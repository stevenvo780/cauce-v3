import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PRAXIS_OWNER_EMAIL, seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let people: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
  people = await seedCompanyIsolation(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function inTransaction<T>(work: (client: DatabaseClient) => Promise<T>): Promise<T> {
  return withTransaction(pool, work);
}
async function admins(company: string): Promise<{ human_id: string; role: string; source: string }[]> {
  return (await pool.query<{ human_id: string; role: string; source: string }>(
    'SELECT human_id::text,role,source FROM company_admins WHERE company_id=$1 ORDER BY role,human_id', [company])).rows;
}
async function operator(email: string, tenant: string, alias: string): Promise<string> {
  return (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$1,$2,$1,'operator',$3,$4) RETURNING id::text`, [email, '$scrypt$' + 'x'.repeat(48), tenant, alias])).rows[0]?.id ?? '';
}
// Every function of 053 and 054, none of which PUBLIC may execute.
const companyFunctions = ['cauce_platform_operator', 'cauce_fill_company', 'cauce_fill_company_from_human', 'cauce_company_immutable',
  'cauce_tenants_company_admission', 'cauce_assert_company_reachable', 'cauce_pair_company_guard', 'cauce_fill_host_company',
  'cauce_register_placed_host', 'cauce_fill_operation_company', 'cauce_config_revision_scope', 'cauce_config_revision_company',
  'cauce_append_only', 'cauce_quota_company_guard', 'cauce_platform_plane_guard', 'cauce_lock_owner_guard',
  'cauce_company_owner_continuity', 'cauce_console_users_owner_guard', 'cauce_company_authority', 'cauce_platform_record',
  'cauce_platform_assert_admin', 'cauce_platform_admins_journal', 'cauce_platform_create_company',
  'cauce_platform_set_company_state', 'cauce_platform_link', 'cauce_platform_unlink', 'cauce_platform_grant_admin',
  'cauce_platform_revoke_admin', 'cauce_role_template_company_guard'];
async function role(name: string): Promise<void> {
  await pool.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='${name}') THEN CREATE ROLE ${name} NOLOGIN; END IF; END $$`);
}

describe('company owners and the platform plane on PostgreSQL', () => {
  it('commits a new company only together with an active owner', async () => {
    await expect(pool.query("INSERT INTO companies(id,name) VALUES('ownerless','Ownerless')")).rejects.toMatchObject({ code: '23514' });
    await inTransaction(async (client) => {
      await client.query("SELECT cauce_platform_create_company('acme',' Acme ',$1)", [people.steven]);
      await client.query("INSERT INTO tenants(id,company_id,is_hub) VALUES('AcmeHub','acme',true)");
      const owner = (await client.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
        VALUES('owner@acme.test','owner@acme.test',$1,'Owner','operator','AcmeHub','owner') RETURNING id::text`, ['$scrypt$' + 'x'.repeat(48)])).rows[0]?.id;
      await client.query("SELECT cauce_platform_grant_admin('acme',$1,' OWNER@acme.test ','owner',$2)", [owner, people.steven]);
    });
    expect((await pool.query("SELECT name FROM companies WHERE id='acme'")).rows).toEqual([{ name: 'Acme' }]);
    expect((await pool.query(`SELECT action,company_id,actor_human_id::text FROM platform_authority_events
      WHERE company_id='acme' ORDER BY id`)).rows).toEqual([
      { action: 'company.create', company_id: 'acme', actor_human_id: people.steven },
      { action: 'admin.grant', company_id: 'acme', actor_human_id: people.steven },
    ]);
    expect((await pool.query("SELECT action FROM audit_events WHERE company_id='acme' AND actor_human_id=$1 ORDER BY id", [people.steven])).rows)
      .toEqual([{ action: 'platform.company.create' }, { action: 'platform.admin.grant' }]);
  });

  it('never lets a company with owners commit without an active one', async () => {
    await inTransaction(client => client.query("SELECT cauce_platform_revoke_admin('humanizar',$1,$2)", [people.miguel, people.steven]));
    await expect(inTransaction(client => client.query("SELECT cauce_platform_revoke_admin('humanizar',$1,$2)", [people.steven, people.steven])))
      .rejects.toMatchObject({ code: '23514' });
    await expect(inTransaction(client => client.query("UPDATE company_admins SET role='admin' WHERE company_id='praxis'")))
      .rejects.toMatchObject({ code: '23514' });
    await inTransaction(async (client) => {
      await client.query("SELECT cauce_platform_grant_admin('humanizar',$1,'miguel@example.test','owner',$2)", [people.miguel, people.steven]);
      await client.query("SELECT cauce_platform_revoke_admin('humanizar',$1,$2)", [people.steven, people.steven]);
    });
    expect(await admins('humanizar')).toEqual([{ human_id: people.miguel, role: 'owner', source: 'platform' }]);
  });

  it('keeps the last active owner and the last platform administrator as active operators', async () => {
    await pool.query("UPDATE console_users SET display_name='Renamed' WHERE id=$1", [people.leon]);
    for (const change of ['active=false', "role='reader'"]) {
      await expect(pool.query(`UPDATE console_users SET ${change} WHERE id=$1`, [people.leon])).rejects.toMatchObject({ code: '23514' });
    }
    await pool.query('UPDATE console_users SET active=false WHERE id=$1', [people.miguel]);
    await expect(pool.query('UPDATE console_users SET active=false WHERE id=$1', [people.steven])).rejects.toMatchObject({ code: '23514' });
    await pool.query('UPDATE console_users SET active=true WHERE id=$1', [people.miguel]);
    await pool.query('DELETE FROM company_admins WHERE company_id=$1 AND human_id=$2', ['humanizar', people.steven]);
    await expect(pool.query('UPDATE console_users SET active=false WHERE id=$1', [people.steven])).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query('DELETE FROM console_users WHERE id=$1', [people.miguel])).rejects.toMatchObject({ code: '23503' });
  });

  it('grants only the exact confirmed operator of the company and only to an active platform administrator', async () => {
    const grant = (human: string, email: string, company = 'praxis', admin = people.steven, grantedRole = 'admin'): Promise<unknown> =>
      inTransaction(client => client.query('SELECT cauce_platform_grant_admin($1,$2,$3,$4,$5)', [company, human, email, grantedRole, admin]));
    const teammate = await operator('teammate@praxis.test', 'PraxisTeam', 'team_agent');
    await expect(grant(teammate, 'other@praxis.test')).rejects.toMatchObject({ code: '22023' });
    await expect(grant(people.miguel, 'miguel@example.test')).rejects.toMatchObject({ code: '22023' });
    await expect(grant(teammate, 'teammate@praxis.test', 'praxis', people.miguel)).rejects.toMatchObject({ code: '42501' });
    await expect(grant(teammate, 'teammate@praxis.test', 'praxis', people.steven, 'superuser')).rejects.toMatchObject({ code: '22023' });
    await expect(grant(teammate, 'teammate@praxis.test', 'missing')).rejects.toMatchObject({ code: 'P0002' });
    await grant(teammate, 'teammate@praxis.test');
    await grant(teammate, 'teammate@praxis.test', 'praxis', people.steven, 'owner');
    expect(await admins('praxis')).toEqual([{ human_id: people.leon, role: 'owner', source: 'import' },
      { human_id: teammate, role: 'owner', source: 'platform' }].sort((left, right) => left.human_id.localeCompare(right.human_id)));
    expect((await pool.query(`SELECT metadata FROM platform_authority_events WHERE subject_human_id=$1 ORDER BY id`, [teammate])).rows)
      .toEqual([{ metadata: { role: 'admin' } }, { metadata: { role: 'owner', previous_role: 'admin' } }]);
    await pool.query("UPDATE console_users SET role='reader' WHERE id=$1", [people.leon]);
    await expect(grant(people.leon, PRAXIS_OWNER_EMAIL, 'praxis', people.steven, 'owner')).rejects.toMatchObject({ code: '22023' });
  });

  it('changes company state and links only through the platform with canonical, journaled rows', async () => {
    await inTransaction(client => client.query("SELECT cauce_platform_link('praxis','humanizar',$1)", [people.steven]));
    expect((await pool.query('SELECT company_a,company_b FROM company_links')).rows).toEqual([{ company_a: 'humanizar', company_b: 'praxis' }]);
    await inTransaction(client => client.query("SELECT cauce_platform_unlink('praxis','humanizar',$1)", [people.steven]));
    await expect(inTransaction(client => client.query("SELECT cauce_platform_unlink('praxis','humanizar',$1)", [people.steven])))
      .rejects.toMatchObject({ code: 'P0002' });
    await inTransaction(client => client.query("SELECT cauce_platform_set_company_state('praxis','retired',$1)", [people.steven]));
    expect((await pool.query("SELECT enabled,retired_at IS NOT NULL AS retired,version FROM companies WHERE id='praxis'")).rows)
      .toEqual([{ enabled: false, retired: true, version: '2' }]);
    await expect(pool.query("INSERT INTO tenants(id,company_id) VALUES('RetiredTeam','praxis')")).rejects.toMatchObject({ code: '23514' });
    await inTransaction(client => client.query("SELECT cauce_platform_set_company_state('praxis','enabled',$1)", [people.steven]));
    expect((await pool.query(`SELECT action,company_id,peer_company_id,metadata FROM platform_authority_events
      WHERE action LIKE 'company.%' ORDER BY id`)).rows).toEqual([
      { action: 'company.link', company_id: 'humanizar', peer_company_id: 'praxis', metadata: {} },
      { action: 'company.unlink', company_id: 'humanizar', peer_company_id: 'praxis', metadata: {} },
      { action: 'company.state', company_id: 'praxis', peer_company_id: null, metadata: { state: 'retired', previous_state: 'enabled' } },
      { action: 'company.state', company_id: 'praxis', peer_company_id: null, metadata: { state: 'enabled', previous_state: 'retired' } },
    ]);
    await expect(pool.query("UPDATE platform_authority_events SET metadata='{}'")).rejects.toMatchObject({ code: '23514' });
  });

  it('journals superuser changes to the platform administrators', async () => {
    await pool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [people.miguel]);
    await pool.query('DELETE FROM platform_admins WHERE human_id=$1', [people.miguel]);
    expect((await pool.query(`SELECT action,subject_human_id::text,actor_human_id,database_role=session_user AS journaled
      FROM platform_authority_events WHERE subject_human_id=$1 ORDER BY id`, [people.miguel])).rows).toEqual([
      { action: 'platform_admin.grant', subject_human_id: people.miguel, actor_human_id: null, journaled: true },
      { action: 'platform_admin.revoke', subject_human_id: people.miguel, actor_human_id: null, journaled: true },
    ]);
  });

  it('resolves locked authority facts for the home company or a requested one', async () => {
    const authority = async (human: string, company: string | null): Promise<unknown[]> => inTransaction(async client =>
      (await client.query<Record<string, unknown>>('SELECT * FROM cauce_company_authority($1,$2)', [human, company])).rows);
    expect(await authority(people.steven, null)).toEqual([{ home_company: 'humanizar', platform_admin: true, company_role: 'owner', company_enabled: true }]);
    expect(await authority(people.steven, 'praxis')).toEqual([{ home_company: 'humanizar', platform_admin: true, company_role: null, company_enabled: true }]);
    expect(await authority(people.leon, null)).toEqual([{ home_company: 'praxis', platform_admin: false, company_role: 'owner', company_enabled: true }]);
    expect(await authority(people.miguel, 'missing')).toEqual([{ home_company: 'humanizar', platform_admin: false, company_role: null, company_enabled: false }]);
    expect(await authority(randomUUID(), null)).toEqual([]);
  });

  it('refuses platform writes from any role outside the platform even with a mistaken grant', async () => {
    await role('cauce_company_test_runtime');
    await pool.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON companies,company_links,platform_admins,company_admins,platform_authority_events,
      company_system_principals,company_agent_roles,agent_role_template_owners TO cauce_company_test_runtime`);
    await pool.query('GRANT EXECUTE ON FUNCTION cauce_platform_operator() TO cauce_company_test_runtime');
    for (const statement of ["INSERT INTO companies(id,name) VALUES('rogue','Rogue')", 'DELETE FROM company_links',
      `INSERT INTO platform_admins(human_id) VALUES('${people.miguel}')`, "UPDATE company_admins SET role='owner'",
      "DELETE FROM platform_authority_events", "DELETE FROM company_agent_roles", "DELETE FROM company_system_principals",
      "DELETE FROM agent_role_template_owners"]) {
      await expect(inTransaction(async (client) => {
        await client.query('SET LOCAL ROLE cauce_company_test_runtime');
        await client.query(statement);
      })).rejects.toMatchObject({ code: '42501', message: expect.stringMatching(/writable only by the platform role/u) as unknown });
    }
  });

  it('grants the runtime read-only authority tables and only the resolver functions', async () => {
    await role('cauce_runtime'); await role('cauce_platform');
    if (!database) throw new Error('test database absent');
    const provisioned = await startTestCaseDatabase(database);
    try {
      const privileges = (await provisioned.pool.query<Record<string, unknown>>(`SELECT
        has_table_privilege('cauce_runtime','company_admins','SELECT') AS read_admins,
        has_table_privilege('cauce_runtime','company_admins','INSERT') AS write_admins,
        has_table_privilege('cauce_runtime','company_system_principals','UPDATE') AS write_principals,
        has_table_privilege('cauce_runtime','platform_authority_events','SELECT') AS read_events,
        has_function_privilege('cauce_runtime','cauce_company_authority(uuid,text)','EXECUTE') AS resolve,
        has_function_privilege('cauce_runtime','cauce_platform_grant_admin(text,uuid,text,text,uuid)','EXECUTE') AS grant_admin,
        has_function_privilege('cauce_platform','cauce_platform_grant_admin(text,uuid,text,text,uuid)','EXECUTE') AS platform_grant,
        has_table_privilege('cauce_platform','company_admins','INSERT') AS platform_write,
        has_function_privilege('cauce_runtime','cauce_platform_operator()','EXECUTE')
          AND has_function_privilege('cauce_runtime','cauce_assert_company_reachable(text,text)','EXECUTE')
          AND has_function_privilege('cauce_runtime','cauce_config_revision_scope(jsonb)','EXECUTE') AS guard_helpers,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=ANY($1::text[])) AS company_functions,
        (SELECT count(*)::int FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
          WHERE n.nspname='public' AND p.proname=ANY($1::text[])
            AND (p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) entry WHERE entry.grantee=0))) AS public_functions`,
      [companyFunctions])).rows[0];
      expect(privileges).toEqual({ read_admins: true, write_admins: false, write_principals: false, read_events: true,
        resolve: true, grant_admin: false, platform_grant: true, platform_write: true, guard_helpers: true,
        company_functions: companyFunctions.length, public_functions: 0 });
    } finally { await provisioned.close(); }
  });

  it('reserves owned role templates to their company', async () => {
    await pool.query(`INSERT INTO agent_role_templates(slug,display_name,brief) VALUES('praxis-clinic','Praxis clinic','Clinic brief'),
      ('shared-brief','Shared','Shared brief')`);
    await pool.query("INSERT INTO agent_role_template_owners(slug,company_id) VALUES('praxis-clinic','praxis')");
    await expect(pool.query(`UPDATE agents SET role_brief='Clinic brief',role_template_slug='praxis-clinic'
      WHERE tenant_id='Steven' AND alias='kant'`)).rejects.toMatchObject({ code: '23514' });
    await pool.query(`UPDATE agents SET role_brief='Clinic brief',role_template_slug='praxis-clinic' WHERE tenant_id='PraxisTeam'`);
    await pool.query(`UPDATE agents SET role_brief='Shared brief',role_template_slug='shared-brief' WHERE tenant_id='Steven' AND alias='kant'`);
    await expect(pool.query("INSERT INTO agent_role_template_owners(slug,company_id) VALUES('shared-brief','praxis')")).rejects.toMatchObject({ code: '23514' });
  });

  it('keeps reserved principals and well-known roles inside their company', async () => {
    await pool.query(`INSERT INTO company_system_principals(company_id,kind,tenant_id,room_id,actor_alias,principal_alias)
      VALUES('praxis','gate_probe','PraxisHub','company-praxis','company_admin','gate-probe')`);
    await expect(pool.query(`INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias)
      VALUES('praxis','gate_probe','PraxisTeam','gate-probe')`)).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query(`INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias)
      VALUES('praxis','director','Steven','argos')`)).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(`INSERT INTO company_system_principals(company_id,kind,tenant_id,room_id,principal_alias)
      VALUES('praxis','human_receipt','PraxisHub','company-team','operador')`)).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query(`INSERT INTO company_system_principals(company_id,kind,tenant_id,actor_alias,principal_alias,recipient_alias,notify_handle)
      VALUES('praxis','supervision_notice','PraxisHub','company_admin','supervisor','company_admin','steven_dm')`)).rejects.toMatchObject({ code: '23503' });
    await pool.query("INSERT INTO company_agent_roles(company_id,role,tenant_id,alias) VALUES('praxis','coordination','PraxisHub','company_admin')");
    await expect(pool.query("INSERT INTO company_agent_roles(company_id,role,tenant_id,alias) VALUES('praxis','coordination','PraxisTeam','team_agent')"))
      .rejects.toMatchObject({ code: '23505' });
    await pool.query("INSERT INTO company_agent_roles(company_id,role,tenant_id,alias) VALUES('praxis','reviewer','PraxisTeam','team_agent')");
    await expect(pool.query("INSERT INTO company_agent_roles(company_id,role,tenant_id,alias) VALUES('humanizar','reviewer','PraxisTeam','team_agent')"))
      .rejects.toMatchObject({ code: '23503' });
  });
});
