import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigMutation } from '@cauce/protocol';
import {
  applyMigrations, applyPlatformConfiguration, ConfigurationRepository, createPool, lockCompanyAuthority, lockConsoleHuman, lockHumanIdentity, withTransaction,
  type ConfigurationAuthorityResolver, type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import {
  esBaseDePruebas, provisionTestLogin, startTestCaseDatabase, startTestDatabase, TEST_RUNTIME_LOGIN,
  type EmptyTestDatabase, type TestDatabase,
} from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { consoleHumanAccess } from '../../../services/gateway/src/console-human-authority.js';
import { createConsoleCredentialStamp } from '../../../services/gateway/src/console-credential-stamp.js';
import { PostgresConsoleUserStore } from '../../../services/gateway/src/console-users.js';
import { PasswordAuthProvider, signConsoleSession } from '../../../services/gateway/src/password-auth.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let repository: ConfigurationRepository;
let actors: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => {
  if (!process.env.CAUCE_TEST_DATABASE_URL) database = await startTestDatabase();
}, 120_000);

async function exclusiveCase(): Promise<EmptyTestDatabase> {
  const external = process.env.CAUCE_TEST_ADMIN_DATABASE_URL ?? process.env.CAUCE_TEST_DATABASE_URL;
  if (!external) {
    if (!database) throw new Error('test database absent');
    const isolated = await startTestCaseDatabase(database);
    try {
      const runtimeUrl = await provisionTestLogin(isolated.adminPool, isolated.adminUrl, TEST_RUNTIME_LOGIN, 'cauce_runtime');
      const runtime = createPool(runtimeUrl);
      return { ...isolated, pool: runtime, url: runtimeUrl, close: async () => {
        await runtime.end(); await isolated.close();
      } };
    } catch (error) { await isolated.close(); throw error; }
  }
  if (!esBaseDePruebas(external)) throw new Error('disposable test database required');
  const server = createPool(external);
  const name = `cauce_test_platform_continuity_${randomUUID().replaceAll('-', '')}`;
  const target = new URL(external); target.pathname = `/${name}`;
  try {
    await server.query(`CREATE DATABASE ${name} TEMPLATE cauce_test_plantilla`);
    const adminPool = createPool(target.toString());
    try {
      await applyMigrations(adminPool);
      const runtimeUrl = await provisionTestLogin(adminPool, target.toString(), TEST_RUNTIME_LOGIN, 'cauce_runtime');
      const runtime = createPool(runtimeUrl);
      return { pool: runtime, adminPool, url: runtimeUrl, adminUrl: target.toString(), close: async () => {
        await Promise.all([runtime.end(), adminPool.end()]);
        const cleanup = createPool(external);
        try { await cleanup.query(`DROP DATABASE ${name}`); } finally { await cleanup.end(); }
      } };
    } catch (error) {
      await adminPool.end(); await server.query(`DROP DATABASE ${name}`); throw error;
    }
  } finally { await server.end(); }
}

beforeEach(async () => {
  current = await exclusiveCase(); pool = current.pool; admin = current.adminPool;
  actors = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [actors.leon]);
  await admin.query(`UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus';
    DELETE FROM acl_edges WHERE from_tenant='Steven' OR to_tenant='Steven';
    UPDATE tenants SET is_hub=false WHERE id='Steven';
    UPDATE tenants SET is_hub=true WHERE id='Miguel';
    INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','company-humanizar','kant','operator')`);
  repository = new ConfigurationRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => {
  if (database) { await database.pool.end(); await database.container.stop(); }
});

function as(tenant: string, alias: string, humanId: string, requestedCompany?: string): ConfigurationAuthorityResolver {
  return client => lockCompanyAuthority(client, { tenant, alias, humanId, ...(requestedCompany === undefined ? {} : { requestedCompany }) });
}
const owner = (): ConfigurationAuthorityResolver => as('Miguel', 'janus', actors.miguel);
const steven = (requestedCompany?: string): ConfigurationAuthorityResolver => as('Steven', 'kant', actors.steven, requestedCompany);
/** Below the platform nobody strips a platform administrator, so only another one can leave the platform without one. */
const replacement = (id: string): ConfigurationAuthorityResolver => as('PraxisTeam', 'team_agent', id, 'humanizar');
const platformConflict = 'configuration cannot remove the last qualified platform administrator';

