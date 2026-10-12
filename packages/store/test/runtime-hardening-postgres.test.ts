import { readdir, readFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import {
  applyMigrationsThrough, ConfigurationRepository, createPool, lockCompanyAuthority, migrationSourcesForApply,
  type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation } from './companies-postgres.fixtures.js';
import {
  closeTestDatabase, provisionTestLogin, startEmptyTestDatabase, startTestDatabaseThrough,
  type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';

const previous = '065_runtime_grants_replay.sql';
const version = '066_runtime_hardening.sql';
const PINNED = ['search_path=pg_catalog, public, pg_temp'];
// UNPINNED on schema 065: every function of public that names a relation or a type of public and
// does not list pg_temp last. 066 pins exactly these.
const PINNED_BY_066 = [
  'cauce_agent_profile_context_journal()', 'cauce_agents_role_brief_journal()', 'cauce_agents_role_template_coherence()',
  'cauce_company_links_withdraw_edges()', 'cauce_deliveries_hub_star_guard()', 'cauce_dlq_apply_030(text,text,text)',
  'cauce_dlq_assert_control_030(text,text)', 'cauce_dlq_can_control_tenant_030(text,text)', 'cauce_dlq_candidates_030()',
  'cauce_dlq_lock_control_tenant_030(text,text,text)', 'cauce_dlq_post_030(text,text,text)', 'cauce_dlq_snapshot_030(text,text)',
  'cauce_egress_destination_guard()', 'cauce_fence_adapter_outbox_causality_030()', 'cauce_fence_dead_letter_030()',
  'cauce_fence_outbox_dead_letter_030()', 'cauce_fence_telegram_effect_030()',
  'cauce_inspect_telegram_replay_030(uuid,text,text,text)', 'cauce_legacy_company_id()',
  'cauce_list_dlq_030(text,text,integer,text)',
  'cauce_manual_replay_telegram_030(text,integer,text,text,text,boolean,uuid,uuid,text,integer)',
  'cauce_oauth_advance_identity_revision()', 'cauce_oauth_preserve_authority()', 'cauce_oauth_reject_truncate()',
  'cauce_profile_runtime_adoption_matches_expectation()', 'cauce_reconcile_telegram_terminal_030(text)',
  'cauce_reopen_outbox_dead_letter_030()', 'cauce_resolve_dlq_without_replay_030(text,uuid,text,text,text,text,boolean,boolean)',
  'cauce_sync_agent_role_to_profile()', 'cauce_sync_profile_role_to_agent()', 'cauce_sync_role_template_to_profiles()',
  'cauce_tenants_hub_star_guard()', 'enforce_human_identity_immutability()', 'preserve_fleet_operation_history()',
  'preserve_human_client_records()', 'reserve_agent_runtime_key()',
];
// Pure SQL helpers of CHECK constraints: a SET clause would stop their inlining (038).
const INLINED = ['cauce_role_summary_to_brief(text)', 'cauce_text_items_ok(text[],integer)', 'cauce_utf16_units(text)'];
const UNPINNED = `SELECT p.oid::regprocedure::text AS name FROM pg_proc p
  WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p')
    AND NOT EXISTS (SELECT 1 FROM pg_depend dependency WHERE dependency.classid='pg_proc'::regclass
      AND dependency.objid=p.oid AND dependency.deptype='e')
    AND NOT EXISTS (SELECT 1 FROM unnest(p.proconfig) setting WHERE setting ~ '^search_path=.+, pg_temp$')
    AND EXISTS (SELECT 1 FROM pg_class relation WHERE relation.relnamespace='public'::regnamespace
        AND p.prosrc ~* ('\\m'||relation.relname||'\\M')
      UNION ALL SELECT 1 FROM pg_type type WHERE type.typnamespace='public'::regnamespace
        AND p.prosrc ~* ('\\m'||type.typname||'\\M'))
  ORDER BY 1`;
const ACL = (acl: string, grantee = 'entry.grantee') => `(SELECT string_agg(format('%s:%s',
  CASE WHEN ${grantee}=0 THEN 'PUBLIC' ELSE ${grantee}::regrole::text END,entry.privilege_type),',' ORDER BY 1)
  FROM aclexplode(${acl}) entry)`;
// Functions with their settings and grants, triggers with their timing, and the effective ACLs of
// every relation, the schema and the database.
const CATALOG = `SELECT line FROM (
  SELECT format('function %s definer=%s config=%s definition=%s acl=%s',p.oid::regprocedure,p.prosecdef,p.proconfig,
      md5(pg_get_functiondef(p.oid)),${ACL("COALESCE(p.proacl,acldefault('f',p.proowner))")}) AS line
    FROM pg_proc p WHERE p.pronamespace='public'::regnamespace AND p.prokind IN ('f','p')
  UNION ALL SELECT format('trigger %s enabled=%s deferrable=%s %s',t.tgrelid::regclass,t.tgenabled,t.tgdeferrable,pg_get_triggerdef(t.oid))
    FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid WHERE c.relnamespace='public'::regnamespace AND NOT t.tgisinternal
  UNION ALL SELECT format('relation %s acl=%s',c.relname,${ACL(`COALESCE(c.relacl,acldefault(CASE WHEN c.relkind='S'
      THEN 's'::"char" ELSE 'r'::"char" END,c.relowner))`)})
    FROM pg_class c WHERE c.relnamespace='public'::regnamespace AND c.relkind IN ('r','p','v','m','f','S')
  UNION ALL SELECT format('schema acl=%s',${ACL("COALESCE(n.nspacl,acldefault('n',n.nspowner))")})
    FROM pg_namespace n WHERE n.nspname='public'
  UNION ALL SELECT format('database acl=%s',${ACL("COALESCE(d.datacl,acldefault('d',d.datdba))")})
    FROM pg_database d WHERE d.datname=current_database()
) catalog ORDER BY line`;

let server: TestDatabase | undefined;
const opened: { close: () => Promise<void> }[] = [];
preparePostgresSuite(import.meta.url, async () => { server = await startTestDatabaseThrough(previous); }, 240_000,
  ['no runtime source creates temporary objects']);
afterAll(async () => {
  for (const resource of opened.splice(0).reverse()) await resource.close().catch(() => undefined);
  await closeTestDatabase(server);
});

/** A fresh database of the suite server migrated exactly through `through`. */
async function at(through: string): Promise<EmptyTestDatabase> {
  if (!server) throw new Error('runtime hardening suite was not prepared');
  const database = await startEmptyTestDatabase(server.adminUrl);
  opened.push(database);
  await applyMigrationsThrough(database.adminPool, through);
  return database;
}

async function login(database: EmptyTestDatabase, name: string, group: string): Promise<DatabasePool> {
  const pool = createPool(await provisionTestLogin(database.adminPool, database.adminUrl, name, group), { max: 1 });
  opened.push({ close: () => pool.end() });
  return pool;
}

function code(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : String(error);
}

/** Runs the statements in one transaction and ends it with `end`; deferred triggers fire only on COMMIT. */
async function attempt(pool: DatabasePool, statements: string[], end: 'COMMIT' | 'ROLLBACK' = 'ROLLBACK'): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const statement of statements) await client.query(statement);
    await client.query(end);
    return 'ok';
  } catch (error) {
    return code(error);
  } finally {
    await client.query('ROLLBACK').catch(() => undefined);
    client.release();
  }
}

