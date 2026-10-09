import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withTransaction, type DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { probeCompanyIsolationPath } from '../../../services/gateway/src/health/schema-companies.js';
import { linkCompanies, seedCompanyFanin, seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

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

async function company(sql: string, params: unknown[] = []): Promise<unknown> {
  return (await pool.query<{ company_id: unknown }>(sql, params)).rows[0]?.company_id;
}
function rejects(sql: string, code: string, params: unknown[] = []): Promise<void> {
  return expect(pool.query(sql, params)).rejects.toMatchObject({ code });
}
function handoffSql(from: string, fromAlias: string, to: string, toAlias: string): string {
  return `INSERT INTO secret_handoffs(id,from_tenant,from_alias,to_tenant,to_alias,label,sealed,sealing_key_id,ephemeral_public,nonce,
    expires_at) VALUES('${randomUUID()}','${from}','${fromAlias}','${to}','${toAlias}','company secret','\\x00','key',
    decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),now()+interval '1 hour')`;
}
async function handoff(from: string, fromAlias: string, to: string, toAlias: string): Promise<unknown> {
  return pool.query(handoffSql(from, fromAlias, to, toAlias));
}
async function notice(parent: string, child: string): Promise<unknown> {
  return pool.query(`INSERT INTO agent_failure_notices(root_message_id,parent_tenant,parent_alias,child_tenant,child_alias,
    failure_signature,window_expires_at) VALUES($1,$2,'kant',$3,'company_admin','company',now()+interval '1 hour')`, [randomUUID(), parent, child]);
}

const writer = 'cauce_company_test_writer';
/** A writer outside the platform role with the grants the runtime holds on the guarded paths, plus TEMP. */
async function grantWriter(): Promise<void> {
  await pool.query(`DO $$ BEGIN CREATE ROLE ${writer} NOLOGIN; EXCEPTION WHEN duplicate_object OR unique_violation THEN NULL; END $$`);
  await pool.query(`DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO ${writer}',current_database()); END $$`);
  await pool.query(`GRANT SELECT,UPDATE ON console_users TO ${writer}`);
  await pool.query(`GRANT SELECT ON tenants,companies,company_links,platform_admins,company_admins TO ${writer}`);
  await pool.query(`GRANT SELECT,INSERT ON config_revisions,secret_handoffs TO ${writer}`);
  await pool.query(`GRANT USAGE ON SEQUENCE config_revisions_id_seq TO ${writer}`);
  await pool.query(`GRANT EXECUTE ON FUNCTION cauce_platform_operator(),cauce_assert_company_reachable(text,text),
    cauce_config_revision_scope(jsonb),cauce_lock_company_link(text,text),cauce_lock_owner_guard(text) TO ${writer}`);
}
/** Runs the statements as the writer and rolls back: the rows of the last one, or the SQLSTATE that stopped them. */
async function asWriter(...statements: string[]): Promise<unknown> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN'); await client.query(`SET LOCAL ROLE ${writer}`);
    let rows: unknown[] = [];
    for (const statement of statements) rows = (await client.query(statement)).rows;
    return rows;
  } catch (error) {
    return (error as { code?: unknown }).code;
  } finally { await client.query('ROLLBACK'); client.release(); }
}

