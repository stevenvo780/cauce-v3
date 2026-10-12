import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ConfigLeafMutation } from '@cauce/protocol';
import {
  ConfigurationRepository, lockCompanyAuthority, withTransaction, type ConfigurationAuthorityResolver, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let repository: ConfigurationRepository;
let actors: CompanyIsolationFixture & { isa: string; zeus: string };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

const OWNER_REFUSAL = /^un dueño no puede deshabilitar ni retirar el acceso de otro dueño/u;
const ADMIN_REFUSAL = /^solo un dueño o la plataforma pueden deshabilitar o retirar el acceso de un administrador/u;

async function person(tenant: string, alias: string): Promise<string> {
  const id = randomUUID();
  await admin.query(`INSERT INTO console_users(id,email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$2,$2,$3,'Fixture','operator',$4,$5)`, [id, `${id}@example.test`, '$scrypt$' + 'x'.repeat(48), tenant, alias]);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,$2,$3,'operator',ARRAY['read','control'])`, [id, tenant, alias]);
  await admin.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('humanizar',$1,'admin','platform',$1)`, [id]);
  return id;
}

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  const seeded = await seedCompanyIsolation(admin);
  await admin.query(`UPDATE memberships SET role='operator' WHERE (tenant_id,alias) IN (('Isa','salva'),('Miguel','janus'))`);
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Steven','company-humanizar','zeus','operator')`);
  actors = { ...seeded, isa: await person('Isa', 'salva'), zeus: await person('Steven', 'zeus') };
  repository = new ConfigurationRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function as(tenant: string, alias: string, humanId: string): ConfigurationAuthorityResolver {
  return client => lockCompanyAuthority(client, { tenant, alias, humanId });
}
const isa = (): ConfigurationAuthorityResolver => as('Isa', 'salva', actors.isa);
const miguel = (): ConfigurationAuthorityResolver => as('Miguel', 'janus', actors.miguel);

async function role(humanId: string, tenant: string, alias: string): Promise<string> {
  return withTransaction(pool, async client => (await lockCompanyAuthority(client, { tenant, alias, humanId })).role);
}

/** Every switch an actor could flip on Miguel's path to control, plus what the configuration journal holds. */
async function miguelPath(): Promise<unknown> {
  return (await admin.query(`SELECT member.enabled AS member,member.retired_at IS NULL AS member_live,member.role,
      room.enabled AS room,room.retired_at IS NULL AS room_live,tenant.enabled AS tenant,tenant.retired_at IS NULL AS tenant_live,
      agent.enabled AS agent,(SELECT count(*)::int FROM config_revisions) AS revisions,
      (SELECT count(*)::int FROM audit_events WHERE action='config.change') AS audits
    FROM memberships member JOIN rooms room ON room.tenant_id=member.tenant_id AND room.id=member.room_id
    JOIN tenants tenant ON tenant.id=member.tenant_id JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
    WHERE member.tenant_id='Miguel' AND member.room_id='grp.miguel' AND member.alias='janus'`)).rows;
}