async function lines(pool: DatabasePool, sql: string): Promise<string[]> {
  return (await pool.query<{ line?: string; name?: string }>(sql)).rows.map(row => row.line ?? row.name ?? '');
}

interface LedgerRow { version: string; source_sha256: string | null; source_origin: string | null }

async function ledger(pool: DatabasePool): Promise<LedgerRow[]> {
  return (await pool.query<LedgerRow>(`SELECT migration.version,ledger.source_sha256,ledger.source_origin
    FROM schema_migrations migration LEFT JOIN schema_migration_ledger ledger USING(version) ORDER BY version`)).rows;
}

async function failure(work: Promise<unknown>): Promise<string> {
  try { await work; return 'ok'; } catch (error) { return error instanceof Error ? error.message : String(error); }
}

async function down(): Promise<string> {
  return readFile(new URL(`../migrations/down/${version}`, import.meta.url), 'utf8');
}

describe('search_path of the functions that name relations', () => {
  it('pins exactly the functions the catalog of 065 lists and leaves the inlined helpers alone', async () => {
    const before = await at(previous);
    expect((await lines(before.adminPool, UNPINNED)).sort()).toEqual([...PINNED_BY_066].sort());
    const after = await at(version);
    expect(await lines(after.adminPool, UNPINNED)).toEqual([]);
    const settings = Object.fromEntries((await after.adminPool.query<{ name: string; config: string[] | null }>(`SELECT
        p.oid::regprocedure::text AS name,p.proconfig AS config FROM pg_proc p WHERE p.oid::regprocedure::text=ANY($1)`,
    [[...PINNED_BY_066, ...INLINED]])).rows.map(row => [row.name, row.config]));
    expect(settings).toEqual(Object.fromEntries([...PINNED_BY_066.map(name => [name, PINNED]), ...INLINED.map(name => [name, null])]));
  });

  it('keeps every function of the complete bundle pinned when it names a relation', async () => {
    const latest = (await migrationSourcesForApply()).at(-1)?.version;
    if (latest === undefined) throw new Error('the migration bundle is empty');
    expect(await lines((await at(latest)).adminPool, UNPINNED)).toEqual([]);
  });

  it('no runtime source creates temporary objects', async () => {
    const root = new URL('../../../', import.meta.url);
    const pattern = /\bCREATE\s+(?:GLOBAL\s+|LOCAL\s+)?TEMP(?:ORARY)?\b|\bINTO\s+TEMP(?:ORARY)?\b|\bpg_temp\./iu;
    const offenders: string[] = [];
    const scan = async (directory: string): Promise<void> => {
      for (const entry of await readdir(new URL(`${directory}/`, root), { withFileTypes: true })) {
        const path = `${directory}/${entry.name}`;
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'test', 'test-support'].includes(entry.name)) await scan(path);
        } else if (/\.(?:[mc]?[jt]s|sql)$/u.test(entry.name) && !/\.test\.[mc]?[jt]s$/u.test(entry.name)
          && pattern.test(await readFile(new URL(path, root), 'utf8'))) offenders.push(path);
      }
    };
    for (const directory of ['services', 'packages/store/src']) await scan(directory);
    expect(offenders).toEqual([]);
  });
});

