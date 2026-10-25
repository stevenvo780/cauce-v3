import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ConfigurationRepository, lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { deleteQuotaAccount, listQuotaAccounts } from '../src/quota-accounts.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

const ALIAS = 'zz-canary-r2-alias';
const CANONICAL = 'humanizar-account';
let database: TestDatabase | undefined;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool;
let admin: DatabasePool;
let actors: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 180_000);

beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database);
  pool = current.pool;
  admin = current.adminPool;
  actors = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [actors.leon]);
  await admin.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled,quota_registration_key)
    VALUES($1,'codex','zz-canary-r2-external','Steven','env_path','CAUCE_TEST_ALIAS_PATH',false,'zz-canary-r2-key')`, [ALIAS]);
  await admin.query(`UPDATE provider_accounts SET quota_identity_hash=$2,quota_version=2 WHERE id=$1`, [CANONICAL, 'ab'.repeat(32)]);
  await admin.query(`UPDATE provider_accounts SET canonical_account_id=$2,enabled=false,quota_version=2 WHERE id=$1`, [ALIAS, CANONICAL]);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });

const steven = () => (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: actors.steven });
const leon = () => (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon });
const owner = (company: 'humanizar' | 'praxis') => company === 'humanizar' ? steven() : leon();

describe('registry deletion of a merged quota alias', () => {
  it('names the canonical account, hides the alias from My quotas, and keeps the other company out', async () => {
    const repository = new ConfigurationRepository(pool);
    const snapshot = await repository.get('Steven', 'kant', steven());
    const revision = snapshot.revision;
    if (typeof revision !== 'number') throw new Error('revision missing');
    const visible = (snapshot.provider_accounts as { id: string }[]).map((row) => row.id);
    expect(visible).toEqual(expect.arrayContaining([CANONICAL, ALIAS]));
    const listed = (await listQuotaAccounts(pool, owner('humanizar'))).accounts.map((row) => row.id);
    expect(listed).toContain(CANONICAL);
    expect(listed).not.toContain(ALIAS);
    expect((await listQuotaAccounts(pool, owner('praxis'))).accounts.some((row) => row.id === ALIAS || row.id === CANONICAL)).toBe(false);

    await expect(repository.apply('PraxisHub', 'company_admin', { resource: 'provider_account', action: 'delete', id: ALIAS }, true, 0, leon()))
      .rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.apply('Steven', 'kant', { resource: 'provider_account', action: 'delete', id: ALIAS }, false, revision, steven()))
      .rejects.toMatchObject({
        code: 'conflict',
        message: `quota account alias must be deleted with canonical account ${CANONICAL} from My quotas`,
      });
    await expect(repository.apply('Steven', 'kant', { resource: 'provider_account', action: 'delete', id: CANONICAL }, false, revision, steven()))
      .rejects.toMatchObject({ code: 'conflict', message: 'quota accounts must be deleted from My quotas' });
    expect((await admin.query('SELECT id FROM provider_accounts WHERE id=ANY($1::text[]) ORDER BY id', [[ALIAS, CANONICAL]])).rows)
      .toEqual([{ id: CANONICAL }, { id: ALIAS }]);

    await expect(deleteQuotaAccount(pool, owner('humanizar'), CANONICAL, 2)).resolves.toMatchObject({ deleted: true });
    expect((await admin.query('SELECT id FROM provider_accounts WHERE id=ANY($1::text[])', [[ALIAS, CANONICAL]])).rows).toEqual([]);
  });
});
