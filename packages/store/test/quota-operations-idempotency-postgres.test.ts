import { randomUUID } from 'node:crypto';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { createQuotaAccount } from '../src/quota-accounts.js';
import { QuotaEnvironmentRepository } from '../src/quota-environments.js';
import { QuotaOperationsRepository, type QuotaOperationClaim } from '../src/quota-operations.js';
import { withTransaction } from '../src/db.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase; let current: EmptyTestDatabase | undefined;
let pool: DatabasePool; let admin: DatabasePool; let actors: CompanyIsolationFixture;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 180_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(database); pool = current.pool; admin = current.adminPool;
  actors = await seedCompanyIsolation(admin);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
});
afterEach(async () => { await current?.close(); });
afterAll(async () => { await database.pool.end(); await database.container.stop(); });
const owner = (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: actors.steven });
const repositories = () => ({ worker: new QuotaOperationsRepository(pool),
  environments: new QuotaEnvironmentRepository(pool, { approvedHostIds: ['humanizar-host'], providers: ['codex'] }) });
async function next(worker: QuotaOperationsRepository): Promise<QuotaOperationClaim> {
  const claim = await worker.claim('worker','humanizar-host');
  if (!claim) throw new Error('fixture claim missing'); return claim;
}
const state = async (id: string) => {
  const row = (await admin.query<{ version: number; status: string; updated_at: Date }>(
    'SELECT version::int,status,updated_at FROM quota_environments WHERE id=$1', [id])).rows[0];
  if (!row) throw new Error('fixture environment missing'); return row;
};