describe('temporary objects of the runtime logins', () => {
  it('denies TEMPORARY to the runtime and observer logins, also after a restore replays the grants', async () => {
    const database = await at(version);
    const runtime = await login(database, 'cauce_gateway', 'cauce_runtime');
    const observer = await login(database, 'cauce_observer_login', 'cauce_observer');
    const temporary = ['CREATE TEMP TABLE messages(id uuid)'];
    for (const pool of [runtime, observer]) expect(await attempt(pool, temporary)).toBe('42501');
    expect(await attempt(runtime, ['CREATE TEMP VIEW acl_edges AS SELECT 1 AS from_tenant'])).toBe('42501');
    expect((await database.adminPool.query(`SELECT has_database_privilege('cauce_runtime',current_database(),'TEMPORARY') AS runtime,
        has_database_privilege('cauce_observer',current_database(),'TEMPORARY') AS observer,
        has_database_privilege('cauce_runtime',current_database(),'CONNECT') AS connect`)).rows)
      .toEqual([{ runtime: false, observer: false, connect: true }]);
    // A restore lands in a new database, whose default ACL grants TEMPORARY to PUBLIC again.
    await database.adminPool.query(`DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO PUBLIC',current_database()); END $$`);
    expect(await attempt(runtime, temporary)).toBe('ok');
    await database.adminPool.query('SELECT cauce_apply_runtime_grants()');
    expect(await attempt(runtime, temporary)).toBe('42501');
    expect(await attempt(runtime, ['SELECT cauce_runtime_grants_066()'])).toBe('42501');
  });

  it('resolves the real tables in the hub-star guards even when a runtime login is forced TEMPORARY', async () => {
    const outcomes: Record<string, Record<string, string>> = {};
    for (const through of [previous, version]) {
      const database = await at(through);
      await seedCompanyIsolation(database.adminPool);
      await database.adminPool.query(`INSERT INTO acl_edges(from_tenant,to_tenant,enabled,allow_route,allow_read,allow_control)
        VALUES('PraxisHub','PraxisTeam',true,true,true,true)`);
      const runtime = await login(database, 'cauce_gateway', 'cauce_runtime');
      await database.adminPool.query(`DO $$ BEGIN EXECUTE format('GRANT TEMPORARY ON DATABASE %I TO cauce_gateway',current_database()); END $$`);
      const message = `INSERT INTO public.messages(id,request_id,trace_id,tenant_id,room_id,actor_alias,body,lane)
        VALUES('11111111-1111-4111-8111-111111111111',gen_random_uuid(),'hardening','PraxisTeam','company-team','team_agent',
          '{"text":"cross company"}','interactive')`;
      const delivery = `INSERT INTO deliveries(message_id,recipient_tenant,recipient_alias)
        VALUES('11111111-1111-4111-8111-111111111111','Miguel','janus')`;
      const demote = "UPDATE tenants SET is_hub=false WHERE id='PraxisHub'";
      outcomes[through] = {
        delivery: await attempt(runtime, [message, delivery]),
        demotion: await attempt(runtime, [demote]),
        shadowedDelivery: await attempt(runtime, ['CREATE TEMP TABLE messages(id uuid,tenant_id text) ON COMMIT DROP', message, delivery]),
        shadowedDemotion: await attempt(runtime, ['CREATE TEMP TABLE acl_edges(from_tenant text,to_tenant text) ON COMMIT DROP', demote]),
      };
    }
    // 065 reproduces the bypass the shadowing tables opened; 066 keeps the guards on public.
    expect(outcomes).toEqual({
      [previous]: { delivery: '23514', demotion: '23514', shadowedDelivery: 'ok', shadowedDemotion: 'ok' },
      [version]: { delivery: '23514', demotion: '23514', shadowedDelivery: '23514', shadowedDemotion: '23514' },
    });
  });
});

