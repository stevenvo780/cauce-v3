import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyMigrationsThrough, createPool, migrationSourcesForApply, withTransaction, type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import { legacyAdoptionSnapshot, lockLegacyAdoptionTargets } from '../src/fleet-adoption-snapshot.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation } from './companies-postgres.fixtures.js';
import {
  closeTestDatabase, provisionTestLogin, runtimeRoleRequested, startEmptyTestDatabase, startTestCaseDatabase,
  startTestDatabaseThrough, TEST_RUNTIME_LOGIN, type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const version = '052_runtime_roles.sql';
const lastRuntimeRolesVersion = '054_company_admins.sql';
const replayVersion = '065_runtime_grants_replay.sql';
const execFileAsync = promisify(execFile);
const GRANTEES = ['PUBLIC', 'cauce_runtime', 'cauce_observer', 'cauce_platform'];
const DML = ['SELECT', 'INSERT', 'UPDATE', 'DELETE'];
const EXCEPTIONS: Record<string, string[]> = {
  companies: ['SELECT'], company_links: ['SELECT'], platform_admins: ['SELECT'], agent_role_templates: ['SELECT'],
  schema_migrations: ['SELECT'], schema_migration_ledger: ['SELECT'], schema_migration_verifications: ['SELECT'],
  cauce_dlq_inventory_030: ['SELECT'], harness_definitions: ['SELECT', 'UPDATE'], role_policies: ['SELECT', 'UPDATE'],
  agent_chain_policies: ['SELECT', 'UPDATE'], fleet_operation_events: ['SELECT', 'INSERT'],
  fleet_operations: ['SELECT', 'INSERT', 'UPDATE'], fleet_runtime_identities: ['SELECT', 'INSERT', 'UPDATE'],
  config_revisions: ['SELECT', 'INSERT', 'UPDATE'], audit_events: DML, tenants: ['SELECT', 'INSERT', 'DELETE'],
  company_admins: ['SELECT'], platform_authority_events: ['SELECT'], company_system_principals: ['SELECT'],
  company_agent_roles: ['SELECT'], agent_role_template_owners: ['SELECT'],
};
// Every function of 052-054, and only those, is closed to PUBLIC. The runtime executes the DEFINER lock
// helpers, the resolver and the helpers its guarded writes call; a trigger fires without EXECUTE on its
// function, so every other function is classified to the platform alone.
const RUNTIME_FUNCTIONS = ['cauce_assert_company_reachable(text,text)', 'cauce_company_authority(uuid,text)',
  'cauce_config_revision_scope(jsonb)', 'cauce_lock_company_link(text,text)', 'cauce_lock_hub_star_tenant(text)',
  'cauce_lock_owner_guard(text)', 'cauce_platform_operator()'];
const PLATFORM_FUNCTIONS = ['cauce_append_only()', 'cauce_apply_runtime_grants()', 'cauce_company_immutable()',
  'cauce_company_owner_continuity()', 'cauce_config_revision_company()', 'cauce_console_users_owner_guard()',
  'cauce_fill_company()', 'cauce_fill_company_from_human()', 'cauce_fill_host_company()', 'cauce_fill_operation_company()',
  'cauce_pair_company_guard()', 'cauce_platform_admins_journal()', 'cauce_platform_assert_admin(uuid)',
  'cauce_platform_create_company(text,text,uuid)', 'cauce_platform_grant_admin(text,uuid,text,text,uuid)',
  'cauce_platform_link(text,text,uuid)', 'cauce_platform_record(text,text,text,uuid,uuid,jsonb)',
  'cauce_platform_revoke_admin(text,uuid,uuid)', 'cauce_platform_set_company_state(text,text,uuid)',
  'cauce_platform_unlink(text,text,uuid)', 'cauce_quota_company_guard()', 'cauce_register_placed_host()',
  'cauce_role_template_company_guard()', 'cauce_runtime_grants_052()', 'cauce_runtime_grants_053()',
  'cauce_runtime_grants_054()', 'cauce_tenants_company_admission()'];
const DEFINERS = ['cauce_company_authority(uuid,text)', 'cauce_lock_company_link(text,text)',
  'cauce_lock_hub_star_tenant(text)', 'cauce_lock_owner_guard(text)'];
const DOWNS = [lastRuntimeRolesVersion, '053_company_isolation.sql', version];
const OBSERVED = ['adapter_outbox', 'agent_output_materializations', 'agents', 'connection_leases', 'dead_letters',
  'deliveries', 'messages', 'outbox_dead_letters', 'tenants'];
const PRIVILEGES = "ARRAY['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']";
const NOT_EXTENSION = (catalog: string, alias: string) => `NOT EXISTS (SELECT 1 FROM pg_depend dependency
  WHERE dependency.classid='${catalog}'::regclass AND dependency.objid=${alias}.oid AND dependency.deptype='e')`;

let database: TestDatabase | undefined;
let through: TestDatabase | undefined;
let gateway: DatabasePool | undefined;
let observer: DatabasePool | undefined;
let currentServer: TestDatabase | undefined;
preparePostgresSuite(import.meta.url, async () => {
  database = await startTestDatabaseThrough(lastRuntimeRolesVersion);
  through = await startTestDatabaseThrough(version);
  gateway = createPool(await provisionTestLogin(database.adminPool, database.adminUrl, 'cauce_gateway', 'cauce_runtime'), { max: 2 });
  observer = createPool(await provisionTestLogin(database.adminPool, database.adminUrl, 'cauce_observer_login', 'cauce_observer'), { max: 1 });
}, 240_000);
afterAll(async () => {
  await Promise.all([gateway?.end(), observer?.end()]);
  await closeTestDatabase(database);
  await closeTestDatabase(through);
  await closeTestDatabase(currentServer);
});

async function latestServer(): Promise<TestDatabase> {
  if (currentServer) return currentServer;
  const latest = (await migrationSourcesForApply()).at(-1);
  if (!latest) throw new Error('runtime grants require a complete migration bundle');
  currentServer = await startTestDatabaseThrough(latest.version);
  return currentServer;
}

function ready(): { admin: DatabasePool; runtime: DatabasePool; reader: DatabasePool; full: TestDatabase; server: TestDatabase } {
  if (!database || !through || !gateway || !observer) throw new Error('runtime grants suite was not prepared');
  return { admin: database.adminPool, runtime: gateway, reader: observer, full: database, server: through };
}

async function attempt(pool: DatabasePool, ...statements: string[]): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) await client.query(statement);
    return 'ok';
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; return 'ok'; } catch (error) { return error instanceof Error ? error.message : String(error); }
}