describe('quota operation terminal receipt idempotency with PostgreSQL', () => {
  it('accepts the same create/query effect without new versions or quota rows and preserves terminal host scope', async () => {
    const { worker, environments } = repositories();
    const created = await environments.create(owner, { account_id: 'humanizar-account', host_id: 'humanizar-host',
      label: 'Replay', idempotency_key: 'create-replay' });
    const claim = await next(worker); const effect = { runtime_verified: true, cli_version: 'codex 1.0.0' };
    await worker.finish(claim, effect);
    const completed = await state(created.environment.id);
    expect(await worker.finish(claim, effect)).toEqual({ operation_id: claim.id, status: 'done' });
    expect(await state(created.environment.id)).toEqual(completed);
    await expect(worker.finish(claim, { ...effect, cli_version: 'codex 2.0.0' })).rejects.toMatchObject({ code: 'conflict' });
    for (const altered of [{ ...claim, claim_epoch: claim.claim_epoch+1 }, { ...claim, claim_token: randomUUID() },
      { ...claim, worker_id: 'other' }, { ...claim, environment_id: randomUUID() }]) {
      await expect(worker.finish(altered, effect)).rejects.toMatchObject({ code: 'conflict' });
    }
    const scope = { host_id: 'humanizar-host', company_id: 'humanizar' };
    await expect(withTransaction(pool, client => worker.assertHostScopeInTransaction(client, claim, scope)))
      .rejects.toMatchObject({ code: 'forbidden' });
    await withTransaction(pool, client => worker.assertHostScopeInTransaction(client, claim, { ...scope, allowTerminal: true }));
    for (const wrong of [{ ...scope, company_id: 'praxis' }, { ...scope, host_id: 'praxis-host' }]) {
      await expect(withTransaction(pool, client => worker.assertHostScopeInTransaction(client, claim, { ...wrong, allowTerminal: true })))
        .rejects.toMatchObject({ code: 'forbidden' });
    }
    expect(await worker.renew(claim)).toBe(false);
    await expect(worker.execution(claim)).rejects.toMatchObject({ code: 'conflict' });
    await environments.action(owner, created.environment.id, { action: 'query', expected_version: completed.version,
      idempotency_key: 'query-replay' });
    const query = await next(worker); const report = { provider: 'codex', account_id: 'humanizar-account', ok: true, available: true,
      available_groups: [], limiting_groups: [], windows: [{ group_key: 'default', window_key: 'week', model: null,
        account_id: 'humanizar-account', used_percent: 12, reset_at: new Date(Date.now()+3_600_000).toISOString() }] };
    const queried = { provider_report: report, captured_at: new Date().toISOString(), observation_status: 'ok' };
    await worker.finish(query, queried);
    const count = async () => (await admin.query<{ count: number }>('SELECT count(*)::int AS count FROM quota_collections')).rows[0];
    const collections = await count(); const queryState = await state(created.environment.id);
    expect(await worker.finish(query, queried)).toEqual({ operation_id: query.id, status: 'done' });
    expect(await count()).toEqual(collections); expect(await state(created.environment.id)).toEqual(queryState);
    await expect(worker.finish(query, { ...queried, observation_status: 'error' })).rejects.toMatchObject({ code: 'conflict' });
    expect(await count()).toEqual(collections);
  });

  it('hashes terminal auth identity and rejects changed or missing identity without storing it', async () => {
    const { worker, environments } = repositories();
    const account = await createQuotaAccount(pool, owner, { provider: 'codex', label: 'Auth', idempotency_key: 'auth-account' });
    const created = await environments.create(owner, { account_id: account.account_id, host_id: 'humanizar-host',
      label: 'Auth replay', idempotency_key: 'auth-environment' });
    await worker.finish(await next(worker), { runtime_verified: true });
    await environments.action(owner, created.environment.id, { action: 'authenticate', consent: true, expected_version: 2,
      idempotency_key: 'authenticate-replay' });
    const auth = await next(worker); const waiting = { expires_at: new Date(Date.now()+600_000).toISOString() };
    await expect(worker.finish(auth, { ...waiting, account_identity: 'fixture-provider-id' }, true))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await worker.finish(auth, waiting, true);
    const waitingState = await state(created.environment.id);
    await worker.finish(auth, waiting, true); expect(await state(created.environment.id)).toEqual(waitingState);
    expect(await worker.resumeAuthentication(auth)).toBe(true);
    const verified = { authenticated_verified: true, account_identity: 'fixture-provider-id' };
    await worker.finish(auth, verified);
    const accountState = async () => (await admin.query<{ quota_version: number; quota_identity_hash: string | null; enabled: boolean }>(
      'SELECT quota_version::int,quota_identity_hash,enabled FROM provider_accounts WHERE id=$1',
      [account.account_id])).rows[0];
    const before = await accountState(); const environment = await state(created.environment.id);
    expect(await worker.finish(auth, verified)).toEqual({ operation_id: auth.id, status: 'done' });
    expect(await accountState()).toEqual(before); expect(await state(created.environment.id)).toEqual(environment);
    for (const effect of [{ ...verified, account_identity: 'changed-provider-id' }, { authenticated_verified: true },
      { ...verified, account_id: 'praxis-account' }]) {
      await expect(worker.finish(auth, effect)).rejects.toMatchObject({ code: 'conflict' });
    }
    const stored = (await admin.query<{ result: Record<string, unknown> }>('SELECT result FROM quota_environment_operations WHERE id=$1', [auth.id])).rows[0];
    expect(stored).toEqual({ result: { authenticated_verified: true, account_id: account.account_id } });
    expect(JSON.stringify(stored)).not.toContain('fixture-provider-id');
    await admin.query('UPDATE provider_accounts SET quota_identity_hash=NULL WHERE id=$1', [account.account_id]);
    await expect(worker.finish(auth, verified)).rejects.toMatchObject({ code: 'conflict' });
  });

  it('revalidates authority on successful replay and accepts only the same fenced failure', async () => {
    const { worker, environments } = repositories();
    const requester = (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: 'Miguel', alias: 'janus', humanId: actors.miguel });
    const created = await environments.create(requester, { account_id: 'humanizar-account', host_id: 'humanizar-host',
      label: 'Revoked replay', idempotency_key: 'revoked-replay' });
    const claim = await next(worker); await worker.finish(claim, { runtime_verified: true });
    await admin.query('DELETE FROM company_admins WHERE human_id=$1', [actors.miguel]);
    await expect(worker.finish(claim, { runtime_verified: true })).rejects.toMatchObject({ code: 'forbidden' });
    await environments.action(owner, created.environment.id, { action: 'update_cli', expected_version: 2, idempotency_key: 'failed-replay' });
    const failed = await next(worker); await worker.fail(failed, 'STEP_FAILED');
    const before = await state(created.environment.id); await worker.fail(failed, 'STEP_FAILED');
    expect(await state(created.environment.id)).toEqual(before);
    await withTransaction(pool, client => worker.assertHostScopeInTransaction(client, failed,
      { host_id: 'humanizar-host', company_id: 'humanizar', allowTerminal: true }));
    await expect(worker.fail(failed, 'RUNTIME_UNAVAILABLE')).rejects.toMatchObject({ code: 'conflict' });
    await expect(worker.fail({ ...failed, claim_epoch: failed.claim_epoch+1 }, 'STEP_FAILED')).rejects.toMatchObject({ code: 'conflict' });
    await expect(worker.fail({ ...failed, environment_id: randomUUID() }, 'STEP_FAILED')).rejects.toMatchObject({ code: 'conflict' });
  });
});
