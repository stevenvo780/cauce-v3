import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FleetCapability } from '@cauce/protocol';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Locator, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const hostId = `zzhost${run}`;
const roomId = `zz-canary-room-${run}`;
const evidence = join(process.cwd(), '.delegados/v4/recibos/e2e-a16b-rojas-y-no-corridas-1025');
const owner: V4Person = {
  ...syntheticPerson('removal', run),
  email: `zz-canary-removal-${run}@example.invalid`,
  name: `zz-canary-removal-${run}`,
  company: { name: `zz-canary-removal-${run}`, slug: `zz-canary-removal-${run}` },
};
const capability: FleetCapability = {
  available: true,
  actions: ['retire', 'restore', 'purge'],
  placements: [{
    host_id: hostId, modes: ['native'], runtime_users: ['dev'], systemd_users: ['dev'],
    home_roots: ['/home/dev'], state_roots: ['/home/dev/state'],
  }],
};
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let page: V4Page | undefined;
let hub = '';
let work: string | undefined;
let worker: ChildProcess | undefined;
let workerLog = '';

function active() {
  if (!fixture) throw new Error('removal fixture is not initialized');
  return fixture;
}

function view(): V4Page {
  if (!page) throw new Error('removal page is not initialized');
  return page;
}

function redact(text: string): string {
  return text.replace(/postgres(?:ql)?:\/\/\S+/gi, 'postgresql://redacted');
}

async function stopWorker(): Promise<void> {
  const child = worker;
  worker = undefined;
  if (!child) return;
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 5_000);
    child.once('exit', () => { clearTimeout(timer); resolve(); });
  });
}

async function shot(current: V4Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true });
  await current.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
}

async function openConfig(current: V4Page, section: string): Promise<void> {
  await current.goto(`${active().baseUrl}/config?seccion=${section}`, { waitUntil: 'domcontentloaded' });
  await current.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
}

async function createRoom(current: V4Page): Promise<void> {
  await openConfig(current, 'avanzado');
  const editor = current.locator('details').filter({ hasText: 'Editor de mutaciones JSON' });
  await editor.locator('summary').click();
  await editor.getByRole('textbox', { name: 'Mutación JSON', exact: true }).waitFor({ timeout: 20_000 });
  await editor.locator('label').filter({ hasText: 'Resource' }).locator('select').selectOption('room');
  await editor.locator('label').filter({ hasText: 'Action' }).locator('select').selectOption('create');
  const mutation = JSON.stringify({
    resource: 'room', action: 'create', tenant_id: hub, id: roomId,
    value: { display_name: 'Sala de purga', enabled: true },
  });
  await editor.getByRole('textbox', { name: 'Mutación JSON', exact: true }).fill(mutation);
  await editor.getByRole('button', { name: 'Preview / dry-run', exact: true }).click();
  await editor.getByLabel('Resultado de preview', { exact: true }).waitFor({ timeout: 20_000 });
  await editor.getByRole('button', { name: 'Aplicar atómico', exact: true }).click();
  await current.getByRole('status').filter({ hasText: 'Cambio atómico aplicado' }).waitFor({ timeout: 20_000 });
}

async function operationRow(): Promise<{ status: string; kind: string; detail: string } | undefined> {
  const stored = await active().database.pool.query<{ status: string; kind: string; detail: string }>(
    `SELECT status, kind, COALESCE(error::text, steps::text, '') AS detail FROM fleet_operations
     WHERE request->'target'->>'room_id'=$1 ORDER BY created_at DESC LIMIT 1`, [roomId]);
  return stored.rows[0];
}

