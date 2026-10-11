import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PeopleAdminRepository } from '../../../services/gateway/src/console/people-admin-store.js';
import type { PeopleAdminActor, PeopleAdminPerson } from '../../../services/gateway/src/console/people-admin-schema.js';
import { maintainConsoleUser } from '../../../services/gateway/src/console-user-maintenance.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

const PASSWORD_HASH = '$scrypt$' + 'x'.repeat(48);
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let repository: PeopleAdminRepository;
let ids: CompanyIsolationFixture;
let steven: PeopleAdminPerson;
let miguel: PeopleAdminPerson;
let leon: PeopleAdminPerson;
let zeus: PeopleAdminPerson;
let second: PeopleAdminPerson;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

async function human(id: string): Promise<PeopleAdminPerson> {
  const row = (await admin.query<PeopleAdminPerson>(`SELECT id,email,display_name,role,tenant_id,alias,active,
    (extract(epoch FROM updated_at)*1000000)::numeric(20,0)::text AS revision FROM console_users WHERE id=$1`, [id])).rows[0];
  if (!row) throw new Error('human absent');
  return row;
}
/** A live agent alias in a tenant room, so a person can be placed on it. */
async function slot(tenant: string, room: string, alias: string): Promise<void> {
  await admin.query("INSERT INTO agents(tenant_id,alias,harness_id) VALUES($1,$2,'codex')", [tenant, alias]);
  await admin.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'operator')", [tenant, room, alias]);
}
/** An operator with a controlling home membership, as every administrator needs. */
async function operator(email: string, tenant: string, room: string, alias: string): Promise<PeopleAdminPerson> {
  await slot(tenant, room, alias);
  const id = (await admin.query<{ id: string }>(`INSERT INTO console_users(email,email_normalized,password_hash,display_name,role,tenant_id,alias)
    VALUES($1,$1,$2,$1,'operator',$3,$4) RETURNING id::text`, [email, PASSWORD_HASH, tenant, alias])).rows[0]?.id;
  if (!id) throw new Error('operator absent');
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,$2,$3,'operator',ARRAY['read','control'])`, [id, tenant, alias]);
  return human(id);
}
function actor(person: PeopleAdminPerson): PeopleAdminActor {
  return { tenant_id: person.tenant_id, alias: person.alias, subject: `console:${person.id}`,
    humanAuthority: async () => ({ humanId: person.id, tenantId: person.tenant_id, actorAlias: person.alias }) };
}
let counter = 0;
async function target(): Promise<PeopleAdminPerson> {
  counter += 1;
  await slot('Steven', 'company-humanizar', `target-${String(counter)}`);
  return repository.create(actor(miguel), { email: `target-${String(counter)}@example.test`, display_name: 'Target', role: 'reader',
    tenant_id: 'Steven', alias: `target-${String(counter)}`, active: true, password: 'synthetic-company-password' });
}
async function fresh(person: PeopleAdminPerson): Promise<PeopleAdminPerson> { return human(person.id); }

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  ids = await seedCompanyIsolation(admin);
  steven = await human(ids.steven); miguel = await human(ids.miguel); leon = await human(ids.leon);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [ids.leon]);
  await admin.query("INSERT INTO rooms(id,tenant_id) VALUES('company-miguel','Miguel')");
  await admin.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES('Steven','company-humanizar','kant','operator'),('Miguel','company-miguel','janus','operator')`);
  zeus = await operator('zeus@example.test', 'Steven', 'company-humanizar', 'zeus-seat');
  second = await operator('second@example.test', 'Steven', 'company-humanizar', 'second-seat');
  await admin.query(`INSERT INTO company_admins(company_id,human_id,role,source,granted_by) VALUES('humanizar',$1,'admin','platform',$2),
    ('humanizar',$3,'admin','platform',$2)`, [zeus.id, ids.steven, second.id]);
  repository = new PeopleAdminRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

