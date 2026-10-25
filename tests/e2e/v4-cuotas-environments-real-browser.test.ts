import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, openRegistration, type V4Page } from './v4-console-real-browser.helpers.js';
import { quotaCanaryPerson, startQuotaDockerHost, type QuotaDockerImage } from './v4-quota-environments-real-browser.fixtures.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', process.env.CAUCE_PLAZOS_FACTOR ?? '3');
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');
const execute = promisify(execFile);
const task = 'e2e-a7-commit-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${task}-${run}`;
const owner = quotaCanaryPerson(`${task}-environment`, run);
const accountLabel = `${prefix}-account`;
const hostId = `${owner.company.slug}-host`;
const evidence = join(process.cwd(), '.delegados/v4/recibos', task, 'environments', run);
const errors = new BrowserErrorLog(HERMETIC_INSTANCE_RULES);
const sha = (value: string | Buffer) => createHash('sha256').update(value).digest('hex');
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let host: Awaited<ReturnType<typeof startQuotaDockerHost>> | undefined;
let image: QuotaDockerImage | undefined;
let page: V4Page;
let pageReady = false;
let accountId: string;
let primaryId: string;
let secondaryId: string;
const primaryLabel = `${prefix}-primary`;
const secondaryLabel = `${prefix}-secondary`;

interface Environment { id: string; label: string; account_id: string; status: string; refresh_status: string; version: number }
interface Snapshot { environments: Environment[]; operations: { environment_id: string; action: string; status: string }[] }
type ObservationMode = 'normal' | 'invalid-json' | 'provider-error' | 'exhausted' | 'model-dependent' | 'automatic-pause' | 'verification-delay';