// Effective privileges per object and grantee, defaults included, so a materialized default ACL equals NULL.
async function privileges(pool: DatabasePool, grantees: string[] | null = null): Promise<unknown> {
  return (await pool.query(`WITH objects AS (
      SELECT 'relation' AS kind,c.relname::text AS name,
        COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S' THEN 's'::"char" ELSE 'r'::"char" END,c.relowner)) AS acl
      FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f','S')
      UNION ALL SELECT 'column',c.relname||'.'||a.attname,a.attacl FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid
        WHERE c.relnamespace='public'::regnamespace AND a.attacl IS NOT NULL
      UNION ALL SELECT 'function',p.oid::regprocedure::text,COALESCE(p.proacl,acldefault('f',p.proowner)) FROM pg_proc p
        WHERE p.pronamespace='public'::regnamespace
      UNION ALL SELECT 'schema',n.nspname,COALESCE(n.nspacl,acldefault('n',n.nspowner)) FROM pg_namespace n WHERE n.nspname='public'
      UNION ALL SELECT 'database','',COALESCE(d.datacl,acldefault('d',d.datdba)) FROM pg_database d WHERE d.datname=current_database())
    SELECT kind,name,grantee,string_agg(privilege,',' ORDER BY privilege) AS privileges FROM (
      SELECT kind,name,CASE WHEN entry.grantee=0 THEN 'PUBLIC' ELSE entry.grantee::regrole::text END AS grantee,
        entry.privilege_type AS privilege FROM objects CROSS JOIN LATERAL aclexplode(objects.acl) entry) granted
    WHERE $1::text[] IS NULL OR grantee=ANY($1) GROUP BY 1,2,3 ORDER BY 1,2,3`, [grantees])).rows;
}

async function definitions(pool: DatabasePool): Promise<unknown> {
  return (await pool.query(`SELECT 'function' AS kind,p.oid::regprocedure::text AS name,
        md5(pg_get_functiondef(p.oid)) AS definition FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind='f'
    UNION ALL SELECT 'trigger',c.relname||'.'||t.tgname,pg_get_triggerdef(t.oid) FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid
      WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
    ORDER BY 1,2`)).rows;
}

async function catalog(pool: DatabasePool): Promise<unknown> {
  return { privileges: await privileges(pool), definitions: await definitions(pool) };
}

async function migrationLedger(pool: DatabasePool): Promise<{ version: string }[]> {
  return (await pool.query<{ version: string }>(`SELECT migration.*,ledger.source_sha256,ledger.source_origin,ledger.recorded_at
    FROM schema_migrations migration LEFT JOIN schema_migration_ledger ledger USING(version) ORDER BY version`)).rows;
}

