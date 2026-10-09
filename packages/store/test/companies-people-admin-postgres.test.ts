import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DatabasePool } from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { PeopleAdminRepository } from '../../../services/gateway/src/console/people-admin-store.js';
import type { PeopleAdminActor, PeopleAdminPerson } from '../../../services/gateway/src/console/people-admin-schema.js';
import { seedCompanyActors, seedCompanyHuman } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let repository: PeopleAdminRepository;
let humanizar: PeopleAdminPerson;
let praxis: PeopleAdminPerson;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool;
  await seedCompanyActors(pool);
  humanizar = await human(await seedCompanyHuman(pool, 'Steven'));
  praxis = await human(await seedCompanyHuman(pool, 'PraxisHub'));
  repository = new PeopleAdminRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
async function human(id: string): Promise<PeopleAdminPerson> {
  const row = (await pool.query<PeopleAdminPerson>(`SELECT id,email,display_name,role,tenant_id,alias,active,
    (extract(epoch FROM updated_at)*1000000)::numeric(20,0)::text AS revision FROM console_users WHERE id=$1`, [id])).rows[0];
  if (!row) throw new Error('human absent');
  return row;
}
function actor(person: PeopleAdminPerson): PeopleAdminActor {
  return { tenant_id: person.tenant_id, alias: person.alias, subject: `console:${person.id}`,
    humanAuthority: async () => ({ humanId: person.id, tenantId: person.tenant_id, actorAlias: person.alias }) };
}

describe('people administration within each company', () => {
  it('lists only the actor company and hides foreign mutations as not found', async () => {
    expect((await repository.list(actor(humanizar))).items.map(row => row.id)).toEqual([humanizar.id]);
    expect((await repository.list(actor(praxis))).items.map(row => row.id)).toEqual([praxis.id]);
    await expect(repository.update(actor(praxis), humanizar.id, { expected_revision: humanizar.revision,
      display_name: 'Foreign edit' })).rejects.toMatchObject({ code: 'not_found' });
    await expect(repository.retire(actor(praxis), humanizar.id, { expected_revision: humanizar.revision })).rejects.toMatchObject({ code: 'not_found' });
    await expect(repository.purge(actor(praxis), humanizar.id, { expected_revision: humanizar.revision })).rejects.toMatchObject({ code: 'not_found' });
    expect((await pool.query('SELECT active FROM console_users WHERE id=$1', [humanizar.id])).rows).toEqual([{ active: true }]);
  });
  it('rejects creating or moving people to a different company even when inactive', async () => {
    await expect(repository.create(actor(humanizar), { email: 'foreign@example.test', display_name: 'Foreign', role: 'reader',
      tenant_id: 'PraxisHub', alias: 'company_admin', active: false, password: 'synthetic-company-password' })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.update(actor(humanizar), humanizar.id, { expected_revision: humanizar.revision,
      tenant_id: 'PraxisHub', active: false })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await pool.query('SELECT tenant_id FROM console_users WHERE id=$1', [humanizar.id])).rows).toEqual([{ tenant_id: 'Steven' }]);
  });
  it('protects each last company administrator even when another company has its own', async () => {
    await expect(repository.retire(actor(humanizar), humanizar.id, { expected_revision: humanizar.revision })).rejects.toMatchObject({ code: 'conflict' });
    await expect(repository.retire(actor(praxis), praxis.id, { expected_revision: praxis.revision })).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query('SELECT active FROM console_users ORDER BY id')).rows).toEqual([{ active: true }, { active: true }]);
  });
  it('blocks global credential revocation when a human has live membership in a foreign company', async () => {
    await pool.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
      VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [humanizar.id]);
    await expect(repository.update(actor(humanizar), humanizar.id, { expected_revision: humanizar.revision,
      display_name: 'Ambiguous company' })).rejects.toMatchObject({ code: 'conflict' });
    expect((await pool.query('SELECT enabled FROM human_tenant_memberships WHERE human_id=$1', [humanizar.id])).rows)
      .toEqual([{ enabled: true }, { enabled: true }]);
  });
});
