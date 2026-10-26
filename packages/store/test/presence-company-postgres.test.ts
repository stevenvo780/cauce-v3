import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  CauceRepository, lockCompanyAuthority, type ConfigurationAuthorityResolver, type DatabaseClient, type DatabasePool,
} from '../src/index.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';

let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let repository: CauceRepository;
let people: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  people = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO connection_leases(tenant_id,alias,instance_id,epoch,lease_until,last_heartbeat_at) VALUES
    ('Steven','kant','kant-live',1,now()+interval '5 minutes',now()),
    ('Miguel','janus','janus-live',1,now()+interval '5 minutes',now()),
    ('PraxisHub','company_admin','hub-live',1,now()+interval '5 minutes',now()),
    ('PraxisTeam','team_agent','team-live',1,now()-interval '5 minutes',now()-interval '6 minutes')`);
  repository = new CauceRepository(pool);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

function as(tenant: string, alias: string, humanId: string, requestedCompany?: string): ConfigurationAuthorityResolver {
  return (client: DatabaseClient) => lockCompanyAuthority(client, { tenant, alias, humanId,
    ...(requestedCompany === undefined ? {} : { requestedCompany }) });
}
const keys = (rows: Record<string, unknown>[]): string[] => rows.map(row => `${String(row.tenant_id)}/${String(row.alias)}`).sort();

describe('listPresence under a company authority', () => {
  it('returns the acting company leases, expired ones included as offline, and none of the home company', async () => {
    const rows = await repository.listPresence('Steven', 'kant', undefined, as('Steven', 'kant', people.steven, 'praxis'));
    expect(keys(rows)).toEqual(['PraxisHub/company_admin', 'PraxisTeam/team_agent']);
    expect(Object.fromEntries(rows.map(row => [row.alias, row.online]))).toEqual({ company_admin: true, team_agent: false });
  });

  it('leaves a retired tenant of the acting company out', async () => {
    await admin.query("UPDATE tenants SET enabled=false,retired_enabled=true,retired_at=now() WHERE id='PraxisTeam'");
    const rows = await repository.listPresence('Steven', 'kant', undefined, as('Steven', 'kant', people.steven, 'praxis'));
    expect(keys(rows)).toEqual(['PraxisHub/company_admin']);
  });

  it('keeps the home reach without a switch and without a resolver', async () => {
    const expected = ['Miguel/janus', 'Steven/kant'];
    expect(keys(await repository.listPresence('Steven', 'kant', undefined, as('Steven', 'kant', people.steven)))).toEqual(expected);
    expect(keys(await repository.listPresence('Steven', 'kant'))).toEqual(expected);
  });

  it('ignores a requested company for a person who is not a platform administrator', async () => {
    const rows = await repository.listPresence('Miguel', 'janus', undefined, as('Miguel', 'janus', people.miguel, 'praxis'));
    expect(keys(rows)).toEqual(['Miguel/janus', 'Steven/kant']);
  });
});
