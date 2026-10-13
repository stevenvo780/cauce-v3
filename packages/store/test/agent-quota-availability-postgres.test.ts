import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import { build } from 'esbuild';
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentQuotaOperationsRepository, lockCompanyAuthority, withTransaction, type DatabaseClient, type DatabasePool } from '../src/index.js';
import { agentQuotaDescriptorModuleUrl, readAgentQuotaPlacement } from '../src/agent-quota-operations-model.js';
import { seedSyntheticCompanyContexts } from '../src/seed-dev-cli.js';
import { preparePostgresSuite } from './postgres-suite.js';
import { requireValue } from './helpers.js';
import { startTestCaseDatabase, startTestDatabase, type EmptyTestDatabase, type TestDatabase } from '../../../tests/helpers/postgres.js';

let database: TestDatabase | undefined; let current: EmptyTestDatabase | undefined; let pool: DatabasePool;
let identities: Awaited<ReturnType<typeof seedSyntheticCompanyContexts>>;
let descriptors: string; let approvalsFile: string; let approvals: Record<string, string>;
const target = { tenant_id: 'ContextAlpha', alias: 'director' };
preparePostgresSuite(import.meta.url, async () => { database = await startTestDatabase(); }, 120_000);
beforeEach(async () => {
  descriptors = await mkdtemp(join(tmpdir(), 'zz-canary-quota-descriptors-'));
  approvalsFile = join(descriptors, 'approvals.json'); approvals = {};
  for (const harness of ['codex', 'claude', 'grok']) await approveFixture(harness);
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE', approvalsFile);
  vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY', descriptors);
  current = await startTestCaseDatabase(requireValue(database, 'database')); pool = current.pool;
  identities = await seedSyntheticCompanyContexts(current.adminUrl);
  await admin().query(`INSERT INTO fleet_hosts(host_id,display_name,company_id)
    VALUES('zz-canary-quota-reader','Quota reader','context_alpha');
    UPDATE agents SET harness_id='codex',runtime_mode='container',host_id='zz-canary-quota-reader',
      container_name='zz-canary-quota-reader',runtime_user='dev',home_directory='/home/dev',
      state_directory='/home/dev/.cauce/dev',systemd_user='stev',runtime_key='zz-canary-quota-reader'
      WHERE tenant_id='ContextAlpha' AND alias='director';`);
  const host = 'zz-canary-quota-reader';
  const owner = requireValue(identities[0], 'owner');
  const enrollment = requireValue((await admin().query<{ id: string }>(`INSERT INTO fleet_host_enrollments
    (company_id,host_id,display_name,invited_by,token_hash,nonce,expires_at,state)
    VALUES($1,$2,$2,$3,$4,$4,now()+interval '1 hour','enrolled') RETURNING id`,
  [owner.company_id, host, owner.human_id, createHash('sha256').update(host).digest('hex')])).rows[0], 'enrollment');
  await admin().query(`INSERT INTO fleet_host_identities
    (host_id,company_id,enrollment_id,public_key,key_fingerprint,enabled,capabilities,capabilities_seen_at)
    VALUES($1,$2,$3,$4,$5,true,'{"fleet_executor":true}',now())`,
  [host, owner.company_id, enrollment.id, 'x'.repeat(64), createHash('sha256').update(`identity-${host}`).digest('hex')]);
});
afterEach(async () => {
  await current?.close(); current = undefined;
  vi.unstubAllEnvs(); if (descriptors) await rm(descriptors, { recursive: true, force: true });
});
afterAll(async () => { if (database) { await database.pool.end(); await database.container.stop(); } });
function admin() { return requireValue(current, 'case database').adminPool; }
function authority(client: DatabaseClient) {
  const person = requireValue(identities[0], 'company');
  return lockCompanyAuthority(client, { tenant: person.tenant_id, alias: 'owner', humanId: person.human_id });
}
function placement() {
  return withTransaction(pool, async client => readAgentQuotaPlacement(client, await authority(client), target));
}
function descriptorFixture(harness: string, quota = true) {
  return JSON.stringify({ schema_version: 1, harness,
    operations: { execute: 'native-execution', ...(quota ? { quota: 'quota-collector' } : {}) },
    context: { native_document: 'AGENTS.md', max_bytes: 65_536 },
    ...(quota ? { provider: { quota_argv: ['/usr/local/bin/zz-canary-quota-reader'] } } : {}) });
}
async function approveFixture(harness: string, quota = true) {
  const fixture = descriptorFixture(harness, quota);
  await writeFile(join(descriptors, `${harness}.json`), fixture);
  approvals[harness] = createHash('sha256').update(fixture).digest('hex');
  await writeFile(approvalsFile, JSON.stringify(approvals));
}