async function authority(humanId = actors.steven, tenant = 'Steven', alias = 'kant'): Promise<string> {
  return withTransaction(pool, async client => (await lockCompanyAuthority(client, { tenant, alias, humanId })).role);
}

async function loss(resource: 'membership' | 'room' | 'tenant', action: 'update' | 'retire' | 'delete' = 'update'): Promise<ConfigMutation> {
  if (resource === 'tenant') return { resource, action: action === 'delete' ? 'retire' : action, id: 'Steven',
    ...(action === 'update' ? { value: { enabled: false } } : {}) };
  const rooms = (await admin.query<{ room_id: string }>(`SELECT member.room_id FROM memberships member
    JOIN role_policies policy ON policy.role=member.role WHERE member.tenant_id='Steven' AND member.alias='kant'
      AND member.enabled AND policy.allow_control ORDER BY member.room_id`)).rows;
  return { resource: 'batch', action: 'apply', mutations: rooms.map(({ room_id }) => resource === 'membership'
    ? { resource, action, tenant_id: 'Steven', room_id, alias: 'kant', ...(action === 'update' ? { value: { role: 'agent' } } : {}) }
    : { resource, action: action === 'delete' ? 'retire' : action, tenant_id: 'Steven', id: room_id,
      ...(action === 'update' ? { value: { enabled: false } } : {}) }) };
}

async function secondPlatform(qualified = true): Promise<string> {
  const id = randomUUID(); const email = `${id}@example.test`;
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Second platform operator','operator','PraxisTeam','team_agent')`,
  [id, email, '$scrypt$' + 'x'.repeat(48)]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisTeam','team_agent','operator',$2);`, [id, qualified ? ['read', 'control'] : ['read']]);
  await admin.query(`INSERT INTO platform_admins(human_id) VALUES($1)`, [id]);
  return id;
}

async function unchanged(): Promise<void> {
  expect(await authority()).toBe('platform_admin');
  expect(await authority(actors.miguel, 'Miguel', 'janus')).toBe('company_owner');
  expect((await admin.query('SELECT id FROM config_revisions')).rows).toEqual([]);
  expect((await admin.query("SELECT id FROM audit_events WHERE action IN ('config.change','config.rollback')")).rows).toEqual([]);
}

async function canonicalChange(mutation: ConfigMutation): Promise<{ app: FastifyInstance; cookie: string }> {
  const users = new PostgresConsoleUserStore(pool);
  const person = await users.findById(actors.steven);
  if (!person?.password_changed_at_us) throw new Error('fixture console person absent');
  const key = Buffer.alloc(32, 37);
  const provider = new PasswordAuthProvider({ users, signingKey: key });
  const issued = Math.floor(Date.now() / 1000);
  const cookie = `__Host-cauce_session=${signConsoleSession(key, {
    iss: 'cauce-v3-gateway', aud: 'cauce-v3-console', sub: person.id, sid: randomUUID(), csrf: 'x'.repeat(32),
    iat: issued, exp: issued + 60, cmp: 'praxis', credential_stamp: createConsoleCredentialStamp(key, {
      userId: person.id, passwordHash: person.password_hash, passwordChangedAtUs: person.password_changed_at_us,
    }),
  })}`;
  const app = Fastify();
  app.post('/change', async (request, reply) => {
    const access = await consoleHumanAccess(provider, request, reply, 'read');
    if (!access) throw new Error('fixture console session absent');
    try { return await repository.apply('Steven', 'kant', mutation, false, undefined, client => access.companyAuthority(client)); }
    finally { access.close(); }
  });
  return { app, cookie };
}

