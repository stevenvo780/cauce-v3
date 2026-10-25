import { execFile } from 'node:child_process';
import { createHash, generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { Agent, request } from 'node:https';
import { userInfo } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HostEnrollmentRepository, hostEnrollmentMessage, lockCompanyAuthority } from '@cauce/store';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration,
  PATTERN_DEFECT_RULE, type V4Page,
} from './v4-console-real-browser.helpers.js';
import { quotaCanaryPerson } from './v4-quota-environments-real-browser.fixtures.js';
import { HostCapabilitiesSchema } from '../../services/gateway/src/fleet/host-channel.capabilities.js';
import { channelPacket, type ChannelHost } from '../../services/gateway/src/fleet/host-channel.fixtures.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', process.env.CAUCE_PLAZOS_FACTOR ?? '3');
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');
const repository = fileURLToPath(new URL('../../', import.meta.url));
const execute = promisify(execFile);
const task = 'e2e-a7-commit-1025';
const run = randomUUID().replaceAll('-', '').slice(0, 8);
const owner = quotaCanaryPerson(`${task}-descriptor`, run);
const accountLabel = `Descriptor account ${run}`;
const environmentLabel = `Approved descriptor ${run}`;
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let tls: Agent | undefined;

interface ApprovedPolicy {
  bundles: { codex: { directory: string; digest: string; executable: string; executable_sha256: string;
    argv: string[]; descriptor_sha256: string } };
  quota_environments: { image: string; network: string; providers: string[] };
}
interface PythonQuotaCapabilities { providers: string[]; actions: Record<string, string[]> }
interface QuotaSnapshot {
  environments: { id: string; label: string; version: number; status: string }[];
  operations: { id: string; action: string; status: string }[];
  capabilities: { available: boolean; providers: string[]; actions: string[];
    hosts: { host_id: string; providers: string[]; provider_actions: Record<string, string[]> }[] };
}

function active() {
  if (!fixture) throw new Error('descriptor browser fixture is not initialized');
  return fixture;
}

const sha256 = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');

async function python(source: string, ...args: string[]): Promise<string> {
  const result = await execute('/usr/bin/python3', ['-c', `import sys\nsys.path.insert(0, sys.argv[1])\n${source}`,
    join(repository, 'ops/cli'), ...args], {
    cwd: repository, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 15_000, maxBuffer: 65_536,
  });
  expect(result.stderr).toBe('');
  return result.stdout.trim();
}

async function bundleDigest(directory: string): Promise<string> {
  return python('from fleet_executor_runtime import bundle_digest\nprint(bundle_digest(sys.argv[2]))', directory);
}

async function quotaCapabilities(policy: ApprovedPolicy): Promise<PythonQuotaCapabilities> {
  const root = join(active().directory, 'executor-cli');
  const roots: Record<string, string> = {};
  for (const name of ['state', 'runtime', 'pki', 'tokens', 'identities']) {
    roots[name] = join(root, name);
    await mkdir(roots[name], { recursive: true, mode: 0o700 });
  }
  const cliPolicy = { schemaVersion: 1, host_id: 'descriptor-host', executor_user: userInfo().username,
    roots, native: [] as unknown[], containers: {}, profiles: {}, hooks: {}, ...policy };
  const policyFile = join(root, 'policy.json');
  await writeFile(policyFile, JSON.stringify(cliPolicy), { mode: 0o600 });
  const result = await execute('/usr/bin/python3', ['-B', join(repository, 'ops/cli/fleet-executor.py'),
    '--policy', policyFile, '--capabilities'], {
    cwd: repository, env: { PATH: '/usr/bin:/bin', PYTHONDONTWRITEBYTECODE: '1' }, timeout: 15_000, maxBuffer: 65_536,
  });
  expect(result.stderr).toBe('');
  const receipt = JSON.parse(result.stdout) as { quota_environments?: PythonQuotaCapabilities };
  if (!receipt.quota_environments) throw new Error('fleet executor did not publish quota capabilities');
  return receipt.quota_environments;
}