async function restoreWithoutAcls(server: TestDatabase, target: EmptyTestDatabase): Promise<void> {
  const source = new URL(server.adminUrl);
  const destination = new URL(target.adminUrl);
  const ownedServer = process.env.CAUCE_TEST_DATABASE_URL ? '' : server.container.getId();
  for (const url of [source, destination]) {
    if (!/^cauce_test(?:_[a-z0-9_]+)?$/u.test(url.pathname.slice(1))) throw new Error('restore requires disposable databases');
  }
  if (source.host !== destination.host || source.username !== destination.username || source.password !== destination.password) {
    throw new Error('restore requires databases on the same test server');
  }
  const ownNetwork = /^[a-f0-9]{64}$/u.test(ownedServer);
  const temporary = await mkdtemp(join(tmpdir(), 'cauce-runtime-grants-'));
  const cidFile = join(temporary, 'client.cid');
  const name = `cauce-test-grants-${randomUUID()}`;
  try {
    const launched = await execFileAsync('docker', ['run', '--detach', '--rm', '--name', name, '--cidfile', cidFile,
      '--network', ownNetwork ? `container:${ownedServer}` : process.env.CAUCE_TEST_DOCKER_NETWORK ?? 'host',
      '--env', 'PGPASSWORD', 'postgres:16-alpine', 'sleep', 'infinity'],
    { timeout: 30_000, env: { ...process.env, PGPASSWORD: decodeURIComponent(source.password) } });
    const clientId = launched.stdout.trim();
    if (!/^[a-f0-9]{64}$/u.test(clientId)) throw new Error('restore client did not return its owned container id');
    console.info(`[testcontainers] owned restore client name=${name} id=${clientId}`);
    const connection = ['--host=' + (ownNetwork ? '127.0.0.1' : source.hostname),
      '--port=' + (ownNetwork ? '5432' : source.port || '5432'), '--username=' + decodeURIComponent(source.username)];
    const { stdout: dump } = await execFileAsync('docker', ['exec', clientId, 'pg_dump', ...connection,
      '--no-acl', '--format=custom', '--dbname=' + source.pathname.slice(1)],
    { encoding: 'buffer', timeout: 30_000, maxBuffer: 64 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const restore = execFile('docker', ['exec', '-i', clientId, 'pg_restore', ...connection,
        '--exit-on-error', '--no-owner', '--no-privileges', '--dbname=' + destination.pathname.slice(1)],
      { timeout: 30_000, maxBuffer: 64 * 1024 * 1024 }, (error) => {
        if (error) reject(new Error('test database restore failed', { cause: error })); else resolve();
      });
      restore.stdin?.end(dump);
    });
    console.info(`[testcontainers] restore client id=${clientId} dump_exit=0 restore_exit=0`);
  } finally {
    const clientId = await readFile(cidFile, 'utf8').catch(() => '');
    try {
      if (/^[a-f0-9]{64}$/u.test(clientId.trim())) await execFileAsync('docker', ['rm', '--force', clientId.trim()], { timeout: 30_000 });
      console.info(`[testcontainers] owned restore client id=${clientId.trim()} cleanup_exit=0`);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
}

async function groupDependencies(pool: DatabasePool): Promise<number> {
  return Number((await pool.query<{ count: string }>(`SELECT count(*) FROM pg_shdepend dependency
    JOIN pg_roles role ON role.oid=dependency.refobjid
    WHERE role.rolname IN ('cauce_runtime','cauce_observer','cauce_platform')
      AND (dependency.dbid=(SELECT oid FROM pg_database WHERE datname=current_database())
        OR (dependency.classid='pg_database'::regclass
          AND dependency.objid=(SELECT oid FROM pg_database WHERE datname=current_database())))`)).rows[0]?.count);
}

describe('least-privilege runtime roles through schema 054 on PostgreSQL', () => {
  it('declares the group roles without login or elevated attributes', async () => {
    const { admin } = ready();
    const roles = (await admin.query<{ rolname: string; elevated: boolean; member_of: number }>(`SELECT rolname,
        rolcanlogin OR rolsuper OR rolbypassrls OR rolcreaterole OR rolcreatedb OR rolreplication AS elevated,
        (SELECT count(*)::int FROM pg_auth_members membership WHERE membership.member=role.oid) AS member_of
      FROM pg_roles role WHERE rolname IN ('cauce_runtime','cauce_observer','cauce_platform') ORDER BY rolname`)).rows;
    expect(roles).toEqual([
      { rolname: 'cauce_observer', elevated: false, member_of: 0 },
      { rolname: 'cauce_platform', elevated: false, member_of: 0 },
      { rolname: 'cauce_runtime', elevated: false, member_of: 0 },
    ]);
    expect((await admin.query(`SELECT 1 FROM pg_auth_members membership
      WHERE membership.roleid='cauce_platform'::regrole AND membership.member=current_user::regrole`)).rowCount).toBe(1);
    expect((await admin.query(`SELECT has_schema_privilege('cauce_runtime','public','USAGE') AS usage,
        has_schema_privilege('cauce_runtime','public','CREATE') AS runtime_create,
        has_schema_privilege('cauce_observer','public','CREATE') AS observer_create,
        has_database_privilege('cauce_runtime',current_database(),'CONNECT') AS connect`)).rows[0])
      .toEqual({ usage: true, runtime_create: false, observer_create: false, connect: true });
  });

  it('classifies every migration relation, sequence and function', async () => {
    const { admin } = ready();
    const relations = (await admin.query<{ name: string; runtime: string[]; observer: string[]; public: boolean }>(`
      SELECT c.relname AS name,
        ARRAY(SELECT p FROM unnest(${PRIVILEGES}) p WHERE has_table_privilege('cauce_runtime',c.oid,p)) AS runtime,
        ARRAY(SELECT p FROM unnest(${PRIVILEGES}) p WHERE has_table_privilege('cauce_observer',c.oid,p)) AS observer,
        EXISTS (SELECT 1 FROM aclexplode(c.relacl) entry WHERE entry.grantee=0) AS public
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind IN ('r','p','v','m','f') AND ${NOT_EXTENSION('pg_class', 'c')}
      ORDER BY 1`)).rows;
    expect(relations.length).toBeGreaterThan(90);
    for (const relation of relations) {
      const expected = EXCEPTIONS[relation.name];
      if (expected) expect({ [relation.name]: relation.runtime }).toEqual({ [relation.name]: expected });
      expect({ [relation.name]: relation.runtime.length > 0 && relation.runtime.every(p => DML.includes(p)) })
        .toEqual({ [relation.name]: true });
      expect({ [relation.name]: relation.observer })
        .toEqual({ [relation.name]: OBSERVED.includes(relation.name) ? ['SELECT'] : [] });
      expect({ [relation.name]: relation.public }).toEqual({ [relation.name]: false });
    }
    expect((await admin.query<{ fixed: string[] }>(`SELECT ARRAY(SELECT attname::text FROM pg_attribute
        WHERE attrelid='tenants'::regclass AND attnum>0 AND NOT attisdropped
          AND NOT has_column_privilege('cauce_runtime','tenants',attname,'UPDATE') ORDER BY attname) AS fixed`)).rows[0]?.fixed)
      .toEqual(['company_id', 'id']);
    // A sequence serves the runtime exactly when it inserts into the table that owns it.
    const sequences = (await admin.query<{ name: string; usage: boolean; any: boolean; update: boolean; inserts: boolean }>(`
      SELECT c.relname AS name,
        has_sequence_privilege('cauce_runtime',c.oid,'USAGE') AND has_sequence_privilege('cauce_runtime',c.oid,'SELECT') AS usage,
        has_sequence_privilege('cauce_runtime',c.oid,'USAGE') OR has_sequence_privilege('cauce_runtime',c.oid,'SELECT') AS any,
        has_sequence_privilege('cauce_runtime',c.oid,'UPDATE') AS update,
        COALESCE((SELECT bool_or(has_table_privilege('cauce_runtime',dependency.refobjid,'INSERT')) FROM pg_depend dependency
          WHERE dependency.classid='pg_class'::regclass AND dependency.objid=c.oid
            AND dependency.refclassid='pg_class'::regclass AND dependency.deptype IN ('a','i')),false) AS inserts
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='S' AND ${NOT_EXTENSION('pg_class', 'c')} ORDER BY 1`)).rows;
    expect(sequences.length).toBeGreaterThan(0);
    for (const sequence of sequences) {
      expect(sequence).toEqual({ ...sequence, usage: sequence.inserts, any: sequence.inserts, update: false });
    }
    expect(sequences.find(sequence => sequence.name === 'platform_authority_events_id_seq')).toMatchObject({ any: false });
    const functions = (await admin.query<{ name: string; definer: boolean; runtime: boolean; platform: boolean;
      public: boolean; pinned: boolean }>(`SELECT p.oid::regprocedure::text AS name,p.prosecdef AS definer,
        has_function_privilege('cauce_runtime',p.oid,'EXECUTE') AS runtime,
        has_function_privilege('cauce_platform',p.oid,'EXECUTE') AS platform,
        p.proacl IS NULL OR EXISTS (SELECT 1 FROM aclexplode(p.proacl) entry WHERE entry.grantee=0) AS public,
        EXISTS (SELECT 1 FROM unnest(p.proconfig) setting WHERE setting ~ '^search_path=.+, pg_temp$') AS pinned
      FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
      WHERE n.nspname='public' AND ${NOT_EXTENSION('pg_proc', 'p')} ORDER BY 1`)).rows;
    for (const fn of functions) {
      expect({ [fn.name]: fn.runtime || fn.platform }).toEqual({ [fn.name]: true });
      if (fn.definer) expect({ [fn.name]: { public: fn.public, pinned: fn.pinned } })
        .toEqual({ [fn.name]: { public: false, pinned: true } });
    }
    expect(functions.filter(fn => fn.definer).map(fn => fn.name)).toEqual(expect.arrayContaining(DEFINERS));
    expect(functions.filter(fn => !fn.public).map(fn => fn.name).sort()).toEqual([...RUNTIME_FUNCTIONS, ...PLATFORM_FUNCTIONS].sort());
    expect(functions.filter(fn => !fn.public && fn.runtime).map(fn => fn.name).sort()).toEqual([...RUNTIME_FUNCTIONS].sort());
    expect(functions.filter(fn => PLATFORM_FUNCTIONS.includes(fn.name) && !fn.platform).map(fn => fn.name)).toEqual([]);
  });

  it('denies the runtime login platform writes, company moves, DDL and trigger tampering', async () => {
    const { runtime } = ready();
    expect((await runtime.query(`SELECT current_user AS login,rolsuper AS super,
        has_table_privilege(current_user,'platform_admins','INSERT') AS platform_insert
      FROM pg_roles WHERE rolname=current_user`)).rows[0]).toEqual({ login: 'cauce_gateway', super: false, platform_insert: false });
    const denied = [
      "INSERT INTO companies(id,name) VALUES('praxis','Praxis')", 'UPDATE companies SET name=name',
      'DELETE FROM company_links', 'DELETE FROM platform_admins',
      "INSERT INTO schema_migrations(version) VALUES('999_intruder.sql')", 'UPDATE agent_role_templates SET brief=brief',
      "INSERT INTO role_policies(role) VALUES('intruder')", 'UPDATE role_policies SET allow_control=true',
      "UPDATE harness_definitions SET command='/bin/false'", "DELETE FROM harness_definitions WHERE id='fake'",
      "UPDATE audit_events SET decision='allow'", 'DELETE FROM fleet_operation_events',
      "UPDATE tenants SET company_id='humanizar'", 'UPDATE tenants SET id=id',
      'CREATE TABLE intruder(id int)', 'CREATE FUNCTION intruder() RETURNS int LANGUAGE sql AS $$SELECT 1$$',
      'ALTER TABLE agents DISABLE TRIGGER USER', 'DROP TRIGGER role_policies_platform_write ON role_policies',
      'ALTER TABLE role_policies DISABLE TRIGGER role_policies_platform_write', 'TRUNCATE audit_events',
      'SELECT 1 FROM companies FOR SHARE', 'SELECT 1 FROM platform_admins FOR SHARE',
      'DELETE FROM fleet_runtime_identities', 'DELETE FROM config_revisions', 'DELETE FROM fleet_operations',
      'UPDATE fleet_operation_events SET version=version', "INSERT INTO harness_definitions(id) VALUES('intruder')",
      `MERGE INTO role_policies policy USING role_policies source ON policy.role=source.role
        WHEN MATCHED THEN UPDATE SET allow_control=true`,
      'WITH changed AS (UPDATE role_policies SET allow_control=true RETURNING 1) SELECT count(*) FROM changed',
      'SELECT cauce_apply_runtime_grants()', 'SELECT cauce_runtime_grants_052()',
      'SELECT cauce_runtime_grants_053()', 'SELECT cauce_runtime_grants_054()',
      "INSERT INTO company_admins(company_id,human_id,role,source) VALUES('humanizar',gen_random_uuid(),'owner','v4.0-hub-operator')",
      "UPDATE company_admins SET role='owner'", 'DELETE FROM company_admins', 'TRUNCATE company_admins',
      'INSERT INTO platform_admins(human_id) VALUES(gen_random_uuid())', 'UPDATE platform_admins SET human_id=human_id',
      "INSERT INTO platform_authority_events(action) VALUES('admin.grant')", 'DELETE FROM platform_authority_events',
      "SELECT nextval('platform_authority_events_id_seq')",
      "INSERT INTO company_system_principals(company_id,kind,tenant_id,principal_alias) VALUES('humanizar','director','Steven','zeus')",
      'DELETE FROM company_agent_roles', 'DELETE FROM agent_role_template_owners',
      'SELECT 1 FROM company_admins FOR SHARE', 'SELECT 1 FROM company_system_principals FOR SHARE',
      "SELECT cauce_platform_grant_admin('humanizar',gen_random_uuid(),'intruder@example.test','owner',gen_random_uuid())",
      "SELECT cauce_platform_revoke_admin('humanizar',gen_random_uuid(),gen_random_uuid())",
      "SELECT cauce_platform_create_company('intruder','Intruder',gen_random_uuid())",
      "SELECT cauce_platform_set_company_state('humanizar','retired',gen_random_uuid())",
      "SELECT cauce_platform_link('humanizar','intruder',gen_random_uuid())",
      "SELECT cauce_platform_unlink('humanizar','intruder',gen_random_uuid())",
      "SELECT cauce_platform_assert_admin(gen_random_uuid())",
      `SELECT cauce_platform_record('admin.grant','humanizar',NULL,NULL,NULL,'{}')`,
    ];
    for (const statement of denied) expect({ [statement]: await attempt(runtime, statement) }).toEqual({ [statement]: '42501' });
    expect(await attempt(runtime, 'CREATE TEMP VIEW policy_view AS SELECT * FROM role_policies',
      'UPDATE policy_view SET allow_control=true')).toBe('42501');
    for (const statement of [
      'UPDATE tenants SET display_name=display_name,enabled=enabled', 'DELETE FROM audit_events WHERE false',
      "INSERT INTO audit_events(tenant_id,actor_alias,action,decision) VALUES('Steven','kant','runtime.grants','allow')",
      "INSERT INTO tenants(id,company_id) VALUES('RuntimeGrants','humanizar')", 'SELECT count(*) FROM companies',
      "SELECT cauce_lock_hub_star_tenant('Steven')", "SELECT cauce_lock_company_link('humanizar','humanizar')",
      'SELECT count(*) FROM company_admins', 'SELECT count(*) FROM platform_authority_events',
      'SELECT count(*) FROM company_system_principals', 'SELECT count(*) FROM company_agent_roles',
      'SELECT count(*) FROM agent_role_template_owners', 'SELECT * FROM cauce_company_authority(gen_random_uuid(),NULL)',
      "SELECT cauce_lock_owner_guard('humanizar')",
    ]) expect({ [statement]: await attempt(runtime, statement) }).toEqual({ [statement]: 'ok' });
  });

  it('lets the runtime take every row and table lock its paths need', async () => {
    const { admin, runtime } = ready();
    const lockable = (await admin.query<{ name: string; table_update: boolean }>(`SELECT c.relname AS name,
        has_table_privilege('cauce_runtime',c.oid,'UPDATE') AS table_update
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relkind='r' AND has_any_column_privilege('cauce_runtime',c.oid,'UPDATE') ORDER BY 1`)).rows;
    expect(lockable.map(table => table.name)).toEqual(expect.arrayContaining(
      ['agents', 'audit_events', 'fleet_runtime_identities', 'harness_definitions', 'memberships', 'role_policies', 'tenants']));
    for (const table of lockable) {
      const statements = [`SELECT 1 FROM ${table.name} LIMIT 1 FOR SHARE`, `SELECT 1 FROM ${table.name} LIMIT 1 FOR UPDATE`];
      if (table.table_update) statements.push(`LOCK TABLE ${table.name} IN SHARE MODE`);
      expect({ [table.name]: await attempt(runtime, ...statements) }).toEqual({ [table.name]: 'ok' });
    }
    expect(await attempt(runtime, 'LOCK TABLE memberships,role_policies,provider_accounts IN SHARE MODE',
      'LOCK TABLE agents IN SHARE MODE', `SELECT membership.room_id FROM memberships membership
        JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
        JOIN role_policies policy ON policy.role=membership.role JOIN tenants tenant ON tenant.id=membership.tenant_id
        FOR SHARE OF membership,room,policy,tenant`, `SELECT edge.from_tenant FROM acl_edges edge
        JOIN tenants source ON source.id=edge.from_tenant JOIN tenants target ON target.id=edge.to_tenant
        FOR SHARE OF edge,source,target`)).toBe('ok');
  });

  it('runs the legacy adoption lock and snapshot as the runtime login', async () => {
    const { server } = ready();
    const current: EmptyTestDatabase = await startTestCaseDatabase(server);
    const runtime = createPool(await provisionTestLogin(current.adminPool, current.adminUrl, 'cauce_gateway', 'cauce_runtime'), { max: 1 });
    try {
      await current.adminPool.query(`INSERT INTO agents(tenant_id,alias,enabled,harness_id,runtime_key,primary_room_id)
        VALUES('Steven','argos',false,'codex','argos','grp.steven')`);
      const targets = [{ tenant_id: 'Steven', alias: 'argos' }];
      const fence = { measure: () => Promise.resolve({}), assertHeld: () => Promise.resolve() };
      const snapshot = await withTransaction(runtime, async (client) => {
        await lockLegacyAdoptionTargets(client, targets);
        return legacyAdoptionSnapshot(client, targets, fence);
      });
      expect(snapshot.blockers.map(blocker => blocker.code)).toContain('facts_unavailable');
    } finally {
      await runtime.end();
      await current.close();
    }
  });

  it('runs the company guards of 053 and 054 as the runtime login and keeps the platform plane closed', async () => {
    const { full } = ready();
    const current = await startTestCaseDatabase(full);
    const runtime = createPool(await provisionTestLogin(current.adminPool, current.adminUrl, 'cauce_gateway', 'cauce_runtime'), { max: 1 });
    try {
      const people = await seedCompanyIsolation(current.adminPool);
      await current.adminPool.query(`INSERT INTO agent_role_templates(slug,display_name,brief) VALUES('praxis-clinic','Clinic','Clinic brief');
        INSERT INTO agent_role_template_owners(slug,company_id) VALUES('praxis-clinic','praxis')`);
      const handoff = (from: string, fromAlias: string, to: string, toAlias: string): string => `INSERT INTO secret_handoffs(id,
        from_tenant,from_alias,to_tenant,to_alias,label,sealed,sealing_key_id,ephemeral_public,nonce,expires_at)
        VALUES(gen_random_uuid(),'${from}','${fromAlias}','${to}','${toAlias}','runtime','\\x00','key',
          decode(repeat('00',32),'hex'),decode(repeat('00',12),'hex'),now()+interval '1 hour')`;
      const allowed = [
        `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
          VALUES('PraxisHub','company_admin','{"resource":"room"}','{}','runtime')`,
        `UPDATE console_users SET active=false WHERE id='${people.miguel}'`,
        "INSERT INTO rooms(id,tenant_id) VALUES('runtime-room','PraxisTeam')",
        handoff('Steven', 'kant', 'Miguel', 'janus'),
      ];
      for (const statement of allowed) expect({ [statement]: await attempt(runtime, statement) }).toEqual({ [statement]: 'ok' });
      expect((await runtime.query('SELECT * FROM cauce_company_authority($1,NULL)', [people.leon])).rows)
        .toEqual([{ home_company: 'praxis', platform_admin: false, company_role: 'owner', company_enabled: true }]);
      const guarded: Record<string, string> = {
        [`UPDATE console_users SET active=false WHERE id='${people.leon}'`]: '23514',
        [`UPDATE console_users SET role='reader' WHERE id='${people.steven}'`]: '23514',
        [handoff('Steven', 'kant', 'PraxisHub', 'company_admin')]: '23514',
        "UPDATE agents SET role_brief='Clinic brief',role_template_slug='praxis-clinic' WHERE tenant_id='Steven' AND alias='kant'": '23514',
        "INSERT INTO fleet_hosts(host_id,display_name) VALUES('ambiguous-host','Ambiguous')": '23502',
        [`INSERT INTO company_admins(company_id,human_id,role,source,granted_by)
          VALUES('humanizar','${people.miguel}','admin','platform','${people.steven}')`]: '42501',
        "UPDATE company_admins SET role='admin'": '42501',
        [`DELETE FROM company_admins WHERE human_id='${people.miguel}'`]: '42501',
        [`INSERT INTO platform_admins(human_id) VALUES('${people.miguel}')`]: '42501',
        [`DELETE FROM platform_admins WHERE human_id='${people.steven}'`]: '42501',
        [`SELECT cauce_platform_grant_admin('humanizar','${people.miguel}','miguel@example.test','admin','${people.steven}')`]: '42501',
        [`SELECT cauce_platform_revoke_admin('humanizar','${people.miguel}','${people.steven}')`]: '42501',
      };
      for (const [statement, code] of Object.entries(guarded)) {
        expect({ [statement]: await attempt(runtime, statement) }).toEqual({ [statement]: code });
      }
      expect(await attempt(runtime, "SELECT set_config('cauce.company_move','on',true)",
        "UPDATE agents SET company_id='praxis' WHERE tenant_id='Steven' AND alias='kant'")).toBe('23514');
      expect((await current.adminPool.query(`SELECT company_id,human_id::text,role FROM company_admins ORDER BY company_id,human_id`)).rows)
        .toEqual([{ company_id: 'humanizar', human_id: people.steven, role: 'owner' }, { company_id: 'humanizar', human_id: people.miguel, role: 'owner' },
          { company_id: 'praxis', human_id: people.leon, role: 'owner' }].sort((left, right) =>
          left.company_id.localeCompare(right.company_id) || left.human_id.localeCompare(right.human_id)));
    } finally {
      await runtime.end();
      await current.close();
    }
  });

  it('gives the observer login read access to the metric tables only', async () => {
    const { reader } = ready();
    for (const table of OBSERVED) expect({ [table]: await attempt(reader, `SELECT count(*) FROM ${table}`) }).toEqual({ [table]: 'ok' });
    for (const statement of ['SELECT 1 FROM companies', 'SELECT 1 FROM console_users', 'SELECT 1 FROM agents FOR SHARE',
      "DELETE FROM messages WHERE false"]) {
      expect({ [statement]: await attempt(reader, statement) }).toEqual({ [statement]: '42501' });
    }
  });

  it('hands suites the runtime login only when CAUCE_TEST_RUNTIME_ROLE=1', async () => {
    const { admin, full } = ready();
    const login = async (pool: DatabasePool) => (await pool.query<{ login: string }>('SELECT current_user AS login')).rows[0]?.login;
    expect(await login(full.pool)).toBe(runtimeRoleRequested() ? TEST_RUNTIME_LOGIN : await login(admin));
    expect(new URL(full.url).username).toBe(runtimeRoleRequested() ? TEST_RUNTIME_LOGIN : new URL(full.adminUrl).username);
  });

  it('keeps every write path of the migrator role, which bypasses the guard', async () => {
    const { admin } = ready();
    expect(await attempt(admin, 'UPDATE role_policies SET allow_read=allow_read', 'UPDATE harness_definitions SET enabled=enabled',
      'UPDATE audit_events SET decision=decision', "INSERT INTO companies(id,name) VALUES('praxis','Praxis')")).toBe('ok');
  });
});

describe('runtime roles migration rollback', () => {
  it('reapplies every grant of 052-054 after a restore without ACLs', async () => {
    const { full } = ready();
    const current = await startTestCaseDatabase(full);
    const runtime = createPool(await provisionTestLogin(current.adminPool, current.adminUrl, 'cauce_gateway', 'cauce_runtime'), { max: 1 });
    const groups = ['PUBLIC', 'cauce_runtime', 'cauce_observer', 'cauce_platform'];
    try {
      const before = await privileges(current.adminPool, groups);
      // What pg_restore --no-acl leaves: every object of the schema with its default ACL.
      await current.adminPool.query(`UPDATE pg_class SET relacl=NULL WHERE relnamespace='public'::regnamespace;
        UPDATE pg_attribute SET attacl=NULL WHERE attrelid IN (SELECT oid FROM pg_class WHERE relnamespace='public'::regnamespace);
        UPDATE pg_proc SET proacl=NULL WHERE pronamespace='public'::regnamespace`);
      expect(await attempt(runtime, 'SELECT 1 FROM agents')).toBe('42501');
      await current.adminPool.query('SELECT cauce_apply_runtime_grants()');
      expect(await privileges(current.adminPool, groups)).toEqual(before);
      expect(await attempt(runtime, 'SELECT 1 FROM agents')).toBe('ok');
    } finally {
      await runtime.end();
      await current.close();
    }
  });

  it('returns to the 051 catalog and reapplies to the same grants', async () => {
    const { server } = ready();
    const current = await startTestCaseDatabase(server);
    const previous = await startEmptyTestDatabase(server.adminUrl);
    try {
      await applyMigrationsThrough(previous.adminPool, '051_companies.sql');
      const before = await catalog(current.adminPool);
      expect(await groupDependencies(current.adminPool)).toBeGreaterThan(0);
      await current.adminPool.query(await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8'));
      expect(await groupDependencies(current.adminPool)).toBe(0);
      expect((await current.adminPool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0])
        .toEqual({ version: '051_companies.sql' });
      expect(await catalog(current.adminPool)).toEqual(await catalog(previous.adminPool));
      await applyMigrationsThrough(current.adminPool, version);
      expect(await catalog(current.adminPool)).toEqual(before);
    } finally {
      await previous.close();
      await current.close();
    }
  });

  it('returns through 054 and 053 to the 051 catalog and reapplies the same grants', async () => {
    const { full, server } = ready();
    const current = await startTestCaseDatabase(full);
    const previous = await startEmptyTestDatabase(server.adminUrl);
    try {
      await applyMigrationsThrough(previous.adminPool, '051_companies.sql');
      const before = await catalog(current.adminPool);
      for (const down of DOWNS) {
        await current.adminPool.query(await readFile(new URL(`../migrations/down/${down}`, import.meta.url), 'utf8'));
      }
      expect(await groupDependencies(current.adminPool)).toBe(0);
      expect((await current.adminPool.query('SELECT max(version) AS version FROM schema_migrations')).rows[0])
        .toEqual({ version: '051_companies.sql' });
      expect(await catalog(current.adminPool)).toEqual(await catalog(previous.adminPool));
      await applyMigrationsThrough(current.adminPool, lastRuntimeRolesVersion);
      expect(await catalog(current.adminPool)).toEqual(before);
    } finally {
      await previous.close();
      await current.close();
    }
  });

  it('refuses while a later migration or a runtime login is present, and on privileged groups', async () => {
    const { server } = ready();
    const current = await startTestCaseDatabase(server);
    const down = await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
    const up = await readFile(new URL(`../migrations/${version}`, import.meta.url), 'utf8');
    const client = await current.adminPool.connect();
    const runtime = createPool(await provisionTestLogin(current.adminPool, current.adminUrl, 'cauce_gateway', 'cauce_runtime'), { max: 1 });
    try {
      await client.query('BEGIN');
      await client.query("INSERT INTO schema_migrations(version) VALUES('053_later.sql')");
      expect(await failure(client.query(down))).toContain('later migration is present');
      await client.query('ROLLBACK');
      await client.query('BEGIN');
      await client.query(down);
      await client.query('ALTER ROLE cauce_runtime CREATEDB');
      expect(await failure(client.query(up))).toContain('unprivileged NOLOGIN leaf groups');
      await client.query('ROLLBACK');
      await runtime.query('SELECT 1');
      expect(await failure(current.adminPool.query(down))).toContain('still connected');
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await runtime.end();
      await current.close();
    }
  });

  it('never drops a group that still has member logins', async () => {
    const { server } = ready();
    await provisionTestLogin(server.adminPool, server.adminUrl, 'cauce_gateway', 'cauce_runtime');
    const memberships = async (client: DatabaseClient) => (await client.query<{ rolname: string }>(`SELECT member.rolname FROM pg_auth_members membership
      JOIN pg_roles member ON member.oid=membership.member WHERE membership.roleid='cauce_runtime'::regrole ORDER BY 1`)).rows;
    const client = await server.adminPool.connect();
    try {
      // The down drops a group only when no other database of the cluster grants it anything.
      const elsewhere = Number((await client.query<{ count: string }>(`SELECT count(*) FROM pg_shdepend dependency
        WHERE dependency.refclassid='pg_authid'::regclass AND dependency.refobjid='cauce_runtime'::regrole
          AND dependency.dbid<>(SELECT oid FROM pg_database WHERE datname=current_database())
          AND NOT (dependency.classid='pg_database'::regclass
            AND dependency.objid=(SELECT oid FROM pg_database WHERE datname=current_database()))`)).rows[0]?.count);
      const before = await memberships(client);
      expect(before).toContainEqual({ rolname: 'cauce_gateway' });
      await client.query('BEGIN');
      const result = await failure(client.query(await readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8')));
      if (elsewhere === 0) expect(result).toContain('cauce_runtime still has member logins');
      else expect({ result, memberships: await memberships(client) }).toEqual({ result: 'ok', memberships: before });
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
  });
});

describe('runtime grants across the complete migration bundle', () => {
  it('replays identical current grants after a real restore without ACLs', async () => {
    const latest = await latestServer();
    const restored = await startEmptyTestDatabase(latest.adminUrl);
    let runtime: DatabasePool | undefined;
    try {
      const before = await privileges(latest.adminPool, GRANTEES);
      const ledger = await migrationLedger(latest.adminPool);
      await restoreWithoutAcls(latest, restored);
      expect(await privileges(restored.adminPool, GRANTEES)).not.toEqual(before);
      expect(await migrationLedger(restored.adminPool)).toEqual(ledger);
      await restored.adminPool.query('SELECT cauce_apply_runtime_grants()');
      expect(await privileges(restored.adminPool, GRANTEES)).toEqual(before);
      await restored.adminPool.query('SELECT cauce_apply_runtime_grants()');
      expect(await privileges(restored.adminPool, GRANTEES)).toEqual(before);
      expect(await migrationLedger(restored.adminPool)).toEqual(ledger);
      runtime = createPool(await provisionTestLogin(restored.adminPool, restored.adminUrl, 'cauce_gateway', 'cauce_runtime'), { max: 1 });
      expect(await attempt(runtime, 'SELECT * FROM cauce_ensure_context_director_anchor(NULL,NULL,NULL,NULL,NULL)')).toBe('22023');
      expect(await attempt(runtime, 'SELECT cauce_lock_host_company(NULL)')).toBe('ok');
      for (const statement of ['SELECT cauce_quota_report_account_guard()',
        'SELECT cauce_runtime_grants_065()', 'SELECT 1 FROM company_admin_versions']) {
        expect({ [statement]: await attempt(runtime, statement) }).toEqual({ [statement]: '42501' });
      }
      const grants = (await restored.adminPool.query(`SELECT p.oid::regprocedure::text AS name,
        has_function_privilege('cauce_runtime',p.oid,'EXECUTE') AS runtime,
        has_function_privilege('cauce_observer',p.oid,'EXECUTE') AS observer,
        has_function_privilege('cauce_platform',p.oid,'EXECUTE') AS platform,
        EXISTS(SELECT 1 FROM aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) entry WHERE entry.grantee=0) AS public
        FROM pg_proc p WHERE p.oid=ANY(ARRAY['cauce_ensure_context_director_anchor(text,text,text,bigint,text)'::regprocedure,
          'cauce_runtime_grants_065()'::regprocedure]) ORDER BY 1`)).rows;
      expect(grants).toEqual([
        { name: 'cauce_ensure_context_director_anchor(text,text,text,bigint,text)', runtime: true, observer: false, platform: true, public: false },
        { name: 'cauce_runtime_grants_065()', runtime: false, observer: false, platform: true, public: false },
      ]);
      expect((await restored.adminPool.query(`SELECT p.proname FROM pg_proc p
        CROSS JOIN LATERAL aclexplode(COALESCE(p.proacl,acldefault('f',p.proowner))) entry
        WHERE p.pronamespace='public'::regnamespace AND entry.grantee=0 AND p.proname=ANY($1)`,
      [['cauce_quota_report_account_guard', 'cauce_lock_host_company', 'cauce_ensure_context_director_anchor']])).rows).toEqual([]);
      expect((await restored.adminPool.query(`SELECT
        has_table_privilege('cauce_runtime','company_admin_versions','SELECT') AS runtime,
        has_table_privilege('cauce_observer','company_admin_versions','SELECT') AS observer`)).rows)
        .toEqual([{ runtime: false, observer: false }]);
    } finally {
      await runtime?.end();
      await restored.close();
    }
  });

  it('down/up preserves the 064 catalog, connected logins and prior atomic ledger', async () => {
    const latest = await latestServer();
    const current = await startTestCaseDatabase(latest);
    const previous = await startEmptyTestDatabase(latest.adminUrl);
    let runtime: DatabasePool | undefined;
    try {
      await applyMigrationsThrough(previous.adminPool, '064_company_context_anchor.sql');
      const before = await catalog(current.adminPool);
      const ledger = await migrationLedger(current.adminPool);
      const members = async () => (await current.adminPool.query<{ role: string; member: string; admin_option: boolean }>(`
        SELECT group_role.rolname AS role,member.rolname AS member,
        membership.admin_option FROM pg_auth_members membership JOIN pg_roles group_role ON group_role.oid=membership.roleid
        JOIN pg_roles member ON member.oid=membership.member WHERE group_role.rolname=ANY($1) ORDER BY 1,2`, [GRANTEES.slice(1)])).rows;
      runtime = createPool(await provisionTestLogin(current.adminPool, current.adminUrl, 'cauce_gateway', 'cauce_runtime'), { max: 1 });
      const memberships = await members();
      expect(await attempt(runtime, 'SELECT 1 FROM agents')).toBe('ok');
      const down = await readFile(new URL(`../migrations/down/${replayVersion}`, import.meta.url), 'utf8');
      await current.adminPool.query(down);
      expect(await catalog(current.adminPool)).toEqual(await catalog(previous.adminPool));
      expect(await migrationLedger(current.adminPool)).toEqual(ledger.filter((row) => row.version !== replayVersion));
      expect(await members()).toEqual(memberships);
      expect(await attempt(runtime, 'SELECT 1 FROM agents')).toBe('ok');
      await expect(current.adminPool.query(down)).resolves.toBeDefined();
      await applyMigrationsThrough(current.adminPool, replayVersion);
      expect(await catalog(current.adminPool)).toEqual(before);
      expect(await members()).toEqual(memberships);
      expect((await current.adminPool.query(`SELECT migration.version,ledger.source_origin
        FROM schema_migrations migration JOIN schema_migration_ledger ledger USING(version)
        WHERE migration.version=$1`, [replayVersion])).rows).toEqual([{ version: replayVersion, source_origin: 'applied-atomically' }]);
    } finally {
      await runtime?.end();
      await previous.close();
      await current.close();
    }
  });

  it('refuses down after later migrations or atomic ledger loss without changing the catalog', async () => {
    const current = await startTestCaseDatabase(await latestServer());
    const down = await readFile(new URL(`../migrations/down/${replayVersion}`, import.meta.url), 'utf8');
    const before = await catalog(current.adminPool);
    const ledger = await migrationLedger(current.adminPool);
    const client = await current.adminPool.connect();
    try {
      for (const [statement, message] of [
        ["INSERT INTO schema_migrations(version) VALUES('066_later.sql')", 'later migration is present'],
        [`DELETE FROM schema_migration_ledger WHERE version='${replayVersion}'`, 'atomic ledger state'],
        [`UPDATE schema_migration_ledger SET source_sha256=repeat('0',64) WHERE version='${replayVersion}'`, 'atomic ledger state'],
      ]) {
        await client.query('BEGIN');
        await client.query(statement ?? '');
        expect(await failure(client.query(down))).toContain(message);
        await client.query('ROLLBACK');
        expect(await catalog(current.adminPool)).toEqual(before);
        expect(await migrationLedger(current.adminPool)).toEqual(ledger);
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
      await current.close();
    }
  });

  it('serializes down with the migration advisory lock without losing the ledger', async () => {
    const current = await startTestCaseDatabase(await latestServer());
    const down = await readFile(new URL(`../migrations/down/${replayVersion}`, import.meta.url), 'utf8');
    const ledger = await migrationLedger(current.adminPool);
    const holder = await current.adminPool.connect();
    const contender = await current.adminPool.connect();
    try {
      await holder.query('BEGIN');
      await holder.query('SELECT pg_advisory_xact_lock(783_003_003)');
      await contender.query('BEGIN');
      await contender.query("SET LOCAL lock_timeout='200ms'");
      await expect(contender.query(down)).rejects.toMatchObject({ code: '55P03' });
      await contender.query('ROLLBACK');
      expect(await migrationLedger(current.adminPool)).toEqual(ledger);
    } finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      await contender.query('ROLLBACK').catch(() => undefined);
      holder.release();
      contender.release();
      await current.close();
    }
  });
});
