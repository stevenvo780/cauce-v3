import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrations, CauceRepository, ConfigurationRepository, createPool, lockCompanyAuthority, registerCompany, withTransaction,
  type CompanyAuthoritySource, type DatabasePool, type RegisteredCompany } from '../src/index.js';
import { ContextVersionStore, readContextVersion } from '../src/context-version.js';
import { esBaseDePruebas, provisionTestLogin, startTestCaseDatabase, startTestDatabase, TEST_RUNTIME_LOGIN,
  type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { DeliveryContextRuntimeSink } from '../../../services/gateway/src/context-version-runtime.js';
import { preparePostgresSuite } from './postgres-suite.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let company: RegisteredCompany;
const hash = '$scrypt$n=32768,r=8,p=1$c2FsdA==$aGFzaA==';
preparePostgresSuite(import.meta.url, async () => {
  if (!process.env.CAUCE_TEST_DATABASE_URL) database = await startTestDatabase();
}, 120_000);

async function exclusiveCase(): Promise<EmptyTestDatabase> {
  const external = process.env.CAUCE_TEST_ADMIN_DATABASE_URL ?? process.env.CAUCE_TEST_DATABASE_URL;
  if (!external) {
    if (!database) throw new Error('test database unavailable');
    return startTestCaseDatabase(database);
  }
  if (!esBaseDePruebas(external)) throw new Error('disposable test database required');
  const server = createPool(external);
  const name = `cauce_test_registration_context_${randomUUID().replaceAll('-', '')}`;
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

beforeEach(async () => {
  current = await exclusiveCase(); pool = current.pool; admin = current.adminPool;
  company = await registerCompany(pool, { email: 'registered@example.test', name: 'Registered owner', passwordHash: hash,
    company: { slug: 'registered', name: 'Registered company' } });
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const source = (value = company): CompanyAuthoritySource => client => lockCompanyAuthority(client,
  { tenant: value.hub.id, alias: value.user.username, humanId: value.user.id });
async function migration(down = false): Promise<void> {
  const sql = await readFile(new URL(`../migrations/${down ? 'down/' : ''}063_company_registration_director.sql`, import.meta.url), 'utf8');
  await withTransaction(admin, client => client.query(sql));
}
async function context() {
  const store = new ContextVersionStore(pool);
  await store.write(source(), company.hub.id, company.user.username,
    { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: 'Registered company context.' }] });
  return withTransaction(pool, client => readContextVersion(client,
    { company_id: company.company.id, tenant_id: company.hub.id, alias: company.user.username }, 1));
}

describe('registered company context director', () => {
  it('publishes a durable context delivery and keeps application pending without a consumed turn', async () => {
    expect((await pool.query("SELECT pg_has_role(current_user,'cauce_runtime','MEMBER') AS runtime")).rows[0]).toEqual({ runtime: true });
    const store = new ContextVersionStore(pool); const version = await context(); expect(version.version).toBe(1);
    const runtime = new DeliveryContextRuntimeSink(pool, 50);
    await expect(runtime.apply(version)).rejects.toThrow('consumed-turn evidence');
    await expect(runtime.apply(version)).rejects.toThrow('consumed-turn evidence');
    const deliveries = await pool.query(`SELECT message.actor_alias,delivery.recipient_tenant,delivery.recipient_alias,delivery.status
      FROM messages message JOIN deliveries delivery ON delivery.message_id=message.id WHERE message.auth_channel='context-broker'`);
    expect(deliveries.rows).toEqual([{ actor_alias: 'context-director', recipient_tenant: company.hub.id,
      recipient_alias: company.user.username, status: 'pending' }]);
    expect((await store.read(source(), company.hub.id, company.user.username)).applied_version).toBe(0);
    expect((await admin.query('SELECT applied_at FROM agent_context_outbox WHERE company_id=$1', [company.company.id])).rows)
      .toEqual([{ applied_at: null }]);
  });

  it('creates a route-only source separately from the owner without runtime, readiness, sessions or credentials', async () => {
    const broker = (await pool.query(`SELECT principal.kind,principal.delivery_source_only,agent.enabled,agent.lifecycle_state,
      agent.harness_id,agent.container_name,agent.runtime_key,agent.host_id,agent.runtime_mode,agent.primary_account_id
      FROM company_system_principals principal JOIN agents agent ON agent.tenant_id=principal.tenant_id AND agent.alias=principal.principal_alias
      WHERE principal.company_id=$1`, [company.company.id])).rows;
    expect(broker).toEqual([{ kind: 'director', delivery_source_only: true, enabled: false, lifecycle_state: 'draft',
      harness_id: null, container_name: null, runtime_key: null, host_id: null, runtime_mode: null, primary_account_id: null }]);
    expect(await new CauceRepository(pool).principalAccess(company.hub.id, 'context-director'))
      .toEqual({ roles: ['context_broker'], permissions: ['route'] });
    expect(await withTransaction(pool, source())).toMatchObject({ role: 'company_owner', humanId: company.user.id });
    expect(await withTransaction(pool, client => lockCompanyAuthority(client, { tenant: company.hub.id, alias: 'context-director' })))
      .toMatchObject({ role: 'none', humanId: null });
    for (const table of ['console_users','human_tenant_memberships','connection_leases','agent_sealing_keys']) {
      const aliasColumn = table === 'human_tenant_memberships' ? 'actor_alias' : 'alias';
      expect((await pool.query(`SELECT 1 FROM ${table} WHERE tenant_id=$1 AND ${aliasColumn}='context-director'`, [company.hub.id])).rows).toEqual([]);
    }
    expect((await pool.query('SELECT 1 FROM platform_admins WHERE human_id=$1', [company.user.id])).rows).toEqual([]);
  });

  it('keeps the base and bootstrap private and restores exact grants through replay', async () => {
    const signatures = ['cauce_register_company_without_director(text,text,text,text,text)', 'cauce_register_company_director(text,text)'];
    for (const signature of signatures) {
      expect((await admin.query(`SELECT has_function_privilege('cauce_runtime',$1,'EXECUTE') AS runtime,
        has_function_privilege('cauce_observer',$1,'EXECUTE') AS observer,
        NOT EXISTS(SELECT 1 FROM pg_proc routine,LATERAL aclexplode(COALESCE(routine.proacl,acldefault('f',routine.proowner))) permission
          WHERE routine.oid=$1::regprocedure AND permission.grantee=0 AND permission.privilege_type='EXECUTE') AS public_revoked`, [signature])).rows)
        .toEqual([{ runtime: false, observer: false, public_revoked: true }]);
    }
    await expect(pool.query('SELECT cauce_register_company_director($1,$2)', [company.company.id, company.hub.id])).rejects.toMatchObject({ code: '42501' });
    await expect(pool.query('SELECT * FROM cauce_register_company_without_director($1,$2,$3,$4,$5)',
      ['bypass@example.test','Bypass',hash,'bypass','Bypass'])).rejects.toMatchObject({ code: '42501' });
    await admin.query('REVOKE EXECUTE ON FUNCTION cauce_register_company(text,text,text,text,text) FROM cauce_runtime');
    await expect(registerCompany(pool, { email: 'replay@example.test', name: 'Replay', passwordHash: hash,
      company: { slug: 'replay', name: 'Replay' } })).rejects.toMatchObject({ code: '42501' });
    await admin.query('SELECT cauce_apply_runtime_grants()');
    expect((await registerCompany(pool, { email: 'replay@example.test', name: 'Replay', passwordHash: hash,
      company: { slug: 'replay', name: 'Replay' } })).company.id).toBe('replay');
    expect((await admin.query(`SELECT prosecdef,proconfig FROM pg_proc WHERE oid='cauce_register_company(text,text,text,text,text)'::regprocedure`)).rows)
      .toEqual([{ prosecdef: true, proconfig: ['search_path=pg_catalog, public, pg_temp'] }]);
  });

  it('rejects runtime flag writes and configuration changes to the broker', async () => {
    await expect(pool.query('UPDATE company_system_principals SET delivery_source_only=false WHERE company_id=$1', [company.company.id]))
      .rejects.toMatchObject({ code: '42501' });
    await expect(admin.query(`INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias,delivery_source_only)
      VALUES($1,'human_receipt',$2,'owner',true)`, [company.company.id, company.hub.id])).rejects.toMatchObject({ code: '23514' });
    const repository = new ConfigurationRepository(pool);
    await expect(repository.apply(company.hub.id, company.user.username,
      { resource: 'agent', action: 'update', tenant_id: company.hub.id, alias: 'context-director', value: { display_name: 'Changed' } },
      false, 0, source())).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.apply(company.hub.id, company.user.username,
      { resource: 'membership', action: 'update', tenant_id: company.hub.id, room_id: 'office', alias: 'context-director', value: { role: 'operator' } },
      false, 0, source())).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query('SELECT 1 FROM config_revisions WHERE company_id=$1', [company.company.id])).rows).toEqual([]);
    expect((await pool.query("SELECT display_name FROM agents WHERE tenant_id=$1 AND alias='context-director'", [company.hub.id])).rows)
      .toEqual([{ display_name: 'Company context broker' }]);
  });

  it('rejects use of the source as a recipient or delivery consumer atomically', async () => {
    const repository = new CauceRepository(pool);
    await expect(repository.publish({ version: '3.0', request_id: randomUUID(), trace_id: 'broker-recipient',
      tenant_id: company.hub.id, room_id: 'office', actor_alias: company.user.username,
      recipients: [{ tenant_id: company.hub.id, alias: 'context-director' }], idempotency_key: 'broker-recipient', lane: 'interactive', priority: 0,
      body: { type: 'command', text: 'This source must never consume a turn.' } })).rejects.toMatchObject({ code: '42501' });
    await expect(repository.acquireLease(company.hub.id, 'context-director', 'forbidden-consumer', [], 60_000))
      .rejects.toMatchObject({ code: '42501' });
    expect((await pool.query("SELECT 1 FROM messages WHERE trace_id='broker-recipient'")).rows).toEqual([]);
    expect((await pool.query("SELECT 1 FROM connection_leases WHERE tenant_id=$1 AND alias='context-director'", [company.hub.id])).rows).toEqual([]);
  });

  it('isolates context authority and never borrows a source from another company', async () => {
    const other = await registerCompany(pool, { email: 'other@example.test', name: 'Other', passwordHash: hash,
      company: { slug: 'other', name: 'Other' } });
    await expect(new ContextVersionStore(pool).write(source(), other.hub.id, other.user.username,
      { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: 'Foreign context.' }] })).rejects.toMatchObject({ code: 'not_found' });
    const version = await context();
    await expect(new DeliveryContextRuntimeSink(pool, 50).apply({ ...version, company_id: other.company.id })).rejects.toThrow('director is unavailable');
    expect((await pool.query("SELECT 1 FROM messages WHERE auth_channel='context-broker'")).rows).toEqual([]);
    expect((await pool.query('SELECT human_id FROM company_admins WHERE company_id=$1', [other.company.id])).rows).toEqual([{ human_id: other.user.id }]);
  });

  it('reapplies migrations and bootstrap without adding another director or elevating the human', async () => {
    const original = (await pool.query('SELECT * FROM company_system_principals WHERE company_id=$1', [company.company.id])).rows;
    await applyMigrations(admin); await applyMigrations(admin);
    await admin.query('SELECT cauce_register_company_director($1,$2)', [company.company.id, company.hub.id]);
    await admin.query('SELECT cauce_register_company_director($1,$2)', [company.company.id, company.hub.id]);
    expect((await pool.query('SELECT * FROM company_system_principals WHERE company_id=$1', [company.company.id])).rows).toEqual(original);
    await expect(registerCompany(pool, { email: 'registered@example.test', name: 'Retry', passwordHash: hash,
      company: { slug: 'orphan', name: 'Orphan' } })).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query("SELECT 1 FROM companies WHERE id='orphan'")).rows).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS count FROM agents WHERE tenant_id=$1 AND alias LIKE 'context-director%'", [company.hub.id])).rows)
      .toEqual([{ count: 1 }]);
  });

  it('backfills previous registrations without adopting a preexisting alias or replacing a director', async () => {
    await migration(true);
    const previous = await registerCompany(pool, { email: 'previous@example.test', name: 'Previous', passwordHash: hash,
      company: { slug: 'previous', name: 'Previous' } });
    const preserved = await registerCompany(pool, { email: 'preserved@example.test', name: 'Preserved', passwordHash: hash,
      company: { slug: 'preserved', name: 'Preserved' } });
    await admin.query("INSERT INTO agents(tenant_id,alias,display_name) VALUES($1,'context-director','Existing alias')", [previous.hub.id]);
    await admin.query(`INSERT INTO agents(tenant_id,alias,harness_id,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES($1,'existing-director','fake',true,'fixture-existing-director','dev','/home/dev','/home/dev/.cauce')`, [preserved.hub.id]);
    await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,'office','existing-director','agent')", [preserved.hub.id]);
    await admin.query("INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias) VALUES($1,'director',$2,'existing-director')",
      [preserved.company.id, preserved.hub.id]);
    const original = (await pool.query('SELECT kind,tenant_id,principal_alias,created_at FROM company_system_principals WHERE company_id=$1', [preserved.company.id])).rows;
    await migration();
    expect((await pool.query('SELECT principal_alias,delivery_source_only FROM company_system_principals WHERE company_id=$1', [previous.company.id])).rows)
      .toEqual([{ principal_alias: 'context-director-1', delivery_source_only: true }]);
    expect((await pool.query('SELECT display_name,enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [previous.hub.id,'context-director'])).rows)
      .toEqual([{ display_name: 'Existing alias', enabled: false }]);
    expect((await pool.query('SELECT kind,tenant_id,principal_alias,created_at FROM company_system_principals WHERE company_id=$1', [preserved.company.id])).rows)
      .toEqual(original);
    expect((await pool.query("SELECT enabled FROM agents WHERE tenant_id=$1 AND alias='existing-director'", [preserved.hub.id])).rows).toEqual([{ enabled: true }]);
    const store = new ContextVersionStore(pool);
    await store.write(source(preserved), preserved.hub.id, preserved.user.username,
      { expected_version: 0, source: 'ui', files: [{ path: 'context/mission.md', content: 'Preserved director context.' }] });
    const version = await withTransaction(pool, client => readContextVersion(client,
      { company_id: preserved.company.id, tenant_id: preserved.hub.id, alias: preserved.user.username }, 1));
    await expect(new DeliveryContextRuntimeSink(pool, 50).apply(version)).rejects.toThrow('consumed-turn evidence');
    expect((await pool.query("SELECT actor_alias FROM messages WHERE auth_channel='context-broker'")).rows).toEqual([{ actor_alias: 'existing-director' }]);
  });

  it('fails a backfill with no viable company hub and leaves the prior registration contract intact', async () => {
    await migration(true);
    await admin.query('UPDATE tenants SET is_hub=false WHERE id=$1', [company.hub.id]);
    await expect(migration()).rejects.toMatchObject({ code: '22023' });
    expect((await pool.query('SELECT 1 FROM company_system_principals WHERE company_id=$1', [company.company.id])).rows).toEqual([]);
    expect((await pool.query("SELECT count(*)::int AS count FROM information_schema.columns WHERE table_name='company_system_principals' AND column_name='delivery_source_only'")).rows)
      .toEqual([{ count: 0 }]);
    expect((await registerCompany(pool, { email: 'rollback@example.test', name: 'Rollback', passwordHash: hash,
      company: { slug: 'rollback', name: 'Rollback' } })).company.id).toBe('rollback');
  });

  it('downgrades without deleting real messages or deliveries and reapplies the registration contract', async () => {
    const definitions = () => pool.query(`SELECT routine.proname,pg_get_functiondef(routine.oid) AS definition FROM pg_proc routine
      WHERE routine.proname IN ('cauce_register_company','cauce_register_company_without_director','cauce_register_company_director',
        'cauce_context_director_mutation_guard','cauce_context_director_recipient_guard','cauce_runtime_grants_063') ORDER BY routine.proname`);
    const originalDefinitions = (await definitions()).rows;
    await expect(new DeliveryContextRuntimeSink(pool, 50).apply(await context())).rejects.toThrow('consumed-turn evidence');
    const messages = (await pool.query('SELECT id,actor_alias FROM messages ORDER BY id')).rows;
    const deliveries = (await pool.query('SELECT id,message_id,status FROM deliveries ORDER BY id')).rows;
    await migration(true);
    expect((await pool.query('SELECT id,actor_alias FROM messages ORDER BY id')).rows).toEqual(messages);
    expect((await pool.query('SELECT id,message_id,status FROM deliveries ORDER BY id')).rows).toEqual(deliveries);
    expect((await pool.query("SELECT enabled,role FROM memberships WHERE tenant_id=$1 AND alias='context-director'", [company.hub.id])).rows)
      .toEqual([{ enabled: false, role: 'agent' }]);
    await migration();
    expect((await definitions()).rows).toEqual(originalDefinitions);
    expect((await pool.query('SELECT principal_alias FROM company_system_principals WHERE company_id=$1', [company.company.id])).rows)
      .toEqual([{ principal_alias: 'context-director-1' }]);
    expect((await registerCompany(pool, { email: 'after@example.test', name: 'After', passwordHash: hash,
      company: { slug: 'after', name: 'After' } })).company.id).toBe('after');
  });
});
