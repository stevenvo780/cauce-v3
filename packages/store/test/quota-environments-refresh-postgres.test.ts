import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, lockCompanyAuthority, type DatabasePool } from '../src/index.js';
import { QuotaEnvironmentRepository, type QuotaEnvironmentOptions } from '../src/quota-environments.js';
import { QuotaOperationsRepository } from '../src/quota-operations.js';
import { listQuotaAccounts } from '../src/quota-accounts.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase;
let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let admin: DatabasePool; let actors: CompanyIsolationFixture;
let clock: number;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 180_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  actors = await seedCompanyIsolation(admin); clock = Date.now();
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,role,permissions)
    VALUES($1,'PraxisHub','company_admin','operator',ARRAY['read','control'])`, [actors.leon]);
});
afterEach(async () => { await current?.close(); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
const owner = (company: 'humanizar' | 'praxis') => (client: import('../src/db.js').DatabaseClient) => lockCompanyAuthority(client,
  company === 'humanizar' ? { tenant: 'Steven', alias: 'kant', humanId: actors.steven }
    : { tenant: 'PraxisHub', alias: 'company_admin', humanId: actors.leon });
const repository = (options: Partial<QuotaEnvironmentOptions> = {}) => new QuotaEnvironmentRepository(pool, {
  approvedHostIds: ['humanizar-host','praxis-host'], providers: ['codex'], now: () => new Date(clock), ...options,
});
async function create(authenticated = true, key = 'refresh-environment') {
  const repo = repository();
  const created = await repo.create(owner('humanizar'), { account_id: 'humanizar-account', host_id: 'humanizar-host',
    label: 'Fresh quota fixture', idempotency_key: key });
  const worker = new QuotaOperationsRepository(pool);
  const creation = await worker.claim('worker','humanizar-host');
  if (!creation) throw new Error('fixture create operation missing');
  await worker.finish(creation, { runtime_verified: true });
  if (authenticated) {
    const environment = (await repo.list(owner('humanizar'))).environments.find(row => row.id === created.environment.id);
    if (!environment) throw new Error('fixture environment missing');
    await repo.action(owner('humanizar'), environment.id, { action: 'authenticate', consent: true,
      expected_version: environment.version, idempotency_key: `refresh-authentication:${key}` });
    const authentication = await worker.claim('worker','humanizar-host');
    if (!authentication) throw new Error('fixture authenticate operation missing');
    await worker.finish(authentication, { authenticated_verified: true, account_identity: 'humanizar-external' });
  }
  return created.environment.id;
}
async function report(captured: number, observed?: number, empty = false, windowObserved?: number) {
  await new CauceRepository(pool).recordQuotaSample('Steven', 'kant', { host: 'fresh-account-fixture',
    captured_at: new Date(captured).toISOString(), schema_version: 2, providers: [{ provider: 'codex',
      account_id: 'humanizar-account', ok: true, available: true, available_groups: [], limiting_groups: [],
      ...observed === undefined ? {} : { observed_at: new Date(observed).toISOString() },
      windows: empty ? [] : [{ group_key: 'default', window_key: 'week', account_id: 'humanizar-account', used_percent: 12,
        ...windowObserved === undefined ? {} : { observed_at: new Date(windowObserved).toISOString() },
        reset_at: new Date(clock + 86_400_000).toISOString() }] }] });
}
const queryCount = async () => Number((await admin.query<{ count: string }>("SELECT count(*)::text AS count FROM quota_environment_operations WHERE action='query'")).rows[0]?.count);

describe('automatic quota refresh with PostgreSQL', () => {
  it('queues once for concurrent tabs and repeats only in a later ten-minute window', async () => {
    const id = await create();
    await report(clock - 600_001);
    const [first, second] = await Promise.all([repository().list(owner('humanizar'), { refresh: true }),
      repository().list(owner('humanizar'), { refresh: true })]);
    const firstRefresh = first.refreshes[0];
    expect(firstRefresh).toMatchObject({ environment_id: id, account_id: 'humanizar-account', status: 'updating' });
    expect(second.refreshes[0]?.operation_id).toBe(firstRefresh?.operation_id);
    expect(first.environments[0]?.refresh_status).toBe('updating');
    expect(first.operations.find(operation => operation.id === firstRefresh?.operation_id)).toMatchObject({ action: 'query', status: 'pending' });
    expect(await queryCount()).toBe(1);
    const worker = new QuotaOperationsRepository(pool); const claim = await worker.claim('worker','humanizar-host');
    if (!claim) throw new Error('fixture query operation missing');
    await worker.fail(claim, 'PROVIDER_UNAVAILABLE');
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({
      status: 'failed', operation_id: claim.id });
    expect(await queryCount()).toBe(1);
    clock += 600_001;
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({ status: 'updating' });
    expect(await queryCount()).toBe(2);
  });
  it('keeps exactly ten minutes fresh and queues only after the strict threshold', async () => {
    await create(); await report(clock - 600_000);
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({ status: 'fresh' });
    expect(await queryCount()).toBe(0);
    clock += 1;
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({ status: 'updating' });
    expect(await queryCount()).toBe(1);
  });
  it('uses a fresh linked-account observation even without any windows', async () => {
    await create(); await create(true, 'shared-account-environment'); await report(clock - 10_000, undefined, true);
    const refreshes = (await repository().refreshStale(owner('humanizar'))).refreshes;
    expect(refreshes).toHaveLength(2);
    for (const refresh of refreshes) expect(refresh).toMatchObject({
      status: 'fresh', captured_at: new Date(clock - 10_000).toISOString(), operation_id: null });
    expect(await queryCount()).toBe(0);
  });
  it('shows fresh data after the queued worker receipt is committed and keeps old native data stale', async () => {
    await create(); clock -= 600_001;
    const worker = new QuotaOperationsRepository(pool);
    for (const old of [true, false]) {
      expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]?.status).toBe('updating');
      const claim = await worker.claim('worker','humanizar-host');
      if (!claim) throw new Error('fixture automatic query missing');
      const observed = old ? clock - 600_001 : clock;
      await worker.finish(claim, { captured_at: new Date(clock).toISOString(), provider_report: {
        provider: 'codex', account_id: 'humanizar-account', ok: true, available: true,
        observed_at: new Date(observed).toISOString(), windows: [{ group_key: 'default', window_key: 'week',
          account_id: 'humanizar-account', used_percent: 12, reset_at: new Date(clock + 86_400_000).toISOString() }],
      } });
      const snapshot = await repository().list(owner('humanizar'), { refresh: true });
      expect(snapshot.refreshes[0]).toMatchObject({ status: old ? 'stale' : 'fresh', captured_at: new Date(observed).toISOString() });
      expect(snapshot.operations[0]).toMatchObject({ action: 'query', status: 'done' });
      if (old) clock += 600_001;
    }
    expect((await listQuotaAccounts(pool, owner('humanizar'))).accounts.find(account => account.id === 'humanizar-account'))
      .toMatchObject({ remaining_percent: 88, observation_status: 'ok' });
    expect(await queryCount()).toBe(2);
  });
  it('preserves native observation age when the collection envelope is recent', async () => {
    await create(); await report(clock, clock - 600_001);
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({
      status: 'updating', captured_at: new Date(clock - 600_001).toISOString() });
    expect(await queryCount()).toBe(1);
  });
  it('preserves an old native window when the provider has no observation timestamp', async () => {
    await create(); await report(clock, undefined, false, clock - 600_001);
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({
      status: 'updating', captured_at: new Date(clock - 600_001).toISOString() });
    expect(await queryCount()).toBe(1);
  });
  it('does not queue for a created environment without a verified authentication receipt', async () => {
    await create(false);
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({ status: 'not_authenticated', operation_id: null });
    expect(await queryCount()).toBe(0);
  });
  it('does not reuse an old verified authentication after a later failed login', async () => {
    const id = await create(); const repo = repository();
    const environment = (await repo.list(owner('humanizar'))).environments[0];
    if (!environment) throw new Error('fixture environment missing');
    await repo.action(owner('humanizar'), id, { action: 'authenticate', consent: true,
      expected_version: environment.version, idempotency_key: 'refresh-authentication-later' });
    const worker = new QuotaOperationsRepository(pool); const claim = await worker.claim('worker','humanizar-host');
    if (!claim) throw new Error('fixture later authentication missing');
    await worker.fail(claim, 'STEP_FAILED');
    expect((await repo.refreshStale(owner('humanizar'))).refreshes[0]?.status).toBe('not_authenticated');
    expect(await queryCount()).toBe(0);
  });
  it('reports executor unavailability without enqueue for a missing query capability or disabled host', async () => {
    await create();
    for (const repo of [repository({ approvedHostIds: [] }), repository({ resolveCapabilities: async () => [{
      host_id: 'humanizar-host', providers: ['codex'], provider_actions: { codex: ['authenticate'] },
    }] })]) {
      expect((await repo.refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({ status: 'executor_unavailable', operation_id: null });
    }
    await admin.query("UPDATE fleet_hosts SET enabled=false WHERE host_id='humanizar-host'");
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]?.status).toBe('executor_unavailable');
    expect(await queryCount()).toBe(0);
  });
  it('reports a deleted environment and does not expose or enqueue a foreign environment', async () => {
    const id = await create();
    await expect(repository().refreshStale(owner('praxis'), { environmentId: id })).rejects.toMatchObject({ code: 'not_found' });
    for (const version of [1, 999]) {
      await expect(repository().action(owner('praxis'), id, { action: 'delete', expected_version: version,
        idempotency_key: 'foreign-delete' })).rejects.toMatchObject({ code: 'not_found' });
      await expect(repository().update(owner('praxis'), id, { expected_version: version, label: 'Foreign update' }))
        .rejects.toMatchObject({ code: 'not_found' });
    }
    expect((await repository().refreshStale(owner('praxis'))).refreshes).toEqual([]);
    await admin.query("UPDATE quota_environments SET status='deleted' WHERE id=$1", [id]);
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({ status: 'deleted', operation_id: null });
    expect(await queryCount()).toBe(0);
  });
  it('filters account reads and leaves a pending query unchanged across refresh windows', async () => {
    await create();
    expect((await repository().refreshStale(owner('humanizar'), { accountIds: ['praxis-account'] })).refreshes).toEqual([]);
    expect(await queryCount()).toBe(0);
    const first = (await repository().refreshStale(owner('humanizar'), { accountIds: ['humanizar-account'] })).refreshes[0];
    clock += 600_001;
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({ status: 'updating', operation_id: first?.operation_id });
    expect(await queryCount()).toBe(1);
  });
  it('lets tenant readers inspect status without elevating them to quota writers', async () => {
    await create();
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [actors.steven]);
    await admin.query('DELETE FROM company_admins WHERE human_id=$1', [actors.steven]);
    expect((await repository().refreshStale(owner('humanizar'))).refreshes[0]).toMatchObject({ status: 'read_only', operation_id: null });
    expect(await queryCount()).toBe(0);
  });
  it('reserves automatic idempotency keys against manual operations', async () => {
    const id = await create();
    await expect(repository().action(owner('humanizar'), id, { action: 'query', expected_version: 3,
      idempotency_key: `auto-query:${id}:${String(Math.floor(clock / 600_000))}` })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await queryCount()).toBe(0);
  });
});