describe('company isolation enforced by PostgreSQL', () => {
  it('derives the company of every owned row from its tenant, payer, collector, person or target', async () => {
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('derived-room','PraxisTeam')");
    expect(await company("SELECT company_id FROM rooms WHERE id='derived-room'")).toBe('praxis');
    expect(await company("SELECT company_id FROM agents WHERE tenant_id='PraxisTeam'")).toBe('praxis');
    expect(await company('SELECT company_id FROM console_users WHERE id=$1', [people.miguel])).toBe('humanizar');
    expect(await company("SELECT company_id FROM provider_accounts WHERE id='praxis-account'")).toBe('praxis');
    expect(await company('SELECT company_id FROM human_tenant_memberships WHERE human_id=$1', [people.miguel])).toBe('humanizar');
    await pool.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('PraxisTeam','team_agent','praxis-account','PraxisHub','PraxisHub')`);
    await pool.query("INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority) VALUES('PraxisTeam','team_agent','praxis-account',0)");
    await pool.query("INSERT INTO console_agent_favorites(human_id,tenant_id,alias) VALUES($1,'Miguel','janus')", [people.miguel]);
    await pool.query(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,captured_at,account_id)
      VALUES('PraxisHub','shared-quota','codex','plan','5h',now(),'praxis-account')`);
    expect(await company('SELECT company_id FROM alias_routing_ceiling')).toBe('praxis');
    expect(await company('SELECT company_id FROM agent_account_bindings')).toBe('praxis');
    expect(await company('SELECT company_id FROM console_agent_favorites')).toBe('humanizar');
    expect(await company('SELECT company_id FROM quota_window_state')).toBe('praxis');
    const operation = (target: Record<string, unknown>, key: string) => pool.query(`INSERT INTO fleet_operations(actor_tenant,actor_alias,
      target,target_key,cohort_key,executor_host,kind,request,request_hash,idempotency_key,expected_revision)
      VALUES('PraxisHub','company_admin',$1::jsonb,$2,$2,'praxis-host','stop','{}',repeat('a',64),$2,0) RETURNING company_id`,
    [JSON.stringify(target), key]);
    expect((await operation({ resource: 'agent', tenant_id: 'PraxisTeam', alias: 'team_agent' }, 'company-target')).rows)
      .toEqual([{ company_id: 'praxis' }]);
    expect((await operation({}, 'company-actor')).rows).toEqual([{ company_id: 'praxis' }]);
  });

  it('rejects accounts, ceilings, bindings and primary accounts that belong to another company', async () => {
    await rejects("UPDATE agents SET primary_account_id='humanizar-account' WHERE tenant_id='PraxisHub'", '23503');
    await rejects(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('PraxisHub','company_admin','humanizar-account','Steven','PraxisHub')`, '23503');
    await pool.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('Steven','kant','humanizar-account','Steven','Steven')`);
    await rejects("INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,company_id) VALUES('Steven','kant','humanizar-account',0,'praxis')", '23503');
    await rejects(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,captured_at,account_id)
      VALUES('PraxisHub','shared-quota','codex','plan','5h',now(),'humanizar-account')`, '23503');
    await rejects(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,company_id)
      VALUES('misfiled','codex','misfiled','Steven','env_path','CAUCE_TEST_MISFILED_PATH','praxis')`, '23503');
  });

  it('places an agent only on a host of its own company', async () => {
    await rejects("UPDATE agents SET host_id='praxis-host' WHERE tenant_id='Steven' AND alias='kant'", '23503');
    await rejects(`INSERT INTO agents(tenant_id,alias,container_name,runtime_user,home_directory,state_directory,host_id)
      VALUES('PraxisTeam','foreign_host','shared-runtime','dev','/home/dev','/home/dev/.cauce','humanizar-host')`, '23503');
    await rejects("UPDATE agents SET host_id='unregistered-host' WHERE tenant_id='PraxisTeam'", '23503');
    expect((await pool.query("SELECT 1 FROM fleet_hosts WHERE host_id='unregistered-host'")).rowCount).toBe(0);
    await pool.query("UPDATE agents SET host_id='praxis-host' WHERE tenant_id='PraxisTeam'");
    expect((await pool.query("SELECT host_id,container_name FROM agents WHERE tenant_id IN ('Steven','PraxisHub') AND host_id IS NOT NULL ORDER BY tenant_id,alias")).rows)
      .toEqual([{ host_id: 'praxis-host', container_name: 'shared-runtime' }, { host_id: 'humanizar-host', container_name: 'shared-runtime' },
        { host_id: 'humanizar-host', container_name: 'shared-runtime' }]);
  });

  it('keeps memberships, favorites and administrators inside the company of the person', async () => {
    await rejects(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read'])`, '23503', [people.miguel]);
    await rejects("INSERT INTO console_agent_favorites(human_id,tenant_id,alias) VALUES($1,'PraxisHub','company_admin')", '23503', [people.miguel]);
    await rejects("INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('praxis',$1,'admin','platform',$2)",
      '23503', [people.miguel, people.steven]);
    await rejects("UPDATE console_users SET tenant_id='PraxisHub' WHERE id=$1", '23503', [people.miguel]);
  });

  it('refuses to move any owned row to another company with UPDATE', async () => {
    const moves: readonly (readonly [string, string, string])[] = [['tenants', "id='PraxisTeam'", 'humanizar'],
      ['rooms', "id='company-team'", 'humanizar'], ['agents', "tenant_id='PraxisTeam'", 'humanizar'],
      ['console_users', `id='${people.leon}'`, 'humanizar'], ['provider_accounts', "id='praxis-account'", 'humanizar'],
      ['fleet_hosts', "host_id='praxis-host'", 'humanizar'], ['human_tenant_memberships', `human_id='${people.miguel}'`, 'praxis']];
    for (const [table, predicate, target] of moves) {
      await rejects(`UPDATE ${table} SET company_id='${target}' WHERE ${predicate}`, '23514');
    }
    await pool.query("INSERT INTO tenants(id,company_id) VALUES('Misplaced','praxis')");
    const hatch = (tenant: string): Promise<unknown> => withTransaction(pool, async (client) => {
      await client.query("SET LOCAL cauce.company_move='on'");
      await client.query("UPDATE tenants SET company_id='humanizar' WHERE id=$1", [tenant]);
    });
    await expect(hatch('PraxisTeam')).rejects.toMatchObject({ code: '23503' });
    await hatch('Misplaced');
    expect(await company("SELECT company_id FROM tenants WHERE id='Misplaced'")).toBe('humanizar');
  });

  it('admits cross-company pairs only through an explicit link', async () => {
    await rejects("SELECT cauce_assert_company_reachable('Steven','PraxisHub')", '23514');
    await expect(handoff('Steven', 'kant', 'PraxisHub', 'company_admin')).rejects.toMatchObject({ code: '23514' });
    await expect(notice('Steven', 'PraxisHub')).rejects.toMatchObject({ code: '23514' });
    await handoff('Steven', 'kant', 'Isa', 'salva'); await notice('Steven', 'Isa'); await notice('Retired', 'PraxisHub');
    await linkCompanies(pool);
    await handoff('Steven', 'kant', 'PraxisHub', 'company_admin'); await notice('Steven', 'PraxisHub');
    const root = await seedCompanyFanin(pool);
    const delivery = (await pool.query<{ id: string }>(`SELECT delivery.id FROM deliveries delivery JOIN messages message ON message.id=delivery.message_id
      WHERE delivery.recipient_tenant='PraxisHub' AND message.body->>'text'='Company branch'`)).rows[0]?.id;
    await pool.query(`INSERT INTO blobs(sha256,bytes,media_type,name,tenant_id,created_by) VALUES(repeat('b',64),1,'text/plain','company.txt','Steven','kant')`);
    const grant = (): Promise<unknown> => pool.query(`INSERT INTO blob_delivery_grants(delivery_id,sha256,owner_tenant_id,source_tenant_id,
      source_alias,target_tenant_id,target_alias) VALUES($1,repeat('b',64),'Steven','Steven','kant','PraxisHub','company_admin')`, [delivery]);
    await grant(); await pool.query('DELETE FROM blob_delivery_grants');
    await pool.query('DELETE FROM company_links');
    await expect(grant()).rejects.toMatchObject({ code: '23514' });
    await expect(handoff('PraxisHub', 'company_admin', 'Steven', 'kant')).rejects.toMatchObject({ code: '23514' });
    await rejects(`INSERT INTO agent_output_materializations(source_delivery_id,source_attempt,output_index,source_message_id,source_tenant,
      source_alias,target_tenant,target_alias,target_ref_hash,body_hash,status,rejection_code,request_id,trace_id,hop_count,hop_budget,correlation)
      SELECT source_delivery_id,source_attempt,1,source_message_id,source_tenant,source_alias,target_tenant,target_alias,target_ref_hash,
        body_hash,'rejected','unroutable_alias',request_id,trace_id,hop_count,hop_budget,correlation FROM agent_output_materializations
      WHERE correlation->>'root_message_id'=$1`, '23514', [root]);
  });

  it('binds every quota sample to an account of its collector company', async () => {
    const collection = async (tenant: string): Promise<string> => (await pool.query<{ id: string }>(
      "SELECT id::text FROM quota_collections WHERE collector_tenant=$1", [tenant])).rows[0]?.id ?? '';
    const sample = (id: string, account: string, window: string): Promise<unknown> => pool.query(`INSERT INTO quota_window_samples(
      collection_id,provider,group_key,window_key,host,captured_at,account_id,used_percent)
      VALUES($1,'codex','plan',$3,'shared-quota',now(),$2,10)`, [id, account, window]);
    const praxis = await collection('PraxisHub');
    await expect(sample(praxis, 'humanizar-account', '5h')).rejects.toMatchObject({ code: '23514' });
    await sample(praxis, 'praxis-account', '5h');
    await sample(await collection('Steven'), 'humanizar-account', '5h');
    await rejects("UPDATE quota_collections SET collector_tenant='Steven' WHERE id=$1", '23514', [praxis]);
    await rejects("UPDATE quota_window_samples SET account_id='humanizar-account' WHERE collection_id=$1", '23514', [praxis]);
  });

  it('scopes room ids to their company', async () => {
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('grp.steven','PraxisTeam')");
    await rejects("INSERT INTO rooms(id,tenant_id) VALUES('grp.steven','Isa')", '23505');
    await rejects("INSERT INTO rooms(id,tenant_id) VALUES('company-team','PraxisHub')", '23505');
    await rejects(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES($1,'company-room','Isa','grp.steven','salva','{}','batch')`, '23503', [randomUUID()]);
  });

  it('admits tenants only into an enabled company and hosts only with an unambiguous company', async () => {
    await pool.query("UPDATE companies SET enabled=false WHERE id='praxis'");
    await rejects("INSERT INTO tenants(id,company_id) VALUES('LateTeam','praxis')", '23514');
    await rejects("INSERT INTO fleet_hosts(host_id,display_name) VALUES('ambiguous-host','Ambiguous')", '23502');
    await pool.query(`INSERT INTO fleet_hosts(host_id,display_name,controller_status,controller_seen_at) VALUES('praxis-host','praxis-host','reachable',now())
      ON CONFLICT (host_id) DO UPDATE SET controller_status=EXCLUDED.controller_status`);
    expect((await pool.query("SELECT company_id,controller_status FROM fleet_hosts WHERE host_id='praxis-host'")).rows)
      .toEqual([{ company_id: 'praxis', controller_status: 'reachable' }]);
  });

  it('keeps configuration revisions append-only and scoped to a company or the platform', async () => {
    const revision = (actor: string, operation: Record<string, unknown>, extra = ''): Promise<{ rows: Record<string, unknown>[] }> => pool.query(
      `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary${extra === '' ? '' : ',company_id,platform_override,actor_human_id'})
       VALUES($1,'company_admin',$2::jsonb,'{}','company'${extra}) RETURNING scope,company_id`, [actor, JSON.stringify(operation)]);
    expect((await revision('PraxisHub', { resource: 'room' })).rows).toEqual([{ scope: 'company', company_id: 'praxis' }]);
    expect((await revision('Steven', { resource: 'batch', mutations: [{ resource: 'harness' }, { resource: 'role_policy' }] })).rows)
      .toEqual([{ scope: 'platform', company_id: null }]);
    expect((await revision('Steven', { resource: 'batch', mutations: [{ resource: 'harness' }, { resource: 'room' }] })).rows)
      .toEqual([{ scope: 'company', company_id: 'humanizar' }]);
    await expect(revision('Steven', { resource: 'room' }, ",'praxis',false,NULL")).rejects.toMatchObject({ code: '23514' });
    await expect(revision('Steven', { resource: 'room' }, `,'praxis',true,'${people.miguel}'`)).rejects.toMatchObject({ code: '23514' });
    expect((await revision('Steven', { resource: 'room' }, `,'praxis',true,'${people.steven}'`)).rows)
      .toEqual([{ scope: 'company', company_id: 'praxis' }]);
    await rejects("UPDATE config_revisions SET summary='rewritten'", '23514');
    await rejects('DELETE FROM config_revisions', '23514');
  });

  it('derives the revision scope from the operation and keeps a rollback inside it', async () => {
    const insert = (actor: string, operation: Record<string, unknown>, columns = '', values = ''): Promise<{ rows: { id: string }[] }> => pool.query(
      `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary${columns})
       VALUES($1,'company_admin',$2::jsonb,'{}','scoped'${values}) RETURNING id::text`, [actor, JSON.stringify(operation)]);
    await expect(insert('PraxisHub', { resource: 'room' }, ',scope', ",'platform'")).rejects.toMatchObject({ code: '23514' });
    await expect(insert('Steven', { resource: 'harness' }, ',scope', ",'company'")).rejects.toMatchObject({ code: '23514' });
    const room = (await insert('Steven', { resource: 'room' }, ',scope', ",'company'")).rows[0]?.id;
    await expect(insert('PraxisHub', { resource: 'room' }, ',rolled_back_revision_id', `,${room ?? ''}`)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('Steven', { resource: 'harness' }, ',rolled_back_revision_id', `,${room ?? ''}`)).rejects.toMatchObject({ code: '23514' });
    await insert('Steven', { resource: 'room' }, ',rolled_back_revision_id', `,${room ?? ''}`);
  });

  it('requires an active platform administrator for a platform revision written outside the platform role', async () => {
    await grantWriter();
    const chain = (admin: string): string => `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary,actor_human_id)
      VALUES('PraxisHub','company_admin','{"resource":"chain_policy"}','{}','chain',${admin}) RETURNING scope,company_id`;
    expect(await asWriter(chain('NULL'))).toBe('23514');
    expect(await asWriter(chain(`'${people.leon}'`))).toBe('23514');
    expect(await asWriter(chain(`'${people.steven}'`))).toEqual([{ scope: 'platform', company_id: null }]);
  });

  it('keeps every guard when the writer shadows the tables and catalogs it reads with temporary ones', async () => {
    await grantWriter();
    const fake = randomUUID();
    expect(await asWriter('CREATE TEMP TABLE company_admins(company_id text,human_id uuid,role text)',
      `UPDATE console_users SET active=false WHERE id='${people.leon}'`)).toBe('23514');
    expect(await asWriter('CREATE TEMP TABLE platform_admins(human_id uuid)',
      `UPDATE console_users SET active=false WHERE id='${people.steven}'`)).toBe('23514');
    expect(await asWriter('CREATE TEMP TABLE platform_admins(human_id uuid)', `INSERT INTO pg_temp.platform_admins VALUES('${fake}')`,
      `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary,company_id,platform_override,actor_human_id)
       VALUES('PraxisHub','company_admin','{"resource":"room"}','{}','override','humanizar',true,'${fake}')`)).toBe('23514');
    expect(await asWriter('CREATE TEMP TABLE tenants(id text,company_id text)',
      "INSERT INTO pg_temp.tenants VALUES('Steven','shared'),('PraxisHub','shared')",
      handoffSql('Steven', 'kant', 'PraxisHub', 'company_admin'))).toBe('23514');
    expect(await asWriter('CREATE TEMP TABLE pg_roles(rolname name,rolsuper boolean)',
      'INSERT INTO pg_temp.pg_roles VALUES(current_user,true)', 'SELECT cauce_platform_operator() AS platform')).toEqual([{ platform: false }]);
  });

  it('proves the company schema contract for readiness and fails closed on a paused guard', async () => {
    await expect(probeCompanyIsolationPath(pool)).resolves.toBeUndefined();
    await pool.query('ALTER TABLE agents DISABLE TRIGGER agents_company_immutable');
    await expect(probeCompanyIsolationPath(pool)).rejects.toThrow(/schema-054 company isolation/u);
    await pool.query('ALTER TABLE agents ENABLE TRIGGER agents_company_immutable');
    await pool.query('ALTER FUNCTION cauce_fill_company() RESET search_path');
    await expect(probeCompanyIsolationPath(pool)).rejects.toThrow(/schema-054 company isolation/u);
    await pool.query('ALTER FUNCTION cauce_fill_company() SET search_path=pg_catalog,public,pg_temp');
    await expect(probeCompanyIsolationPath(pool)).resolves.toBeUndefined();
    await pool.query(`DROP TRIGGER company_links_platform_write ON company_links;
      CREATE TRIGGER company_links_platform_write BEFORE INSERT ON company_links FOR EACH STATEMENT EXECUTE FUNCTION cauce_append_only()`);
    await expect(probeCompanyIsolationPath(pool)).rejects.toThrow(/schema-054 company isolation/u);
    await pool.query(`DROP TRIGGER company_links_platform_write ON company_links;
      CREATE TRIGGER company_links_platform_write BEFORE INSERT OR UPDATE OR DELETE OR TRUNCATE ON company_links
        FOR EACH STATEMENT EXECUTE FUNCTION cauce_platform_write_guard()`);
    await expect(probeCompanyIsolationPath(pool)).resolves.toBeUndefined();
    await pool.query('ALTER TABLE agents DROP CONSTRAINT agents_host_company_fkey');
    await expect(probeCompanyIsolationPath(pool)).rejects.toThrow(/schema-054 company isolation/u);
  });
});
