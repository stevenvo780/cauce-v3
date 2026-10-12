import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { lockCompanyAuthority, withTransaction, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { bindAgentQuotaSample, type AgentQuotaSnapshot } from '../src/agent-quota-bindings.js';
import { quotaAccountSnapshot } from '../src/quota-accounts.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let identities: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>;
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  current = await startTestCaseDatabase(requireValue(database, 'database')); pool = current.pool;
  identities = await seedSyntheticCompanyContexts(current.adminUrl);
  await current.adminPool.query(`INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES
    ('zz-canary-alpha','Alpha','context_alpha'),('zz-canary-beta','Beta','context_beta');
    UPDATE agents SET harness_id='codex',runtime_mode='container',host_id=CASE company_id
      WHEN 'context_alpha' THEN 'zz-canary-alpha' ELSE 'zz-canary-beta' END,
      container_name='zz-canary-'||lower(tenant_id)||'-'||alias,runtime_user='dev',
      home_directory='/home/dev',state_directory='/home/dev/.cauce/dev',systemd_user='stev',
      runtime_key=COALESCE(runtime_key,'zz-canary-'||lower(tenant_id)||'-'||alias)
      WHERE company_id IN ('context_alpha','context_beta');`);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function admin() { return requireValue(current, 'case database').adminPool; }
function authority(index = 0) {
  const person = requireValue(identities[index], 'company');
  return (client: DatabaseClient) => lockCompanyAuthority(client, { tenant: person.tenant_id, alias: 'owner', humanId: person.human_id });
}
async function snapshot(alias = 'director', index = 0): Promise<AgentQuotaSnapshot> {
  const person = requireValue(identities[index], 'company');
  const result = await admin().query<Omit<AgentQuotaSnapshot, 'operation_id' | 'expected_revision'>>(`SELECT company_id,tenant_id,alias,harness_id,host_id,
    runtime_mode,container_name,runtime_user,home_directory,state_directory,runtime_key,systemd_user,primary_account_id
    FROM agents WHERE tenant_id=$1 AND alias=$2`, [person.tenant_id, alias]);
  const revision = (await admin().query<{ revision: number }>('SELECT COALESCE(max(id),0)::int AS revision FROM config_revisions')).rows[0];
  return { ...requireValue(result.rows[0], 'agent snapshot'), operation_id: randomUUID(), expected_revision: requireValue(revision, 'revision').revision };
}
function measured(target: AgentQuotaSnapshot, provider = 'codex', identity = 'zz-canary-provider-identity') {
  return { status: 'measured', operation_id: target.operation_id, tenant: target.tenant_id, alias: target.alias,
    host_id: target.host_id, container_name: target.container_name, harness: target.harness_id, captured_at: new Date().toISOString(),
    provider, identity_hash: createHash('sha256').update(JSON.stringify([provider, identity])).digest('hex'), observation_status: 'ok',
    provider_report: { provider, ok: true, available: true, windows: [{ group_key: 'default', window_key: 'week', used_percent: 12, remaining_percent: 88 }] } };
}
function ingest(target: AgentQuotaSnapshot, receipt: unknown = measured(target), index = 0) {
  return withTransaction(pool, client => bindAgentQuotaSample(client, pool, authority(index), target, receipt));
}
async function measuredIngest(target: AgentQuotaSnapshot, receipt: unknown = measured(target), index = 0) {
  const result = await ingest(target, receipt, index);
  if (result.status !== 'measured') throw new Error('expected a measured quota result');
  return result;
}
async function counts() {
  return (await admin().query<{ accounts: number; bindings: number; collections: number }>(`SELECT
    (SELECT count(*)::int FROM provider_accounts WHERE quota_identity_hash IS NOT NULL) AS accounts,
    (SELECT count(*)::int FROM agent_account_bindings) AS bindings,(SELECT count(*)::int FROM quota_collections) AS collections`)).rows[0];
}

describe('trusted agent quota result binding and sample ingestion with real PostgreSQL', () => {
  it('deduplicates two concurrent agents into one company subscription with a shared snapshot', async () => {
    const targets = [await snapshot(), await snapshot('owner')];
    const results = await Promise.all(targets.map(target => measuredIngest(target)));
    expect(results[0]).toMatchObject({ status: 'measured', duplicate: false });
    expect(results[1]).toMatchObject({ status: 'measured', account_id: results[0]?.account_id });
    expect(await counts()).toEqual({ accounts: 1, bindings: 2, collections: 2 });
    const card = await withTransaction(pool, async client => quotaAccountSnapshot(client, await authority()(client)));
    expect(card.accounts).toEqual([expect.objectContaining({ shared: true, agent_count: 2, observation_status: 'ok' })]);
    const account = (await admin().query<{ shared_with_pool: boolean; external_account_id: string }>('SELECT shared_with_pool,external_account_id FROM provider_accounts')).rows[0];
    expect(account?.shared_with_pool).toBe(false); expect(JSON.stringify(account)).not.toContain('zz-canary-provider-identity');
  });
  it('separates identities across companies and providers while binding every window to its canonical account', async () => {
    const a = await snapshot(); const b = await snapshot('director', 1); const first = await measuredIngest(a); const second = await measuredIngest(b, measured(b), 1);
    await admin().query("UPDATE agents SET harness_id='claude' WHERE tenant_id='ContextAlpha' AND alias='director'");
    const claude = await snapshot(); const third = await measuredIngest(claude, measured(claude, 'claude'));
    expect(new Set([first.account_id, second.account_id, third.account_id]).size).toBe(3);
    expect((await admin().query('SELECT count(*)::int AS count FROM quota_window_samples WHERE account_id IS NULL')).rows[0]).toEqual({ count: 0 });
    expect(await counts()).toEqual({ accounts: 3, bindings: 3, collections: 3 });
  });
  it('rejects another company without creating accounts, bindings or samples', async () => {
    await expect(ingest(await snapshot('director', 1))).rejects.toMatchObject({ code: 'forbidden' });
    expect(await counts()).toEqual({ accounts: 0, bindings: 0, collections: 0 });
  });
  it('rejects stale configuration revisions and a changed placement snapshot', async () => {
    const target = await snapshot(); await expect(ingest({ ...target, expected_revision: target.expected_revision + 1 })).rejects.toMatchObject({ code: 'conflict' });
    for (const changed of [{ runtime_key: 'zz-canary-replaced' }, { systemd_user: 'other' }, { primary_account_id: 'other' }]) {
      await expect(ingest({ ...target, ...changed })).rejects.toMatchObject({ code: 'conflict' });
    }
    await admin().query("UPDATE agents SET container_name='zz-canary-moved' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    await expect(ingest(target)).rejects.toMatchObject({ code: 'conflict' }); expect(await counts()).toEqual({ accounts: 0, bindings: 0, collections: 0 });
  });
  it.each(['revoked', 'no_read', 'mismatched'])('revalidates %s human authority before accepting a trusted result', async change => {
    const target = await snapshot(); const person = requireValue(identities[0], 'owner');
    const sql = change === 'revoked' ? 'enabled=false,revoked_at=now()' : change === 'no_read' ? "permissions=ARRAY['control']" : "actor_alias='director'";
    await admin().query(`UPDATE human_tenant_memberships SET ${sql} WHERE human_id=$1`, [person.human_id]);
    await expect(ingest(target)).rejects.toMatchObject({ code: 'forbidden' }); expect(await counts()).toEqual({ accounts: 0, bindings: 0, collections: 0 });
  });
  it('rejects receipts for a different operation, host, agent, harness or provider', async () => {
    const target = await snapshot(); const receipt = measured(target);
    for (const changed of [{ operation_id: randomUUID() }, { host_id: 'zz-canary-beta' }, { tenant: 'ContextBeta' }, { alias: 'owner' },
      { container_name: 'zz-canary-other' }, { harness: 'claude' }, { provider: 'claude' }]) {
      await expect(ingest(target, { ...receipt, ...changed })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    expect(await counts()).toEqual({ accounts: 0, bindings: 0, collections: 0 });
  });
  it('rejects arbitrary report and window account ids with no partial account or binding writes', async () => {
    const target = await snapshot(); const receipt = measured(target);
    for (const provider_report of [{ ...receipt.provider_report, provider: 'claude' }, { ...receipt.provider_report, account_id: 'arbitrary-account' },
      { ...receipt.provider_report, windows: [{ ...receipt.provider_report.windows[0], account_id: 'arbitrary-account' }] }]) {
      await expect(ingest(target, { ...receipt, provider_report })).rejects.toMatchObject({ code: 'invalid_input' });
      expect(await counts()).toEqual({ accounts: 0, bindings: 0, collections: 0 });
    }
  });
  it('rejects secret-bearing free text before creating accounts, bindings or samples', async () => {
    const target = await snapshot(); const receipt = measured(target); const token = 'Bearer zz-canary-secret-marker';
    const window = requireValue(receipt.provider_report.windows[0], 'quota window');
    const reports = ['note', 'kind', 'source', 'plan'].map(key => ({ ...receipt.provider_report, [key]: token }));
    reports.push(...['label', 'family', 'model', 'binding_note'].map(key => ({ ...receipt.provider_report,
      windows: [{ ...window, [key]: token }] })));
    for (const provider_report of reports) await expect(ingest(target, { ...receipt, provider_report })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(await counts()).toEqual({ accounts: 0, bindings: 0, collections: 0 });
    const error = { ...receipt, observation_status: 'error', provider_report: { provider: 'codex', ok: false, note: 'token_expired', windows: [] } };
    expect(await ingest(target, error)).toMatchObject({ status: 'measured', captured_at: receipt.captured_at });
    expect((await admin().query('SELECT note FROM quota_provider_reports')).rows).toEqual([{ note: 'token_expired' }]);
  });
  it('preserves existing manual bindings and disabled canonical accounts', async () => {
    const target = await snapshot(); const first = await measuredIngest(target);
    await admin().query("UPDATE provider_accounts SET enabled=false,paused_until=now()+interval '1 hour',paused_reason='manual' WHERE id=$1", [first.account_id]);
    await admin().query('UPDATE agent_account_bindings SET priority=7,enabled=true WHERE account_id=$1', [first.account_id]);
    const replay = await measuredIngest(target); expect(replay.account_id).toBe(first.account_id);
    expect((await admin().query('SELECT priority,enabled FROM agent_account_bindings')).rows).toEqual([{ priority: 7, enabled: true }]);
    expect((await admin().query('SELECT enabled,paused_reason,paused_until>now() AS paused FROM provider_accounts')).rows)
      .toEqual([{ enabled: false, paused_reason: 'manual', paused: true }]);
    expect((await admin().query('SELECT primary_account_id FROM agents WHERE tenant_id=$1 AND alias=$2', [target.tenant_id, target.alias])).rows)
      .toEqual([{ primary_account_id: null }]);
  });
  it('reuses a legacy registered identity without changing its profile, consent or enabled state', async () => {
    const target = await snapshot(); const receipt = measured(target);
    await admin().query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,label,
      credential_ref_kind,credential_ref,shared_with_pool,enabled,company_id) VALUES
      ('zz-canary-legacy','codex','zz-canary-provider-identity','ContextAlpha','Existing','file','/private/profile',false,false,'context_alpha')`);
    expect(await ingest(target, receipt)).toMatchObject({ account_id: 'zz-canary-legacy' });
    expect(await counts()).toEqual({ accounts: 1, bindings: 1, collections: 1 });
    expect((await admin().query('SELECT quota_identity_hash,enabled,shared_with_pool,credential_ref FROM provider_accounts')).rows)
      .toEqual([{ quota_identity_hash: receipt.identity_hash, enabled: false, shared_with_pool: false, credential_ref: '/private/profile' }]);
  });
  it('requires existing payer pool consent to bind a sibling tenant to the same subscription', async () => {
    const target = await snapshot(); const first = await measuredIngest(target);
    await admin().query(`INSERT INTO tenants(id,company_id) VALUES('ContextPeer','context_alpha');
      INSERT INTO agents(tenant_id,alias,harness_id,enabled,host_id,runtime_mode,container_name,runtime_user,home_directory,state_directory,runtime_key,systemd_user)
      VALUES('ContextPeer','peer','codex',true,'zz-canary-alpha','container','zz-canary-peer','dev','/home/dev','/home/dev/.cauce/dev','zz-canary-peer','stev')`);
    const peer = { ...target, tenant_id: 'ContextPeer', alias: 'peer', container_name: 'zz-canary-peer', runtime_key: 'zz-canary-peer', operation_id: randomUUID() };
    await expect(ingest(peer)).rejects.toMatchObject({ code: 'conflict' }); expect(await counts()).toEqual({ accounts: 1, bindings: 1, collections: 1 });
    await admin().query('UPDATE provider_accounts SET shared_with_pool=true WHERE id=$1', [first.account_id]);
    expect(await ingest(peer)).toMatchObject({ account_id: first.account_id });
    expect(await counts()).toEqual({ accounts: 1, bindings: 2, collections: 2 });
  });
  it('accepts identical replay but rejects changed identity, provider and windows before side effects', async () => {
    const target = await snapshot(); const receipt = measured(target);
    receipt.provider_report.windows[0] = { group_key: 'default', window_key: 'week', used_percent: 12.3456, remaining_percent: 87.6544 };
    const first = await measuredIngest(target, receipt);
    expect(await ingest(target, receipt)).toMatchObject({ account_id: first.account_id, duplicate: true });
    for (const changed of [{ identity_hash: 'a'.repeat(64) }, { provider_report: { ...receipt.provider_report,
      windows: [{ ...receipt.provider_report.windows[0], used_percent: 13 }] } }]) {
      await expect(ingest(target, { ...receipt, ...changed })).rejects.toMatchObject({ code: 'conflict' });
    }
    expect(await counts()).toEqual({ accounts: 1, bindings: 1, collections: 1 });
  });
  it('rolls back the binding and account when PostgreSQL rejects the sample timestamp', async () => {
    const target = await snapshot(); const receipt = measured(target); receipt.captured_at = new Date(Date.now() + 600_000).toISOString();
    await expect(ingest(target, receipt)).rejects.toMatchObject({ code: '23514' });
    expect(await counts()).toEqual({ accounts: 0, bindings: 0, collections: 0 });
  });
  it('keeps identical container names on different hosts in distinct sample collections', async () => {
    const target = await snapshot(); const receipt = measured(target); await ingest(target, receipt);
    await admin().query("INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES('zz-canary-other','Other','context_alpha'); UPDATE agents SET host_id='zz-canary-other' WHERE tenant_id='ContextAlpha' AND alias='director'");
    const moved = await snapshot(); expect(await ingest(moved, { ...receipt, operation_id: moved.operation_id, host_id: moved.host_id })).toMatchObject({ duplicate: false });
    expect(await counts()).toEqual({ accounts: 1, bindings: 1, collections: 2 });
  });
  it('returns an explicit unsupported state without registering an account or writing a sample', async () => {
    await admin().query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id='ContextAlpha' AND alias='director'");
    const target = await snapshot(); const { provider: _provider, identity_hash: _identity, provider_report: _report, observation_status: _status, ...envelope } = measured(target);
    expect(await ingest(target, { ...envelope, status: 'unsupported', reason: 'quota_reader_unavailable' }))
      .toMatchObject({ status: 'unsupported', reason: 'quota_reader_unavailable' });
    expect(await counts()).toEqual({ accounts: 0, bindings: 0, collections: 0 });
    await expect(ingest(target, { ...measured(target), account_identity: 'private-identity' })).rejects.toMatchObject({ code: 'invalid_input' });
  });
  it.skipIf(!process.env.CAUCE_AGENT_QUOTA_RECEIPTS)('ingests two sanitized results produced by actual Docker readers as one shared account', async () => {
    const parsed = JSON.parse(await readFile(requireValue(process.env.CAUCE_AGENT_QUOTA_RECEIPTS, 'Docker receipts'), 'utf8')) as {
      receipts: Record<string, unknown>[]; snapshots: Omit<AgentQuotaSnapshot, 'company_id' | 'expected_revision'>[];
    };
    expect(parsed.receipts.filter(receipt => receipt.status === 'measured')).toHaveLength(2);
    expect(parsed.receipts.filter(receipt => receipt.status === 'unsupported')).toHaveLength(1);
    const results = []; const revision = (await snapshot()).expected_revision;
    for (const receipt of parsed.receipts) {
      const packet = requireValue(parsed.snapshots.find(value => value.operation_id === receipt.operation_id), 'original Docker snapshot');
      const target = { ...packet, company_id: 'context_alpha', expected_revision: revision };
      await admin().query('INSERT INTO tenants(id,company_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [target.tenant_id, target.company_id]);
      await admin().query('INSERT INTO fleet_hosts(host_id,display_name,company_id) VALUES($1,$1,$2) ON CONFLICT DO NOTHING', [target.host_id, target.company_id]);
      await admin().query(`INSERT INTO agents(tenant_id,alias,company_id,harness_id,host_id,runtime_mode,container_name,
        runtime_user,home_directory,state_directory,runtime_key,systemd_user,primary_account_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`, [target.tenant_id,target.alias,target.company_id,target.harness_id,
      target.host_id,target.runtime_mode,target.container_name,target.runtime_user,target.home_directory,target.state_directory,
      target.runtime_key,target.systemd_user,target.primary_account_id]);
      const result = await ingest(target, receipt);
      if (result.status === 'measured') results.push(result);
      else expect(result).toEqual({ status: 'unsupported', reason: 'quota_reader_unavailable' });
    }
    expect(results[1]?.account_id).toBe(results[0]?.account_id); expect(await counts()).toEqual({ accounts: 1, bindings: 2, collections: 2 });
    const card = await withTransaction(pool, async client => quotaAccountSnapshot(client, await authority()(client)));
    expect(card.accounts).toEqual([expect.objectContaining({ shared: true, agent_count: 2 })]);
  });
});