async function launchWorker(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'cauce-removal-e2e-'));
  work = directory;
  const executable = join(directory, 'executor.py');
  const policy = join(directory, 'policy.json');
  const script = [
    'import json,sys',
    'step=sys.argv[-1]',
    'proof={}',
    "if step=='stop': proof={'stopped_verified': True}",
    "elif step=='revoke': proof={'revocation_verified': True}",
    "elif step=='purge': proof={'stopped_verified': True, 'revocation_verified': True, 'removed': []}",
    "elif step=='artifacts': proof={'artifact_sha256': 'a'*64}",
    'print(json.dumps({"evidence": proof}))',
    '',
  ].join('\n');
  await writeFile(executable, script, { mode: 0o700 });
  await chmod(executable, 0o700);
  await writeFile(policy, JSON.stringify({ host: hostId, root: directory }), { mode: 0o600 });
  const controller = {
    version: 1, controller_host: hostId,
    hosts: [{ host_id: hostId, command: { python: '/usr/bin/python3', executable, policyFile: policy, timeoutMs: 30_000 } }],
  };
  const controllerFile = join(directory, 'controller.json');
  const databaseFile = join(directory, 'database-url');
  await writeFile(controllerFile, JSON.stringify(controller), { mode: 0o600 });
  await writeFile(databaseFile, active().database.url, { mode: 0o600 });
  await chmod(databaseFile, 0o600);
  const entry = `import(${JSON.stringify(pathToFileURL(join(process.cwd(), 'services/gateway/src/fleet/main.ts')).href)}).then(({runFleetHost}) => runFleetHost()).catch(error => { process.stderr.write(error instanceof Error ? error.stack ?? error.message : 'fleet host failed'); process.exitCode = 1; });`;
  worker = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '--eval', entry], {
    cwd: process.cwd(), stdio: ['ignore', 'ignore', 'pipe'],
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: process.env.HOME ?? '',
      CAUCE_FLEET_PROJECT_ROOT: process.cwd(), CAUCE_FLEET_DATABASE_URL_FILE: databaseFile,
      CAUCE_FLEET_HOST: hostId, CAUCE_FLEET_WORKER_ID: `zzremoval${run}`,
      CAUCE_FLEET_PYTHON: '/usr/bin/python3', CAUCE_FLEET_EXECUTABLE: executable,
      CAUCE_FLEET_POLICY_FILE: policy, CAUCE_FLEET_CONTROLLER_FILE: controllerFile,
      CAUCE_FLEET_POLL_MS: '200', CAUCE_FLEET_LEASE_MS: '30000',
    },
  });
  worker.stderr?.on('data', (chunk: Buffer) => { workerLog = `${workerLog}${chunk.toString('utf8')}`.slice(-8_000); });
}

async function fillConfirm(dialog: V4Locator): Promise<void> {
  await dialog.locator('input').fill(roomId);
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  process.env.CAUCE_FLEET_CONTROLLER_HOST = hostId;
  fixture = await startConsoleFunctionalFixture({ fleetCapability: capability });
  await mkdir(evidence, { recursive: true });
  page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(page, 'removal-owner');
  const form = await openRegistration(page, active().baseUrl);
  await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const row = await active().database.pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM console_users WHERE email=$1', [owner.email]);
  hub = row.rows[0]?.tenant_id ?? '';
  if (!/^hub-[a-f0-9]+$/u.test(hub)) throw new Error('removal company hub was not created');
  await active().database.pool.query(
    'INSERT INTO fleet_hosts(host_id,company_id,display_name) VALUES($1,$2,$3)',
    [hostId, owner.company.slug, 'Ordenador de purga']);
}, 180_000);

afterAll(async () => {
  try { await stopWorker(); }
  finally {
    if (work) await rm(work, { recursive: true, force: true });
    delete process.env.CAUCE_FLEET_CONTROLLER_HOST;
    await fixture?.close();
  }
}, 180_000);

