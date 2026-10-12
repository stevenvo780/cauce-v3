import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CauceRepository, lockCompanyAuthority, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let repository: CauceRepository; let fixtures: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('database unavailable');
  current = await startTestCaseDatabase(database); pool = current.pool;
  fixtures = await seedSyntheticCompanyContexts(current.adminUrl); repository = new CauceRepository(pool);
  await current.adminPool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES
    ('zz-canary-audit-alpha','Audit alpha','context_alpha'),('zz-canary-audit-beta','Audit beta','context_beta');
    INSERT INTO tenants(id,company_id) VALUES('ContextPeer','context_alpha');`);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function fixture(index = 0) { return requireValue(fixtures[index], 'company fixture'); }
function authority(index = 0, requestedCompany?: string) {
  const target = fixture(index);
  return (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: target.tenant_id, alias: 'owner',
    humanId: target.human_id, ...(requestedCompany === undefined ? {} : { requestedCompany }) });
}
function page(index = 0, options: NonNullable<Parameters<CauceRepository['listAudit']>[2]> = {}) {
  return repository.listAudit(fixture(index).tenant_id, 'owner', { ...options, humanAuthority: authority(index) });
}
async function audit(values: { tenant?: string | null; actor?: string; company?: string | null; action?: string;
  trace?: string; at?: string; id?: string; metadata?: Record<string, unknown> } = {}) {
  const result = await pool.query<{ id: string }>(`INSERT INTO audit_events
    (id,tenant_id,actor_alias,company_id,action,decision,trace_id,metadata,created_at)
    VALUES(COALESCE($1::bigint,nextval('audit_events_id_seq')),$2,$3,$4,$5,'allow',$6,$7::jsonb,$8::timestamptz) RETURNING id::text`,
  [values.id ?? null, values.tenant === undefined ? 'ContextAlpha' : values.tenant, values.actor ?? 'director',
    values.company ?? null, values.action ?? 'context.sync', values.trace ?? 'zz-canary-audit-chain',
    JSON.stringify(values.metadata ?? { state: 'synced' }), values.at ?? '2026-08-26T08:00:00Z']);
  return requireValue(result.rows[0], 'audit receipt').id;
}
function ids(result: Record<string, unknown>) { return (result.items as { event_id: string }[]).map(row => row.event_id); }

describe('company-scoped audit keyset pagination', () => {
  it('shows the owner every company tenant and honors explicit attribution before legacy fallback', async () => {
    const own = await audit(); const peer = await audit({ tenant: 'ContextPeer', actor: 'peer-agent' });
    const platform = await audit({ tenant: null, actor: 'platform', company: 'context_alpha' });
    await audit({ tenant: 'ContextBeta' }); await audit({ tenant: 'ContextAlpha', company: 'context_beta' });
    expect(ids(await page())).toEqual([platform, peer, own]);
    expect((await page()).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ event_id: own, company_id: 'context_alpha', actor_alias: 'director' }),
      expect.objectContaining({ event_id: peer, company_id: 'context_alpha', tenant_id: 'ContextPeer' }),
    ]));
    expect(ids(await page(1))).toHaveLength(2);
  });
  it('restricts a platform administrator to the signed active company', async () => {
    if (!current) throw new Error('case database unavailable');
    await current.adminPool.query('INSERT INTO platform_admins(human_id) VALUES($1)', [fixture().human_id]);
    await audit(); const foreign = await audit({ tenant: 'ContextBeta' });
    const switched = await repository.listAudit(fixture().tenant_id, 'owner', { humanAuthority: authority(0, 'context_beta') });
    expect(ids(switched)).toEqual([foreign]);
    expect(switched.items).toEqual([expect.objectContaining({ company_id: 'context_beta' })]);
    expect(ids(await page())).toHaveLength(1);
  });
  it('limits unverified agents and aliases to their home tenant without company promotion', async () => {
    const own = await audit(); await audit({ tenant: 'ContextPeer' }); await audit({ tenant: 'ContextBeta' });
    await audit({ tenant: 'ContextAlpha', company: 'context_beta' });
    expect(ids(await repository.listAudit(fixture().tenant_id, 'director'))).toEqual([own]);
    expect(ids(await repository.listAudit(fixture().tenant_id, 'owner'))).toEqual([own]);
  });
  it('projects registered company hosts and known components without metadata or secrets', async () => {
    const safe = await audit({ metadata: { host_id: 'zz-canary-audit-alpha', component: 'context', state: 'synced',
      token: 'AUDIT_SECRET', payload: 'AUDIT_SECRET', session_id: 'AUDIT_SECRET' } });
    const rejected = await audit({ metadata: { host_id: 'zz-canary-audit-beta', component: 'fixture-token', token: 'AUDIT_SECRET' } });
    const result = await page();
    expect(result.items).toEqual([
      expect.objectContaining({ event_id: rejected, host_id: null, component: null, summary: null }),
      expect.objectContaining({ event_id: safe, host_id: 'zz-canary-audit-alpha', component: 'context', summary: '{"state":"synced"}' }),
    ]);
    for (const forbidden of ['AUDIT_SECRET', 'metadata', 'zz-canary-audit-beta']) expect(JSON.stringify(result)).not.toContain(forbidden);
  });
  it('applies exact trace, alias, action and inclusive date filters before pagination', async () => {
    await audit({ trace: 'other-trace' }); await audit({ actor: 'owner' }); await audit({ action: 'delivery.ack' });
    await audit({ at: '2026-08-26T07:59:59.999Z' }); await audit({ at: '2026-08-26T08:00:01.001Z' });
    await audit({ tenant: 'ContextBeta' }); const lower = await audit(); const upper = await audit({ at: '2026-08-26T08:00:01Z' });
    const options = { trace_id: 'zz-canary-audit-chain', alias: 'director', action: 'context.sync',
      from: '2026-08-26T08:00:00Z', to: '2026-08-26T08:00:01Z', limit: 1 };
    const first = await page(0, options); expect(ids(first)).toEqual([upper]); expect(first.next_cursor).toBe(upper);
    const second = await page(0, { ...options, before: upper }); expect(ids(second)).toEqual([lower]); expect(second.next_cursor).toBeNull();
  });
  it('keeps stable pages for equal timestamps and excludes newer concurrent inserts', async () => {
    const oldest = await audit(); const middle = await audit(); const latest = await audit();
    const first = await page(0, { limit: 2 }); expect(ids(first)).toEqual([latest, middle]); expect(first.next_cursor).toBe(middle);
    await audit(); const second = await page(0, { limit: 2, before: middle });
    expect(ids(second)).toEqual([oldest]); expect(second.next_cursor).toBeNull();
    expect(ids(await page(0, { limit: 500 }))).toHaveLength(4);
  });
  it('preserves PostgreSQL bigint event identities beyond JavaScript safe integers', async () => {
    const id = await audit({ id: '9007199254740993' });
    expect(ids(await page(0, { before: '9223372036854775807' }))).toEqual(['9007199254740993']);
    expect(ids(await page(0, { before: id }))).toEqual([]);
  });
  it('rejects malformed pagination and server filters defensively', async () => {
    for (const options of [
      { limit: 0 }, { limit: 501 }, { limit: 1.5 }, { before: '01' }, { before: '9223372036854775808' },
      { trace_id: '' }, { trace_id: 'x'.repeat(257) }, { trace_id: 'invalid\ntrace' },
      { alias: 'owner%' }, { action: 'context.*' }, { action: 'context\nsync' },
      { from: '2026-02-30T08:00:00Z' }, { to: '2026-08-26' }, { from: '2026-08-26T08:00:00+00:00' },
      { from: '2026-08-27T00:00:00Z', to: '2026-08-26T00:00:00Z' },
    ]) await expect(page(0, options)).rejects.toMatchObject({ name: 'StoreError', code: 'invalid_input' });
  });
  it('rejects a verified authority whose home principal differs from the caller', async () => {
    await expect(repository.listAudit(fixture().tenant_id, 'owner', { humanAuthority: authority(1) })).rejects.toMatchObject({ code: 'forbidden' });
    await expect(repository.listAudit(fixture().tenant_id, 'director', { humanAuthority: authority() })).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('rechecks read permission while authority locks are held', async () => {
    if (!current) throw new Error('case database unavailable');
    await current.adminPool.query("UPDATE role_policies SET allow_read=false WHERE role='agent'");
    await expect(repository.listAudit(fixture().tenant_id, 'director')).rejects.toMatchObject({ code: 'forbidden' });
  });
});