async function approvedPolicy(): Promise<{ policy: ApprovedPolicy; descriptorPath: string; descriptor: string }> {
  const directory = join(active().directory, 'approved-descriptor-bundle');
  const descriptorDirectory = join(directory, 'packages/adapter-sdk/dist/descriptors');
  await mkdir(descriptorDirectory, { recursive: true, mode: 0o700 });
  const descriptor = await readFile(join(repository, 'packages/adapter-sdk/descriptors/codex.json'), 'utf8');
  const descriptorPath = join(descriptorDirectory, 'codex.json');
  await writeFile(descriptorPath, descriptor, { mode: 0o600 });
  const policy: ApprovedPolicy = {
    bundles: { codex: { directory, digest: await bundleDigest(directory), executable: '/usr/bin/true',
      executable_sha256: sha256(await readFile('/usr/bin/true')), argv: [], descriptor_sha256: sha256(descriptor) } },
    quota_environments: { image: `sha256:${'a'.repeat(64)}`, network: 'descriptor-test', providers: ['codex'] },
  };
  return { policy, descriptorPath, descriptor };
}

async function enrollHost(): Promise<ChannelHost> {
  const pool = active().database.pool;
  const person = (await pool.query<{ id: string; company_id: string; tenant_id: string; alias: string }>(
    'SELECT id::text,company_id,tenant_id,alias FROM console_users WHERE email=$1', [owner.email])).rows[0];
  if (!person) throw new Error('descriptor test owner was not registered');
  const keys = generateKeyPairSync('ed25519');
  const host_id = `${person.company_id}-descriptor`;
  const enrollment = new HostEnrollmentRepository(pool);
  const invitation = await enrollment.invite(client => lockCompanyAuthority(client,
    { tenant: person.tenant_id, alias: person.alias, humanId: person.id }), { host_id, display_name: 'Descriptor host' });
  await enrollment.claim(invitation.enrollment_id, {
    invitation_token: invitation.invitation_token,
    public_key: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    proof: sign(null, Buffer.from(hostEnrollmentMessage(invitation)), keys.privateKey).toString('base64'),
  });
  return { host_id, company_id: person.company_id, keys };
}

async function publishCapabilities(host: ChannelHost, policy: ApprovedPolicy, quota: PythonQuotaCapabilities): Promise<void> {
  const capabilities = HostCapabilitiesSchema.parse({ resource: 'host', action: 'capabilities', schemaVersion: 1,
    executor_version: 'descriptor-browser-test', policy_sha256: sha256(JSON.stringify(policy)), fleet_executor: false,
    quota_executor: true, templates: [], quota_providers: quota.providers, quota_provider_actions: quota.actions });
  const payload = JSON.stringify(channelPacket(host, capabilities));
  const response = await new Promise<{ status: number; body: Record<string, unknown> }>((resolve, reject) => {
    const outgoing = request(`${active().gatewayUrl}/v3/fleet/hosts/${host.host_id}/channel`, {
      agent: tls, method: 'POST', headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) },
    }, incoming => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
      incoming.on('error', reject);
      incoming.on('end', () => {
        try { resolve({ status: incoming.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown> }); }
        catch (cause) { reject(cause instanceof Error ? cause : new Error('invalid signed host channel response', { cause })); }
      });
    });
    outgoing.on('error', reject);
    outgoing.setTimeout(10_000, () => outgoing.destroy(new Error('signed descriptor capability publication timed out')));
    outgoing.end(payload);
  });
  expect(response.status).toBe(200);
  expect(response.body).toMatchObject({ accepted: true, quota_executor_ready: quota.providers.length > 0 });
}

async function quotaSnapshot(page: V4Page): Promise<QuotaSnapshot> {
  const response = await apiGet(page, '/v3/console/quota-environments');
  expect(response.status).toBe(200);
  return response.body as unknown as QuotaSnapshot;
}

