import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertKeepsCompanyAuthority, assertPlatformAdmin, companyRevision, companyScopeSql, lockCompanyAuthority, lockCompanyConfiguration,
  lockPlatformConfiguration, RequestedCompanyUnavailableError, withCompanyContext, withTransaction,
  type CompanyAuthority, type CompanyAuthorityRequest, type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let actors: CompanyIsolationFixture & { zeus: string; isa: string; team: string };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

async function person(tenant: string, alias: string, permissions = ['read', 'control']): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Fixture','operator',$4,$5)`, [id, `${id}@example.test`, '$scrypt$' + 'x'.repeat(48), tenant, alias]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,$2,$3,'operator',$4)`, [id, tenant, alias, permissions]);
  return id;
}

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  const seeded = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [seeded.leon]);
  await admin.query(`UPDATE memberships SET role='operator' WHERE (tenant_id,alias) IN (('Isa','salva'),('Miguel','janus'))`);
  await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','company-humanizar','zeus','operator')");
  const zeus = await person('Steven', 'zeus');
  await admin.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('humanizar',$1,'admin','platform',$2)`,
    [zeus, seeded.steven]);
  actors = { ...seeded, zeus, isa: await person('Isa', 'salva'), team: await person('PraxisTeam', 'team_agent') };
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function resolve(request: CompanyAuthorityRequest): Promise<CompanyAuthority> {
  return withTransaction(pool, client => lockCompanyAuthority(client, request));
}
function summary(authority: CompanyAuthority): Pick<CompanyAuthority, 'role' | 'scope' | 'actingCompany' | 'platformOverride'> {
  return { role: authority.role, scope: authority.scope, actingCompany: authority.actingCompany, platformOverride: authority.platformOverride };
}

describe('company authority resolver on PostgreSQL', () => {
  it('decides the role of every actor from durable facts and never from the hub', async () => {
    const cases: [CompanyAuthorityRequest, ReturnType<typeof summary>][] = [
      [{ tenant: 'Steven', alias: 'kant', humanId: actors.steven },
        { role: 'platform_admin', scope: 'platform', actingCompany: 'humanizar', platformOverride: false }],
      [{ tenant: 'Steven', alias: 'kant', humanId: actors.steven, requestedCompany: 'praxis' },
        { role: 'platform_admin', scope: 'platform', actingCompany: 'praxis', platformOverride: true }],
      [{ tenant: 'Miguel', alias: 'janus', humanId: actors.miguel },
        { role: 'company_owner', scope: 'company', actingCompany: 'humanizar', platformOverride: false }],
      [{ tenant: 'Miguel', alias: 'janus', humanId: actors.miguel, requestedCompany: 'praxis' },
        { role: 'company_owner', scope: 'company', actingCompany: 'humanizar', platformOverride: false }],
      [{ tenant: 'Steven', alias: 'zeus', humanId: actors.zeus },
        { role: 'company_admin', scope: 'company', actingCompany: 'humanizar', platformOverride: false }],
      [{ tenant: 'Isa', alias: 'salva', humanId: actors.isa },
        { role: 'tenant_operator', scope: 'tenant', actingCompany: 'humanizar', platformOverride: false }],
      [{ tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon, requestedCompany: 'humanizar' },
        { role: 'company_owner', scope: 'company', actingCompany: 'praxis', platformOverride: false }],
      [{ tenant: 'PraxisTeam', alias: 'team_agent', humanId: actors.team, requestedCompany: 'humanizar' },
        { role: 'tenant_operator', scope: 'tenant', actingCompany: 'praxis', platformOverride: false }],
      [{ tenant: 'Miguel', alias: 'janus', requestedCompany: 'praxis' },
        { role: 'tenant_operator', scope: 'tenant', actingCompany: 'humanizar', platformOverride: false }],
      [{ tenant: 'Steven', alias: 'kant', requestedCompany: 'praxis' },
        { role: 'tenant_operator', scope: 'tenant', actingCompany: 'humanizar', platformOverride: false }],
    ];
    for (const [request, expected] of cases) expect([request, summary(await resolve(request))]).toEqual([request, expected]);
    const agent = await resolve({ tenant: 'Miguel', alias: 'janus' });
    expect(agent).toMatchObject({ humanId: null, homeTenant: 'Miguel', alias: 'janus', homeCompany: 'humanizar' });
  });

  it('refuses an unusable requested company instead of acting at home, and ignores the claim once the platform role is revoked', async () => {
    const steven = { tenant: 'Steven', alias: 'kant', humanId: actors.steven };
    for (const state of ['disabled', 'retired']) {
      await withTransaction(admin, client => client.query('SELECT cauce_platform_set_company_state($1,$2,$3)', ['praxis', state, actors.steven]));
      const refused = resolve({ ...steven, requestedCompany: 'praxis' });
      await expect(refused).rejects.toBeInstanceOf(RequestedCompanyUnavailableError);
      await expect(refused).rejects.toMatchObject({ code: 'forbidden', company: 'praxis' });
      expect(summary(await resolve(steven))).toEqual({ role: 'platform_admin', scope: 'platform', actingCompany: 'humanizar', platformOverride: false });
      expect(summary(await resolve({ ...steven, requestedCompany: 'humanizar' }))).toMatchObject({ actingCompany: 'humanizar' });
      expect(summary(await resolve({ tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon })))
        .toEqual({ role: 'none', scope: 'none', actingCompany: 'praxis', platformOverride: false });
    }
    await expect(resolve({ ...steven, requestedCompany: 'absent' })).rejects.toBeInstanceOf(RequestedCompanyUnavailableError);
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)', [actors.miguel]);
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [actors.steven]);
    expect(summary(await resolve({ ...steven, requestedCompany: 'praxis' })))
      .toEqual({ role: 'company_owner', scope: 'company', actingCompany: 'humanizar', platformOverride: false });
  });

  it('requires an active operator with a controlling home membership for company authority', async () => {
    const miguel = { tenant: 'Miguel', alias: 'janus', humanId: actors.miguel };
    await admin.query("UPDATE human_tenant_memberships SET permissions=ARRAY['read'] WHERE human_id=$1", [actors.miguel]);
    expect(summary(await resolve(miguel))).toMatchObject({ role: 'reader', scope: 'tenant' });
    await admin.query('UPDATE human_tenant_memberships SET enabled=false,revoked_at=now() WHERE human_id=$1', [actors.miguel]);
    expect(summary(await resolve(miguel))).toMatchObject({ role: 'none', scope: 'none' });
    await admin.query('UPDATE console_users SET active=false WHERE id=$1', [actors.miguel]);
    await expect(resolve(miguel)).rejects.toMatchObject({ code: 'forbidden' });
    for (const request of [{ tenant: 'Steven', alias: 'kant', humanId: actors.isa }, { tenant: 'Absent', alias: 'kant' },
      { tenant: 'Steven', alias: 'kant', humanId: actors.steven, requestedCompany: 'Not A Company' }]) {
      await expect(resolve(request)).rejects.toMatchObject({ code: 'forbidden' });
    }
  });

  it('refuses a membership write that leaves a company or the platform without a qualified holder', async () => {
    const strip = (human: string, permissions: string[] = ['read']) => withTransaction(pool, async (client) => {
      await client.query('UPDATE human_tenant_memberships SET permissions=$2 WHERE human_id=$1', [human, permissions]);
      await assertKeepsCompanyAuthority(client, human);
    });
    const permissions = async (human: string) => (await admin.query<{ permissions: string[] }>(
      'SELECT permissions FROM human_tenant_memberships WHERE human_id=$1', [human])).rows[0]?.permissions;
    await strip(actors.zeus);
    await strip(actors.miguel);
    await expect(strip(actors.steven)).rejects.toMatchObject({ code: 'conflict', message: 'company humanizar must keep a qualified owner' });
    await strip(actors.miguel, ['read', 'control']);
    await expect(strip(actors.steven)).rejects.toMatchObject({ code: 'conflict', message: 'the platform must keep a qualified administrator' });
    expect(await permissions(actors.steven)).toEqual(['read', 'control']);
    await expect(strip(actors.leon)).rejects.toMatchObject({ code: 'conflict', message: 'company praxis must keep a qualified owner' });
    await strip(actors.isa, []);
  });

  it('accepts only a platform administrator resolved from a person', async () => {
    expect(() => { assertPlatformAdmin(Object.freeze({ humanId: null, homeTenant: 'Steven', alias: 'kant', homeCompany: 'humanizar',
      actingCompany: 'humanizar', role: 'platform_admin', scope: 'platform', platformOverride: false })); }).toThrow('platform administrator');
    expect(() => { assertPlatformAdmin(Object.freeze({ humanId: actors.miguel, homeTenant: 'Miguel', alias: 'janus', homeCompany: 'humanizar',
      actingCompany: 'humanizar', role: 'company_owner', scope: 'company', platformOverride: false })); }).toThrow('platform administrator');
    assertPlatformAdmin(await resolve({ tenant: 'Steven', alias: 'kant', humanId: actors.steven }));
  });
});

describe('company scope, locks, revisions and context', () => {
  it('scopes tenant columns to a company parameter and refuses anything but identifiers', async () => {
    const tenants = await pool.query<{ id: string }>(`SELECT id FROM tenants tenant WHERE ${companyScopeSql('tenant.id', '$1')} ORDER BY id`, ['praxis']);
    expect(tenants.rows.map(row => row.id)).toEqual(['PraxisHub', 'PraxisTeam']);
    expect(() => companyScopeSql('id; DROP TABLE tenants', '$1')).toThrow('company scope');
    expect(() => companyScopeSql('id', "'praxis'")).toThrow('company scope');
  });

  it('lets two companies write at once while one company, the platform and V4.0 writers exclude each other', async () => {
    const clients: DatabaseClient[] = [];
    const open = async (): Promise<DatabaseClient> => {
      const client = await pool.connect(); clients.push(client);
      await client.query('BEGIN'); await client.query("SET LOCAL lock_timeout='200ms'"); return client;
    };
    try {
      const humanizar = await open();
      await lockCompanyConfiguration(humanizar, 'humanizar');
      await lockCompanyConfiguration(await open(), 'praxis');
      const held = await pool.query<{ count: string }>(`SELECT count(*)::text AS count FROM pg_locks
        WHERE locktype='advisory' AND granted AND pid=ANY($1::int[])`, [clients.map(client => (client as unknown as { processID: number }).processID)]);
      expect(held.rows[0]?.count).toBe('4');
      await expect(lockCompanyConfiguration(await open(), 'humanizar')).rejects.toMatchObject({ code: '55P03' });
      await expect(lockPlatformConfiguration(await open())).rejects.toMatchObject({ code: '55P03' });
      await expect((await open()).query('SELECT pg_advisory_xact_lock(783_003_004)')).rejects.toMatchObject({ code: '55P03' });
      for (const client of clients.splice(0)) { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
      await lockPlatformConfiguration(await open());
      await expect(lockCompanyConfiguration(await open(), 'praxis')).rejects.toMatchObject({ code: '55P03' });
    } finally {
      for (const client of clients) { await client.query('ROLLBACK').catch(() => undefined); client.release(); }
    }
  });

  it('counts the company revisions together with every platform revision', async () => {
    const revise = async (tenant: string, alias: string, operation: string): Promise<number> => Number((await admin.query<{ id: string }>(
      `INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
       VALUES($1,$2,$3::jsonb,$3::jsonb,'fixture') RETURNING id::text`, [tenant, alias, operation])).rows[0]?.id);
    const humanizar = await revise('Steven', 'kant', '{}');
    expect(await withTransaction(pool, client => companyRevision(client, 'praxis'))).toBe(0);
    const praxis = await revise('PraxisHub', 'company_admin', '{}');
    expect(await withTransaction(pool, client => companyRevision(client, 'humanizar'))).toBe(humanizar);
    const platform = await revise('Steven', 'kant', '{"resource":"harness"}');
    expect(await withTransaction(pool, client => companyRevision(client, 'praxis'))).toBe(platform);
    await revise('Steven', 'kant', '{}');
    expect(await withTransaction(pool, client => companyRevision(client, 'praxis'))).toBe(platform);
    expect(praxis).toBeLessThan(platform);
  });

  it('names the acting company only inside its transaction', async () => {
    const inside = await withCompanyContext(pool, 'praxis', async client =>
      (await client.query<{ company: string }>("SELECT current_setting('cauce.company_id') AS company")).rows[0]?.company);
    expect(inside).toBe('praxis');
    await expect(withCompanyContext(pool, 'Praxis!', async () => 'unreachable')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});
