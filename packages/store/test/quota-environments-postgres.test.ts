import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, lockCompanyAuthority, type DatabasePool } from '../src/index.js';
import { createQuotaAccount, deleteQuotaAccount, listQuotaAccounts, quotaAccountSnapshot, updateQuotaAccount } from '../src/quota-accounts.js';
import { QuotaEnvironmentRepository } from '../src/quota-environments.js';
import { QuotaOperationsRepository } from '../src/quota-operations.js';
import { bindQuotaEnvironmentIdentity } from '../src/quota-identity.js';
import { selectAccountForAlias } from '../src/accounts.js';
import { withTransaction } from '../src/db.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let admin: DatabasePool; let actors: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 180_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  actors = await seedCompanyIsolation(admin);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [actors.leon]);
});
afterEach(async () => { await current?.close(); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
const owner = (company: 'humanizar' | 'praxis') => (client: import('../src/db.js').DatabaseClient) => lockCompanyAuthority(client,
  company === 'humanizar' ? { tenant: 'Steven', alias: 'kant', humanId: actors.steven }
    : { tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon });
const repository = () => new QuotaEnvironmentRepository(pool, { approvedHostIds: ['humanizar-host','praxis-host'], providers: ['codex','claude'] });
function sample(account: string, windows: import('@cauce/protocol').QuotaSampleRequest['providers'][number]['windows'],
  ok = true, time = new Date().toISOString()): import('@cauce/protocol').QuotaSampleRequest {
  return { host: 'shared-alias', captured_at: time, schema_version: 2, providers: [{ provider: 'codex', account_id: account,
    ok, available: ok, available_groups: [], limiting_groups: [], windows }] };
}
const window = (account: string, used: number, model: string | null = null) => ({ group_key: 'default', window_key: 'week', model,
  used_percent: used, reset_at: new Date(Date.now() + 3_600_000).toISOString(), account_id: account });

describe('quota accounts and managed environments with PostgreSQL', () => {
  it('registers a quota account without an agent, applies CAS and deletes only its company', async () => {
    const input = { provider: 'codex', label: 'Personal', idempotency_key: 'personal' };
    const created = await createQuotaAccount(pool, owner('humanizar'), input);
    expect(await createQuotaAccount(pool, owner('humanizar'), input)).toEqual({ ...created, duplicate: true });
    expect((await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(row => row.id === created.account_id)).toMatchObject({
      observation_status: 'unknown', remaining_percent: null, agents: [], version: 1 });
    await expect(updateQuotaAccount(pool, owner('humanizar'), created.account_id, { expected_version: 1, enabled: true }))
      .rejects.toMatchObject({ code: 'conflict' });
    await expect(updateQuotaAccount(pool, owner('praxis'), created.account_id, { expected_version: 1, label: 'Foreign' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await updateQuotaAccount(pool, owner('humanizar'), created.account_id, { expected_version: 1, label: 'Renamed' })).toMatchObject({ version: 2 });
    await expect(updateQuotaAccount(pool, owner('humanizar'), created.account_id, { expected_version: 1, label: 'Lost' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await deleteQuotaAccount(pool, owner('humanizar'), created.account_id, 2)).toMatchObject({ deleted: true });
  });
  it('queues idempotent typed effects and refuses foreign accounts/hosts and shell input', async () => {
    const repo = repository();
    const input = { account_id: 'humanizar-account', host_id: 'humanizar-host', label: 'Quota fixture', idempotency_key: 'environment-fixture' };
    const created = await repo.create(owner('humanizar'), input);
    expect(created.environment.status).toBe('pending'); expect(created.operation.status).toBe('pending');
    expect((await repo.create(owner('humanizar'), input)).operation.id).toBe(created.operation.id);
    await expect(repo.create(owner('praxis'), input)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repo.action(owner('humanizar'), created.environment.id,
      { action: 'query', command: 'bash', expected_version: 1, idempotency_key: 'arbitrary' })).rejects.toThrow();
    await expect(repo.action(owner('humanizar'), created.environment.id,
      { action: 'authenticate', expected_version: 1, idempotency_key: 'unconsented' })).rejects.toThrow();
    await expect(deleteQuotaAccount(pool, owner('humanizar'), 'humanizar-account', 1)).rejects.toMatchObject({ code: 'conflict' });
    expect((await repo.list(owner('praxis'))).environments).toEqual([]);
    expect((await repo.list(owner('humanizar'))).capabilities.available).toBe(true);
    await expect(new QuotaEnvironmentRepository(pool).create(owner('humanizar'), { ...input, idempotency_key: 'no-executor' }))
      .rejects.toMatchObject({ code: 'conflict' });
  });
  it('keeps one shared subscription with several agent assignments and windows separated by model', async () => {
    for (const alias of ['kant','zeus']) {
      await admin.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
        VALUES('Steven',$1,'humanizar-account','Steven','Steven')`, [alias]);
      await admin.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority)
        VALUES('Steven',$1,'humanizar-account',1)`, [alias]);
    }
    await new CauceRepository(pool).recordQuotaSample('Steven', 'kant', sample('humanizar-account', [
      window('humanizar-account', 8, 'model-a'), window('humanizar-account', 42, 'model-b')]));
    const account = (await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(row => row.id === 'humanizar-account');
    expect(account).toMatchObject({ shared: true, observation_status: 'ok', remaining_percent: 58 });
    expect(account?.agents.map(agent => agent.alias)).toEqual(['kant','zeus']);
    expect(account?.windows.map(window => window.model)).toEqual(['model-a','model-b']);
    expect(JSON.stringify(account)).not.toMatch(/credential_ref|humanizar-external/u);
  });
  it('reports a shared account to a tenant-scoped reader without exposing foreign aliases', async () => {
    for (const [tenant, alias] of [['Steven','kant'],['Steven','zeus'],['Miguel','janus']]) {
      await admin.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
        VALUES($1,$2,'humanizar-account','Steven','Steven')`, [tenant, alias]);
      await admin.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority)
        VALUES($1,$2,'humanizar-account',1)`, [tenant, alias]);
    }
    const authority = { humanId: actors.steven, homeTenant: 'Miguel', alias: 'janus', homeCompany: 'humanizar', actingCompany: 'humanizar',
      role: 'tenant_operator', scope: 'tenant', platformOverride: false } as const;
    const account = (await withTransaction(pool, client => quotaAccountSnapshot(client, authority))).accounts.find(row => row.id === 'humanizar-account');
    expect(account).toMatchObject({ shared: true, agent_count: 3 });
    expect(account?.agents).toEqual([expect.objectContaining({ tenant_id: 'Miguel', alias: 'janus' })]);
  });
  it('does not turn a probe 429 into exhaustion or clear manual pauses', async () => {
    const repo = new CauceRepository(pool);
    await admin.query("UPDATE provider_accounts SET paused_reason='manual maintenance',paused_until=now()+interval '2 hours' WHERE id='humanizar-account'");
    await repo.recordQuotaSample('Steven','kant',sample('humanizar-account',[window('humanizar-account',100)]));
    expect((await admin.query("SELECT paused_reason FROM provider_accounts WHERE id='humanizar-account'")).rows[0]).toEqual({ paused_reason: 'manual maintenance' });
    await repo.recordQuotaSample('Steven','kant',sample('humanizar-account',[],false,new Date(Date.now()+1).toISOString()));
    const account = (await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(row => row.id === 'humanizar-account');
    expect(account).toMatchObject({ observation_status: 'error', remaining_percent: null, paused_reason: 'manual maintenance' });
  });
  it('matches native Claude model limits without applying error observations or pausing other models', async () => {
    await admin.query("UPDATE provider_accounts SET provider='claude' WHERE id='humanizar-account'");
    await admin.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('Steven','kant','humanizar-account','Steven','Steven')`);
    await admin.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
      VALUES('Steven','kant','humanizar-account',1,true)`);
    const observation = sample('humanizar-account', [window('humanizar-account', 100, 'sonnet')]);
    const observedProvider = observation.providers[0];
    if (observedProvider === undefined) throw new Error('fixture provider absent');
    observedProvider.provider = 'claude';
    await new CauceRepository(pool).recordQuotaSample('Steven','kant',observation);
    const select = (model: string) => selectAccountForAlias(pool, { tenant_id: 'Steven', alias: 'kant', provider: 'claude', model });
    expect((await select('claude-sonnet-4-6')).selected).toBeNull();
    expect((await select('sonnet[1m]')).selected).toBeNull();
    expect((await select('claude-opus-4-6')).selected?.account_id).toBe('humanizar-account');
    expect((await admin.query("SELECT paused_until FROM provider_accounts WHERE id='humanizar-account'")).rows[0]).toEqual({ paused_until: null });
    await admin.query("UPDATE quota_window_state SET status='error' WHERE account_id='humanizar-account'");
    expect((await select('claude-sonnet-4-6')).selected?.account_id).toBe('humanizar-account');
  });
  it('keeps stale window timestamps despite a fresh collection and treats passed or absent resets honestly', async () => {
    const repo = new CauceRepository(pool);
    await repo.recordQuotaSample('Steven','kant',sample('humanizar-account',[{ ...window('humanizar-account',100), reset_at: null }]));
    await admin.query("UPDATE quota_window_state SET received_at=now()-interval '2 hours' WHERE account_id='humanizar-account'");
    const stale = (await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(row => row.id === 'humanizar-account');
    expect(stale).toMatchObject({ observation_status: 'stale', remaining_percent: null, paused_until: null });
    await repo.recordQuotaSample('Steven','kant',sample('humanizar-account',[{ ...window('humanizar-account',100), reset_at: new Date(Date.now()-1).toISOString() }],
      true, new Date(Date.now()+1).toISOString()));
    expect((await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(row => row.id === 'humanizar-account'))
      .toMatchObject({ observation_status: 'unknown', remaining_percent: null, paused_until: null });
  });
  it('isolates two companies declaring equal host and aliases in observations', async () => {
    const repo = new CauceRepository(pool);
    await repo.recordQuotaSample('Steven','company_admin',sample('humanizar-account',[window('humanizar-account',8)]));
    await repo.recordQuotaSample('PraxisHub','company_admin',sample('praxis-account',[window('praxis-account',89)]));
    const humanizar = await listQuotaAccounts(pool, owner('humanizar')); const praxis = await listQuotaAccounts(pool, owner('praxis'));
    expect(humanizar.accounts.find(row => row.id === 'humanizar-account')?.remaining_percent).toBe(92);
    expect(praxis.accounts.find(row => row.id === 'praxis-account')?.remaining_percent).toBe(11);
    expect(humanizar.accounts.some(row => row.id === 'praxis-account')).toBe(false);
    expect(praxis.accounts.some(row => row.id === 'humanizar-account')).toBe(false);
  });
  it('keeps a freshly received historical observation stale and never uses it to pause or resume an account', async () => {
    await admin.query(`INSERT INTO alias_routing_ceiling(tenant_id,alias,account_id,account_payer_tenant,created_by_tenant)
      VALUES('Steven','kant','humanizar-account','Steven','Steven')`);
    await admin.query(`INSERT INTO agent_account_bindings(tenant_id,agent_alias,account_id,priority,enabled)
      VALUES('Steven','kant','humanizar-account',1,true)`);
    const old = Date.now()-901_000; const repo = new CauceRepository(pool);
    await repo.recordQuotaSample('Steven','kant',sample('humanizar-account', [
      { ...window('humanizar-account',100), reset_at: null, observed_at: new Date(old).toISOString() },
    ]));
    expect((await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(row => row.id === 'humanizar-account'))
      .toMatchObject({ observation_status: 'stale', remaining_percent: null, paused_until: null });
    expect((await selectAccountForAlias(pool, { tenant_id: 'Steven', alias: 'kant', provider: 'codex' })).selected?.account_id)
      .toBe('humanizar-account');
    await admin.query("UPDATE provider_accounts SET paused_until=now()+interval '1 hour',paused_reason='quota_exhausted:fixture' WHERE id='humanizar-account'");
    await repo.recordQuotaSample('Steven','kant',sample('humanizar-account', [
      { ...window('humanizar-account',8), observed_at: new Date(old+1).toISOString() },
    ], true, new Date(Date.now()+1).toISOString()));
    expect((await admin.query("SELECT paused_reason FROM provider_accounts WHERE id='humanizar-account'")).rows[0])
      .toEqual({ paused_reason: 'quota_exhausted:fixture' });
  });
  it('fences durable worker receipts and publishes query observations to the common snapshot atomically', async () => {
    const created = await repository().create(owner('humanizar'), { account_id: 'humanizar-account', host_id: 'humanizar-host',
      label: 'Queue fixture', idempotency_key: 'worker-environment' });
    const worker = new QuotaOperationsRepository(pool);
    const first = await worker.claim('worker','humanizar-host');
    if (!first) throw new Error('fixture claim missing');
    expect(await worker.renew(first)).toBe(true);
    await expect(worker.finish(first, {})).rejects.toMatchObject({ code: 'invalid_input' });
    await admin.query("UPDATE quota_environment_operations SET lease_until=now()-interval '1 second' WHERE id=$1", [first.id]);
    const replacement = await worker.claim('replacement','humanizar-host');
    if (!replacement) throw new Error('replacement claim missing');
    expect(replacement.claim_epoch).toBe(first.claim_epoch + 1);
    await expect(worker.finish(first, { runtime_verified: true })).rejects.toMatchObject({ code: 'conflict' });
    await worker.finish(replacement, { runtime_verified: true });
    const environment = (await repository().list(owner('humanizar'))).environments.find(row => row.id === created.environment.id);
    if (!environment) throw new Error('environment missing');
    await repository().action(owner('humanizar'), environment.id, { action: 'query', expected_version: environment.version, idempotency_key: 'query-fixture' });
    const query = await worker.claim('worker','humanizar-host');
    if (!query) throw new Error('query claim missing');
    const report = sample('humanizar-account',[window('humanizar-account',12)]).providers[0];
    await worker.finish(query, { provider_report: report, captured_at: new Date().toISOString(), observation_status: 'ok' });
    expect((await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(row => row.id === 'humanizar-account')?.remaining_percent).toBe(88);
  });
  it('deduplicates subscription identity across profiles without independent balances or exposing identity', async () => {
    const first = await createQuotaAccount(pool, owner('humanizar'), { provider: 'codex', label: 'A', idempotency_key: 'identity-a' });
    const second = await createQuotaAccount(pool, owner('humanizar'), { provider: 'codex', label: 'B', idempotency_key: 'identity-b' });
    const a = await repository().create(owner('humanizar'), { account_id: first.account_id, host_id: 'humanizar-host', label: 'A', idempotency_key: 'identity-env-a' });
    const b = await repository().create(owner('humanizar'), { account_id: second.account_id, host_id: 'humanizar-host', label: 'B', idempotency_key: 'identity-env-b' });
    const bind = (id: string, identity: string) => withTransaction(pool, client => bindQuotaEnvironmentIdentity(client, id, identity));
    expect(await bind(a.environment.id, 'fixture-provider-identity')).toBe(first.account_id);
    expect(await bind(b.environment.id, 'fixture-provider-identity')).toBe(first.account_id);
    expect(await createQuotaAccount(pool, owner('humanizar'), { provider: 'codex', label: 'B', idempotency_key: 'identity-b' }))
      .toEqual({ account_id: first.account_id, duplicate: true });
    const snapshot = await listQuotaAccounts(pool, owner('humanizar'));
    expect(snapshot.accounts.some(account => account.id === second.account_id)).toBe(false);
    const environments = (await repository().list(owner('humanizar'))).environments;
    expect(environments.filter(environment => environment.account_id === first.account_id)).toHaveLength(2);
    await expect(bind(a.environment.id, 'other-provider-identity')).rejects.toMatchObject({ code: 'conflict' });
    expect(JSON.stringify(snapshot)).not.toContain('fixture-provider-identity');
    await expect(deleteQuotaAccount(pool, owner('humanizar'), first.account_id, snapshot.accounts.find(row => row.id === first.account_id)?.version ?? 0))
      .rejects.toMatchObject({ code: 'conflict' });
    await admin.query("UPDATE quota_environments SET status='deleted' WHERE account_id=$1", [first.account_id]);
    expect(await deleteQuotaAccount(pool, owner('humanizar'), first.account_id, snapshot.accounts.find(row => row.id === first.account_id)?.version ?? 0))
      .toMatchObject({ deleted: true });
    expect((await admin.query('SELECT id FROM provider_accounts WHERE id=ANY($1::text[])', [[first.account_id, second.account_id]])).rows).toEqual([]);
  });
  it('rechecks authority before execution, receipt ingestion and lease renewal', async () => {
    const source = (client: import('../src/db.js').DatabaseClient) => lockCompanyAuthority(client,
      { tenant: 'Miguel', alias: 'janus', humanId: actors.miguel });
    const created = await repository().create(source, { account_id: 'humanizar-account', host_id: 'humanizar-host',
      label: 'Revoked fixture', idempotency_key: 'revoked-worker' });
    const worker = new QuotaOperationsRepository(pool); const claim = await worker.claim('worker','humanizar-host');
    if (!claim) throw new Error('fixture claim missing');
    await admin.query('DELETE FROM company_admins WHERE human_id=$1', [actors.miguel]);
    await expect(worker.execution(claim)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(worker.finish(claim, { runtime_verified: true })).rejects.toMatchObject({ code: 'forbidden' });
    expect(await worker.renew(claim)).toBe(false);
    expect((await repository().list(owner('humanizar'))).operations.find(row => row.environment_id === created.environment.id))
      .toMatchObject({ status: 'failed', error_code: 'AUTHORITY_REVOKED' });
  });
  it('does not resume authentication after the requesting owner loses authority', async () => {
    const source = (client: import('../src/db.js').DatabaseClient) => lockCompanyAuthority(client,
      { tenant: 'Miguel', alias: 'janus', humanId: actors.miguel });
    const created = await repository().create(source, { account_id: 'humanizar-account', host_id: 'humanizar-host',
      label: 'Auth revoked fixture', idempotency_key: 'auth-revoked-worker' });
    const worker = new QuotaOperationsRepository(pool); const creation = await worker.claim('worker','humanizar-host');
    if (!creation) throw new Error('fixture claim missing');
    await worker.finish(creation, { runtime_verified: true });
    await repository().action(source, created.environment.id, { action: 'authenticate', consent: true, expected_version: 2, idempotency_key: 'auth-revoked' });
    const claim = await worker.claim('worker','humanizar-host');
    if (!claim) throw new Error('fixture auth claim missing');
    await worker.finish(claim, { expires_at: new Date(Date.now()+600_000).toISOString() }, true);
    await admin.query('DELETE FROM company_admins WHERE human_id=$1', [actors.miguel]);
    expect(await worker.resumeAuthentication(claim)).toBe(false);
    expect((await repository().list(owner('humanizar'))).operations.find(row => row.id === claim.id))
      .toMatchObject({ status: 'failed', error_code: 'AUTHORITY_REVOKED' });
  });
  it('bounds auth lifetime and expires waiting or resumed logins without enabling an unverified account', async () => {
    const account = await createQuotaAccount(pool, owner('humanizar'), { provider: 'codex', label: 'TTL', idempotency_key: 'ttl-account' });
    const created = await repository().create(owner('humanizar'), { account_id: account.account_id, host_id: 'humanizar-host',
      label: 'TTL environment', idempotency_key: 'ttl-environment' });
    const worker = new QuotaOperationsRepository(pool); const creation = await worker.claim('worker','humanizar-host');
    if (!creation) throw new Error('fixture creation claim missing');
    await worker.finish(creation, { runtime_verified: true });
    const start = async (key: string) => {
      const environment = (await repository().list(owner('humanizar'))).environments.find(row => row.id === created.environment.id);
      if (!environment) throw new Error('fixture TTL environment missing');
      await repository().action(owner('humanizar'), environment.id,
        { action: 'authenticate', consent: true, expected_version: environment.version, idempotency_key: key });
      const claim = await worker.claim('worker','humanizar-host');
      if (!claim) throw new Error('fixture TTL auth claim missing');
      return claim;
    };
    const claim = await start('ttl-auth');
    for (const value of [{}, { expires_at: new Date(Date.now()-1).toISOString() }, { expires_at: new Date(Date.now()+901_000).toISOString() }]) {
      await expect(worker.finish(claim, value, true)).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await worker.finish(claim, { expires_at: new Date(Date.now()+600_000).toISOString() }, true);
    await admin.query("UPDATE quota_environment_operations SET result=jsonb_set(result,'{expires_at}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1", [claim.id]);
    expect(await worker.resumeAuthentication(claim)).toBe(false);
    expect((await repository().list(owner('humanizar'))).operations.find(row => row.id === claim.id))
      .toMatchObject({ status: 'failed', error_code: 'AUTH_EXPIRED' });
    const resumed = await start('resumed-ttl-auth');
    await worker.finish(resumed, { expires_at: new Date(Date.now()+600_000).toISOString() }, true);
    expect(await worker.resumeAuthentication(resumed)).toBe(true);
    await admin.query("UPDATE quota_environment_operations SET result=jsonb_set(result,'{expires_at}',to_jsonb((now()-interval '1 second')::text)) WHERE id=$1", [resumed.id]);
    await expect(worker.finish(resumed, { authenticated_verified: true, account_identity: 'expired-provider-account' }))
      .rejects.toMatchObject({ code: 'conflict' });
    expect(await worker.renew(resumed)).toBe(false);
    expect((await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(row => row.id === account.account_id)?.enabled).toBe(false);
    const failed = await start('idempotent-auth-failure');
    await worker.fail(failed,'STEP_FAILED'); await worker.fail(failed,'STEP_FAILED');
    await expect(worker.fail({ ...failed, claim_epoch: failed.claim_epoch+1 },'STEP_FAILED')).rejects.toMatchObject({ code: 'conflict' });
  });
  it('shares the host-channel transaction and confines claims to its signed company and host', async () => {
    const created = await repository().create(owner('humanizar'), { account_id: 'humanizar-account', host_id: 'humanizar-host',
      label: 'Atomic host fixture', idempotency_key: 'host-atomic' });
    const worker = new QuotaOperationsRepository(pool);
    await expect(withTransaction(pool, async client => {
      expect(await worker.forTransaction(client).claim('worker','humanizar-host')).not.toBeNull();
      throw new Error('nonce transaction rejected');
    })).rejects.toThrow('nonce transaction rejected');
    expect((await admin.query('SELECT status,worker_id FROM quota_environment_operations WHERE id=$1', [created.operation.id])).rows)
      .toEqual([{ status: 'pending', worker_id: null }]);
    const claim = await worker.claim('worker','humanizar-host');
    if (!claim) throw new Error('fixture claim missing');
    await expect(withTransaction(pool, client => worker.assertHostScopeInTransaction(client, claim,
      { host_id: 'humanizar-host', company_id: 'praxis' }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(withTransaction(pool, client => worker.assertHostScopeInTransaction(client, claim,
      { host_id: 'praxis-host', company_id: 'humanizar' }))).rejects.toMatchObject({ code: 'forbidden' });
    await withTransaction(pool, async client => {
      await worker.assertHostScopeInTransaction(client, claim, { host_id: 'humanizar-host', company_id: 'humanizar' });
      await worker.forTransaction(client).finish(claim, { runtime_verified: true });
    });
    expect((await repository().list(owner('humanizar'))).operations.find(row => row.id === claim.id)?.status).toBe('done');
  });
  it('rejects foreign provider-report bindings at the database boundary', async () => {
    const collection = (await admin.query<{ id: string }>("SELECT id FROM quota_collections WHERE collector_tenant='Steven' LIMIT 1")).rows[0];
    if (!collection) throw new Error('fixture collection missing');
    await expect(pool.query(`INSERT INTO quota_provider_reports(collection_id,provider,ok,available,account_id)
      VALUES($1,'codex',true,true,'praxis-account')`, [collection.id])).rejects.toMatchObject({ code: '23514' });
  });

});