describe('agent quota reader availability with real PostgreSQL', () => {
  it.each(['codex', 'claude', 'grok'])('distinguishes a legacy %s runtime from a missing harness reader', async harness => {
    await admin().query("UPDATE agents SET harness_id=$1,runtime_mode='native' WHERE tenant_id=$2 AND alias=$3",
      [harness, target.tenant_id, target.alias]);
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_target_unplaced' });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: false, reason: 'quota_target_unplaced', status: 'unsupported' });
  });
  it.each([
    ['missing host', "UPDATE agents SET host_id=NULL WHERE tenant_id='ContextAlpha' AND alias='director'"],
    ['disabled host', "UPDATE fleet_hosts SET enabled=false WHERE host_id='zz-canary-quota-reader'"],
    ['disabled harness', "UPDATE harness_definitions SET enabled=false WHERE id='codex'"],
    ['disabled agent', "UPDATE agents SET enabled=false WHERE tenant_id='ContextAlpha' AND alias='director'"],
    ['retired agent', "UPDATE agents SET enabled=false,retired_at=now() WHERE tenant_id='ContextAlpha' AND alias='director'"],
  ])('reports target unavailability for a %s', async (_name, sql) => {
    await admin().query(sql);
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_target_unplaced' });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: false, reason: 'quota_target_unplaced' });
  });
  it.each(['openclaw', 'muse', 'hermes', 'opencode'])('reports a missing reader only for the unsupported %s harness', async harness => {
    await admin().query('UPDATE agents SET harness_id=$1 WHERE tenant_id=$2 AND alias=$3',
      [harness, target.tenant_id, target.alias]);
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_reader_unavailable' });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: false, reason: 'quota_reader_unavailable' });
  });
  it('retains the reader for an enabled supported container runtime', async () => {
    expect(await placement()).toMatchObject({ reader: true, reason: null });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: true, can_query: true, reason: null, status: 'unknown' });
  });
  it('retains the reader but blocks querying a host without a live identity', async () => {
    await admin().query("DELETE FROM fleet_host_identities WHERE host_id='zz-canary-quota-reader'");
    expect(await placement()).toMatchObject({ reader: true, reason: null });
    expect(await new AgentQuotaOperationsRepository(pool).snapshot(authority, target))
      .toMatchObject({ reader_available: true, can_query: false, reason: 'quota_host_unavailable', status: 'unknown' });
  });
  it('keeps unchanged unsupported observations stable across repeated reads', async () => {
    await admin().query("UPDATE agents SET harness_id='openclaw' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    const repository = new AgentQuotaOperationsRepository(pool);
    await repository.snapshot(authority, target);
    const before = (await admin().query('SELECT xmin::text,updated_at FROM agent_quota_observations')).rows;
    await repository.snapshot(authority, target);
    expect((await admin().query('SELECT xmin::text,updated_at FROM agent_quota_observations')).rows).toEqual(before);
  });
  it('enables a new approved quota descriptor and withdraws a removed operation without a SQL list edit', async () => {
    const harness = 'zz-canary-descriptor';
    await admin().query("INSERT INTO harness_definitions(id,display_name,capabilities) VALUES($1,$1,'[]')", [harness]);
    await admin().query('UPDATE agents SET harness_id=$1 WHERE tenant_id=$2 AND alias=$3', [harness, target.tenant_id, target.alias]);
    await writeFile(join(descriptors, `${harness}.json`), descriptorFixture(harness));
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_reader_unavailable' });
    await approveFixture(harness);
    expect(await placement()).toMatchObject({ reader: true, reason: null });
    await approveFixture(harness, false);
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_reader_unavailable' });
  });
  it('rereads approvals and descriptor bytes rather than retaining a cached reader', async () => {
    expect(await placement()).toMatchObject({ reader: true });
    delete approvals.codex; await writeFile(approvalsFile, JSON.stringify(approvals));
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_reader_unavailable' });
    await approveFixture('codex'); expect(await placement()).toMatchObject({ reader: true });
    await writeFile(join(descriptors, 'codex.json'), `${descriptorFixture('codex')}\n`);
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_reader_unavailable' });
    await admin().query("UPDATE agents SET harness_id='claude' WHERE tenant_id=$1 AND alias=$2", [target.tenant_id, target.alias]);
    expect(await placement()).toMatchObject({ reader: true });
  });
  it.each(['missing approvals', 'missing file', 'invalid map', 'missing directory'])('fails closed for %s', async failure => {
    if (failure === 'missing approvals') vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_APPROVALS_FILE', undefined);
    if (failure === 'missing file') await rm(approvalsFile);
    if (failure === 'invalid map') await writeFile(approvalsFile, JSON.stringify({ codex: 7 }));
    if (failure === 'missing directory') vi.stubEnv('CAUCE_HARNESS_DESCRIPTOR_DIRECTORY', join(descriptors, 'absent'));
    expect(await placement()).toMatchObject({ reader: false, reason: 'quota_reader_unavailable' });
  });
  it.each([
    ['source', 'packages/store/src/agent-quota-operations-model.ts'],
    ['deployment', 'packages/store/dist/agent-quota-operations-model.js'],
    ['core build', 'dist/packages/store/src/agent-quota-operations-model.js'],
  ])('loads the real SDK catalog in the %s layout with a standalone Node process', async (_name, relative) => {
    const root = join(descriptors, 'runtime'); const modelPath = join(root, relative);
    const sdkUrl = agentQuotaDescriptorModuleUrl(pathToFileURL(modelPath).href);
    const sdkPath = fileURLToPath(sdkUrl);
    await mkdir(root, { recursive: true });
    await symlink(fileURLToPath(new URL('../../../node_modules', import.meta.url)), join(root, 'node_modules'));
    const dependencies = [
      [new URL('../node_modules/', pathToFileURL(modelPath)), new URL('../node_modules/', import.meta.url)],
      [new URL(sdkPath.endsWith('.ts') ? '../../node_modules/' : '../../../node_modules/', sdkUrl),
        new URL('../../adapter-sdk/node_modules/', import.meta.url)],
    ] as const;
    for (const [link, source] of dependencies) {
      const path = fileURLToPath(link).replace(/\/$/u, ''); await mkdir(dirname(path), { recursive: true });
      await symlink(fileURLToPath(source), path);
    }
    await writeFile(join(root, 'package.json'), '{"type":"module"}');
    for (const [source, outfile] of [
      [new URL('../src/agent-quota-operations-model.ts', import.meta.url), modelPath],
      [new URL('../../adapter-sdk/src/context/harness-descriptor.ts', import.meta.url), sdkPath],
    ] as const) {
      await build({ entryPoints: [fileURLToPath(source)], outfile, bundle: true, platform: 'node', format: 'esm',
        packages: 'external', logLevel: 'silent' });
    }
    const catalog = fileURLToPath(new URL('../../descriptors/', sdkUrl)); await mkdir(catalog, { recursive: true });
    for (const harness of Object.keys(approvals)) {
      await writeFile(join(catalog, `${harness}.json`), await readFile(join(descriptors, `${harness}.json`)));
    }
    const env = { ...process.env }; delete env.CAUCE_HARNESS_DESCRIPTOR_DIRECTORY;
    const run = () => promisify(execFile)(process.execPath, [
      ...(relative.endsWith('.ts') ? ['--import', 'tsx'] : []), '--input-type=module', '--eval',
      `const model = await import(${JSON.stringify(pathToFileURL(modelPath).href)}); console.log(JSON.stringify(await model.approvedAgentQuotaHarnesses()));`,
    ], { cwd: fileURLToPath(new URL('../../../', import.meta.url)), env });
    expect(JSON.parse((await run()).stdout)).toEqual(['claude', 'codex', 'grok']);
    await rm(sdkPath);
    expect(JSON.parse((await run()).stdout)).toEqual([]);
  });
});
