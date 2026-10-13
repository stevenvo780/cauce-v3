import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  applyMigrations, applyMigrationsThrough, ConfigurationRepository, inspectMigrationIntegrity,
  lockAgentContextSnapshot, lockCompanyAuthority, migrationSourcesForApply, recordFleetHostStatus, withTransaction, type DatabasePool,
} from '../src/index.js';
import { applyPlatformConfiguration } from '../src/configuration-platform.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const isolation = '053_company_isolation.sql';
const admins = '054_company_admins.sql';
// The columns 053 adds; every other column of a legacy table must survive unchanged.
const added: Readonly<Record<string, readonly string[]>> = {
  ...Object.fromEntries(['rooms', 'console_users', 'agents', 'provider_accounts', 'alias_routing_ceiling', 'agent_account_bindings',
    'quota_window_state', 'console_agent_favorites', 'human_tenant_memberships', 'fleet_hosts', 'fleet_operations',
  ].map((table): [string, string[]] => [table, ['company_id']])),
  config_revisions: ['scope', 'company_id', 'actor_human_id', 'platform_override'], audit_events: ['company_id', 'actor_human_id'],
};
const paused = ['cauce_oauth_membership_revision', 'human_membership_preserved', 'agents_role_brief_journal',
  'agent_runtime_key_reservation', 'agents_role_template_coherence', 'fleet_operations_history'];
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabaseThrough('051_companies.sql');
}, 120_000);
beforeEach(async () => {
  if (!database) return;
  current = await startTestCaseDatabase(database); pool = current.pool;
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function down(version: string): Promise<void> {
  await pool.query(await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'));
}
/** The migration bundled right before 053: the state its down files must restore exactly. */
async function predecessor(): Promise<string> {
  const versions = (await migrationSourcesForApply()).map(source => source.version);
  const previous = versions[versions.indexOf(isolation) - 1];
  if (previous === undefined) throw new Error('053 has no predecessor');
  return previous;
}
async function applied(version: string): Promise<boolean> {
  return ((await pool.query('SELECT 1 FROM schema_migrations WHERE version=$1', [version])).rowCount ?? 0) > 0;
}

interface ProductionShape { kant: string; zeus: string; miguel: string }

/** A 051 database shaped like production: one company, people administrators kant and zeus. */
async function productionShape(): Promise<ProductionShape> {
  const sql = async (text: string, params: unknown[] = []): Promise<void> => { await pool.query(text, params); };
  await sql("INSERT INTO agent_role_templates(slug,display_name,brief) VALUES('humanizar-ops','Ops','Ops brief')");
  await sql("INSERT INTO fleet_hosts(host_id,display_name) VALUES('kratos','Kratos'),('spare','Spare')");
  await sql("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','grp.steven','zeus','operator')");
  // V4.0 also placed agents on approved hosts it never registered, like salva on 'approved'.
  for (const [tenant, alias, host] of [['Steven', 'kant', 'kratos'], ['Steven', 'zeus', 'kratos'], ['Steven', 'argos', 'kratos'],
    ['Miguel', 'janus', 'kratos'], ['Isa', 'salva', 'approved']]) {
    await sql(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,container_name,runtime_user,home_directory,state_directory,host_id,
      runtime_key,lifecycle_state,role_brief,role_template_slug) VALUES($1,$2,true,'codex',$2,'dev','/home/dev',$3,$4,$2,'ready',
      CASE WHEN $2='kant' THEN 'Ops brief' END,CASE WHEN $2='kant' THEN 'humanizar-ops' END)`,
    [tenant, alias, `/home/dev/.cauce/${alias ?? ''}`, host]);
  }
  await sql(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,shared_with_pool,enabled)
    VALUES('codex-main','codex','main','Steven','env_path','CAUCE_CODEX_MAIN_PATH',true,true)`);
  await sql("UPDATE agents SET primary_account_id='codex-main' WHERE tenant_id='Steven' AND alias='kant'");
  await sql(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
    VALUES('Steven','kant','codex-main','Steven','Steven'),('Miguel','janus','codex-main','Steven','Steven')`);
  await sql(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
    VALUES('Steven','kant','codex-main',0,true),('Miguel','janus','codex-main',0,true)`);
  const collection = (await pool.query<{ id: string }>(`INSERT INTO quota_collections(host,collector_tenant,collector_alias,captured_at,schema_version)
    VALUES('kratos','Steven','kant',now(),1) RETURNING id::text`)).rows[0]?.id;
  await sql(`INSERT INTO quota_window_samples(collection_id,provider,group_key,window_key,host,captured_at,account_id,used_percent)
    VALUES($1,'codex','plan','5h','kratos',now(),'codex-main',12)`, [collection]);
  await sql(`INSERT INTO quota_window_state(collector_tenant,host,provider,group_key,window_key,collection_id,captured_at,account_id,used_percent)
    VALUES('Steven','kratos','codex','plan','5h',$1,now(),'codex-main',12)`, [collection]);
  const person = async (email: string, tenant: string, alias: string, role = 'operator'): Promise<string> => {
    const id = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES($1,$1,$2,$1,$5,$3,$4) RETURNING id::text`, [email, '$scrypt$' + 'x'.repeat(48), tenant, alias, role])).rows[0]?.id ?? '';
    await sql(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,$2,$3,$4,CASE WHEN $4='operator' THEN ARRAY['read','control'] ELSE ARRAY['read'] END)`, [id, tenant, alias, role]);
    return id;
  };
  const kant = await person('steven@example.test', 'Steven', 'kant');
  const zeus = await person('zeus@example.test', 'Steven', 'zeus');
  const miguel = await person('miguel@example.test', 'Miguel', 'janus');
  await person('reader@example.test', 'Isa', 'salva', 'reader');
  await sql("UPDATE human_tenant_memberships SET permissions=ARRAY['read','control','route'] WHERE human_id=$1", [zeus]);
  await sql('INSERT INTO platform_admins(human_id) VALUES($1)', [kant]);
  await sql("INSERT INTO console_agent_favorites(human_id,tenant_id,alias) VALUES($1,'Miguel','janus')", [kant]);
  await sql(`INSERT INTO fleet_operations(actor_tenant,actor_alias,target,target_key,cohort_key,executor_host,kind,request,request_hash,
    idempotency_key,expected_revision) VALUES('Steven','kant','{"resource":"agent","tenant_id":"Miguel","alias":"janus"}',
    'agent:Miguel:janus','kratos:dev','kratos','stop','{}',repeat('a',64),'production-shape',0)`);
  for (const operation of [{ resource: 'room' }, { resource: 'harness', id: 'codex' },
    { resource: 'batch', mutations: [{ resource: 'role_policy' }, { resource: 'chain_policy' }] }, { legacy: true }]) {
    await sql(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES('Steven','kant',$1::jsonb,'{}','production shape')`, [JSON.stringify(operation)]);
  }
  const message = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
    VALUES($1,'production-shape','Steven','grp.steven','kant','{"text":"baseline"}','interactive') RETURNING id::text`, [randomUUID()])).rows[0]?.id;
  await sql("INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,'Miguel','janus')", [message]);
  await sql("INSERT INTO audit_events(tenant_id,actor_alias,action,decision) VALUES('Steven','kant','company.baseline','allow')");
  await sql(`INSERT INTO agent_failure_notices(root_message_id,parent_tenant,parent_alias,child_tenant,child_alias,failure_signature,window_expires_at)
    VALUES($1,'Steven','kant','Miguel','janus','shape',now()+interval '1 hour'),($2,'Retired','kant','Steven','argos','shape',now()+interval '1 hour')`,
  [randomUUID(), randomUUID()]);
  await sql(`INSERT INTO secret_handoffs(id,from_tenant,from_alias,to_tenant,to_alias,label,sealed,sealing_key_id,ephemeral_public,nonce,expires_at)
    VALUES($1,'Steven','kant','Miguel','janus','shape','\\x00','key',decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),now()+interval '1 hour')`,
  [randomUUID()]);
  return { kant, zeus, miguel };
}

/** Every legacy row without the columns 053 adds; hosts the backfill registered are left out. */
async function snapshot(tables: readonly string[]): Promise<Record<string, unknown>> {
  const data: Record<string, unknown> = {};
  for (const table of tables) {
    if (!/^[a-z][a-z0-9_]*$/u.test(table)) throw new Error('unexpected table identifier');
    const registered = table === 'fleet_hosts' ? "WHERE entry.host_id<>'approved'" : '';
    data[table] = (await pool.query<{ data: unknown }>(`SELECT COALESCE(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) AS data
      FROM (SELECT to_jsonb(entry)-$1::text[] AS value FROM ${table} entry ${registered}) rows`, [added[table] ?? []])).rows[0]?.data;
  }
  return data;
}
async function legacyTables(): Promise<string[]> {
  return (await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('schema_migrations','schema_migration_ledger','schema_migration_verifications') ORDER BY tablename`)).rows
    .map(row => row.tablename);
}
async function schema(): Promise<Record<string, unknown>> {
  const read = async (sql: string): Promise<unknown> => (await pool.query(sql)).rows;
  return {
    functions: await read(`SELECT p.proname,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS acl FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1,2`),
    triggers: await read(`SELECT pg_get_triggerdef(t.oid) AS definition,t.tgenabled FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1`),
    indexes: await read("SELECT indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1"),
    constraints: await read(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition,convalidated
      FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`),
    columns: await read(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' ORDER BY 1,2`),
    tables: await read("SELECT tablename FROM pg_tables WHERE schemaname='public' ORDER BY 1"),
  };
}
async function contextDigest(): Promise<string> {
  return withTransaction(pool, async client => (await lockAgentContextSnapshot(client, 'Steven', 'kant')).agentSha256);
}

describe('company isolation and owner migrations from a production-shaped 051 database', () => {
  it('preserves every legacy row and authority input across up, down and reapply', async () => {
    const people = await productionShape();
    await applyMigrationsThrough(pool, await predecessor());
    const tables = await legacyTables();
    const before = await snapshot(tables); const structure = await schema(); const digest = await contextDigest();
    await applyMigrationsThrough(pool, admins);
    expect(await snapshot(tables)).toEqual(before);
    expect(await contextDigest()).toBe(digest);
    expect((await pool.query("SELECT host_id,display_name,company_id FROM fleet_hosts WHERE host_id='approved'")).rows)
      .toEqual([{ host_id: 'approved', display_name: 'approved', company_id: 'humanizar' }]);
    expect((await pool.query(`SELECT host_id FROM agents WHERE host_id IS NOT NULL
      EXCEPT SELECT host_id FROM fleet_hosts`)).rowCount).toBe(0);
    await withTransaction(pool, client => inspectMigrationIntegrity(client));
    expect((await pool.query(`SELECT tgname,tgenabled FROM pg_trigger WHERE tgname=ANY($1::text[]) ORDER BY tgname`, [paused])).rows)
      .toEqual([...paused].sort().map(tgname => ({ tgname, tgenabled: 'O' })));
    for (const table of ['rooms', 'console_users', 'agents', 'provider_accounts', 'alias_routing_ceiling', 'agent_account_bindings',
      'quota_window_state', 'console_agent_favorites', 'human_tenant_memberships', 'fleet_hosts', 'fleet_operations']) {
      expect((await pool.query(`SELECT DISTINCT company_id FROM ${table}`)).rows, table).toEqual([{ company_id: 'humanizar' }]);
    }
    expect((await pool.query(`SELECT operation->>'resource' AS resource,scope,company_id FROM config_revisions ORDER BY id`)).rows).toEqual([
      { resource: 'room', scope: 'company', company_id: 'humanizar' }, { resource: 'harness', scope: 'platform', company_id: null },
      { resource: 'batch', scope: 'platform', company_id: null }, { resource: null, scope: 'company', company_id: 'humanizar' }]);
    expect((await pool.query('SELECT company_id,human_id::text,role,source,granted_by FROM company_admins ORDER BY human_id')).rows)
      .toEqual([people.kant, people.zeus].sort().map(human_id => ({ company_id: 'humanizar', human_id, role: 'admin',
        source: 'v4.0-hub-operator', granted_by: null })));
    expect((await pool.query(`SELECT kind,tenant_id,room_id,actor_alias,principal_alias FROM company_system_principals ORDER BY kind`)).rows)
      .toEqual([{ kind: 'director', tenant_id: 'Steven', room_id: null, actor_alias: null, principal_alias: 'argos' },
        { kind: 'gate_probe', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant', principal_alias: 'gate-probe' }]);
    expect((await pool.query('SELECT role,tenant_id,alias FROM company_agent_roles ORDER BY role')).rows)
      .toEqual([{ role: 'coordination', tenant_id: 'Steven', alias: 'kant' }, { role: 'infra_escalation', tenant_id: 'Steven', alias: 'zeus' }]);
    await down(admins); await down(isolation);
    expect(await snapshot(tables)).toEqual(before);
    expect(await schema()).toEqual(structure);
    expect((await pool.query("SELECT host_id FROM fleet_hosts WHERE host_id='approved'")).rowCount).toBe(1);
    expect(await applied(isolation) || await applied(admins)).toBe(false);
    expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=ANY($1::text[])', [[isolation, admins]])).rowCount).toBe(0);
    await applyMigrationsThrough(pool, admins);
    expect(await snapshot(tables)).toEqual(before);
  });

  it('refuses lossy downgrades once owners, history or a second company exist', async () => {
    const people = await productionShape();
    await applyMigrationsThrough(pool, admins);
    await expect(down(isolation)).rejects.toThrow(/later migration/u);
    await pool.query("INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias) VALUES('humanizar','director','Steven','zeus')");
    await expect(down(admins)).rejects.toThrow(/preserves company authority/u);
    await pool.query("DELETE FROM company_system_principals WHERE principal_alias='zeus'");
    await withTransaction(pool, client => client.query(
      "SELECT cauce_platform_grant_admin('humanizar',$1,'miguel@example.test','owner',$2)", [people.miguel, people.kant]));
    await expect(down(admins)).rejects.toThrow(/preserves company authority/u);
    expect(await applied(admins)).toBe(true);
  });

  it('refuses to drop isolation while two companies or repeated room ids exist', async () => {
    await applyMigrationsThrough(pool, isolation);
    await pool.query("INSERT INTO companies(id,name) VALUES('praxis','Praxis')");
    await pool.query("INSERT INTO tenants(id,company_id,is_hub) VALUES('PraxisHub','praxis',true)");
    await pool.query("INSERT INTO rooms(id,tenant_id) VALUES('grp.steven','PraxisHub')");
    await expect(down(isolation)).rejects.toThrow(/preserves company isolation/u);
    expect(await applied(isolation)).toBe(true);
  });

  it('takes its table locks first and fails fast behind a long reader', async () => {
    await applyMigrationsThrough(pool, await predecessor());
    const reader = await pool.connect();
    try {
      await reader.query('BEGIN'); await reader.query('SELECT count(*) FROM tenants');
      const started = Date.now();
      const attempt = applyMigrationsThrough(pool, isolation).then(() => undefined, (error: unknown) => error);
      await expect.poll(async () => (await pool.query<{ relation: string; mode: string; granted: boolean }>(`SELECT relation::regclass::text AS relation,mode,granted
        FROM pg_locks WHERE locktype='relation' AND NOT granted AND pid IN (SELECT pid FROM pg_stat_activity
          WHERE wait_event_type='Lock' AND pid<>pg_backend_pid())`)).rows, { timeout: 4000 })
        .toEqual([{ relation: 'tenants', mode: 'AccessExclusiveLock', granted: false }]);
      expect(await attempt).toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally { await reader.query('ROLLBACK'); reader.release(); }
    expect(await applied(isolation)).toBe(false);
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('lock_timeout','1234ms',true)");
      await client.query("SELECT set_config('statement_timeout','54321ms',true)");
      for (const version of [isolation, admins]) {
        await client.query(await readFile(new URL(`../migrations/${version}`, import.meta.url), 'utf8'));
      }
      expect((await client.query("SELECT current_setting('lock_timeout') AS locks,current_setting('statement_timeout') AS statements"))
        .rows).toEqual([{ locks: '1234ms', statements: '54321ms' }]);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });

  it('bounds the whole lock phase even when every single wait stays under lock_timeout', async () => {
    await applyMigrationsThrough(pool, await predecessor());
    const holders = await Promise.all([pool.connect(), pool.connect()]);
    const [tenants, rooms] = holders;
    try {
      await tenants.query('BEGIN'); await tenants.query('SELECT count(*) FROM tenants');
      await rooms.query('BEGIN'); await rooms.query('SELECT count(*) FROM rooms');
      const started = Date.now();
      const attempt = applyMigrationsThrough(pool, isolation).then(() => undefined, (error: unknown) => error);
      // tenants is released after 3 s, so the wait for rooms starts with tenants already held exclusively.
      setTimeout(() => { void tenants.query('ROLLBACK'); }, 3_000);
      expect(await attempt).toMatchObject({ code: '57014' });
      expect(Date.now() - started).toBeLessThan(8_000);
    } finally {
      await Promise.all(holders.map(async holder => { await holder.query('ROLLBACK'); holder.release(); }));
    }
    expect(await applied(isolation)).toBe(false);
  });

  it('refuses a host that already carries agents of two companies', async () => {
    await productionShape();
    await pool.query("INSERT INTO companies(id,name) VALUES('praxis','Praxis')");
    await pool.query("INSERT INTO tenants(id,company_id,is_hub) VALUES('PraxisHub','praxis',true)");
    await pool.query(`INSERT INTO agents(tenant_id,alias,container_name,runtime_user,home_directory,state_directory,host_id)
      VALUES('PraxisHub','operador','operador','dev','/home/dev','/home/dev/.cauce/operador','kratos')`);
    await expect(applyMigrationsThrough(pool, admins)).rejects.toMatchObject({ code: '23514' });
    expect(await applied(isolation)).toBe(false);
    await pool.query("UPDATE agents SET host_id=NULL WHERE tenant_id='PraxisHub'");
    await expect(applyMigrationsThrough(pool, admins)).rejects.toMatchObject({ code: '23502' });
    await pool.query("DELETE FROM fleet_hosts WHERE host_id='spare'");
    await applyMigrationsThrough(pool, admins);
    expect(await applied(admins)).toBe(true);
  });

  it('keeps legacy runtime writes working after upgrading to the current schema with durable human authority', async () => {
    const people = await productionShape();
    await applyMigrations(pool);
    const repository = new ConfigurationRepository(pool);
    const created = await repository.apply('Steven', 'kant', { resource: 'batch', action: 'apply', mutations: [
      { resource: 'tenant', action: 'create', id: 'LegacyTeam', value: { display_name: 'Legacy' } },
      { resource: 'room', action: 'create', tenant_id: 'LegacyTeam', id: 'legacy-room', value: {} },
    ] }, false, undefined, client => lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: people.kant }));
    await applyPlatformConfiguration(pool, { tenant: 'Steven', alias: 'kant', humanId: people.kant, companyId: 'humanizar' },
      { resource: 'harness', action: 'update', id: 'codex', value: { display_name: 'Codex' } }, false, created.revision);
    expect((await pool.query(`SELECT scope,company_id FROM config_revisions WHERE id>=$1 ORDER BY id`, [created.revision])).rows)
      .toEqual([{ scope: 'company', company_id: 'humanizar' }, { scope: 'platform', company_id: null }]);
    expect((await pool.query("SELECT company_id FROM rooms WHERE id='legacy-room'")).rows).toEqual([{ company_id: 'humanizar' }]);
    await pool.query("INSERT INTO fleet_hosts(host_id,display_name,notes) VALUES('legacy-host','Legacy host','')");
    await recordFleetHostStatus(pool, 'kratos', 'reachable');
    await recordFleetHostStatus(pool, 'reported-host', 'reachable');
    await pool.query("UPDATE agents SET host_id='placed-host' WHERE tenant_id='Isa' AND alias='salva'");
    expect((await pool.query(`SELECT host_id,company_id FROM fleet_hosts WHERE host_id IN ('legacy-host','placed-host','reported-host')
      ORDER BY 1`)).rows).toEqual(['legacy-host', 'placed-host', 'reported-host'].map(host_id => ({ host_id, company_id: 'humanizar' })));
    const person = (await pool.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
      VALUES('legacy@example.test','legacy@example.test',$1,'Legacy','operator','Isa','salva') RETURNING id::text`, ['$scrypt$' + 'x'.repeat(48)])).rows[0]?.id;
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias) VALUES($1,'Isa','salva')`, [person]);
    await pool.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read','control'] WHERE human_id=$1", [person]);
    expect((await pool.query('SELECT company_id,revision FROM human_tenant_memberships WHERE human_id=$1', [person])).rows)
      .toEqual([{ company_id: 'humanizar', revision: '2' }]);
  });
});