describe('configuration keeps a qualified platform administrator', () => {
  it.each([false, true])('rejects the membership batch of the last administrator with dryRun=%s', async dryRun => {
    expect(await authority()).toBe('platform_admin');
    await expect(repository.apply('Steven', 'kant', await loss('membership'), dryRun, undefined, steven()))
      .rejects.toMatchObject({ code: 'conflict', message: platformConflict });
    await unchanged();
  });

  it.each([['membership', 'retire'], ['membership', 'delete'], ['room', 'update'], ['room', 'retire'],
    ['tenant', 'update'], ['tenant', 'retire']] as const)('rejects %s %s when it removes the last administrator', async (resource, action) => {
    await expect(repository.apply('Steven', 'kant', await loss(resource, action), false, undefined, steven()))
      .rejects.toMatchObject({ code: 'conflict', message: platformConflict });
    await unchanged();
  });

  it('does not count a dormant platform role as a qualified replacement', async () => {
    const second = await secondPlatform(false);
    expect(await authority(second, 'PraxisTeam', 'team_agent')).toBe('reader');
    await expect(repository.apply('Steven', 'kant', await loss('membership'), false, undefined, steven()))
      .rejects.toMatchObject({ code: 'conflict' });
    await unchanged();
  });

  it('allows a change when a qualified administrator in another company remains', async () => {
    const second = await secondPlatform();
    expect(await authority(second, 'PraxisTeam', 'team_agent')).toBe('platform_admin');
    await expect(repository.apply('Miguel', 'janus', await loss('membership'), false, undefined, owner()))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect((await repository.apply('PraxisTeam', 'team_agent', await loss('membership'), false, undefined, replacement(second))).applied)
      .toBe(true);
    expect(await authority()).toBe('reader');
    expect(await authority(second, 'PraxisTeam', 'team_agent')).toBe('platform_admin');
  });

  it.each([false, true])('rejects rollback dryRun=%s after the replacement leaves', async dryRun => {
    const second = await secondPlatform();
    const removed = await repository.apply('PraxisTeam', 'team_agent', await loss('membership'), false, undefined, replacement(second));
    const restored = await repository.apply('PraxisTeam', 'team_agent', removed.inverse_mutation, false, undefined, replacement(second));
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [second]);
    await expect(repository.rollback('Steven', 'kant', restored.revision, dryRun, undefined, steven()))
      .rejects.toMatchObject({ code: 'conflict', message: platformConflict });
    expect(await authority()).toBe('platform_admin');
    expect((await admin.query('SELECT id FROM config_revisions')).rowCount).toBe(2);
    expect((await admin.query("SELECT id FROM audit_events WHERE action='config.rollback'")).rows).toEqual([]);
  });

  it('takes the common guard before holding human authority rows', async () => {
    const blocker = await admin.connect();
    await blocker.query('BEGIN');
    await blocker.query("SELECT cauce_lock_owner_guard('praxis')");
    const attempt = repository.apply('Miguel', 'janus', await loss('membership'), false, undefined, owner())
      .then(result => result, (error: unknown) => error);
    try {
      await expect.poll(async () => (await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND query='SELECT cauce_lock_authority_read_guard()'`)).rowCount, { timeout: 5000 }).toBe(1);
      await blocker.query("SET LOCAL lock_timeout='2s'");
      await blocker.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1", [actors.miguel]);
      await blocker.query('COMMIT');
      expect(await attempt).toMatchObject({ code: 'forbidden' });
      expect(await authority()).toBe('platform_admin');
      expect((await admin.query('SELECT id FROM config_revisions')).rows).toEqual([]);
    } finally { await blocker.query('ROLLBACK'); blocker.release(); await attempt; }
  });

  it('serializes losses in two companies and commits only one', async () => {
    const second = await secondPlatform();
    let ready = 0;
    let release!: () => void;
    const together = new Promise<void>(resolve => { release = resolve; });
    const synchronized = (resolver: ConfigurationAuthorityResolver): ConfigurationAuthorityResolver => {
      let first = true;
      return async client => {
        const result = await resolver(client);
        if (first) { first = false; ready += 1; if (ready === 2) release(); await together; }
        return result;
      };
    };
    const mutation = await loss('membership');
    const outcomes = await Promise.allSettled([
      repository.apply('PraxisTeam', 'team_agent', mutation, false, undefined, synchronized(replacement(second))),
      repository.apply('Steven', 'kant', { resource: 'membership', action: 'update', tenant_id: 'PraxisTeam',
        room_id: 'company-team', alias: 'team_agent', value: { role: 'agent' } }, false, undefined, synchronized(steven('praxis'))),
    ]);
    expect(outcomes.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter(result => result.status === 'rejected')).toHaveLength(1);
    for (const outcome of outcomes) {
      if (outcome.status === 'rejected') expect(outcome.reason as unknown).toMatchObject({ code: 'conflict' });
    }
    expect([await authority(), await authority(second, 'PraxisTeam', 'team_agent')]
      .filter(role => role === 'platform_admin')).toHaveLength(1);
    expect((await admin.query('SELECT id FROM config_revisions')).rowCount).toBe(1);
  });

  it.each(['direct', 'console', 'oauth'] as const)('keeps a legitimate writer and incomplete authority peek free of deadlock with mode=%s', async mode => {
    let resume!: () => void;
    let held!: () => void;
    let calls = 0;
    const writing = new Promise<void>(resolve => { held = resolve; });
    const ready = new Promise<void>(resolve => { resume = resolve; });
    const second: ConfigMutation = { resource: 'membership', action: 'update', tenant_id: 'PraxisTeam', room_id: 'company-team',
      alias: 'team_agent', value: { role: 'operator' } };
    const route = mode === 'console' ? await canonicalChange(second) : undefined;
    if (mode === 'oauth') await admin.query(`INSERT INTO human_external_identities(human_id,provider,namespace,subject)
      VALUES($1::uuid,'oauth','authority-guard-fixture',$1::uuid::text)`, [actors.steven]);
    const firstMutation: ConfigMutation = mode === 'oauth'
      ? { resource: 'tenant', action: 'update', id: 'Steven', value: { display_name: 'Guarded fixture tenant' } }
      : { resource: 'membership', action: 'update', tenant_id: 'Steven', room_id: 'company-humanizar', alias: 'kant', value: { role: 'agent' } };
    const first = repository.apply('Miguel', 'janus', firstMutation, false, undefined, async client => {
      const current = await owner()(client);
      if (++calls === 2) { held(); await ready; }
      return current;
    });
    let attempt: Promise<boolean> | undefined;
    try {
      await writing;
      attempt = route ? route.app.inject({ method: 'POST', url: '/change', headers: { cookie: route.cookie } }).then(response => {
        expect(response.statusCode, response.body).toBe(200);
        return response.json<{ applied: boolean }>().applied;
      }) : repository.apply('Steven', 'kant', second, false, undefined, async client => {
        if (mode === 'oauth') {
          await lockHumanIdentity(client, { provider: 'oauth', namespace: 'authority-guard-fixture', subject: actors.steven }, actors.steven);
          await lockConsoleHuman(client, actors.steven);
        }
        return lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: actors.steven, requestedCompany: 'praxis' });
      }).then(result => result.applied);
      await expect.poll(async () => (await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND (query LIKE 'SELECT home_company,platform_admin,company_role,company_enabled FROM cauce_company_authority%'
          OR query='SELECT cauce_lock_authority_read_guard()')`)).rowCount, { timeout: 5000 }).toBe(1);
      resume();
      const outcomes = await Promise.allSettled([first.then(result => result.applied), attempt]);
      expect(outcomes).toEqual([{ status: 'fulfilled', value: true }, { status: 'fulfilled', value: true }]);
      expect(await authority()).toBe('platform_admin');
      expect((await admin.query('SELECT id FROM config_revisions')).rowCount).toBe(2);
    } finally {
      resume(); await Promise.allSettled([first, attempt]); await route?.app.close();
    }
  });

  it('lets runtime authority readers hold shared guards concurrently', async () => {
    const first = await pool.connect(); const second = await pool.connect();
    try {
      await first.query('BEGIN'); await second.query('BEGIN');
      await first.query("SET LOCAL lock_timeout='500ms'"); await second.query("SET LOCAL lock_timeout='500ms'");
      expect((await lockCompanyAuthority(first, { tenant: 'Steven', alias: 'kant', humanId: actors.steven })).role).toBe('platform_admin');
      expect((await lockCompanyAuthority(second, { tenant: 'Miguel', alias: 'janus', humanId: actors.miguel })).role).toBe('company_owner');
    } finally {
      await first.query('ROLLBACK'); await second.query('ROLLBACK'); first.release(); second.release();
    }
  });

  it('keeps a platform policy update and an authority reader free of deadlock', async () => {
    let resume!: () => void;
    let held!: () => void;
    const changed = new Promise<void>(resolve => { held = resolve; });
    const ready = new Promise<void>(resolve => { resume = resolve; });
    const writer = withTransaction(admin, async client => {
      const query = client.query.bind(client);
      client.query = (async (sql: string, params?: unknown[]) => {
        const result = await query(sql, params);
        if (sql.startsWith('UPDATE role_policies SET')) { held(); await ready; }
        return result;
      }) as DatabaseClient['query'];
      try {
        return await applyPlatformConfiguration(admin, { tenant: 'Steven', alias: 'kant', humanId: actors.steven, companyId: 'humanizar' },
          { resource: 'role_policy', action: 'update', role: 'operator', value: { allow_notify: false } }, false, 0, client);
      } finally { client.query = query; }
    });
    let reader: Promise<string> | undefined;
    try {
      await Promise.race([changed, writer.then(() => { throw new Error('platform writer completed before its policy update'); })]);
      reader = authority(actors.miguel, 'Miguel', 'janus');
      await expect.poll(async () => (await admin.query(`SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
        AND wait_event_type='Lock' AND (query LIKE 'SELECT policy.allow_control,policy.allow_read FROM memberships member%'
          OR query='SELECT cauce_lock_authority_read_guard()')`)).rowCount, { timeout: 5000 }).toBe(1);
      resume();
      const outcomes = await Promise.allSettled([writer.then(result => result.applied), reader]);
      expect(outcomes).toEqual([{ status: 'fulfilled', value: true }, { status: 'fulfilled', value: 'company_owner' }]);
      expect((await admin.query('SELECT id FROM config_revisions')).rowCount).toBe(1);
    } finally { resume(); await Promise.allSettled([writer, reader]); }
  });

  it('keeps the read guard definer scoped and restores its runtime grant through replay', async () => {
    const checked = (await admin.query<{ definer: boolean; config: string[]; definition: string; public_revoked: boolean; observer: boolean }>(
      `SELECT function.prosecdef AS definer,function.proconfig AS config,pg_get_functiondef(function.oid) AS definition,
         NOT EXISTS(SELECT 1 FROM aclexplode(COALESCE(function.proacl,acldefault('f',function.proowner))) permission
           WHERE permission.grantee=0 AND permission.privilege_type='EXECUTE') AS public_revoked,
         has_function_privilege('cauce_observer',function.oid,'EXECUTE') AS observer
       FROM pg_proc function WHERE function.oid='cauce_lock_authority_read_guard()'::regprocedure`)).rows[0];
    expect(checked).toMatchObject({ definer: true, public_revoked: true, observer: false });
    expect(checked?.config).toEqual(['search_path=pg_catalog, public, pg_temp']);
    expect(checked?.definition).toContain('public.platform_admins');
    expect(checked?.definition).toContain('ORDER BY admin.human_id FOR SHARE OF admin');
    expect((await pool.query('SELECT current_user AS role,rolsuper FROM pg_roles WHERE rolname=current_user')).rows)
      .toEqual([{ role: TEST_RUNTIME_LOGIN, rolsuper: false }]);
    await admin.query('REVOKE EXECUTE ON FUNCTION cauce_lock_authority_read_guard() FROM cauce_runtime');
    await expect(pool.query('SELECT cauce_lock_authority_read_guard()')).rejects.toMatchObject({ code: '42501' });
    await admin.query('SELECT cauce_apply_runtime_grants()');
    expect((await pool.query('SELECT cauce_lock_authority_read_guard()')).rowCount).toBe(1);
  });
});