describe('people administration by owners and administrators', () => {
  it('lets an owner outside the hub administer the people of the company', async () => {
    expect((await admin.query('SELECT is_hub FROM tenants WHERE id=$1', ['Miguel'])).rows).toEqual([{ is_hub: false }]);
    const created = await target();
    const changed = await repository.update(actor(miguel), created.id, { expected_revision: created.revision, display_name: 'Renamed' });
    const retired = await repository.retire(actor(miguel), created.id, { expected_revision: changed.revision });
    const restored = await repository.restore(actor(miguel), created.id, { expected_revision: retired.revision });
    expect(restored).toMatchObject({ display_name: 'Renamed', active: true });
    const listed = (await repository.list(actor(miguel))).items.map(row => row.id);
    expect(listed).toEqual(expect.arrayContaining([created.id, miguel.id, steven.id, zeus.id]));
    const event = (await admin.query<{ company_id: string; actor_human_id: string }>(
      "SELECT company_id,actor_human_id::text FROM audit_events WHERE action='people.update'")).rows;
    expect(event).toEqual(Array(3).fill({ company_id: 'humanizar', actor_human_id: miguel.id }));
  });

  it('lets an administrator manage plain people but not owners, administrators or the platform', async () => {
    const created = await target();
    const edited = await repository.update(actor(zeus), created.id, { expected_revision: created.revision, display_name: 'By admin' });
    expect(edited.display_name).toBe('By admin');
    for (const protectedPerson of [miguel, steven, second]) {
      await expect(repository.update(actor(zeus), protectedPerson.id, { expected_revision: protectedPerson.revision, display_name: 'Nope' }))
        .rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.retire(actor(zeus), protectedPerson.id, { expected_revision: protectedPerson.revision }))
        .rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.purge(actor(zeus), protectedPerson.id, { expected_revision: protectedPerson.revision }))
        .rejects.toMatchObject({ code: 'forbidden' });
    }
    expect((await admin.query("SELECT count(*)::int AS n FROM console_users WHERE display_name='Nope'")).rows).toEqual([{ n: 0 }]);
  });

  it('lets an owner edit an administrator but never another owner or the platform administrator', async () => {
    const edited = await repository.update(actor(miguel), second.id, { expected_revision: second.revision, display_name: 'Admin by owner' });
    expect(edited.display_name).toBe('Admin by owner');
    await expect(repository.update(actor(miguel), steven.id, { expected_revision: steven.revision, display_name: 'Nope' }))
      .rejects.toMatchObject({ code: 'forbidden' });
    await admin.query("DELETE FROM company_admins WHERE human_id=$1 AND role='owner'", [steven.id]);
    await expect(repository.retire(actor(miguel), steven.id, { expected_revision: steven.revision }))
      .rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets the platform administrator manage owners and administrators', async () => {
    const retired = await repository.retire(actor(steven), miguel.id, { expected_revision: miguel.revision });
    expect(retired.active).toBe(false);
    const restored = await repository.restore(actor(steven), miguel.id, { expected_revision: retired.revision });
    expect(restored.active).toBe(true);
    expect((await repository.update(actor(steven), zeus.id, { expected_revision: zeus.revision, display_name: 'By platform' })).display_name)
      .toBe('By platform');
  });

  it('lets nobody change their own role, state or placement, but anybody their name and password', async () => {
    for (const person of [steven, miguel, zeus]) {
      const self = actor(person);
      await expect(repository.update(self, person.id, { expected_revision: person.revision, role: 'reader' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.update(self, person.id, { expected_revision: person.revision, alias: 'company_admin' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.update(self, person.id, { expected_revision: person.revision, email: 'moved@example.test' })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.retire(self, person.id, { expected_revision: person.revision })).rejects.toMatchObject({ code: 'forbidden' });
      await expect(repository.purge(self, person.id, { expected_revision: person.revision })).rejects.toMatchObject({ code: 'forbidden' });
      const renamed = await repository.update(self, person.id, { expected_revision: person.revision, display_name: 'Self name',
        email: person.email.toUpperCase(), password: 'synthetic-self-password' });
      expect(renamed).toMatchObject({ display_name: 'Self name', role: 'operator', active: true });
    }
  });

  it('keeps people of other companies out of reach, as not found', async () => {
    const praxis = await operator('team-lead@example.test', 'PraxisHub', 'company-praxis', 'lead-seat');
    expect((await repository.list(actor(leon))).items.map(row => row.id).sort()).toEqual([leon.id, praxis.id].sort());
    for (const foreign of [praxis, leon]) {
      await expect(repository.update(actor(miguel), foreign.id, { expected_revision: foreign.revision, display_name: 'Foreign' }))
        .rejects.toMatchObject({ code: 'not_found' });
    }
    await expect(repository.create(actor(miguel), { email: 'foreign@example.test', display_name: 'Foreign', role: 'reader',
      tenant_id: 'PraxisHub', alias: 'company_admin', active: false, password: 'synthetic-company-password' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.update(actor(miguel), zeus.id, { expected_revision: zeus.revision, tenant_id: 'PraxisHub', active: false }))
      .rejects.toMatchObject({ code: 'forbidden' });
    expect((await fresh(zeus)).tenant_id).toBe('Steven');
  });

  it('refuses people without a company role and agents that share an administrator identity', async () => {
    const plain = await target();
    await expect(repository.list(actor(plain))).rejects.toMatchObject({ code: 'forbidden' });
    const impostor: PeopleAdminActor = { ...actor(miguel), humanAuthority: async () => ({ humanId: plain.id, tenantId: 'Miguel', actorAlias: 'janus' }) };
    await expect(repository.list(impostor)).rejects.toMatchObject({ code: 'forbidden' });
    await admin.query('UPDATE human_tenant_memberships SET permissions=ARRAY[$2]::text[] WHERE human_id=$1', [miguel.id, 'read']);
    await expect(repository.list(actor(miguel))).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('protects the last owner and answers a purge of an administrator with a conflict', async () => {
    await admin.query("DELETE FROM company_admins WHERE human_id=$1 AND role='owner'", [steven.id]);
    await expect(repository.retire(actor(steven), miguel.id, { expected_revision: miguel.revision })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.update(actor(steven), miguel.id, { expected_revision: miguel.revision, role: 'reader' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await fresh(miguel)).active).toBe(true);
    const retired = await repository.retire(actor(miguel), zeus.id, { expected_revision: zeus.revision });
    await expect(repository.purge(actor(miguel), zeus.id, { expected_revision: retired.revision })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.purge(actor(steven), second.id, { expected_revision: second.revision })).rejects.toMatchObject({ code: 'conflict' });
    expect((await admin.query('SELECT count(*)::int AS n FROM console_users WHERE id=ANY($1::uuid[])', [[zeus.id, second.id]])).rows).toEqual([{ n: 2 }]);
  });

  it('serializes two platform administrators retiring the two owners so one owner always survives', async () => {
    await admin.query("UPDATE company_admins SET role='owner' WHERE human_id=$1", [zeus.id]);
    await admin.query("DELETE FROM company_admins WHERE human_id=$1 AND role='owner'", [steven.id]);
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)', [second.id]);
    const results = await Promise.allSettled([
      repository.retire(actor(steven), miguel.id, { expected_revision: miguel.revision }),
      repository.retire(actor(second), zeus.id, { expected_revision: zeus.revision })]);
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(result => result.status === 'rejected')).toMatchObject([{ reason: { code: 'conflict' } }]);
    expect((await admin.query("SELECT count(*)::int AS n FROM console_users u JOIN company_admins a ON a.human_id=u.id WHERE a.role='owner' AND a.company_id='humanizar' AND u.active")).rows)
      .toEqual([{ n: 1 }]);
  });

  it.each([['42501', 'forbidden'], ['23514', 'conflict']])('translates the database error %s to %s', async (code, expected) => {
    await admin.query(`CREATE FUNCTION people_admin_fault() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'injected' USING ERRCODE='${code}'; END $$`);
    await admin.query('CREATE TRIGGER people_admin_fault BEFORE INSERT ON audit_events FOR EACH ROW EXECUTE FUNCTION people_admin_fault()');
    await expect(repository.update(actor(miguel), zeus.id, { expected_revision: zeus.revision, display_name: 'Faulty' }))
      .rejects.toMatchObject({ code: expected });
    expect((await fresh(zeus)).display_name).toBe('zeus@example.test');
  });

  it('never lets a person hold a membership in a foreign company', async () => {
    await expect(admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [zeus.id])).rejects.toMatchObject({ code: '23503' });
  });
});

describe('console user maintenance across companies', () => {
  const options = { email: 'cli-person@example.test', name: 'Cli', role: 'reader' as const, tenant: 'Steven', alias: 'company_admin',
    updateOnly: false, activate: false };

  it('never moves a person to a tenant of another company', async () => {
    const saved = await maintainConsoleUser(admin, options, PASSWORD_HASH);
    await expect(maintainConsoleUser(admin, { ...options, tenant: 'PraxisHub' }, PASSWORD_HASH)).rejects.toThrow('no cambia de empresa');
    await expect(maintainConsoleUser(admin, { ...options, tenant: 'PraxisHub', updateOnly: true }, PASSWORD_HASH)).rejects.toThrow('no cambia de empresa');
    expect((await admin.query('SELECT tenant_id,company_id FROM console_users WHERE id=$1', [saved.id])).rows)
      .toEqual([{ tenant_id: 'Steven', company_id: 'humanizar' }]);
    const moved = await maintainConsoleUser(admin, { ...options, tenant: 'Miguel', alias: 'janus', updateOnly: true }, PASSWORD_HASH);
    expect(moved).toMatchObject({ tenant_id: 'Miguel', alias: 'janus' });
  });

  it('refuses to create an account without an explicit tenant and alias', async () => {
    await expect(maintainConsoleUser(admin, { ...options, tenant: undefined }, PASSWORD_HASH)).rejects.toThrow('--tenant y --alias');
    await expect(maintainConsoleUser(admin, { ...options, alias: undefined }, PASSWORD_HASH)).rejects.toThrow('--tenant y --alias');
    expect((await admin.query('SELECT 1 FROM console_users WHERE email_normalized=$1', [options.email])).rowCount).toBe(0);
  });
});