const membership = { resource: 'membership', tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus' } as const;
const strippingMiguel: [string, ConfigLeafMutation][] = [
  ['membership disabled', { ...membership, action: 'update', value: { enabled: false } }],
  ['membership demoted', { ...membership, action: 'update', value: { role: 'agent' } }],
  ['membership retired', { ...membership, action: 'retire' }],
  ['room disabled', { resource: 'room', action: 'update', tenant_id: 'Miguel', id: 'grp.miguel', value: { enabled: false } }],
  ['room retired', { resource: 'room', action: 'retire', tenant_id: 'Miguel', id: 'grp.miguel' }],
  ['tenant disabled', { resource: 'tenant', action: 'update', id: 'Miguel', value: { enabled: false } }],
  ['tenant retired', { resource: 'tenant', action: 'retire', id: 'Miguel' }],
  ['agent disabled', { resource: 'agent', action: 'update', tenant_id: 'Miguel', alias: 'janus', value: { enabled: false } }],
];

function disabling(tenant: string, room: string, alias: string): ConfigLeafMutation {
  return { resource: 'membership', action: 'update', tenant_id: tenant, room_id: room, alias, value: { enabled: false } };
}

describe('configuration respects the company hierarchy of its holders', () => {
  it.each(strippingMiguel)('refuses an administrator the owner access change: %s', async (_name, mutation) => {
    const before = await miguelPath();
    for (const dryRun of [true, false]) {
      await expect(repository.apply('Isa', 'salva', mutation, dryRun, undefined, isa()))
        .rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(ADMIN_REFUSAL) as unknown });
    }
    expect(await miguelPath()).toEqual(before);
    expect(await role(actors.miguel, 'Miguel', 'janus')).toBe('company_owner');
  });

  it('refuses an owner the access of another owner and of a platform administrator', async () => {
    await admin.query("UPDATE company_admins SET role='owner' WHERE human_id=$1", [actors.isa]);
    await expect(repository.apply('Miguel', 'janus', disabling('Isa', 'grp.isa', 'salva'), false, undefined, miguel()))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(OWNER_REFUSAL) as unknown });
    await admin.query("DELETE FROM company_admins WHERE human_id=$1 AND company_id='humanizar'", [actors.steven]);
    await expect(repository.apply('Miguel', 'janus', { resource: 'tenant', action: 'update', id: 'Steven', value: { enabled: false } },
      false, undefined, miguel())).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(OWNER_REFUSAL) as unknown });
    expect([await role(actors.isa, 'Isa', 'salva'), await role(actors.steven, 'Steven', 'kant')]).toEqual(['company_owner', 'platform_admin']);
    expect((await admin.query('SELECT id FROM config_revisions')).rows).toEqual([]);
  });

  it('lets an owner remove an administrator and refuses that to another administrator', async () => {
    await expect(repository.apply('Steven', 'zeus', disabling('Isa', 'grp.isa', 'salva'), false, undefined, as('Steven', 'zeus', actors.zeus)))
      .rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(ADMIN_REFUSAL) as unknown });
    expect(await role(actors.isa, 'Isa', 'salva')).toBe('company_admin');
    expect((await repository.apply('Miguel', 'janus', disabling('Isa', 'grp.isa', 'salva'), false, undefined, miguel())).applied).toBe(true);
    expect(await role(actors.isa, 'Isa', 'salva')).not.toBe('company_admin');
  });

  it('allows what leaves every holder qualified and refuses the change that removes the last path', async () => {
    await admin.query(`INSERT INTO rooms(id,tenant_id) VALUES('miguel-spare','Miguel');
      INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES('Miguel','miguel-spare','janus','operator')`);
    expect((await repository.apply('Isa', 'salva', disabling('Miguel', 'grp.miguel', 'kratos'), false, undefined, isa())).applied).toBe(true);
    expect((await repository.apply('Isa', 'salva', disabling('Miguel', 'grp.miguel', 'janus'), false, undefined, isa())).applied).toBe(true);
    await expect(repository.apply('Isa', 'salva', disabling('Miguel', 'miguel-spare', 'janus'), false, undefined, isa()))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect(await role(actors.miguel, 'Miguel', 'janus')).toBe('company_owner');
    expect((await admin.query('SELECT count(*)::int AS revisions FROM config_revisions')).rows).toEqual([{ revisions: 2 }]);
  });

  it('lets the platform remove an owner access and audits it', async () => {
    const applied = await repository.apply('Steven', 'kant', disabling('Miguel', 'grp.miguel', 'janus'), false, undefined,
      as('Steven', 'kant', actors.steven));
    expect(applied.applied).toBe(true);
    expect(await role(actors.miguel, 'Miguel', 'janus')).not.toBe('company_owner');
    expect((await admin.query(`SELECT company_id,actor_human_id::text,metadata->>'revision' AS revision FROM audit_events
      WHERE action='config.change'`)).rows).toEqual([{ company_id: 'humanizar', actor_human_id: actors.steven, revision: String(applied.revision) }]);
  });
});
