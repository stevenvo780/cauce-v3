import { afterAll, afterEach, beforeEach, describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { sha256Hex, type ConfigLeafMutation } from '@cauce/protocol';
import { ConfigurationRepository, FleetOperationsRepository, createPool, lockCompanyAuthority, withTransaction, type DatabasePool } from '../src/index.js';
import { applyPlatformConfiguration, readPlatformConfiguration, rollbackPlatformConfiguration, type PlatformActor } from '../src/configuration-platform.js';
import { exportCompanyConfiguration, importCompanyConfiguration, planCompanyConfigurationImport } from '../src/company-transfer.js';
import { parseCompanyTransferBundle, type CompanyTransferBundle } from '../src/company-transfer-model.js';
import { buildCompanyTransferPlan } from '../src/company-transfer-plan.js';
import { runPlatformCli } from '../../../services/gateway/src/platform-cli.js';
import { hashPassword } from '../../../services/gateway/src/password.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { seedCompanyIsolation, type CompanyIsolationFixture } from './companies-postgres.fixtures.js';
import { provisionTestLogin, startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined;
let admin: DatabasePool; let people: CompanyIsolationFixture;
const password = 'platform-current-test-password';
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  if (!database) throw new Error('test database absent');
  current = await startTestCaseDatabase(database); admin = current.adminPool;
  people = await seedCompanyIsolation(admin);
  await admin.query(`INSERT INTO human_tenant_memberships(human_id,tenant_id,actor_alias,permissions)
    VALUES($1,'PraxisHub','company_admin',ARRAY['read','control'])`, [people.leon]);
  await admin.query("UPDATE memberships SET role='operator' WHERE tenant_id='Miguel' AND alias='janus'");
  await admin.query('UPDATE console_users SET password_hash=$1 WHERE id=$2',
    [await hashPassword(password, { cost: 1024, blockSize: 8, parallelism: 1 }), people.steven]);
});
afterEach(async () => { await current?.close(); current = undefined; });
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
const platform = (companyId = 'praxis'): PlatformActor => ({ humanId: people.steven, tenant: 'Steven', alias: 'kant', companyId });
const owner = (): PlatformActor => ({ humanId: people.leon, tenant: 'PraxisHub', alias: 'company_admin', companyId: 'praxis' });
const policy: ConfigLeafMutation = { resource: 'role_policy', action: 'create', role: 'transfer_role', value: { allow_read: true, allow_route: true } };
function seal(value: CompanyTransferBundle): CompanyTransferBundle {
  const { bundle_sha256: _discard, ...payload } = value;
  return { ...payload, bundle_sha256: sha256Hex(payload) };
}
async function revisions(): Promise<number> { return (await admin.query('SELECT id FROM config_revisions')).rowCount ?? 0; }
async function changedRoom(): Promise<{ current: CompanyTransferBundle; bundle: CompanyTransferBundle }> {
  const current = await exportCompanyConfiguration(admin, platform());
  const bundle = seal({ ...current, records: { ...current.records, rooms: [...current.records.rooms,
    { tenant_id: 'PraxisHub', id: 'imported-room', display_name: 'Imported', enabled: true }] } });
  return { current, bundle };
}
describe('human platform CLI and company transfer', () => {
  it('keeps global catalogs outside the generic GUI and requires a durable platform person and a platform database connection', async () => {
    const generic = new ConfigurationRepository(admin);
    await expect(generic.apply('Steven', 'kant', policy, false, 0,
      client => lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: people.steven }))).rejects.toMatchObject({ code: 'forbidden' });
    await expect(applyPlatformConfiguration(admin, owner(), policy, false, 0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(readPlatformConfiguration(admin, { ...platform(), humanId: people.leon })).rejects.toMatchObject({ code: 'forbidden' });
    expect((await readPlatformConfiguration(admin, platform())).company_id).toBe('praxis');
    if (!current) throw new Error('test database absent');
    const runtime = createPool(await provisionTestLogin(admin, current.adminUrl, 'cauce_gateway', 'cauce_runtime'), { max: 1 });
    try {
      expect((await runtime.query('SELECT current_user AS role')).rows).toEqual([{ role: 'cauce_gateway' }]);
      await expect(applyPlatformConfiguration(runtime, platform(), policy, false, 0)).rejects.toMatchObject({ code: '42501' });
    } finally { await runtime.end(); }
    expect(await revisions()).toBe(0);
  });
  it('uses catalog preview, CAS, inverse rollback and human platform audit history', async () => {
    expect((await applyPlatformConfiguration(admin, platform(), policy, true, 0)).dry_run).toBe(true);
    expect(await revisions()).toBe(0); expect((await admin.query("SELECT role FROM role_policies WHERE role='transfer_role'")).rows).toEqual([]);
    const applied = await applyPlatformConfiguration(admin, platform(), policy, false, 0);
    expect(applied.applied).toBe(true);
    await expect(applyPlatformConfiguration(admin, platform(), { ...policy, role: 'stale_role' }, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    const rollback = await rollbackPlatformConfiguration(admin, platform(), applied.revision, false, applied.revision);
    expect(rollback.rolled_back_revision_id).toBe(applied.revision);
    expect((await admin.query("SELECT role FROM role_policies WHERE role='transfer_role'")).rows).toEqual([]);
    expect((await admin.query("SELECT scope,company_id,actor_human_id::text FROM config_revisions ORDER BY id")).rows)
      .toEqual([1, 2].map(() => ({ scope: 'platform', company_id: null, actor_human_id: people.steven })));
    expect((await admin.query("SELECT action,actor_human_id::text FROM audit_events WHERE action LIKE 'config.%' ORDER BY id")).rows)
      .toEqual([{ action: 'config.change', actor_human_id: people.steven }, { action: 'config.rollback', actor_human_id: people.steven }]);
  });
  it('cannot remove the final platform controller through a role policy change', async () => {
    const revoke: ConfigLeafMutation = { resource: 'role_policy', action: 'update', role: 'operator', value: { allow_control: false } };
    await expect(applyPlatformConfiguration(admin, platform(), revoke, false, 0)).rejects.toMatchObject({ code: 'conflict' });
    expect((await admin.query("SELECT allow_control FROM role_policies WHERE role='operator'")).rows).toEqual([{ allow_control: true }]);
    expect(await revisions()).toBe(0);
  });
  it('requires the current password and rejects revoked roles and unavailable acting companies', async () => {
    const request = { email: 'steven@example.test', password, companyId: 'praxis', command: { kind: 'show' as const } };
    expect(await runPlatformCli(admin, request)).toMatchObject({ company_id: 'praxis' });
    await expect(runPlatformCli(admin, { ...request, password: 'wrong' })).rejects.toThrow('authentication');
    await expect(runPlatformCli(admin, { ...request, companyId: 'missing' })).rejects.toMatchObject({ code: 'forbidden' });
    await admin.query('INSERT INTO platform_admins(human_id) VALUES($1)', [people.miguel]);
    await admin.query('DELETE FROM platform_admins WHERE human_id=$1', [people.steven]);
    await expect(runPlatformCli(admin, request)).rejects.toMatchObject({ code: 'forbidden' });
    expect(await revisions()).toBe(0);
  });
  it('exports Praxis with a strict allowlist and no provider, human or session material', async () => {
    const result = await exportCompanyConfiguration(admin, platform());
    expect(result.records.tenants.map(row => row.id)).toEqual(['PraxisHub', 'PraxisTeam']);
    expect(parseCompanyTransferBundle(result)).toEqual(result);
    const encoded = JSON.stringify(result);
    for (const excluded of ['credential_ref', 'password_hash', 'provider_accounts', 'humanizar-account', 'praxis-account', 'CAUCE_TEST', 'sessions', 'messages']) {
      expect(encoded).not.toContain(excluded);
    }
    await expect(exportCompanyConfiguration(admin, owner())).rejects.toMatchObject({ code: 'forbidden' });
  });
  it('preserves the physical descriptor of native agents with the database host sentinel', async () => {
    await admin.query(`UPDATE agents SET runtime_key='praxis-native',primary_room_id='company-praxis',runtime_mode='native',
      container_name='host:praxis-host',systemd_user='stev',lifecycle_state='ready' WHERE tenant_id='PraxisHub' AND alias='company_admin'`);
    const bundle = await exportCompanyConfiguration(admin, platform());
    const native = bundle.records.agents.find(row => row.tenant_id === 'PraxisHub' && row.alias === 'company_admin');
    expect(native?.runtime).toMatchObject({ runtime_key: 'praxis-native', placement: { mode: 'native', host_id: 'praxis-host', systemd_user: 'stev' } });
    expect(native?.runtime?.placement).not.toHaveProperty('container_name');
    expect(parseCompanyTransferBundle(bundle)).toEqual(bundle);
    expect((await planCompanyConfigurationImport(admin, platform(), bundle, 0)).fleet_requests).toEqual([]);
  });
  it('rolls back import previews and failures midway while preserving the outer transaction', async () => {
    const { current, bundle } = await changedRoom();
    const plan = await planCompanyConfigurationImport(admin, platform(), bundle, 0);
    expect(plan.mutations.some(row => row.resource === 'room')).toBe(true); expect(await revisions()).toBe(0);
    await withTransaction(admin, async client => {
      expect(await importCompanyConfiguration(admin, platform(), bundle, plan, true, { transactionClient: client })).toMatchObject({ dry_run: true, applied: false });
      expect((await client.query("SELECT id FROM rooms WHERE id='imported-room'")).rows).toEqual([]);
      expect((await client.query('SELECT id FROM config_revisions')).rows).toEqual([]);
      const failed = seal({ ...bundle, records: { ...bundle.records, memberships: bundle.records.memberships.map(row => ({ ...row, role: 'missing_transfer_role' })) } });
      const failedPlan = buildCompanyTransferPlan(failed, current, 0);
      await expect(importCompanyConfiguration(admin, platform(), failed, failedPlan, false, { transactionClient: client })).rejects.toBeDefined();
      expect((await client.query("SELECT id FROM rooms WHERE id='imported-room'")).rows).toEqual([]);
      expect((await client.query('SELECT id FROM config_revisions')).rows).toEqual([]);
      expect((await client.query('SELECT 1 AS usable')).rows).toEqual([{ usable: 1 }]);
    });
  });
  it('applies exact plans with scoped history and replays the receipt without overwriting later edits', async () => {
    const { bundle } = await changedRoom(); const plan = await planCompanyConfigurationImport(admin, platform(), bundle, 0);
    const receipt = await importCompanyConfiguration(admin, platform(), bundle, plan, false);
    expect(receipt).toMatchObject({ applied: true, replayed: false, physical_effect_verified: false, fleet_operations: [] });
    expect((await admin.query("SELECT company_id,actor_human_id::text,platform_override FROM config_revisions")).rows)
      .toEqual([{ company_id: 'praxis', actor_human_id: people.steven, platform_override: true }]);
    const later = await new ConfigurationRepository(admin).apply('Steven', 'kant', { resource: 'room', action: 'update', tenant_id: 'PraxisHub',
      id: 'imported-room', value: { display_name: 'Later local edit' } }, false, receipt.revision,
    client => lockCompanyAuthority(client, { tenant: 'Steven', alias: 'kant', humanId: people.steven, requestedCompany: 'praxis' }));
    expect((await importCompanyConfiguration(admin, platform(), bundle, plan, false)).replayed).toBe(true);
    expect((await admin.query("SELECT display_name FROM rooms WHERE id='imported-room'")).rows).toEqual([{ display_name: 'Later local edit' }]);
    expect(await revisions()).toBe(2); expect(later.revision).toBeGreaterThan(receipt.revision);
    expect((await admin.query("SELECT company_id,metadata->>'bundle_sha256' AS bundle FROM audit_events WHERE action='company.configuration.import'")).rows)
      .toEqual([{ company_id: 'praxis', bundle: bundle.bundle_sha256 }]);
  });
  it('rejects cross-company, collision, stale and tampered plans before applying', async () => {
    const { bundle } = await changedRoom(); const plan = await planCompanyConfigurationImport(admin, platform(), bundle, 0);
    await expect(importCompanyConfiguration(admin, platform('humanizar'), bundle, plan, false)).rejects.toMatchObject({ code: 'forbidden' });
    const foreign = seal({ ...bundle, records: { ...bundle.records, tenants: [...bundle.records.tenants,
      { id: 'Steven', display_name: null, is_hub: false, enabled: true }] } });
    await expect(planCompanyConfigurationImport(admin, platform(), foreign, 0)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(importCompanyConfiguration(admin, platform(), bundle, { ...plan, mutations: [] }, false)).rejects.toMatchObject({ code: 'invalid_input' });
    const { plan_sha256: _discard, ...payload } = plan;
    const tampered = { ...payload, mutations: [policy] }; const forged = { ...tampered, plan_sha256: sha256Hex(tampered) };
    await expect(importCompanyConfiguration(admin, platform(), bundle, forged, false)).rejects.toMatchObject({ code: 'conflict' });
    await applyPlatformConfiguration(admin, platform(), policy, false, 0);
    await expect(importCompanyConfiguration(admin, platform(), bundle, plan, false)).rejects.toMatchObject({ code: 'conflict' });
    expect((await admin.query("SELECT id FROM rooms WHERE id='imported-room'")).rows).toEqual([]);
  });
  it('keeps identical imports free of spurious configuration revisions', async () => {
    const bundle = await exportCompanyConfiguration(admin, platform()); const plan = await planCompanyConfigurationImport(admin, platform(), bundle, 0);
    expect(plan.mutations).toEqual([]);
    await importCompanyConfiguration(admin, platform(), bundle, plan, false);
    expect(await revisions()).toBe(0);
  });
  it('creates an inactive draft and one fenced pending operation through the real coordinator repository', async () => {
    const current = await exportCompanyConfiguration(admin, platform());
    const runtime = { runtime_key: 'praxis-transfer-agent', harness_id: 'codex', primary_room_id: 'company-praxis',
      memberships: [{ room_id: 'company-praxis', role: 'operator', enabled: true }],
      placement: { host_id: 'praxis-host', mode: 'container' as const, container_name: 'praxis-transfer-agent', runtime_user: 'dev',
        home_directory: '/home/dev', state_directory: '/home/dev/.cauce/praxis-transfer-agent' } };
    const bundle = seal({ ...current, records: { ...current.records, agents: [...current.records.agents,
      { tenant_id: 'PraxisHub', alias: 'transfer_agent', display_name: 'Transfer agent', max_concurrent_deliveries: 2, runtime }],
      memberships: [...current.records.memberships, { tenant_id: 'PraxisHub', alias: 'transfer_agent', room_id: 'company-praxis', role: 'operator', enabled: true }] } });
    const fleetRepository = new FleetOperationsRepository(admin, { controllerHost: 'humanizar-host', coordinatorEnabled: true,
      coordinatorHosts: ['humanizar-host', 'praxis-host'] });
    const options = { fleetRepository };
    const plan = await planCompanyConfigurationImport(admin, platform(), bundle, 0, options);
    expect((await admin.query("SELECT alias FROM agents WHERE alias='transfer_agent'")).rows).toEqual([]);
    expect((await admin.query('SELECT id FROM fleet_operations')).rows).toEqual([]);
    const receipt = await importCompanyConfiguration(admin, platform(), bundle, plan, false, options);
    expect(receipt.fleet_operations).toEqual([expect.objectContaining({ status: 'queued' })]);
    expect(receipt.physical_effect_verified).toBe(false);
    expect((await admin.query("SELECT enabled,lifecycle_state,runtime_key FROM agents WHERE alias='transfer_agent'")).rows)
      .toEqual([{ enabled: false, lifecycle_state: 'draft', runtime_key: null }]);
    expect((await admin.query("SELECT company_id,actor_tenant,actor_alias,executor_host FROM fleet_operations")).rows)
      .toEqual([{ company_id: 'praxis', actor_tenant: 'Steven', actor_alias: 'kant', executor_host: 'humanizar-host' }]);
    expect((await importCompanyConfiguration(admin, platform(), bundle, plan, false, options)).replayed).toBe(true);
    expect((await admin.query('SELECT id FROM fleet_operations')).rowCount).toBe(1);
  });
  it('preserves current target provider selections during physical updates without exporting them', async () => {
    await admin.query(`UPDATE agents SET runtime_key='praxis-current',primary_room_id='company-praxis',runtime_mode='container',
      state_directory='/home/dev/.cauce/praxis-current',systemd_user='stev',lifecycle_state='ready',primary_account_id='praxis-account',
      model_id='codex/gpt-6.1-sol',reasoning_effort='high' WHERE tenant_id='PraxisHub' AND alias='company_admin'`);
    const current = await exportCompanyConfiguration(admin, platform());
    const placed = current.records.agents.find(row => row.tenant_id === 'PraxisHub' && row.alias === 'company_admin');
    if (!placed?.runtime) throw new Error('fixture placed runtime absent');
    const membership = { tenant_id: 'PraxisHub', alias: 'company_admin', room_id: 'imported-room', role: 'operator', enabled: true };
    const runtime = { ...placed.runtime, memberships: [...placed.runtime.memberships,
      { room_id: membership.room_id, role: membership.role, enabled: true }] };
    const bundle = seal({ ...current, records: { ...current.records,
      rooms: [...current.records.rooms, { tenant_id: 'PraxisHub', id: 'imported-room', display_name: 'Imported', enabled: true }],
      agents: current.records.agents.map(row => row === placed ? { ...row, runtime } : row),
      memberships: [...current.records.memberships, membership] } });
    expect(JSON.stringify(bundle)).not.toContain('praxis-account'); expect(JSON.stringify(bundle)).not.toContain('codex/gpt-6.1-sol');
    const options = { fleetRepository: new FleetOperationsRepository(admin, { controllerHost: 'humanizar-host', coordinatorEnabled: true,
      coordinatorHosts: ['humanizar-host', 'praxis-host'] }) };
    const plan = await planCompanyConfigurationImport(admin, platform(), bundle, 0, options);
    expect(plan.fleet_requests).toEqual([expect.objectContaining({ kind: 'update' })]);
    const receipt = await importCompanyConfiguration(admin, platform(), bundle, plan, false, options);
    expect(receipt.physical_effect_verified).toBe(false);
    expect((await admin.query(`SELECT request->'parameters'->>'primary_account_id' AS account,
      request->'parameters'->>'model_id' AS model,request->'parameters'->>'reasoning_effort' AS effort FROM fleet_operations`)).rows)
      .toEqual([{ account: 'praxis-account', model: 'codex/gpt-6.1-sol', effort: 'high' }]);
    expect((await admin.query("SELECT primary_account_id,model_id,reasoning_effort FROM agents WHERE tenant_id='PraxisHub' AND alias='company_admin'")).rows)
      .toEqual([{ primary_account_id: 'praxis-account', model_id: 'codex/gpt-6.1-sol', reasoning_effort: 'high' }]);
  });
  it('executes the real local CLI source with a private DSN file and current password environment', async () => {
    if (!current) throw new Error('test database absent');
    const directory = await mkdtemp(join(tmpdir(), 'cauce-platform-cli-'));
    const dsn = join(directory, 'owner-dsn'); const exported = join(directory, 'export.json');
    const accepted = join(directory, 'plan.json'); const mutation = join(directory, 'mutation.json');
    const cli = fileURLToPath(new URL('../../../services/gateway/src/platform-cli-main.ts', import.meta.url));
    const cwd = fileURLToPath(new URL('../../../', import.meta.url));
    const environment: NodeJS.ProcessEnv = { ...process.env, CAUCE_PLATFORM_PASSWORD: password };
    delete environment.CAUCE_FLEET_API_CONFIG_FILE; delete environment.CAUCE_FLEET_CONTROLLER_HOST;
    const execute = async (command: string, args: string[] = []) => {
      const result = await promisify(execFile)(process.execPath, ['--import', 'tsx', cli, command, '--email', 'steven@example.test',
        '--company', 'praxis', '--database-url-file', dsn, ...args], { cwd, env: environment, timeout: 30_000 });
      expect(result.stderr).toBe(''); expect(result.stdout).not.toContain(password); expect(result.stdout).not.toContain(current?.adminUrl);
      return result.stdout;
    };
    try {
      await writeFile(dsn, current.adminUrl, { mode: 0o600 });
      expect(JSON.parse(await execute('show')) as unknown).toMatchObject({ company_id: 'praxis', revision: 0 });
      await writeFile(mutation, JSON.stringify(policy), { mode: 0o600 });
      expect(JSON.parse(await execute('change', ['--mutation-file', mutation, '--expected-revision', '0', '--dry-run'])) as unknown)
        .toMatchObject({ applied: false, dry_run: true });
      expect(await revisions()).toBe(0);
      await execute('export', ['--output', exported]);
      expect((await stat(exported)).mode & 0o777).toBe(0o600);
      await execute('plan-import', ['--bundle-file', exported, '--expected-revision', '0', '--output', accepted]);
      const plan: unknown = JSON.parse(await readFile(accepted, 'utf8'));
      expect(plan).toMatchObject({ company_id: 'praxis', mutations: [], fleet_requests: [] });
      expect(JSON.parse(await execute('import', ['--bundle-file', exported, '--plan-file', accepted, '--apply'])) as unknown)
        .toMatchObject({ applied: true, replayed: false, physical_effect_verified: false });
      expect(JSON.parse(await execute('import', ['--bundle-file', exported, '--plan-file', accepted, '--apply'])) as unknown)
        .toMatchObject({ replayed: true });
      expect(await revisions()).toBe(0);
    } finally { await rm(directory, { recursive: true, force: true }); }
  }, 30_000);
});