function active() { if (!fixture) throw new Error('quota cycle fixture unavailable'); return fixture; }
function runtime() { if (!host) throw new Error('quota cycle host unavailable'); return host; }
async function record(name: string, value: unknown) { await writeFile(join(evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`); }
async function snapshot(): Promise<Snapshot> {
  const response = await apiGet(page, '/v3/console/quota-environments');
  expect(response.status).toBe(200);
  return response.body as unknown as Snapshot;
}
async function assertVisibleWindows() {
  const card = page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true });
  for (const label of ['5 h', 'Semanal', '72%', '91%']) await card.getByText(label, { exact: true }).waitFor({ timeout: 20_000 });
  expect(await card.getByRole('meter', { name: 'Restante 5 h', exact: true }).evaluate(input => input.getAttribute('value'))).toBe('72');
  expect(await card.getByRole('meter', { name: 'Restante Semanal', exact: true }).evaluate(input => input.getAttribute('value'))).toBe('91');
}
async function capture(name: string) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.screenshot({ path: join(evidence, `${name}-desktop.png`), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: join(evidence, `${name}-mobile.png`), fullPage: false });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.setViewportSize({ width: 1440, height: 900 });
}
async function observationMode(mode: ObservationMode) {
  const observed = await runtime().inspect(primaryId);
  expect(observed).toMatchObject({ present: true, volume_present: true });
  await execute('docker', ['exec', '--user', '1000:1000', observed.container_name, '/usr/bin/python3', '-I', '-B', '-c',
    'import pathlib,sys;pathlib.Path("/home/node/.fake2-mode").write_text(sys.argv[1])', mode], { timeout: 15_000 });
}
async function queryPrimary(status: 'done' | 'failed' = 'done') {
  const last = (await active().database.pool.query<{ id: string }>(
    "SELECT id FROM quota_environment_operations WHERE environment_id=$1 AND action='query' ORDER BY created_at DESC,id DESC LIMIT 1", [primaryId])).rows[0];
  const button = page.getByRole('article', { name: `Entorno ${primaryLabel}`, exact: true }).getByRole('button', { name: 'Consultar cuotas', exact: true });
  await expect.poll(async () => button.isDisabled(), { timeout: 20_000 }).toBe(false);
  await button.click();
  const receipt = await runtime().waitOperation(primaryId, 'query', { status, ...(last ? { afterId: last.id } : {}) });
  await page.reload({ waitUntil: 'domcontentloaded' });
  return receipt;
}
function authStreamReady(): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('fake2 authentication stream did not become ready')); }, 30_000);
    page.on('websocket', candidate => {
      if (!candidate.url().includes('/provider-auth/sessions/')) return;
      const socket = candidate as unknown as { on(event: 'framereceived', callback: (frame: { payload: string | Buffer }) => void): void };
      let ready = false; let output = false;
      socket.on('framereceived', ({ payload }) => {
        if (Buffer.isBuffer(payload)) output ||= payload.length > 0;
        else ready ||= payload === '{"type":"ready"}';
        if (ready && output) { clearTimeout(timer); resolve(); }
      });
    });
  });
}
async function prepareImage(): Promise<QuotaDockerImage> {
  const directory = join(evidence, 'fake2-image');
  await mkdir(directory, { recursive: true });
  const double = `#!/usr/bin/python3
import datetime, json, pathlib, sys, time
home = pathlib.Path('/home/node')
session = home / '.fake2-session'
updated = home / '.fake2-updated'
if '--version' in sys.argv:
    print('fake2-cli 2.0.0' if updated.exists() else 'fake2-cli 1.0.0')
elif 'login' in sys.argv:
    print('fake2: escribe APROBAR para autorizar https://example.invalid/fake2', flush=True)
    if input().strip() == 'APROBAR':
        session.write_text('fake2-owned-subscription')
        print('fake2: sesion autorizada', flush=True)
        time.sleep(300)
elif 'quota' in sys.argv:
    if not session.exists():
        print(json.dumps({'ok': False, 'error_code': 'not_authenticated', 'error': 'sin credencial', 'windows': []}))
        sys.exit(1)
    mode_file = home / '.fake2-mode'
    mode = mode_file.read_text() if mode_file.exists() else 'normal'
    if mode == 'invalid-json':
        print('fake2: unreadable quota response')
        sys.exit(0)
    if mode == 'provider-error':
        print(json.dumps({'ok': False, 'error_code': 'network', 'error': 'fake2 network failure', 'windows': []}))
        sys.exit(1)
    if mode == 'verification-delay':
        time.sleep(3)
    windows = [
        {'key': 'five-hour', 'label': 'Cinco horas fake2', 'remainingPercent': 72, 'usedPercent': 28, 'windowMinutes': 300},
        {'key': 'seven-day', 'label': 'Semana fake2', 'remainingPercent': 91, 'usedPercent': 9, 'windowMinutes': 10080}]
    if mode in ('exhausted', 'model-dependent', 'automatic-pause'):
        windows[0].update({'remainingPercent': 0, 'usedPercent': 100})
    if mode == 'automatic-pause':
        windows[0]['resetAt'] = (datetime.datetime.now(datetime.UTC) + datetime.timedelta(hours=1)).isoformat()
    if mode == 'model-dependent':
        windows[0]['model'] = 'fake2-small'
        windows[1]['model'] = 'fake2-large'
    print(json.dumps({'ok': True, 'available': True, 'account_id': session.read_text(),
        'source': 'fake2', 'effectiveRemainingPercent': 0 if mode in ('exhausted', 'model-dependent', 'automatic-pause') else 72, 'windows': windows}))
else:
    sys.exit(2)
`;
  const update = '#!/bin/sh\nset -eu\nmkdir -p /home/node/.local/bin\ncp /usr/local/bin/claude /home/node/.local/bin/claude\ntouch /home/node/.fake2-updated\n';
  const launcher = `#include <errno.h>
#include <stdlib.h>
#include <sys/wait.h>
#include <unistd.h>
int main(int argc, char **argv) {
    char **command = calloc((size_t)argc + 2, sizeof(char *));
    if (!command) return 111;
    command[0] = "/usr/bin/python3";
    command[1] = "/usr/local/lib/cauce-fake2.py";
    for (int index = 1; index < argc; index++) command[index + 1] = argv[index];
    pid_t child = fork();
    if (child < 0) return 111;
    if (child == 0) { execv(command[0], command); _exit(127); }
    int status;
    while (waitpid(child, &status, 0) < 0) if (errno != EINTR) return 111;
    free(command);
    return WIFEXITED(status) ? WEXITSTATUS(status) : 128 + WTERMSIG(status);
}
`;
  const runnerDockerfile = await readFile(join(process.cwd(), 'tests/e2e/lab-runner/Dockerfile'));
  const baseImage = `cauce-e2e-lab-runner:${sha(runnerDockerfile).slice(0, 12)}`;
  await writeFile(join(directory, 'fake2'), double, { mode: 0o755 });
  await writeFile(join(directory, 'npm'), update, { mode: 0o755 });
  await writeFile(join(directory, 'launcher.c'), launcher);
  await writeFile(join(directory, 'Dockerfile'), `FROM ${baseImage} AS compiler\nUSER root\nRUN apt-get update && apt-get install -y --no-install-recommends gcc libc6-dev && rm -rf /var/lib/apt/lists/*\nCOPY launcher.c /tmp/launcher.c\nRUN cc -O2 -Wall -Wextra -Werror /tmp/launcher.c -o /tmp/claude\nFROM ${baseImage}\nUSER root\nCOPY --from=compiler --chmod=0555 /tmp/claude /usr/local/bin/claude\nCOPY --chmod=0555 fake2 /usr/local/lib/cauce-fake2.py\nCOPY --chmod=0555 npm /usr/local/bin/npm\nUSER node\nWORKDIR /home/node\nENV HOME=/home/node\nCMD ["sleep", "infinity"]\n`);
  const tag = `${prefix}:fake2`;
  const built = await execute('docker', ['build', '--pull=false', '--label', `cauce.e2e.owner=${task}`, '-t', tag, directory], { timeout: 300_000 });
  await writeFile(join(evidence, 'fake2-build.log'), `${built.stdout}${built.stderr}`);
  const imageId = (await execute('docker', ['image', 'inspect', '--format', '{{.Id}}', tag])).stdout.trim();
  const bundle = join(evidence, 'fake2-bundle');
  const descriptors = join(bundle, 'packages/adapter-sdk/dist/descriptors');
  await mkdir(descriptors, { recursive: true });
  const descriptor = JSON.stringify({ schema_version: 1, harness: 'claude',
    operations: { install: 'runtime-package', execute: 'native-execution', authenticate: 'provider-login', quota: 'quota-collector', update: 'provider-update' },
    context: { native_document: 'AGENTS.md', max_bytes: 65536 },
    provider: { authenticate_argv: ['/usr/local/bin/claude', 'login'], quota_argv: ['/usr/local/bin/claude', 'quota'],
      verify_argv: ['/usr/local/bin/claude', 'quota'], update_package: '@cauce/fake2', fleet_module: null } });
  await writeFile(join(descriptors, 'claude.json'), descriptor);
  const digest = (await execute('/usr/bin/python3', ['-B', '-c',
    'import sys;sys.path.insert(0,sys.argv[1]);from fleet_executor_runtime import bundle_digest;print(bundle_digest(sys.argv[2]))',
    join(process.cwd(), 'ops/cli'), bundle])).stdout.trim();
  return { image: imageId, tag, providers: ['claude'], bundle_digest: digest, versions: { claude: 'fake2-cli 1.0.0' },
    bundles: { claude: { directory: bundle, digest, executable: '/usr/bin/true', executable_sha256: sha(await readFile('/usr/bin/true')),
      argv: [], descriptor_sha256: sha(descriptor) } } };
}
async function createEnvironment(label: string): Promise<string> {
  const form = page.getByRole('form', { name: 'Crear entorno de cuotas', exact: true });
  await form.locator('select').nth(0).selectOption(accountId);
  await form.locator('select').nth(1).selectOption(hostId);
  await form.getByLabel('Nombre del entorno', { exact: true }).fill(label);
  await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
  await page.getByRole('article', { name: `Entorno ${label}`, exact: true }).waitFor({ timeout: 20_000 });
  const environment = (await snapshot()).environments.find(row => row.label === label);
  if (!environment) throw new Error('created environment not persisted');
  expect((await runtime().waitOperation(environment.id, 'create')).result.runtime_verified).toBe(true);
  expect(await runtime().inspect(environment.id)).toMatchObject({ present: true, volume_present: true });
  await page.reload({ waitUntil: 'domcontentloaded' });
  return environment.id;
}
beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  await record('source', { sha: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    suite_sha256: sha(await readFile(join(process.cwd(), 'tests/e2e/v4-cuotas-environments-real-browser.test.ts'))) });
  image = await prepareImage();
  await record('image', { image: image.image, tag: image.tag });
  fixture = await startConsoleFunctionalFixture();
  page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 }));
  pageReady = true;
  errors.watch(page, 'quota-fake2');
  const registration = await openRegistration(page, fixture.baseUrl);
  await fillRegistration(registration, owner);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  host = await startQuotaDockerHost(fixture, owner, hostId, image, evidence);
}, 600_000);
afterAll(async () => {
  try { await host?.close(); }
  finally {
    try { await fixture?.close(); }
    finally {
      try {
        if (image) {
          await execute('docker', ['image', 'rm', image.tag], { timeout: 30_000 });
          expect((await execute('docker', ['image', 'ls', '--filter', `reference=${image.tag}`, '--format', '{{.ID}}'], { timeout: 30_000 })).stdout.trim()).toBe('');
          await record('image-cleanup', { image_removed_verified: true });
        }
      } finally { vi.unstubAllEnvs(); }
    }
  }
}, 180_000);
afterEach(async ({ task: current }) => {
  if (current.result?.state !== 'fail' || !pageReady) return;
  await page.screenshot({ path: join(evidence, `failed-${current.id}.png`), fullPage: false });
  const database = active().database.pool;
  const operations = (await database.query(`SELECT id,environment_id,action,status,error_code,
    result->>'authenticated_verified' AS authenticated_verified FROM quota_environment_operations WHERE company_id=$1 ORDER BY created_at,id`, [owner.company.slug])).rows;
  const accounts = (await database.query(`SELECT id,enabled,quota_identity_hash IS NOT NULL AS verified FROM provider_accounts WHERE company_id=$1`, [owner.company.slug])).rows;
  const authentication = (await database.query(`SELECT decision,metadata->>'operation_id' AS operation_id,
    metadata->>'status' AS status,metadata->>'error' AS error FROM audit_events
    WHERE company_id=$1 AND action='quota_environment.authentication' ORDER BY id`, [owner.company.slug])).rows;
  await record(`failed-${current.id}`, { body: await page.locator('body').innerText(), errors: errors.trace,
    operations, accounts, authentication });
});

describe('cuotas con doble fake2 en descriptor aprobado y Chromium, gateway, PostgreSQL y Docker reales', () => {
  it('crea dos entornos, consulta sin sesión y cancela la autenticación del entorno seleccionado', async () => {
    await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByText('No hay entornos de consulta. Registra una cuenta y crea su entorno.', { exact: true }).waitFor({ timeout: 20_000 });
    await capture('01-empty');
    await expect.poll(async () => page.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled()).toBe(false);
    await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
    const form = page.getByRole('form', { name: 'Registrar cuenta de cuotas', exact: true });
    await form.getByLabel('Nombre de la cuenta', { exact: true }).fill(accountLabel);
    await form.locator('select').selectOption('claude');
    await form.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
    await page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }).waitFor({ timeout: 20_000 });
    const accounts = await apiGet(page, '/v3/console/quota-accounts');
    const account = (accounts.body as unknown as { accounts: { id: string; label: string }[] }).accounts.find(row => row.label === accountLabel);
    if (!account) throw new Error('registered account not persisted');
    accountId = account.id;
    primaryId = await createEnvironment(primaryLabel);
    secondaryId = await createEnvironment(secondaryLabel);
    await capture('02-two-environments');
    const secondaryCard = page.getByRole('article', { name: `Entorno ${secondaryLabel}`, exact: true });
    await secondaryCard.getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
    expect((await runtime().waitOperation(secondaryId, 'query')).result).toMatchObject({ observation_status: 'error',
      provider_report: { ok: false, note: 'not_authenticated', windows: [] } });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await secondaryCard.getByText('Sin sesión', { exact: true }).waitFor({ timeout: 20_000 });
    await capture('02-without-session');
    const login = page.getByRole('region', { name: `Inicio de sesión de ${accountLabel}`, exact: true });
    await login.getByLabel('Entorno u ordenador', { exact: true }).selectOption(secondaryId);
    await Promise.all([authStreamReady(), login.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()]);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Terminal privada de autenticación', { exact: true }).waitFor({ timeout: 30_000 });
    await capture('03-cancel-auth-terminal');
    await dialog.getByRole('button', { name: 'Cancelar conexión', exact: true }).click();
    await dialog.getByText('Conexión cancelada', { exact: true }).waitFor({ timeout: 20_000 });
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    const cancelled = await runtime().waitOperation(secondaryId, 'authenticate', { status: 'failed' });
    expect(cancelled.error_code).toBe('AUTH_CANCELLED');
    expect((await active().database.pool.query('SELECT quota_identity_hash,enabled FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ quota_identity_hash: null, enabled: false }]);
    expect(await runtime().inspect(secondaryId)).toMatchObject({ present: true, volume_present: true });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await secondaryCard.getByText('Listo para iniciar sesión', { exact: true }).waitFor({ timeout: 20_000 });
    await secondaryCard.getByText('Cancelada', { exact: true }).waitFor({ timeout: 20_000 });
    await capture('03-cancelled');
  }, 120_000);

  it('rechaza verificar sin aprobación del proveedor y conserva el fallo durable sin habilitar la cuenta', async () => {
    const previous = (await active().database.pool.query<{ id: string }>(
      "SELECT id FROM quota_environment_operations WHERE environment_id=$1 AND action='authenticate' ORDER BY created_at DESC,id DESC LIMIT 1", [secondaryId])).rows[0];
    if (!previous) throw new Error('cancelled authentication receipt absent');
    const login = page.getByRole('region', { name: `Inicio de sesión de ${accountLabel}`, exact: true });
    await login.getByLabel('Entorno u ordenador', { exact: true }).selectOption(secondaryId);
    await Promise.all([authStreamReady(), login.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()]);
    const dialog = page.getByRole('dialog');
    await dialog.getByLabel('Terminal privada de autenticación', { exact: true }).waitFor({ timeout: 30_000 });
    await dialog.getByRole('button', { name: 'Verificar conexión', exact: true }).click();
    await dialog.getByText('La cuenta aún no pasó una llamada funcional.', { exact: true }).waitFor({ timeout: 30_000 });
    expect(await dialog.getByLabel('Terminal privada de autenticación', { exact: true }).count()).toBe(0);
    expect((await active().database.pool.query('SELECT quota_identity_hash,enabled FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ quota_identity_hash: null, enabled: false }]);
    await capture('03-auth-verification-failed');
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    expect(await runtime().waitOperation(secondaryId, 'authenticate', { status: 'failed', afterId: previous.id }))
      .toMatchObject({ error_code: 'STEP_FAILED' });
    await page.reload({ waitUntil: 'domcontentloaded' });
  }, 90_000);

  it('reintenta el inicio de sesión y acredita la cuenta desde la terminal privada', async () => {
    const login = page.getByRole('region', { name: `Inicio de sesión de ${accountLabel}`, exact: true });
    await login.getByLabel('Entorno u ordenador', { exact: true }).selectOption(primaryId);
    await page.setViewportSize({ width: 390, height: 844 });
    await Promise.all([authStreamReady(), login.getByRole('button', { name: 'Iniciar sesión', exact: true }).click()]);
    const dialog = page.getByRole('dialog');
    const terminal = dialog.getByLabel('Terminal privada de autenticación', { exact: true });
    await terminal.waitFor({ timeout: 30_000 });
    await capture('03-auth-terminal');
    const textarea = terminal.locator('textarea') as unknown as { pressSequentially(value: string): Promise<void>; press(value: string): Promise<void> };
    await textarea.pressSequentially('APROBAR');
    await textarea.press('Enter');
    const observed = await runtime().inspect(primaryId);
    await expect.poll(async () => {
      try {
        await execute('docker', ['exec', '--user', '1000:1000', observed.container_name, 'test', '-s', '/home/node/.fake2-session'], { timeout: 10_000 });
        return true;
      } catch { return false; }
    }, { timeout: 20_000 }).toBe(true);
    await observationMode('verification-delay');
    await dialog.getByRole('button', { name: 'Verificar conexión', exact: true }).click();
    await dialog.getByText('Verificando la cuenta con el proveedor…', { exact: true }).waitFor({ timeout: 20_000 });
    await capture('03-verifying');
    await page.getByText('Sesión iniciada y verificada.', { exact: true }).waitFor({ timeout: 30_000 });
    await observationMode('normal');
    expect((await runtime().waitOperation(primaryId, 'authenticate')).result.authenticated_verified).toBe(true);
    const database = await active().database.pool.query<{ enabled: boolean; verified: boolean }>(
      'SELECT enabled,quota_identity_hash IS NOT NULL AS verified FROM provider_accounts WHERE id=$1', [accountId]);
    expect(database.rows).toEqual([{ enabled: true, verified: true }]);
    expect((await snapshot()).operations.find(row => row.environment_id === secondaryId)).toMatchObject({ action: 'authenticate', status: 'failed' });
    await record('authentication', { account_id: accountId, selected_environment: primaryId, untouched_environment: secondaryId, persisted: database.rows });
    await capture('04-authenticated');
    for (const enabled of [false, true]) {
      await page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }).getByRole('button', { name: 'Editar cuenta', exact: true }).click();
      const edit = page.getByRole('form', { name: 'Editar cuenta de cuotas', exact: true });
      const checkbox = edit.getByLabel('Cuenta habilitada', { exact: true });
      if (enabled) await checkbox.check(); else await checkbox.uncheck();
      await edit.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
      await edit.waitFor({ state: 'hidden', timeout: 20_000 });
      expect((await active().database.pool.query('SELECT enabled FROM provider_accounts WHERE id=$1', [accountId])).rows).toEqual([{ enabled }]);
      await capture(`04-${enabled ? 'reenabled' : 'disabled'}`);
    }
  }, 120_000);

  it('resuelve conflictos de edición descartando y reintentando el borrador sin sobrescribir silenciosamente', async () => {
    let currentLabel = primaryLabel;
    for (const discard of [true, false]) {
      await page.getByRole('article', { name: `Entorno ${currentLabel}`, exact: true }).getByRole('button', { name: 'Editar entorno', exact: true }).click();
      const form = page.getByRole('form', { name: 'Editar entorno de cuotas', exact: true });
      const draftLabel = discard ? `${prefix}-draft` : primaryLabel;
      const remoteLabel = `${prefix}-remote-${discard ? 'discard' : 'retry'}`;
      await form.getByLabel('Nombre del entorno', { exact: true }).fill(draftLabel);
      const current = (await snapshot()).environments.find(row => row.id === primaryId);
      if (!current) throw new Error('conflict environment absent');
      const changed = await page.evaluate(async ({ id, version, label }: { id: string; version: number; label: string }) => {
        const session = await (await fetch('/v3/auth/session', { credentials: 'include' })).json() as { csrf_token: string };
        return (await fetch(`/v3/console/quota-environments/${id}`, { method: 'PATCH', credentials: 'include',
          headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token },
          body: JSON.stringify({ expected_version: version, label }) })).status;
      }, { id: primaryId, version: current.version, label: remoteLabel });
      expect(changed).toBe(200);
      errors.expectHttpError(`/v3/console/quota-environments/${primaryId}`, 409);
      await form.getByRole('button', { name: 'Guardar entorno', exact: true }).click();
      const conflict = page.getByRole('group', { name: 'Conflicto de versión', exact: true });
      await conflict.waitFor({ timeout: 20_000 });
      expect((await snapshot()).environments.find(row => row.id === primaryId)?.label).toBe(remoteLabel);
      await capture(`conflict-${discard ? 'discard' : 'retry'}`);
      await conflict.getByRole('button', { name: discard ? 'Descartar mis cambios' : 'Releer y reintentar con mis cambios', exact: true }).click();
      currentLabel = discard ? remoteLabel : primaryLabel;
      if (discard) {
        expect(await form.getByLabel('Nombre del entorno', { exact: true }).inputValue()).toBe(remoteLabel);
        await form.getByRole('button', { name: 'Cancelar', exact: true }).click();
      } else await page.getByText('Configuración del entorno guardada.', { exact: true }).waitFor({ timeout: 20_000 });
      expect((await snapshot()).environments.find(row => row.id === primaryId)?.label).toBe(currentLabel);
    }
  }, 90_000);

  it('consulta, actualiza el CLI y vuelve a consultar conservando la sesión y sus ventanas', async () => {
    const card = () => page.getByRole('article', { name: `Entorno ${primaryLabel}`, exact: true });
    await expect.poll(async () => card().getByRole('button', { name: 'Consultar cuotas', exact: true }).isDisabled(), { timeout: 30_000 }).toBe(false);
    const previous = (await active().database.pool.query<{ id: string }>(
      "SELECT id FROM quota_environment_operations WHERE environment_id=$1 AND action='query' ORDER BY created_at DESC,id DESC LIMIT 1", [primaryId])).rows[0];
    runtime().pause();
    try {
      await card().getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
      await card().getByText('Actualizando…', { exact: true }).waitFor({ timeout: 20_000 });
      await card().getByText('En cola', { exact: true }).waitFor({ timeout: 20_000 });
      for (const action of ['Consultar cuotas', 'Actualizar CLI', 'Eliminar entorno']) {
        expect(await card().getByRole('button', { name: action, exact: true }).isDisabled()).toBe(true);
      }
      expect((await snapshot()).operations.find(row => row.environment_id === primaryId)).toMatchObject({ action: 'query', status: 'pending' });
      await capture('05-query-pending');
    } finally { runtime().resume(); }
    const before = await runtime().waitOperation(primaryId, 'query', previous ? { afterId: previous.id } : {});
    expect(before.result).toMatchObject({ observation_status: 'ok', cli_version: 'fake2-cli 1.0.0',
      provider_report: { ok: true, windows: [{ remaining_percent: 72 }, { remaining_percent: 91 }] } });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertVisibleWindows();
    await capture('05-query');
    await card().getByRole('button', { name: 'Actualizar CLI', exact: true }).click();
    expect((await runtime().waitOperation(primaryId, 'update_cli')).result).toMatchObject({ cli_updated_verified: true, cli_version: 'fake2-cli 2.0.0' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await capture('06-cli-updated');
    await card().getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
    const after = await runtime().waitOperation(primaryId, 'query', { afterId: before.id });
    const beforeReport = before.result.provider_report as { windows: unknown[]; account_id: string };
    expect(after.result).toMatchObject({ observation_status: 'ok', cli_version: 'fake2-cli 2.0.0',
      provider_report: { ok: true, account_id: beforeReport.account_id, windows: beforeReport.windows } });
    expect((await active().database.pool.query('SELECT quota_identity_hash IS NOT NULL AS verified FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ verified: true }]);
    await record('session-preserved', { before: before.id, after: after.id, observation_status: after.result.observation_status, cli_version: after.result.cli_version });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await assertVisibleWindows();
    await card().locator('summary').click();
    await card().getByText('Detalles técnicos', { exact: true }).waitFor();
    await capture('07-query-after-update');
  }, 120_000);

  it('presenta fallos reales del lector, reintenta y muestra saldo agotado o distinto por modelo', async () => {
    const card = page.getByRole('article', { name: `Entorno ${primaryLabel}`, exact: true });
    const account = page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true });
    await observationMode('invalid-json');
    const unreadable = await queryPrimary('failed');
    expect(unreadable).toMatchObject({ error_code: 'STEP_FAILED', result: { failure_reason: 'reader_unreadable' } });
    await card.getByText('Falló', { exact: true }).waitFor({ timeout: 20_000 });
    await card.getByText('«Consultar cuotas» falló: El lector de cuotas no devolvió una medición. Reintenta. Si se repite, actualiza el CLI del entorno.', { exact: true }).waitFor({ timeout: 20_000 });
    await capture('reader-failed');

    await observationMode('provider-error');
    const failedProvider = await queryPrimary();
    expect(failedProvider.result).toMatchObject({ observation_status: 'error', provider_report: { ok: false, note: 'network', windows: [] } });
    await account.getByText(/No se pudo contactar al proveedor; se reintentará/u).waitFor({ timeout: 20_000 });
    await capture('provider-error');

    await observationMode('normal');
    const retried = await queryPrimary();
    expect(retried.result).toMatchObject({ observation_status: 'ok', cli_version: 'fake2-cli 2.0.0' });
    await assertVisibleWindows();
    await capture('reader-retried');

    for (const [mode, label] of [['exhausted', 'Sin disponibilidad'], ['model-dependent', 'Varía por modelo']] as const) {
      await observationMode(mode);
      const reading = await queryPrimary();
      expect(reading.result).toMatchObject({ observation_status: 'ok', provider_report: { effective_remaining_percent: 0 } });
      await account.getByText(label, { exact: true }).waitFor({ timeout: 20_000 });
      if (mode === 'model-dependent') {
        for (const name of ['5 h · fake2-small', 'Semanal · fake2-large']) {
          await account.getByText(name, { exact: true }).waitFor({ timeout: 20_000 });
        }
      }
      await capture(`quota-${mode}`);
    }
    await observationMode('automatic-pause');
    await queryPrimary();
    await account.getByText('En pausa', { exact: true }).waitFor({ timeout: 20_000 });
    await account.getByRole('button', { name: 'Editar cuenta', exact: true }).click();
    const edit = page.getByRole('form', { name: 'Editar cuenta de cuotas', exact: true });
    await edit.getByText('Pausada por cuota agotada en claude/default/five-hour', { exact: true }).waitFor({ timeout: 20_000 });
    expect(await edit.getByLabel('Motivo de pausa', { exact: true }).count()).toBe(0);
    await capture('automatic-pause');
    await edit.getByLabel('Reanudar ahora (quita la pausa)', { exact: true }).check();
    await edit.getByRole('button', { name: 'Guardar cuenta', exact: true }).click();
    await page.getByText('Cuenta actualizada.', { exact: true }).waitFor({ timeout: 20_000 });
    expect((await active().database.pool.query('SELECT paused_until,paused_reason FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ paused_until: null, paused_reason: null }]);
    await observationMode('normal');
    await queryPrimary();
    await assertVisibleWindows();
  }, 180_000);

  it('cancela edición y eliminación; elimina ambos entornos y comprueba contenedor y volumen fuera', async () => {
    for (const [id, label] of [[primaryId, primaryLabel], [secondaryId, secondaryLabel]] as const) {
      const previous = (await snapshot()).environments.find(row => row.id === id);
      if (!previous) throw new Error('environment to remove is absent');
      const card = page.getByRole('article', { name: `Entorno ${label}`, exact: true });
      await card.getByRole('button', { name: 'Editar entorno', exact: true }).click();
      await page.getByRole('form', { name: 'Editar entorno de cuotas', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();
      await card.getByRole('button', { name: 'Eliminar entorno', exact: true }).click();
      await page.getByRole('region', { name: 'Confirmar operación del entorno', exact: true }).getByRole('button', { name: 'Cancelar', exact: true }).click();
      expect((await snapshot()).environments.find(row => row.id === id)?.status).toBe(previous.status);
      await card.getByRole('button', { name: 'Eliminar entorno', exact: true }).click();
      await capture(`08-delete-confirm-${id}`);
      await page.getByRole('region', { name: 'Confirmar operación del entorno', exact: true }).getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
      expect((await runtime().waitOperation(id, 'delete')).result).toMatchObject({ stopped_verified: true, profile_removed_verified: true });
      expect(await runtime().inspect(id)).toMatchObject({ present: false, volume_present: false });
      await page.reload({ waitUntil: 'domcontentloaded' });
      await card.getByText('Eliminado', { exact: true }).waitFor({ timeout: 20_000 });
    }
    await capture('09-deleted');
    expect((await snapshot()).environments.filter(row => [primaryId, secondaryId].includes(row.id)).every(row => row.status === 'deleted')).toBe(true);
    const remainingAccount = await apiGet(page, '/v3/console/quota-accounts');
    expect(remainingAccount.status).toBe(200);
    expect((remainingAccount.body as unknown as { accounts: { id: string; enabled: boolean }[] }).accounts)
      .toEqual([expect.objectContaining({ id: accountId, enabled: true })]);
    errors.assertClean();
    await record('browser-errors', { unexpected: errors.unexpected, ignored: Object.fromEntries(errors.ignored) });
  }, 120_000);
});