async function post(page: V4Page, target: string, payload: unknown) {
  return page.evaluate(async ({ path, body }: { path: string; body: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(path, { method: 'POST', credentials: 'include', body,
      headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, { path: target, body: JSON.stringify(payload) });
}

async function registerAccount(page: V4Page): Promise<string> {
  await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
  const form = page.getByRole('form', { name: 'Registrar cuenta de cuotas' });
  await form.getByLabel('Nombre de la cuenta', { exact: true }).fill(accountLabel);
  await form.locator('select').selectOption('codex');
  await form.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
  await page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }).waitFor({ timeout: 20_000 });
  const response = await apiGet(page, '/v3/console/quota-accounts');
  expect(response.status).toBe(200);
  const account = (response.body as unknown as { accounts: { id: string; label: string }[] }).accounts.find(row => row.label === accountLabel);
  if (!account) throw new Error('descriptor quota account was not persisted');
  return account.id;
}

let previousCwd: string | undefined;

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this descriptor E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  previousCwd = process.cwd();
  process.chdir(repository);
  fixture = await startConsoleFunctionalFixture();
  tls = new Agent({ ca: await readFile(fixture.pki.ca.cert), cert: await readFile(fixture.pki.consoleClient.cert),
    key: await readFile(fixture.pki.consoleClient.key), rejectUnauthorized: true });
}, 600_000);

afterAll(async () => {
  tls?.destroy();
  try { await fixture?.close(); }
  finally { if (previousCwd) process.chdir(previousCwd); vi.unstubAllEnvs(); }
}, 180_000);