describe('chain policies only change in a platform revision', () => {
  it('rejects a runtime write without a platform revision of the same policy in its transaction', async () => {
    const database = await at(version);
    const people = await seedCompanyIsolation(database.adminPool);
    const runtime = await login(database, 'cauce_gateway', 'cauce_runtime');
    const revision = (operation: Record<string, unknown>): string => `INSERT INTO config_revisions(actor_tenant,actor_alias,
      operation,inverse_operation,summary,scope,actor_human_id)
      VALUES('Steven','kant','${JSON.stringify(operation)}','{}','chain policy','platform','${people.steven}')`;
    const chain = { resource: 'chain_policy', action: 'update', id: 'default', value: { max_fanout_per_turn: 7 } };
    const update = "UPDATE agent_chain_policies SET max_fanout_per_turn=max_fanout_per_turn+1 WHERE id='default'";
    const fanout = async () => (await database.adminPool.query<{ max_fanout_per_turn: number }>(
      "SELECT max_fanout_per_turn FROM agent_chain_policies WHERE id='default'")).rows[0]?.max_fanout_per_turn;
    const initial = await fanout();
    const cases: [string[], string][] = [
      [[update], '42501'],
      [[update, revision(chain)], 'ok'],
      [[revision(chain), update], 'ok'],
      [[update, 'SAVEPOINT revision', revision(chain), 'RELEASE SAVEPOINT revision'], 'ok'],
      [['SAVEPOINT policy', update, 'RELEASE SAVEPOINT policy', revision({ resource: 'batch', mutations: [chain] })], 'ok'],
      [[update, 'SAVEPOINT revision', revision(chain), 'ROLLBACK TO SAVEPOINT revision'], '42501'],
      [[update, revision({ resource: 'harness', action: 'update', id: 'codex', value: {} })], '42501'],
      [[update, revision({ ...chain, id: 'other' })], '42501'],
      [['SET CONSTRAINTS agent_chain_policies_platform_revision IMMEDIATE', update, revision(chain)], '42501'],
    ];
    const results = [];
    for (const [statements] of cases) results.push(await attempt(runtime, statements, 'COMMIT'));
    expect(results).toEqual(cases.map(([, expected]) => expected));
    // A revision committed earlier never covers a later write.
    expect(await attempt(runtime, [revision(chain)], 'COMMIT')).toBe('ok');
    expect(await attempt(runtime, [update], 'COMMIT')).toBe('42501');
    expect(await attempt(database.adminPool, [update], 'COMMIT')).toBe('ok');
    // Four accepted runtime writes and the platform one.
    expect(await fanout()).toBe((initial ?? 0) + 5);
  });

  it('lets a platform administrator change and roll back a chain policy through the runtime login', async () => {
    const database = await at(version);
    const people = await seedCompanyIsolation(database.adminPool);
    const runtime = await login(database, 'cauce_gateway', 'cauce_runtime');
    const repository = new ConfigurationRepository(runtime);
    const steven = (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: people.steven });
    const fanout = async () => (await database.adminPool.query<{ max_fanout_per_turn: number }>(
      "SELECT max_fanout_per_turn FROM agent_chain_policies WHERE id='default'")).rows;
    const before = await fanout();
    const applied = await repository.apply('Steven', 'kant',
      { resource: 'chain_policy', action: 'update', id: 'default', value: { max_fanout_per_turn: 9 } }, false, undefined, steven);
    expect(await fanout()).toEqual([{ max_fanout_per_turn: 9 }]);
    await repository.rollback('Steven', 'kant', applied.revision, false, undefined, steven);
    expect(await fanout()).toEqual(before);
    expect((await database.adminPool.query("SELECT scope FROM config_revisions ORDER BY id")).rows)
      .toEqual([{ scope: 'platform' }, { scope: 'platform' }]);
  });
});

