import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { applyMigrationsThrough, migrationSourcesForApply, type DatabasePool } from '../src/index.js';
import { hubEdgeExistsSql } from '../src/repository/acl-edges.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabaseThrough, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const version = '051_companies.sql';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabaseThrough('050_fleet_hosts.sql');
}, 120_000, ['bundles the company foundation']);
beforeEach(async () => {
  if (!database) return;
  current = await startTestCaseDatabase(database); pool = current.pool;
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

async function down(): Promise<void> {
  await pool.query(await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'));
}
async function company(): Promise<void> {
  await pool.query("INSERT INTO companies(id,name) VALUES('praxis','Praxis')");
  await pool.query("INSERT INTO tenants(id,company_id,is_hub) VALUES('PraxisHub','praxis',true),('PraxisTeam','praxis',false)");
}
async function administrator(): Promise<string> {
  const id = randomUUID();
  await pool.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,'owner@example.test','owner@example.test',$2,'Owner','operator','Steven','kant')`, [id, '$scrypt$' + 'x'.repeat(48)]);
  await pool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [id]);
  return id;
}
async function snapshot(): Promise<Record<string, unknown>> {
  const tables = (await pool.query<{ tablename: string }>(`SELECT tablename FROM pg_tables WHERE schemaname='public'
    AND tablename NOT IN ('schema_migrations','schema_migration_ledger','schema_migration_verifications','companies','platform_admins','company_links')
    ORDER BY tablename`)).rows;
  const data: Record<string, unknown> = {};
  for (const { tablename } of tables) {
    if (!/^[a-z][a-z0-9_]*$/u.test(tablename)) throw new Error('unexpected table identifier');
    const expression = tablename === 'tenants' ? "to_jsonb(entry)-'company_id'" : 'to_jsonb(entry)';
    data[tablename] = (await pool.query<{ data: unknown }>(`SELECT COALESCE(jsonb_agg(value ORDER BY value::text),'[]'::jsonb) AS data
      FROM (SELECT ${expression} AS value FROM ${tablename} entry) rows`)).rows[0]?.data;
  }
  return data;
}

async function schema(): Promise<Record<string, unknown>> {
  const read = async (sql: string): Promise<unknown> => (await pool.query(sql)).rows;
  return {
    functions: await read(`SELECT p.proname,pg_get_functiondef(p.oid) AS definition,p.proacl::text AS acl FROM pg_proc p
      JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public' ORDER BY 1,2`),
    triggers: await read(`SELECT pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND NOT t.tgisinternal ORDER BY 1`),
    indexes: await read("SELECT indexdef FROM pg_indexes WHERE schemaname='public' ORDER BY 1"),
    constraints: await read(`SELECT conrelid::regclass::text AS relation,conname,pg_get_constraintdef(oid) AS definition
      FROM pg_constraint WHERE connamespace='public'::regnamespace ORDER BY 1,2`),
    columns: await read(`SELECT table_name,column_name,data_type,is_nullable,column_default FROM information_schema.columns
      WHERE table_schema='public' ORDER BY 1,2`),
  };
}
async function linkedEdges(): Promise<string> {
  await company();
  const admin = await administrator();
  await pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [admin]);
  await pool.query(`INSERT INTO acl_edges(from_tenant,to_tenant,allow_route,allow_read,allow_control)
    VALUES('Steven','PraxisHub',true,true,true),('PraxisHub','Steven',true,true,true),('PraxisHub','PraxisTeam',true,true,true)`);
  return admin;
}
async function enabledEdges(): Promise<{ from_tenant: string; to_tenant: string; enabled: boolean }[]> {
  return (await pool.query<{ from_tenant: string; to_tenant: string; enabled: boolean }>(`SELECT from_tenant,to_tenant,enabled FROM acl_edges
    WHERE 'praxis' IN (SELECT company_id FROM tenants WHERE id IN (from_tenant,to_tenant)) ORDER BY 1,2`)).rows;
}

