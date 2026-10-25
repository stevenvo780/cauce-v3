import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login, openRegistration, type V4Page } from './v4-console-real-browser.helpers.js';
import { prepareFake2QuotaImage } from './v4-cuotas-fake2.fixtures.js';
import { quotaCanaryPerson, startQuotaDockerHost, type QuotaDockerImage } from './v4-quota-environments-real-browser.fixtures.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', process.env.CAUCE_PLAZOS_FACTOR ?? '3');
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');
const execute = promisify(execFile);
const task = 'e2e-a7-sigue-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-availability-${run}`;
const owner = quotaCanaryPerson('quota-availability', run);
const accountLabel = `${prefix}-account`;
const hostIds = [`${owner.company.slug}-primary`, `${owner.company.slug}-alternate`] as const;
const labels = [`${prefix}-primary`, `${prefix}-alternate`] as const;
const evidence = join(process.cwd(), '.delegados/v4/recibos', task, 'availability', run);
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
type Host = Awaited<ReturnType<typeof startQuotaDockerHost>>;
interface Environment { id: string; label: string; account_id: string; host_id: string; status: string; version: number }
interface Snapshot { environments: Environment[]; operations: { id: string; environment_id: string; action: string; status: string }[];
  capabilities: { hosts: { host_id: string }[] } }