describe('migration 066 rollback', () => {
  it('returns to the 065 catalog and reapplies the same one', async () => {
    const current = await at(version);
    const reference = await at(previous);
    const migrated = await lines(current.adminPool, CATALOG);
    const applied = await ledger(current.adminPool);
    await current.adminPool.query(await down());
    expect(await lines(current.adminPool, CATALOG)).toEqual(await lines(reference.adminPool, CATALOG));
    expect(await ledger(current.adminPool)).toEqual(applied.filter(row => row.version !== version));
    await expect(current.adminPool.query(await down())).resolves.toBeDefined();
    await applyMigrationsThrough(current.adminPool, version);
    expect(await lines(current.adminPool, CATALOG)).toEqual(migrated);
    expect(await ledger(current.adminPool)).toEqual(applied);
  });

  it('refuses after a later migration or with an inconsistent ledger without changing the catalog', async () => {
    const current = await at(version);
    const before = await lines(current.adminPool, CATALOG);
    const client = await current.adminPool.connect();
    try {
      for (const [statement, message] of [
        ["INSERT INTO schema_migrations(version) VALUES('067_later.sql')", 'later migration is present'],
        [`DELETE FROM schema_migration_ledger WHERE version='${version}'`, 'atomic ledger state'],
        [`UPDATE schema_migration_ledger SET source_sha256=repeat('0',64) WHERE version='${version}'`, 'atomic ledger state'],
      ] as const) {
        await client.query('BEGIN');
        await client.query(statement);
        expect(await failure(client.query(await down()))).toContain(message);
        await client.query('ROLLBACK');
      }
    } finally {
      await client.query('ROLLBACK').catch(() => undefined);
      client.release();
    }
    expect(await lines(current.adminPool, CATALOG)).toEqual(before);
  });
});