describe('company foundation migration on PostgreSQL', () => {
  it('bundles the company foundation', async () => {
    expect((await migrationSourcesForApply()).some(source => source.version === version)).toBe(true);
  });
  it('preserves every legacy row across up, down and reapply on a populated database', async () => {
    const message = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES($1,'company-baseline','Steven','grp.steven','kant','{"text":"baseline"}','interactive') RETURNING id`, [randomUUID()])).rows[0];
    if (!message) throw new Error('message absent');
    await pool.query("INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,'Isa','salva')", [message.id]);
    await pool.query("INSERT INTO audit_events(tenant_id,actor_alias,action,decision) VALUES('Steven','kant','company.baseline','allow')");
    const before = await snapshot(); const structure = await schema();
    await applyMigrationsThrough(pool, version);
    expect(await snapshot()).toEqual(before);
    expect((await pool.query('SELECT DISTINCT company_id FROM tenants')).rows).toEqual([{ company_id: 'humanizar' }]);
    expect((await pool.query('SELECT human_id FROM platform_admins')).rows).toEqual([]);
    expect((await pool.query('SELECT company_a FROM company_links')).rows).toEqual([]);
    await down();
    expect(await snapshot()).toEqual(before);
    expect(await schema()).toEqual(structure);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rowCount).toBe(0);
    expect((await pool.query('SELECT version FROM schema_migration_ledger WHERE version=$1', [version])).rowCount).toBe(0);
    await applyMigrationsThrough(pool, version);
    expect(await snapshot()).toEqual(before);
  });
  it('takes its table locks strongest first and fails fast behind a long reader', async () => {
    const reader = await pool.connect();
    try {
      await reader.query('BEGIN'); await reader.query('SELECT count(*) FROM tenants');
      const started = Date.now();
      const attempt = applyMigrationsThrough(pool, version).then(() => undefined, (error: unknown) => error);
      await expect.poll(async () => (await pool.query<{ relation: string; mode: string; granted: boolean }>(`SELECT relation::regclass::text AS relation,mode,granted
        FROM pg_locks WHERE locktype='relation' AND pid IN (SELECT pid FROM pg_stat_activity WHERE query LIKE '%783_003_051%' AND pid<>pg_backend_pid())
          AND relation::regclass::text IN ('tenants','acl_edges','deliveries','console_users') ORDER BY 1,2`)).rows, { timeout: 4000 })
        .toEqual([{ relation: 'tenants', mode: 'AccessExclusiveLock', granted: false }]);
      expect(await attempt).toMatchObject({ code: '55P03' });
      expect(Date.now() - started).toBeLessThan(15_000);
    } finally { await reader.query('ROLLBACK'); reader.release(); }
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query("SELECT set_config('lock_timeout','1234ms',true)");
      await client.query(await readFile(new URL(`../migrations/${version}`, import.meta.url), 'utf8'));
      expect((await client.query("SELECT current_setting('lock_timeout') AS value")).rows).toEqual([{ value: '1234ms' }]);
    } finally { await client.query('ROLLBACK'); client.release(); }
    await applyMigrationsThrough(pool, version);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rowCount).toBe(1);
  });
  it('allows a hub per company and accepts an omitted company only while Humanizar is the sole company', async () => {
    await applyMigrationsThrough(pool, version);
    await pool.query("INSERT INTO tenants(id) VALUES('LegacyTeam')");
    expect((await pool.query("SELECT company_id FROM tenants WHERE id='LegacyTeam'")).rows).toEqual([{ company_id: 'humanizar' }]);
    await company();
    await expect(pool.query("INSERT INTO tenants(id) VALUES('UnplacedTeam')")).rejects.toMatchObject({ code: '23502' });
    await pool.query("INSERT INTO tenants(id,company_id) VALUES('PlacedTeam','humanizar')");
    await expect(pool.query("INSERT INTO tenants(id,company_id,is_hub) VALUES('OtherHub','praxis',true)")).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query("INSERT INTO tenants(id,company_id) VALUES('Unknown','missing')")).rejects.toMatchObject({ code: '23503' });
    await expect(pool.query("INSERT INTO companies(id,name) VALUES('Bad Slug','Bad')")).rejects.toMatchObject({ code: '23514' });
  });
  it('denies foreign companies by default and admits only linked hub endpoints', async () => {
    await applyMigrationsThrough(pool, version); await company();
    await pool.query("INSERT INTO acl_edges(from_tenant,to_tenant) VALUES('PraxisHub','PraxisTeam')");
    await expect(pool.query("INSERT INTO acl_edges(from_tenant,to_tenant) VALUES('Steven','PraxisHub')")).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO acl_edges(from_tenant,to_tenant) VALUES('Isa','Pablo')")).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [randomUUID()])).rejects.toMatchObject({ code: '23503' });
    const admin = await administrator();
    await pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [admin]);
    await pool.query("INSERT INTO acl_edges(from_tenant,to_tenant) VALUES('Steven','PraxisHub'),('PraxisHub','Steven')");
    await expect(pool.query("INSERT INTO acl_edges(from_tenant,to_tenant) VALUES('Isa','PraxisHub')")).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO acl_edges(from_tenant,to_tenant) VALUES('Steven','PraxisTeam')")).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('praxis','humanizar',$1)", [admin])).rejects.toMatchObject({ code: '23514' });
  });
  it('applies the same default-deny backstop to deliveries without rewriting history', async () => {
    await applyMigrationsThrough(pool, version); await company();
    const message = (await pool.query<{ id: string }>(`INSERT INTO messages(request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
      VALUES($1,'company-delivery','Steven','grp.steven','kant','{}','interactive') RETURNING id`, [randomUUID()])).rows[0];
    if (!message) throw new Error('message absent');
    await expect(pool.query("INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,'PraxisHub','bot')", [message.id])).rejects.toMatchObject({ code: '23514' });
    const admin = await administrator();
    await pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [admin]);
    await pool.query("INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,'PraxisHub','bot')", [message.id]);
    await pool.query('DELETE FROM company_links');
    await expect(pool.query("INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias) VALUES($1,'PraxisHub','other')", [message.id])).rejects.toMatchObject({ code: '23514' });
    expect((await pool.query("SELECT recipient_alias FROM deliveries WHERE message_id=$1", [message.id])).rows).toEqual([{ recipient_alias: 'bot' }]);
  });
  it('rejects hub and company changes that would invalidate existing ACL edges', async () => {
    await applyMigrationsThrough(pool, version); await company();
    await pool.query("INSERT INTO acl_edges(from_tenant,to_tenant) VALUES('PraxisHub','PraxisTeam')");
    await expect(pool.query("UPDATE tenants SET is_hub=false WHERE id='PraxisHub'")).rejects.toMatchObject({ code: '23514' });
    await expect(pool.query("UPDATE tenants SET company_id='humanizar' WHERE id='PraxisTeam'")).rejects.toMatchObject({ code: '23514' });
  });
  it('refuses lossy downgrade and restores the original single-hub and star rules', async () => {
    await applyMigrationsThrough(pool, version); await company();
    await expect(down()).rejects.toThrow(/preserves company/u);
    expect((await pool.query('SELECT version FROM schema_migrations WHERE version=$1', [version])).rowCount).toBe(1);
    await pool.query("DELETE FROM tenants WHERE company_id='praxis'");
    await pool.query("DELETE FROM companies WHERE id='praxis'");
    const admin = await administrator();
    await expect(down()).rejects.toThrow(/preserves company/u);
    await pool.query('DELETE FROM platform_admins WHERE human_id=$1', [admin]);
    await down();
    await expect(pool.query("INSERT INTO tenants(id,is_hub) VALUES('SecondHub',true)")).rejects.toMatchObject({ code: '23505' });
    await expect(pool.query("INSERT INTO acl_edges(from_tenant,to_tenant) VALUES('Isa','Pablo')")).rejects.toMatchObject({ code: '23514' });
  });
  it('withdraws every cross-company edge with its link and requires a link to re-enable one', async () => {
    await applyMigrationsThrough(pool, version); await linkedEdges();
    const control = async (): Promise<unknown> => (await pool.query(
      "SELECT cauce_dlq_can_control_tenant_030('Steven','PraxisHub') AS allowed")).rows;
    expect(await control()).toEqual([{ allowed: true }]);
    await pool.query('DELETE FROM company_links');
    expect(await enabledEdges()).toEqual([
      { from_tenant: 'PraxisHub', to_tenant: 'PraxisTeam', enabled: true },
      { from_tenant: 'PraxisHub', to_tenant: 'Steven', enabled: false },
      { from_tenant: 'Steven', to_tenant: 'PraxisHub', enabled: false },
    ]);
    expect(await control()).toEqual([{ allowed: false }]);
    await expect(pool.query("UPDATE acl_edges SET enabled=true WHERE from_tenant='Steven' AND to_tenant='PraxisHub'"))
      .rejects.toMatchObject({ code: '23514' });
    await pool.query("UPDATE acl_edges SET allow_read=false WHERE from_tenant='Steven' AND to_tenant='PraxisHub'");
  });
  it('withdraws edges when the links are truncated and keeps the DLQ rule within one company', async () => {
    await applyMigrationsThrough(pool, version); const admin = await linkedEdges();
    await pool.query("UPDATE acl_edges SET enabled=false WHERE from_tenant='Steven' AND to_tenant='PraxisHub'");
    await pool.query("UPDATE acl_edges SET enabled=true WHERE from_tenant='Steven' AND to_tenant='PraxisHub'");
    await pool.query('TRUNCATE company_links');
    expect((await enabledEdges()).filter(edge => edge.enabled)).toEqual([{ from_tenant: 'PraxisHub', to_tenant: 'PraxisTeam', enabled: true }]);
    await pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [admin]);
    expect((await enabledEdges()).filter(edge => edge.enabled)).toHaveLength(1);
    expect((await pool.query(`SELECT cauce_dlq_can_control_tenant_030('PraxisHub','PraxisTeam') AS own,
      cauce_dlq_can_control_tenant_030('Steven','Isa') AS legacy`)).rows).toEqual([{ own: true, legacy: true }]);
  });
  it('grants a provisioned least-privilege role read-only access to company authority', async () => {
    await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cauce_gateway') THEN CREATE ROLE cauce_gateway; END IF; END $$");
    await applyMigrationsThrough(pool, version);
    const privileges = (await pool.query<Record<string, boolean>>(`SELECT has_table_privilege('cauce_gateway','companies','SELECT') AS companies,
      has_table_privilege('cauce_gateway','platform_admins','SELECT') AS admins,
      has_table_privilege('cauce_gateway','company_links','SELECT') AS links,
      has_table_privilege('cauce_gateway','platform_admins','INSERT') AS create_admin,
      has_table_privilege('cauce_gateway','company_links','INSERT') AS create_link`)).rows[0];
    expect(privileges).toEqual({ companies: true, admins: true, links: true, create_admin: false, create_link: false });
  });
  it('runs the trigger backstop for a role that may only read tenants', async () => {
    await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cauce_gateway') THEN CREATE ROLE cauce_gateway; END IF; END $$");
    await applyMigrationsThrough(pool, version);
    await pool.query('GRANT SELECT ON tenants TO cauce_gateway');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE cauce_gateway');
      await client.query("SELECT cauce_assert_hub_star('Steven','Isa')");
      await client.query('SAVEPOINT star');
      await expect(client.query("SELECT cauce_assert_hub_star('Isa','Pablo')")).rejects.toMatchObject({ code: '23514' });
      await client.query('ROLLBACK TO SAVEPOINT star');
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
  it('allows linked hub checks under a provisioned least-privilege role', async () => {
    await pool.query("DO $$ BEGIN IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname='cauce_gateway') THEN CREATE ROLE cauce_gateway; END IF; END $$");
    await applyMigrationsThrough(pool, version); await company();
    const admin = await administrator();
    await pool.query("INSERT INTO company_links(company_a,company_b,created_by) VALUES('humanizar','praxis',$1)", [admin]);
    await pool.query("INSERT INTO acl_edges(from_tenant,to_tenant,allow_route) VALUES('Steven','PraxisHub',true)");
    // Repository edge checks take row locks themselves, so they need UPDATE on both tables.
    await pool.query('GRANT SELECT,UPDATE ON tenants TO cauce_gateway');
    await pool.query('GRANT SELECT,UPDATE ON acl_edges TO cauce_gateway');
    const client = await pool.connect();
    try {
      await client.query('BEGIN'); await client.query('SET LOCAL ROLE cauce_gateway');
      await client.query("SELECT cauce_assert_hub_star('Steven','PraxisHub')");
      expect((await client.query(hubEdgeExistsSql('allow_route', 1, 2), ['Steven', 'Isa'])).rowCount).toBe(1);
      expect((await client.query(hubEdgeExistsSql('allow_route', 1, 2), ['Steven', 'PraxisHub'])).rowCount).toBe(1);
    } finally { await client.query('ROLLBACK'); client.release(); }
  });
});