describe('approved descriptor quota capabilities with real Python, PostgreSQL, gateway and Chromium', () => {
  it('withdraws the altered pinned descriptor from Mis cuotas and rejects create/query before enqueue', async () => {
    const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    errors.watch(page, 'descriptor-owner');
    const registration = await openRegistration(page, active().baseUrl);
    await fillRegistration(registration, owner);
    await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    const host = await enrollHost();
    const { policy, descriptorPath, descriptor } = await approvedPolicy();
    const approvedQuota = await quotaCapabilities(policy);
    expect(approvedQuota.providers).toEqual(['codex']);
    expect(approvedQuota.actions.codex).toEqual(['create', 'authenticate', 'query', 'update_cli', 'delete']);
    await publishCapabilities(host, policy, approvedQuota);

    await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    const accountId = await registerAccount(page);
    const before = await quotaSnapshot(page);
    expect(before.capabilities).toMatchObject({ available: true, providers: ['codex'],
      hosts: [{ host_id: host.host_id, provider_actions: { codex: approvedQuota.actions.codex } }] });
    expect(before.capabilities.actions).toEqual(expect.arrayContaining(['create', 'query']));
    const form = page.getByRole('form', { name: 'Crear entorno de cuotas' });
    await form.locator('select').nth(0).selectOption(accountId);
    await form.locator('select').nth(1).selectOption(host.host_id);
    await form.getByLabel('Nombre del entorno', { exact: true }).fill(environmentLabel);
    expect(await form.getByRole('button', { name: 'Crear entorno', exact: true }).isDisabled()).toBe(false);
    await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
    const card = page.getByRole('article', { name: `Entorno ${environmentLabel}`, exact: true });
    await card.waitFor({ timeout: 20_000 });
    expect(await card.getByRole('button', { name: 'Consultar cuotas', exact: true }).count()).toBe(1);
    const created = await quotaSnapshot(page);
    const environment = created.environments.find(row => row.label === environmentLabel);
    if (!environment) throw new Error('approved descriptor environment was not persisted');
    expect(environment.status).toBe('pending');
    expect(created.operations).toHaveLength(1);
    expect(created.operations[0]).toMatchObject({ action: 'create', status: 'pending' });

    const altered = JSON.parse(descriptor) as { context: { max_bytes: number } };
    altered.context.max_bytes += 1024;
    await writeFile(descriptorPath, JSON.stringify(altered), { mode: 0o600 });
    const validatedDigest = await python('from harness_operations import read_descriptor\nprint(read_descriptor(sys.argv[2], "codex")[1])',
      policy.bundles.codex.directory);
    expect(validatedDigest).not.toBe(policy.bundles.codex.descriptor_sha256);
    const previousBundleDigest = policy.bundles.codex.digest;
    expect(await quotaCapabilities(policy)).toEqual({ providers: [], actions: {} });
    policy.bundles.codex.digest = await bundleDigest(policy.bundles.codex.directory);
    expect(policy.bundles.codex.digest).not.toBe(previousBundleDigest);
    expect(policy.bundles.codex.descriptor_sha256).toBe(sha256(descriptor));
    const alteredQuota = await quotaCapabilities(policy);
    expect(alteredQuota).toEqual({ providers: [], actions: {} });
    await publishCapabilities(host, policy, alteredQuota);
    const after = await quotaSnapshot(page);
    expect(after.capabilities).toEqual({ available: false, providers: [], hosts: [], actions: [] });
    expect(after.environments).toEqual(created.environments);
    expect(after.operations).toEqual(created.operations);

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByText('No hay un ejecutor disponible para esta empresa. Los entornos conservan su estado; las operaciones requieren recuperar la conexión.',
      { exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.getByRole('form', { name: 'Crear entorno de cuotas' }).getByRole('button', { name: 'Crear entorno', exact: true }).isDisabled()).toBe(true);
    expect(await page.getByRole('article', { name: `Entorno ${environmentLabel}`, exact: true }).getByRole('button', { name: 'Consultar cuotas', exact: true }).isDisabled()).toBe(true);
    const evidence = join(repository, '.delegados/v4/recibos', task, 'environments', `descriptor-${run}`);
    await mkdir(evidence, { recursive: true });
    await page.screenshot({ path: join(evidence, 'descriptor-withdrawn-desktop.png'), fullPage: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({ path: join(evidence, 'descriptor-withdrawn-mobile.png'), fullPage: false });
    await page.setViewportSize({ width: 1440, height: 900 });
    const createKey = `descriptor-create-${run}`;
    errors.expectHttpError('/v3/console/quota-environments', 409);
    const rejectedCreate = await post(page, '/v3/console/quota-environments', {
      account_id: accountId, host_id: host.host_id, label: `Altered descriptor ${run}`, idempotency_key: createKey,
    });
    const actionPath = `/v3/console/quota-environments/${environment.id}/actions`;
    const queryKey = `descriptor-query-${run}`;
    errors.expectHttpError(actionPath, 409);
    const rejectedQuery = await post(page, actionPath, { action: 'query', expected_version: environment.version, idempotency_key: queryKey });
    for (const response of [rejectedCreate, rejectedQuery]) {
      expect(response.status).toBe(409);
      expect(response.body).toMatchObject({ error: 'conflict', message: 'quota executor is unavailable for this host and provider' });
    }
    const pool = active().database.pool;
    expect((await pool.query('SELECT id FROM quota_environments WHERE company_id=$1 AND idempotency_key=$2',
      [host.company_id, createKey])).rows).toEqual([]);
    expect((await pool.query('SELECT id FROM quota_environment_operations WHERE company_id=$1 AND idempotency_key=ANY($2::text[])',
      [host.company_id, [`create:${createKey}`, queryKey]])).rows).toEqual([]);
    expect((await pool.query<{ count: number }>('SELECT count(*)::int AS count FROM quota_environment_operations WHERE company_id=$1',
      [host.company_id])).rows).toEqual([{ count: 1 }]);
    const rejected = await quotaSnapshot(page);
    expect(rejected.environments).toEqual(created.environments);
    expect(rejected.operations).toEqual(created.operations);
    await writeFile(descriptorPath, descriptor, { mode: 0o600 });
    policy.bundles.codex.digest = previousBundleDigest;
    expect(await bundleDigest(policy.bundles.codex.directory)).toBe(previousBundleDigest);
    const restoredQuota = await quotaCapabilities(policy);
    expect(restoredQuota).toEqual(approvedQuota);
    await publishCapabilities(host, policy, restoredQuota);
    expect((await quotaSnapshot(page)).capabilities).toEqual(before.capabilities);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByRole('form', { name: 'Crear entorno de cuotas' }).locator('select').nth(0).selectOption(accountId);
    await page.getByRole('form', { name: 'Crear entorno de cuotas' }).locator('select').nth(1).selectOption(host.host_id);
    await page.getByRole('form', { name: 'Crear entorno de cuotas' }).getByLabel('Nombre del entorno', { exact: true }).fill(`Restored ${run}`);
    expect(await page.getByRole('form', { name: 'Crear entorno de cuotas' }).getByRole('button', { name: 'Crear entorno', exact: true }).isDisabled()).toBe(false);
    await page.screenshot({ path: join(evidence, 'descriptor-restored-desktop.png'), fullPage: false });
    errors.assertClean();
  }, 120_000);
});