interface QueryProcess { pid: number; start_ticks: string }
interface Resource { kind: 'container' | 'volume' | 'network' | 'image'; id: string }
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let image: QuotaDockerImage | undefined;
const hosts: Host[] = [];
const environmentIds: string[] = [];
const resources: Resource[] = [];
const mutations: string[] = [];
const verifyResponses: { path: string; status: number; body: Record<string, unknown> }[] = [];
let page: V4Page;
let other: V4Page;
let pageReady = false;
let accountId = '';
let pausedHost = false;
let pausedContainer: string | undefined;
const active = () => { if (!fixture) throw new Error('availability fixture unavailable'); return fixture; };
const primary = () => { const host = hosts[0]; if (!host) throw new Error('availability host unavailable'); return host; };
const environmentId = () => { const id = environmentIds[0]; if (!id) throw new Error('availability environment unavailable'); return id; };
const loginPanel = () => page.getByRole('region', { name: `Inicio de sesión de ${accountLabel}`, exact: true });
const card = () => page.getByRole('article', { name: `Entorno ${labels[0]}`, exact: true });
const record = async (name: string, value: unknown) => writeFile(join(evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
async function snapshot(target = page): Promise<Snapshot> {
  const response = await apiGet(target, '/v3/console/quota-environments');
  expect(response.status).toBe(200);
  return response.body as unknown as Snapshot;
}
async function authenticationCount() {
  return (await active().database.pool.query<{ count: number }>(`SELECT count(*)::int AS count FROM quota_environment_operations
    WHERE company_id=$1 AND action='authenticate'`, [owner.company.slug])).rows[0]?.count;
}
async function capture(name: string, anchor: 'login' | 'environment' = 'login') {
  for (const [size, suffix] of [[{ width: 1440, height: 900 }, '1440'], [{ width: 390, height: 844 }, '390']] as const) {
    await page.setViewportSize(size);
    const target = anchor === 'login' ? loginPanel() : card();
    await target.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
    await page.screenshot({ path: join(evidence, `${name}-${suffix}.png`), fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function createEnvironment(index: 0 | 1) {
  const form = page.getByRole('form', { name: 'Crear entorno de cuotas', exact: true });
  await form.locator('select').nth(0).selectOption(accountId);
  await form.locator('select').nth(1).selectOption(hostIds[index]);
  await form.getByLabel('Nombre del entorno', { exact: true }).fill(labels[index]);
  await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
  await page.getByRole('article', { name: `Entorno ${labels[index]}`, exact: true }).waitFor({ timeout: 20_000 });
  const environment = (await snapshot()).environments.find(row => row.label === labels[index]);
  const host = hosts[index];
  if (!environment || !host) throw new Error('owned availability environment absent');
  environmentIds.push(environment.id);
  expect((await host.waitOperation(environment.id, 'create')).result.runtime_verified).toBe(true);
  const observed = await host.inspect(environment.id);
  expect(observed).toMatchObject({ present: true, volume_present: true });
  resources.push({ kind: 'container', id: observed.container_name }, { kind: 'volume', id: `${observed.container_name}-profile` });
  await page.reload({ waitUntil: 'domcontentloaded' });
}
async function queryProcesses(container: string): Promise<QueryProcess[]> {
  const program = `import json,pathlib
found=[]
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit(): continue
    try:
        args=(entry/'cmdline').read_bytes().split(b'\\0')
        if args[:3]==[b'/usr/bin/python3',b'/usr/local/lib/cauce-fake2.py',b'quota']:
            ticks=(entry/'stat').read_text().rsplit(')',1)[1].split()[19]
            found.append({'pid':int(entry.name),'start_ticks':ticks})
    except (FileNotFoundError,ProcessLookupError,PermissionError): pass
print(json.dumps(found))`;
  const output = await execute('docker', ['exec', '--user', '1000:1000', container, '/usr/bin/python3', '-I', '-B', '-c', program], { timeout: 10_000 });
  return JSON.parse(output.stdout) as QueryProcess[];
}
async function mode(container: string, value: 'normal' | 'verification-delay') {
  await execute('docker', ['exec', '--user', '1000:1000', container, '/usr/bin/python3', '-I', '-B', '-c',
    'import pathlib,sys;pathlib.Path("/home/node/.fake2-mode").write_text(sys.argv[1])', value], { timeout: 10_000 });
}
async function authenticate() {
  await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).selectOption(environmentId());
  let resolve: (() => void) | undefined;
  const attached = new Promise<void>(done => { resolve = done; });
  let sessionId = '';
  page.on('websocket', socket => {
    const match = /\/provider-auth\/sessions\/([a-f0-9-]{36})\/stream$/u.exec(new URL(socket.url()).pathname);
    if (!match?.[1]) return;
    sessionId = match[1];
    let ready = false; let output = false;
    (socket as unknown as { on(event: 'framereceived', callback: (frame: { payload: string | Buffer }) => void): void }).on('framereceived', ({ payload }) => {
      if (Buffer.isBuffer(payload)) output ||= payload.length > 0;
      else ready ||= payload === '{"type":"ready"}';
      if (ready && output) resolve?.();
    });
  });
  await loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
  await Promise.race([attached, delay(30_000).then(() => { throw new Error('availability authentication stream did not attach'); })]);
  const dialog = page.getByRole('dialog');
  const terminal = dialog.getByLabel('Terminal privada de autenticación', { exact: true });
  const textarea = terminal.locator('textarea') as unknown as { pressSequentially(value: string): Promise<void>; press(value: string): Promise<void> };
  await textarea.pressSequentially('APROBAR'); await textarea.press('Enter');
  await terminal.getByText('fake2: sesion autorizada', { exact: true }).waitFor({ timeout: 15_000 });
  const verifyMarker = verifyResponses.length;
  await dialog.getByRole('button', { name: 'Verificar conexión', exact: true }).click();
  const operation = await primary().waitOperation(environmentId(), 'authenticate');
  expect(operation.result.authenticated_verified).toBe(true);
  const persisted = (await active().database.pool.query('SELECT enabled,quota_identity_hash IS NOT NULL AS verified FROM provider_accounts WHERE id=$1', [accountId])).rows;
  expect(persisted).toEqual([{ enabled: true, verified: true }]);
  let broker: Record<string, unknown> = {};
  await expect.poll(async () => {
    const response = await apiGet(page, `/v3/console/provider-auth/sessions/${sessionId}`);
    expect(response.status).toBe(200); broker = response.body;
    return ['authenticated', 'failed', 'cancelled', 'expired'].includes(String(broker.status));
  }, { timeout: 20_000 }).toBe(true);
  await expect.poll(() => verifyResponses.length, { timeout: 15_000 }).toBeGreaterThan(verifyMarker);
  const inconsistentMessage = 'La conexión no se pudo verificar. Relee la operación antes de continuar.';
  const inconsistent = await page.getByText(inconsistentMessage, { exact: true }).isVisible();
  await record('authentication-preparation', { operation_id: operation.id, operation_status: operation.status, persisted,
    broker, verify_response: verifyResponses[verifyMarker],
    audit: (await active().database.pool.query(`SELECT id,decision,metadata->>'operation_id' AS operation_id,
      metadata->>'status' AS status,metadata->>'error' AS error,metadata->>'reason' AS reason FROM audit_events
      WHERE company_id=$1 AND action='quota_environment.authentication' AND metadata->>'operation_id'=$2 ORDER BY id`,
    [owner.company.slug, operation.id])).rows,
    inconsistent_notice: inconsistent ? inconsistentMessage : null,
    verified_notice_visible: await page.getByText('Sesión iniciada y verificada.', { exact: true }).isVisible() });
  if (inconsistent) await capture('authentication-inconsistent');
  await page.reload({ waitUntil: 'domcontentloaded' });
}

beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  await record('sources', { sha: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), sources: Object.fromEntries(await Promise.all([
    'tests/e2e/v4-cuotas-availability-real-browser.test.ts', 'tests/e2e/v4-cuotas-fake2.fixtures.ts',
    'tests/e2e/v4-quota-environments-real-browser.fixtures.ts', 'tests/e2e/console-functional-browser.fixtures.ts',
    'console/src/features/accounts/AccountLogin.tsx', 'console/src/features/accounts/account-login-targets.ts',
    'console/src/features/accounts/ProviderAuthPanel.tsx', 'services/gateway/src/console/provider-auth.sessions.ts',
    'services/gateway/src/fleet/quota-auth-broker.ts',
    'services/gateway/src/fleet/host-channel.capabilities.ts', 'packages/store/src/quota-environments.ts',
  ].map(async path => [path, createHash('sha256').update(await readFile(path)).digest('hex')] as const))) });
  fixture = await startConsoleFunctionalFixture({ sessionTtlMs: 1_200_000 });
  resources.push({ kind: 'container', id: fixture.database.container.getId() }, { kind: 'container', id: fixture.browserContainer });
  if (fixture.browserRuntime.owned) resources.push({ kind: 'image', id: fixture.browserRuntime.image });
  const mounts = JSON.parse((await execute('docker', ['inspect', '--format', '{{json .Mounts}}', fixture.database.container.getId()])).stdout) as { Type: string; Name?: string }[];
  for (const mount of mounts) if (mount.Type === 'volume' && mount.Name) resources.push({ kind: 'volume', id: mount.Name });
  const networks = JSON.parse((await execute('docker', ['inspect', '--format', '{{json .NetworkSettings.Networks}}', fixture.browserContainer])).stdout) as Record<string, { NetworkID: string }>;
  for (const [name, value] of Object.entries(networks)) if (name.startsWith('cauce-ui-network-')) resources.push({ kind: 'network', id: value.NetworkID });
  image = await prepareFake2QuotaImage(evidence, prefix, task);
  resources.push({ kind: 'image', id: image.tag });
  await record('resources', { resources, image: image.image });
  page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 })); pageReady = true;
  errors.watch(page, 'availability');
  page.on('request', raw => {
    const request = raw as { method(): string; url(): string };
    const path = new URL(request.url()).pathname;
    if (request.method() === 'POST' && path.startsWith('/v3/console/quota-environments')) mutations.push(path);
  });
  page.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.request().method() !== 'POST' || !/^\/v3\/console\/provider-auth\/sessions\/[a-f0-9-]{36}\/verify$/u.test(path)) return;
    void (response as unknown as { json(): Promise<Record<string, unknown>> }).json()
      .then(body => { verifyResponses.push({ path, status: response.status(), body }); })
      .catch(() => { verifyResponses.push({ path, status: response.status(), body: { read_error: 'not_json' } }); });
  });
  const registration = await openRegistration(page, fixture.baseUrl);
  await fillRegistration(registration, owner);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  for (const hostId of hostIds) hosts.push(await startQuotaDockerHost(fixture, owner, hostId, image, join(evidence, hostId)));
  await page.goto(`${fixture.baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
  await page.locator('button').filter({ hasText: 'Registrar cuenta' }).waitFor();
  await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
  const form = page.getByRole('form', { name: 'Registrar cuenta de cuotas', exact: true });
  await form.getByLabel('Nombre de la cuenta', { exact: true }).fill(accountLabel);
  await form.locator('select').selectOption('claude');
  await form.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
  await page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }).waitFor({ timeout: 20_000 });
  const accounts = (await apiGet(page, '/v3/console/quota-accounts')).body as unknown as { accounts: { id: string; label: string }[] };
  const account = accounts.accounts.find(row => row.label === accountLabel);
  if (!account) throw new Error('availability account absent');
  accountId = account.id;
  await createEnvironment(0); await createEnvironment(1);
  other = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
  errors.watch(other, 'availability-independent');
  await login(other, fixture.baseUrl, owner);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await record('resources', { resources, image: image.image, environments: environmentIds, hosts: hostIds });
}, 600_000);

afterEach(async ({ task: current }) => {
  if (pausedContainer) { await execute('docker', ['unpause', pausedContainer], { timeout: 15_000 }); pausedContainer = undefined; }
  if (pausedHost) { primary().resume(); pausedHost = false; }
  if (current.result?.state !== 'fail' || !pageReady) return;
  await page.screenshot({ path: join(evidence, `failed-${current.id}.png`), fullPage: false }).catch(() => undefined);
  await record(`failed-${current.id}`, { body: await page.locator('body').innerText().catch(() => null), errors: errors.trace,
    operations: (await active().database.pool.query('SELECT id,environment_id,action,status,worker_id,error_code FROM quota_environment_operations WHERE company_id=$1 ORDER BY created_at,id', [owner.company.slug])).rows });
});

afterAll(async () => {
  const failures: unknown[] = [];
  if (pausedContainer) await execute('docker', ['unpause', pausedContainer], { timeout: 15_000 }).catch((error: unknown) => { failures.push(error); });
  if (pausedHost) { try { primary().resume(); } catch (error) { failures.push(error); } }
  for (const host of hosts) await host.close().catch((error: unknown) => { failures.push(error); });
  await fixture?.close().catch((error: unknown) => { failures.push(error); });
  if (image) await execute('docker', ['image', 'rm', image.tag], { timeout: 30_000 }).catch((error: unknown) => { failures.push(error); });
  const audit = [];
  for (const resource of resources) {
    let state = 'present';
    try { await execute('docker', [resource.kind, 'inspect', resource.id, '--format', resource.kind === 'volume' ? '{{.Name}}' : '{{.Id}}'], { timeout: 15_000 }); }
    catch (error) { state = /no such|not found/iu.test((error as { stderr?: string }).stderr ?? '') ? 'absent' : 'error'; }
    audit.push({ ...resource, state });
    if (state !== 'absent') failures.push(new Error(`owned availability ${resource.kind} remains ${state}: ${resource.id}`));
  }
  await record('resource-audit', { audit, all_known_resources_absent: audit.length > 0 && audit.every(row => row.state === 'absent') });
  vi.unstubAllEnvs();
  if (failures.length) throw new AggregateError(failures, 'availability cleanup incomplete');
  process.stdout.write(`Availability cleanup verified: ${run}\n`);
}, 180_000);

describe('disponibilidad física de los destinos de inicio de sesión de cuotas', () => {
  it('caduca la capacidad tras desconectar realmente el host, bloquea su destino y recupera la acción al reconectar', async () => {
    await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).selectOption(environmentId());
    expect(await loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled()).toBe(false);
    const previous = await authenticationCount();
    const before = await snapshot();
    const started = performance.now();
    const wallStarted = new Date().toISOString();
    primary().pause(); pausedHost = true;
    try {
      process.stdout.write(`Availability real capability wait started: ${wallStarted}; run=${run}\n`);
      await delay(123_000);
      const elapsed = performance.now() - started;
      expect(elapsed).toBeGreaterThanOrEqual(120_000);
      const capabilities = (await active().database.pool.query(`SELECT host_id,capabilities_seen_at,
        extract(epoch FROM (clock_timestamp()-capabilities_seen_at))*1000 AS age_ms FROM fleet_host_identities
        WHERE company_id=$1 ORDER BY host_id`, [owner.company.slug])).rows as { host_id: string; age_ms: string }[];
      expect(Number(capabilities.find(row => row.host_id === hostIds[0])?.age_ms)).toBeGreaterThan(120_000);
      const offline = await snapshot();
      expect(offline.capabilities.hosts.map(host => host.host_id)).toEqual([hostIds[1]]);
      await page.getByRole('button', { name: 'Actualizar cuotas y entornos', exact: true }).click();
      await loginPanel().getByText('El ordenador del entorno de esta cuenta no está disponible ahora. Revisa que esté encendido y conectado.', { exact: true }).waitFor({ timeout: 20_000 });
      const choice = loginPanel().getByLabel('Entorno u ordenador', { exact: true });
      expect(await choice.inputValue()).toBe(environmentId());
      expect(await choice.locator(`option[value="${environmentId()}"]`).innerText()).toContain('No disponible');
      expect(await loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled()).toBe(true);
      expect(await authenticationCount()).toBe(previous);
      await capture('host-offline');
      await record('host-offline', { wall_started: wallStarted, elapsed_ms: elapsed, before, offline, capabilities, authentication_count: previous });
    } finally { primary().resume(); pausedHost = false; }
    await expect.poll(async () => (await snapshot()).capabilities.hosts.some(host => host.host_id === hostIds[0]), { timeout: 45_000 }).toBe(true);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).selectOption(environmentId());
    await expect.poll(async () => loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
    expect(await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).locator(`option[value="${environmentId()}"]`).innerText()).not.toContain('No disponible');
    expect(await authenticationCount()).toBe(previous);
    await record('host-recovered', await snapshot());
    await capture('host-recovered');
  }, 210_000);

  it('mantiene una consulta realmente running mientras su proceso está congelado y bloquea otra autenticación', async () => {
    await authenticate();
    const observed = await primary().inspect(environmentId());
    await mode(observed.container_name, 'verification-delay');
    const previous = await authenticationCount();
    const query = card().getByRole('button', { name: 'Consultar cuotas', exact: true });
    await expect.poll(async () => query.isDisabled(), { timeout: 20_000 }).toBe(false);
    await query.click();
    let processes: QueryProcess[] = [];
    await expect.poll(async () => { processes = await queryProcesses(observed.container_name); return processes.length; }, { timeout: 15_000, interval: 100 }).toBeGreaterThan(0);
    await execute('docker', ['pause', observed.container_name], { timeout: 15_000 }); pausedContainer = observed.container_name;
    let runningId = '';
    try {
      const rows = (await active().database.pool.query<{ id: string; action: string; status: string; worker_id: string; claimed: boolean }>(`SELECT id,action,status,worker_id,claim_token IS NOT NULL AS claimed FROM quota_environment_operations
        WHERE environment_id=$1 ORDER BY created_at DESC,id DESC LIMIT 1`, [environmentId()])).rows;
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ action: 'query', status: 'running', worker_id: `host-${hostIds[0]}` });
      expect(rows[0]?.claimed).toBe(true);
      runningId = rows[0]?.id ?? '';
      const paused = (await execute('docker', ['inspect', '--format', '{{.State.Paused}}', observed.container_name])).stdout.trim();
      expect(paused).toBe('true');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).selectOption(environmentId());
      await loginPanel().getByText('El entorno de esta cuenta tiene otra operación en curso. Espera a que termine.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled()).toBe(true);
      await card().getByText('En curso', { exact: true }).waitFor({ timeout: 20_000 });
      expect((await snapshot()).operations.find(row => row.id === runningId)).toMatchObject({ action: 'query', status: 'running' });
      expect(await authenticationCount()).toBe(previous);
      await capture('query-running-login-blocked');
      await capture('query-running-environment', 'environment');
      await record('query-running', { operation: rows[0], processes, paused, authentication_count: previous, snapshot: await snapshot() });
    } finally { await execute('docker', ['unpause', observed.container_name], { timeout: 15_000 }); pausedContainer = undefined; }
    const completed = await primary().waitOperation(environmentId(), 'query');
    expect(completed).toMatchObject({ id: runningId, status: 'done', result: { observation_status: 'ok', provider_report: { ok: true } } });
    await mode(observed.container_name, 'normal');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).selectOption(environmentId());
    await expect.poll(async () => loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
    expect(await authenticationCount()).toBe(previous);
    expect(await queryProcesses(observed.container_name)).toEqual([]);
    await record('query-recovered', { operation_id: completed.id, status: completed.status, result: completed.result });
    await capture('query-recovered');
  }, 150_000);

  it('revalida el destino retenido eliminado desde una segunda sesión y no crea otra autenticación ni entorno', async () => {
    const current = (await snapshot(other)).environments.find(row => row.id === environmentId());
    if (!current) throw new Error('availability environment missing before canonical deletion');
    const previous = await authenticationCount();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).selectOption(environmentId());
    const deleted = await other.evaluate(async input => {
      const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token: string };
      const response = await fetch(`/v3/console/quota-environments/${input.id}/actions`, { method: 'POST', credentials: 'include',
        headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token },
        body: JSON.stringify({ action: 'delete', expected_version: input.version, idempotency_key: input.key }) });
      return { status: response.status, body: await response.json() as Record<string, unknown> };
    }, { id: environmentId(), version: current.version, key: randomUUID() });
    expect(deleted.status).toBe(200);
    expect((await primary().waitOperation(environmentId(), 'delete')).result).toMatchObject({ stopped_verified: true, profile_removed_verified: true });
    expect(await primary().inspect(environmentId())).toMatchObject({ present: false, volume_present: false });
    expect(await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).inputValue()).toBe(environmentId());
    const marker = mutations.length;
    await loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await loginPanel().getByText('Este entorno ya no está disponible. Actualiza cuotas y entornos.', { exact: true }).waitFor({ timeout: 20_000 });
    await expect.poll(() => page.getByRole('dialog').count(), { timeout: 10_000 }).toBe(0);
    expect(mutations.slice(marker)).toEqual([]);
    expect(await authenticationCount()).toBe(previous);
    expect((await active().database.pool.query('SELECT status FROM quota_environments WHERE id=$1', [environmentId()])).rows).toEqual([{ status: 'deleted' }]);
    const after = await snapshot();
    expect(after.environments.find(row => row.id === environmentId())?.status).toBe('deleted');
    await record('deleted-target-revalidated', { deletion: deleted, snapshot: after, posts_after_start: mutations.slice(marker), authentication_count: previous });
    await capture('deleted-target-revalidated');
    errors.assertClean();
  }, 90_000);
});