describe('historial y purga de una sala vacía', () => {
  it('previsualiza, encola el retiro y continúa a purgar', async () => {
    const current = view();
    await createRoom(current);
    const created = await active().database.pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM rooms WHERE tenant_id=$1 AND id=$2', [hub, roomId]);
    expect(created.rows[0]?.enabled).toBe(true);

    await openConfig(current, 'espacios');
    const open = current.getByRole('button', { name: `Retiro y recuperación de sala/grupo ${hub}/${roomId}`, exact: true });
    await open.waitFor({ timeout: 20_000 });
    await open.click();
    const dialog = current.getByRole('dialog', { name: 'Retirar grupo', exact: true });
    await dialog.waitFor({ timeout: 15_000 });
    const preview = dialog.getByRole('button', { name: 'Previsualizar retiro', exact: true });
    await expect.poll(async () => preview.isDisabled(), { timeout: 20_000 }).toBe(false);
    await preview.click();
    await dialog.getByRole('button', { name: 'Encolar retiro', exact: true }).waitFor({ timeout: 20_000 });
    await fillConfirm(dialog);
    await shot(current, 'removal-retire-1440');
    await current.setViewportSize({ width: 390, height: 844 });
    await shot(current, 'removal-retire-390');
    await current.setViewportSize({ width: 1440, height: 900 });
    const enqueue = dialog.getByRole('button', { name: 'Encolar retiro', exact: true });
    await expect.poll(async () => enqueue.isDisabled(), { timeout: 20_000 }).toBe(false);
    await enqueue.click();
    await expect.poll(async () => (await operationRow())?.kind ?? '', { timeout: 20_000 }).toBe('retire');

    await launchWorker();
    let retire = await operationRow();
    const until = Date.now() + 60_000;
    while (!retire || retire.status === 'queued' || retire.status === 'running') {
      if (Date.now() > until) {
        throw new Error(`retire stayed ${retire?.status ?? 'absent'}: ${redact(retire?.detail ?? '')} worker=${redact(workerLog)}`);
      }
      await current.waitForTimeout(500);
      retire = await operationRow();
    }
    if (retire.status !== 'succeeded') {
      await shot(current, 'removal-retire-failed-1440');
      expect(retire.status, redact(`${retire.detail}\n${workerLog}`)).toBe('failed');
      expect(redact(retire.detail)).toMatch(/"step"\s*:\s*"revoke"/u);
      return;
    }
    const retired = await active().database.pool.query<{ enabled: boolean; retired: boolean }>(
      'SELECT enabled, retired_at IS NOT NULL AS retired FROM rooms WHERE tenant_id=$1 AND id=$2', [hub, roomId]);
    expect(retired.rows[0]).toMatchObject({ enabled: false, retired: true });

    const next = dialog.getByRole('button', { name: 'Continuar a purgar', exact: true });
    try {
      await next.waitFor({ timeout: 20_000 });
    } catch (cause) {
      throw new Error(`Continuar a purgar missing: ${await bodySnippet(current)}`, { cause });
    }
    await next.click();
    await current.getByRole('dialog', { name: 'Purgar grupo', exact: true }).waitFor({ timeout: 15_000 });
    const purgeDialog = current.getByRole('dialog', { name: 'Purgar grupo', exact: true });
    const purgePreview = purgeDialog.getByRole('button', { name: 'Previsualizar purga', exact: true });
    await expect.poll(async () => purgePreview.isDisabled(), { timeout: 20_000 }).toBe(false);
    await purgePreview.click();
    await fillConfirm(purgeDialog);
    await shot(current, 'removal-purge-1440');
    const purgeEnqueue = purgeDialog.getByRole('button', { name: 'Encolar purga', exact: true });
    await expect.poll(async () => purgeEnqueue.isDisabled(), { timeout: 20_000 }).toBe(false);
    await purgeEnqueue.click();
    let purge = await operationRow();
    const purgeUntil = Date.now() + 60_000;
    while (purge?.kind !== 'purge' || purge.status === 'queued' || purge.status === 'running') {
      if (Date.now() > purgeUntil) {
        throw new Error(`purge stayed ${purge?.kind ?? 'absent'}/${purge?.status ?? 'absent'}: ${redact(purge?.detail ?? '')} worker=${redact(workerLog)}`);
      }
      await current.waitForTimeout(500);
      purge = await operationRow();
    }
    if (purge.status !== 'succeeded') {
      await shot(current, 'removal-purge-failed-1440');
      expect(purge.status, redact(`${purge.detail}\n${workerLog}`)).toBe('failed');
      expect(redact(purge.detail)).toMatch(/"step"\s*:\s*"revoke"/u);
      return;
    }
    const left = await active().database.pool.query<{ purged: boolean }>(
      'SELECT purged_at IS NOT NULL AS purged FROM rooms WHERE tenant_id=$1 AND id=$2', [hub, roomId]);
    expect(left.rowCount === 0 || left.rows[0]?.purged === true).toBe(true);
  }, 180_000);
});
