import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { COMPUTER_RUNTIME, FIXTURE_DEVICE_CODE, FIXTURE_LOGIN_DONE, docker } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import type { ProviderAuthSnapshot } from '../../services/gateway/src/console/provider-auth.types.js';
import { apiGet, bodySnippet, type IgnoredConsoleRule, type V4Locator } from './v4-console-real-browser.helpers.js';
import { coverageCapture, coverageEnqueue, coverageOperations, startCoverageFixture } from './v4-agentes-l-helpers.js';

type CoverageFixture = Awaited<ReturnType<typeof startCoverageFixture>>;
let fixture: CoverageFixture | undefined;
let alias = '';
let draftAlias = '';
let container = '';
let loginOperation = '';
let terminalOutput = '';
const taskOwner = 'e2e-a19-rojas-viejas-1025';
const sourceFiles = ['tests/e2e/v4-agentes-q-real-browser.test.ts', 'tests/e2e/v4-agentes-l-helpers.ts',
  'services/gateway/src/fleet/host-computer.fixtures.ts', 'services/gateway/src/console/provider-auth-socket.ts',
  'services/gateway/src/console/provider-auth.sessions.ts', 'console/src/features/accounts/ProviderSignIn.tsx',
  'console/src/features/accounts/ProviderAuthPanel.tsx', 'console/src/features/accounts/ProviderAuthTerminal.tsx'];
interface AuthResponse {
  url(): string; status(): number; request(): { method(): string }; json(): Promise<unknown>;
}
interface AuthSocket {
  on(event: 'framereceived' | 'framesent', callback: (frame: { payload: string | Buffer }) => void): void;
  on(event: 'close', callback: () => void): void;
}
interface AuthPage {
  keyboard: { insertText(value: string): Promise<void> };
  waitForResponse(predicate: (response: AuthResponse) => boolean, options: { timeout: number }): Promise<AuthResponse>;
}
interface SocketMetrics {
  path: string; opened_at_ms: number; closed_at_ms: number | null;
  sent: { at_ms: number; bytes: number; binary: boolean }[]; received: { at_ms: number; bytes: number; binary: boolean }[];
}
const sockets: SocketMetrics[] = [];
const failures: Record<string, unknown>[] = [];
const evidence: Record<string, unknown> = { section: 'Q', mocks: false, failures };
const fixtureRules: IgnoredConsoleRule[] = [
  { id: 'coverage-terminal-inventories-404', reason: 'computer fixture has no terminal relay',
    matches: (text, url) => text.includes('status of 404')
      && ['/v3/console/terminal/sessions', '/v3/console/terminal/targets'].includes(new URL(url).pathname) },
  { id: 'coverage-backups-404', reason: 'computer fixture does not configure the space backup service',
    matches: (text, url) => text.includes('status of 404')
      && /^\/v3\/console\/spaces\/hub-[a-f0-9]{32}\/quick[a-f0-9]{8}\/backups$/u.test(new URL(url).pathname) },
  { id: 'coverage-native-admin-501', reason: 'computer fixture does not configure native administration',
    matches: (text, url) => text.includes('status of 501')
      && /^\/v3\/console\/tenants\/hub-[a-f0-9]{32}\/agents\/quick[a-f0-9]{8}\/native\/skill$/u.test(new URL(url).pathname) },
];
const active = () => { if (!fixture) throw new Error('quick actions fixture is unavailable'); return fixture; };

async function operationCount(): Promise<number> {
  return Number((await active().computer.pool.query<{ count: string }>(
    `SELECT count(*)::text AS count FROM fleet_operations operation WHERE target->>'tenant_id'=$1
      AND NOT EXISTS(SELECT 1 FROM fleet_operation_events origin WHERE origin.operation_id=operation.id
        AND origin.event='queued' AND origin.metadata ? 'maintenance' AND origin.metadata->>'actor_subject' LIKE 'host:%')`, [active().tenantId],
  )).rows[0]?.count);
}

async function capture(name: string): Promise<void> {
  await coverageCapture(active(), name);
}

async function openSheet(agentAlias = alias): Promise<V4Locator> {
  const { page, baseUrl, tenantId, computer } = active();
  const row = (await computer.pool.query<{ display_name: string }>(
    'SELECT display_name FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, agentAlias],
  )).rows[0];
  if (!row) throw new Error(`owned agent ${agentAlias} is missing`);
  const target = `${baseUrl}/config?seccion=agentes&agente=${encodeURIComponent(`${tenantId}/${agentAlias}`)}`;
  if (page.url() === target) {
    await page.reload({ waitUntil: 'domcontentloaded' });
  } else {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
  }
  const sheet = page.getByRole('dialog', { name: row.display_name, exact: true });
  await sheet.waitFor({ timeout: 30_000 });
  return sheet;
}

async function unchanged(action: () => Promise<void>): Promise<void> {
  const before = await operationCount();
  await action();
  expect(await operationCount()).toBe(before);
}

async function retiredRuntime(): Promise<{ processes: number; credentials: boolean }> {
  return JSON.parse(await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
    'import json,os,pathlib,sys;key=sys.argv[1];count=0\nfor pid in filter(str.isdigit,os.listdir("/proc")):\n'
    + ' try:\n  env=pathlib.Path("/proc",pid,"environ").read_bytes().split(bytes([0]));count+=bytes("CAUCE_RUNTIME_KEY="+key,"utf8") in env\n'
    + ' except OSError:pass\nprint(json.dumps({"processes":count,"credentials":(pathlib.Path("/run/cauce-credentials")/key).exists()}))',
    `quick-${active().run}`])) as { processes: number; credentials: boolean };
}

async function providerRuntime(): Promise<{ login_processes: number; profile_exists: boolean }> {
  const profile = `${COMPUTER_RUNTIME.home}/.cauce-profiles/quick-${active().run}/${createHash('sha256').update(active().accountId).digest('hex')}/auth.json`;
  return JSON.parse(await docker(['exec', '--user', COMPUTER_RUNTIME.user, container, 'python3', '-I', '-B', '-c',
    'import json,pathlib,sys;count=0\nfor item in pathlib.Path("/proc").iterdir():\n'
    + ' if not item.name.isdigit():continue\n'
    + ' try:count+=b"/usr/local/bin/cauce-fixture-codex" in (item/"cmdline").read_bytes().split(bytes([0]))\n'
    + ' except OSError:pass\nprint(json.dumps({"login_processes":count,"profile_exists":pathlib.Path(sys.argv[1]).is_file()}))',
    profile])) as { login_processes: number; profile_exists: boolean };
}

async function reservation(): Promise<{ session_id: string; state: string } | undefined> {
  return (await active().computer.pool.query<{ session_id: string; state: string }>(`SELECT
    metadata->'provider_auth'->>'session_id' AS session_id,metadata->'provider_auth'->>'state' AS state
    FROM fleet_operation_events WHERE operation_id=$1 AND metadata ? 'provider_auth' ORDER BY id DESC LIMIT 1`,
  [loginOperation])).rows[0];
}

async function cancelQueuedMaintenance(panel: V4Locator): Promise<void> {
  const { page, computer, tenantId } = active();
  const pending = (await computer.pool.query<{
    id: string; kind: string; status: string; desired_revision: number | null; automatic: boolean;
    steps: { status: string }[]; deferred_reason: string | null;
  }>(`SELECT operation.id,operation.kind,operation.status,operation.desired_revision,
    EXISTS(SELECT 1 FROM fleet_operation_events origin WHERE origin.operation_id=operation.id
      AND origin.event='queued' AND origin.metadata ? 'maintenance' AND origin.metadata->>'actor_subject' LIKE 'host:%') AS automatic,
    operation.steps,
    (SELECT metadata->'maintenance_deferred'->>'reason' FROM fleet_operation_events deferred
      WHERE deferred.operation_id=operation.id AND metadata ? 'maintenance_deferred' ORDER BY id DESC LIMIT 1) AS deferred_reason
    FROM fleet_operations operation WHERE target->>'tenant_id'=$1 AND target->>'alias'=$2
      AND status IN ('queued','running','cancelling') ORDER BY created_at DESC LIMIT 1`, [tenantId, alias])).rows[0];
  if (!pending) return;
  expect(pending).toMatchObject({ kind: 'update', status: 'queued', desired_revision: null, automatic: true });
  expect(pending.steps.length).toBeGreaterThan(0);
  expect(pending.steps.every(step => step.status === 'pending')).toBe(true);
  const cancelledResponse = (page as unknown as AuthPage).waitForResponse(response => response.request().method() === 'POST'
    && new URL(response.url()).pathname === `/v3/console/fleet/operations/${pending.id}/cancel`, { timeout: 30_000 });
  const cancel = panel.getByRole('button', { name: 'Cancelar', exact: true });
  await expect.poll(() => cancel.isDisabled(), { timeout: 30_000 }).toBe(false);
  await cancel.click();
  const cancelledHttp = await cancelledResponse;
  expect(cancelledHttp.status()).toBe(200);
  await expect.poll(async () => (await coverageOperations(active(), alias)).find(row => row.id === pending.id)?.status,
    { timeout: 120_000, interval: 500 }).toBe('cancelled');
  evidence.maintenanceBeforeRemoval = { ...pending, cancelPostStatus: cancelledHttp.status(), terminalStatus: 'cancelled' };
}

async function prepareWithLogin() {
  const { page, baseUrl, tenantId, room, hostId, accountId } = active();
  await page.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('button', { name: 'Añadir agente', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Añadir agente' });
  await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
  const panel = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
  await panel.getByLabel('Espacio de trabajo operativo').selectOption(tenantId);
  await panel.getByLabel('Alias operativo').fill(alias);
  await panel.getByLabel('Nombre visible operativo').fill(`Cobertura ${alias}`);
  await panel.getByLabel('Clave física de ejecución').fill(`quick-${active().run}`);
  await panel.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
  await panel.getByLabel('Grupo primario').selectOption(room);
  await panel.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
  await panel.getByLabel('Host operativo').selectOption(hostId);
  await panel.getByLabel('Plantilla de ejecución').selectOption('0');
  await panel.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
  return coverageEnqueue(active(), panel, alias, 'create', ['awaiting_auth']);
}

beforeAll(async () => {
  process.env.CAUCE_PLAZOS_FACTOR ??= '3';
  evidence.sourceSha256 = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
    [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
  fixture = await startCoverageFixture('q', { providerLogin: true, ignoredConsoleRules: fixtureRules, extraSourceFiles: [
    'packages/store/src/device-authorization.ts', 'packages/store/src/device-authorization-authority.ts',
    'services/gateway/src/device-authorization.ts',
    'packages/protocol/src/context-retirement.ts', 'packages/store/src/context-retirement.ts',
    'packages/store/src/context-git-retirement.ts', 'ops/container-runtime/cauce_container_restart.py',
    'packages/store/src/repository/fleet-operation-maintenance.ts',
    'services/gateway/src/fleet/host-maintenance.ts',
    'services/gateway/src/fleet/host-maintenance-guard.ts',
    'ops/cli/fleet_executor_maintenance.py',
    'services/gateway/src/fleet/enrolled-backups.ts',
  ] });
  alias = `quick${fixture.run}`;
  draftAlias = `draft${fixture.run}`;
  fixture.page.on('websocket', candidate => {
    const path = new URL(candidate.url()).pathname;
    if (!path.startsWith('/v3/console/provider-auth/sessions/')) return;
    const metric: SocketMetrics = { path, opened_at_ms: Date.now(), closed_at_ms: null, sent: [], received: [] };
    sockets.push(metric);
    const socket = candidate as unknown as AuthSocket;
    socket.on('close', () => { metric.closed_at_ms = Date.now(); });
    for (const event of ['framereceived', 'framesent'] as const) socket.on(event, ({ payload }) => {
      const frame = { at_ms: Date.now(), bytes: Buffer.isBuffer(payload) ? payload.byteLength : Buffer.byteLength(payload), binary: Buffer.isBuffer(payload) };
      if (event === 'framesent') metric.sent.push(frame);
      else { metric.received.push(frame); terminalOutput += Buffer.isBuffer(payload) ? payload.toString('utf8') : payload; }
    });
  });
  await fixture.computer.pool.query(`INSERT INTO agents(tenant_id,alias,display_name,enabled,company_id)
    VALUES($1,$2,$3,false,$4)`, [fixture.tenantId, draftAlias, `Borrador ${fixture.run}`, fixture.companyId]);
  await fixture.computer.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES($1,$2,$3,'agent')`, [fixture.tenantId, fixture.room, draftAlias]);
}, 900_000);

afterAll(async () => {
  if (!fixture) return;
  try {
    evidence.sourceSha256After = Object.fromEntries(await Promise.all(sourceFiles.map(async file =>
      [file, createHash('sha256').update(await readFile(file)).digest('hex')])));
    await writeFile(join(fixture.receipts, 'evidence.json'), JSON.stringify({
      ...evidence, run: fixture.run, browserErrors: fixture.errors.unexpected,
      taskOwner, sourceReceipts: fixture.receipts, authenticationSockets: sockets,
      ignoredConsoleRules: Object.fromEntries(fixture.errors.ignored),
      fixtureCapabilities: { terminalRelay: false, spaceBackups: false, nativeAdministration: false },
    }, null, 2) + '\n', { mode: 0o600 });
    expect(evidence.sourceSha256After).toEqual(evidence.sourceSha256);
  } finally {
    try { await fixture.close(); }
    finally {
      const destination = join(process.cwd(), '.delegados/v4/recibos', taskOwner, 'q', fixture.run);
      await mkdir(destination, { recursive: true, mode: 0o700 });
      await cp(fixture.receipts, destination, { recursive: true });
      const m2bDestination = join(process.cwd(), '.delegados/v4/recibos/m2b-login-proveedor-1025/q', fixture.run);
      await mkdir(m2bDestination, { recursive: true, mode: 0o700 });
      await cp(fixture.receipts, m2bDestination, { recursive: true });
      console.info('AGENTES_Q_TASK_RECEIPTS', JSON.stringify({ run: fixture.run, receipts: destination, m2bReceipts: m2bDestination, sourceReceipts: fixture.receipts }));
    }
  }
}, 300_000);

afterEach(async ({ task }) => {
  if (fixture && task.result?.state === 'fail') {
    const failure = { test: task.name, page: await bodySnippet(fixture.page), operations: await coverageOperations(fixture, alias) };
    evidence.lastFailure = failure;
    failures.push(failure);
    await capture('failure');
  }
});

describe.sequential('acciones frecuentes de Agentes con Chromium y persistencia reales', () => {
  it('Q01/Q07: el borrador dirige a Preparar y a Ajustes sin crear operaciones', async () => {
    const { page, tenantId } = active();
    await unchanged(async () => {
      let sheet = await openSheet(draftAlias);
      expect(await sheet.getByRole('button', { name: `Iniciar sesión de ${draftAlias}`, exact: true }).isDisabled()).toBe(true);
      await sheet.getByRole('link', { name: `Preparar ${draftAlias}`, exact: true }).click();
      await sheet.getByRole('region', { name: `Operación de ${tenantId}/${draftAlias}`, exact: true }).waitFor({ timeout: 30_000 });
      expect(await sheet.getByLabel('¿Qué quieres hacer?').inputValue()).toBe('create');
      await capture('Q01-preparar');
      sheet = await openSheet(draftAlias);
      await sheet.getByRole('button', { name: `Eliminar agente ${tenantId}/${draftAlias}`, exact: true }).click();
      expect(await sheet.getByRole('tab', { name: 'Ajustes', exact: true }).evaluate(element => element.getAttribute('aria-selected'))).toBe('true');
      await sheet.getByRole('button', { name: 'Eliminar registro', exact: true }).waitFor({ timeout: 15_000 });
      await capture('Q07-ir-a-eliminar');
    });
    expect((await apiGet(page, '/v3/console/config')).status).toBe(200);
    evidence.draftActions = { prepareKind: 'create', deleteTab: 'Ajustes', enqueued: 0 };
  }, 180_000);

  it('prepara el agente de las acciones mediante Chromium y verifica el contenedor real', async () => {
    const waiting = await prepareWithLogin();
    loginOperation = waiting.id;
    const { computer, tenantId } = active();
    const row = (await computer.pool.query<{ container_name: string; runtime_key: string; enabled: boolean }>(
      'SELECT container_name,runtime_key,enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias],
    )).rows[0];
    if (!row) throw new Error('created quick-action agent is missing');
    container = row.container_name;
    expect(waiting.status).toBe('awaiting_auth');
    expect(row.enabled).toBe(false);
    expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
    expect(await providerRuntime()).toEqual({ login_processes: 0, profile_exists: false });
    evidence.prepared = { alias, runtime: row.runtime_key, container, running: true, operation: waiting, admitted: false };
  }, 600_000);

  it('Q01: inicia sesión del proveedor desde Estado, verifica y reanuda la misma operación', async () => {
    const { page, accountId, hostId, computer, tenantId } = active();
    const authPage = page as unknown as AuthPage;
    const sheet = await openSheet();
    const button = sheet.getByRole('button', { name: `Iniciar sesión de ${alias}`, exact: true });
    await expect.poll(() => button.isDisabled(), { timeout: 30_000 }).toBe(false);
    const startResponse = authPage.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/v3/console/provider-auth/sessions', { timeout: 90_000 });
    await button.click();
    const dialog = page.getByRole('dialog', { name: 'Iniciar sesión en GPT / Codex', exact: true });
    await dialog.waitFor({ timeout: 30_000 });
    const startedHttp = await startResponse;
    expect(startedHttp.status()).toBe(202);
    const started = await startedHttp.json() as ProviderAuthSnapshot;
    expect(started).toMatchObject({ operation_id: loginOperation, provider_id: 'codex', account_id: accountId,
      host_id: hostId, runtime_user: COMPUTER_RUNTIME.user, profile_id: accountId, method: 'device',
      status: 'awaiting_login', cleanup_pending: false, error: null });
    expect(started.session_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await reservation()).toEqual({ session_id: started.session_id, state: 'reserved' });
    const live = await apiGet(page, `/v3/console/provider-auth/sessions/${started.session_id}`);
    expect(live.status).toBe(200);
    expect(live.body).toMatchObject({ session_id: started.session_id, status: 'awaiting_login', operation_id: loginOperation });
    await dialog.getByLabel('Terminal privada de autenticación', { exact: true }).waitFor({ timeout: 60_000 });
    await expect.poll(() => terminalOutput, { timeout: 60_000 }).toContain(`enter the code ${FIXTURE_DEVICE_CODE}`);
    await expect.poll(() => terminalOutput, { timeout: 30_000 }).toContain('"type":"ready"');
    await capture('Q01-login-preparado');
    const input = dialog.locator('.xterm-helper-textarea');
    expect(await input.evaluate(element => { element.focus(); return element === document.activeElement; })).toBe(true);

    await authPage.keyboard.insertText('CODIGO-RECHAZADO');
    await input.press('Enter');
    await expect.poll(() => terminalOutput, { timeout: 30_000 }).toContain('FIXTURE_LOGIN_REJECTED');
    const rejectionResponse = authPage.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/v3/console/provider-auth/sessions/${started.session_id}/verify`, { timeout: 90_000 });
    const rejectVerify = dialog.getByRole('button', { name: 'Verificar conexión', exact: true });
    await expect.poll(() => rejectVerify.isDisabled(), { timeout: 30_000 }).toBe(false);
    await rejectVerify.click();
    const rejectedHttp = await rejectionResponse;
    expect(rejectedHttp.status()).toBe(200);
    const rejected = await rejectedHttp.json() as ProviderAuthSnapshot;
    expect(rejected).toMatchObject({ session_id: started.session_id, status: 'failed', cleanup_pending: false });
    expect(rejected.error).not.toBeNull();
    await dialog.getByRole('alert').waitFor({ timeout: 30_000 });
    const rejectedReread = await apiGet(page, `/v3/console/provider-auth/sessions/${started.session_id}`);
    expect(rejectedReread.status).toBe(200);
    expect(rejectedReread.body).toMatchObject(rejected);
    expect((await coverageOperations(active(), alias)).find(row => row.id === loginOperation)?.status).toBe('awaiting_auth');
    expect((await computer.pool.query<{ enabled: boolean }>(
      'SELECT enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias],
    )).rows[0]?.enabled).toBe(false);
    await expect.poll(() => providerRuntime(), { timeout: 30_000, interval: 1000 })
      .toEqual({ login_processes: 0, profile_exists: false });
    await capture('Q01-login-rechazado');
    await expect.poll(() => reservation(), { timeout: 30_000, interval: 1000 })
      .toEqual({ session_id: started.session_id, state: 'released' });
    await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect.poll(() => dialog.isVisible(), { timeout: 30_000 }).toBe(false);

    terminalOutput = '';
    const secondStartResponse = authPage.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/v3/console/provider-auth/sessions', { timeout: 90_000 });
    await expect.poll(() => button.isDisabled(), { timeout: 30_000 }).toBe(false);
    await button.click();
    const secondDialog = page.getByRole('dialog', { name: 'Iniciar sesión en GPT / Codex', exact: true });
    await secondDialog.waitFor({ timeout: 30_000 });
    const secondStartedHttp = await secondStartResponse;
    expect(secondStartedHttp.status()).toBe(202);
    const secondStarted = await secondStartedHttp.json() as ProviderAuthSnapshot;
    expect(secondStarted.session_id).toMatch(/^[a-f0-9-]{36}$/u);
    expect(await reservation()).toEqual({ session_id: secondStarted.session_id, state: 'reserved' });

    await secondDialog.getByLabel('Terminal privada de autenticación', { exact: true }).waitFor({ timeout: 60_000 });
    await expect.poll(() => terminalOutput, { timeout: 60_000 }).toContain(`enter the code ${FIXTURE_DEVICE_CODE}`);
    await expect.poll(() => terminalOutput, { timeout: 30_000 }).toContain('"type":"ready"');
    const secondInput = secondDialog.locator('.xterm-helper-textarea');
    expect(await secondInput.evaluate(element => { element.focus(); return element === document.activeElement; })).toBe(true);
    await authPage.keyboard.insertText(FIXTURE_DEVICE_CODE);
    await secondInput.press('Enter');
    await expect.poll(() => terminalOutput, { timeout: 60_000 }).toContain(FIXTURE_LOGIN_DONE);
    expect(sockets.some(socket => socket.path.includes(secondStarted.session_id)
      && socket.sent.some(frame => frame.binary && frame.bytes === Buffer.byteLength(FIXTURE_DEVICE_CODE)))).toBe(true);
    const verifyResponse = authPage.waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === `/v3/console/provider-auth/sessions/${secondStarted.session_id}/verify`, { timeout: 90_000 });
    const verify = secondDialog.getByRole('button', { name: 'Verificar conexión', exact: true });
    await expect.poll(() => verify.isDisabled(), { timeout: 30_000 }).toBe(false);
    await verify.click();
    const verifiedHttp = await verifyResponse;
    expect(verifiedHttp.status()).toBe(200);
    const verified = await verifiedHttp.json() as ProviderAuthSnapshot;
    expect(verified).toMatchObject({ session_id: secondStarted.session_id, status: 'authenticated', cleanup_pending: false, error: null });
    await secondDialog.getByText('Cuenta verificada y operación reanudada. El agente sigue preparándose; puedes cerrar esta ventana.', { exact: true })
      .waitFor({ timeout: 90_000 });
    await expect.poll(async () => (await coverageOperations(active(), alias)).find(row => row.id === loginOperation)?.status,
      { timeout: 240_000, interval: 1000 }).toBe('succeeded');
    await expect.poll(() => reservation(), { timeout: 60_000, interval: 1000 })
      .toEqual({ session_id: secondStarted.session_id, state: 'released' });
    await expect.poll(() => providerRuntime(), { timeout: 30_000, interval: 1000 })
      .toEqual({ login_processes: 0, profile_exists: true });
    await expect.poll(() => sockets.filter(socket => socket.path.includes(secondStarted.session_id))
      .every(socket => socket.closed_at_ms !== null), { timeout: 30_000 }).toBe(true);
    expect(sockets.some(socket => socket.path.includes(secondStarted.session_id) && socket.sent.length > 0)).toBe(true);
    expect((await computer.pool.query<{ enabled: boolean }>('SELECT enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias]))
      .rows[0]?.enabled).toBe(true);
    await capture('Q01-login-verificado-y-limpio');
    await secondDialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
    await expect.poll(() => secondDialog.isVisible(), { timeout: 30_000 }).toBe(false);

    const refreshedSheet = await openSheet();
    const dbRow = (await computer.pool.query<{ enabled: boolean; lifecycle_state: string }>(
      'SELECT enabled, lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias],
    )).rows[0];
    expect(dbRow).toEqual({ enabled: true, lifecycle_state: 'ready' });
    const stateRegion = refreshedSheet.getByRole('region', { name: `Estado de ${tenantId}/${alias}`, exact: true });
    await stateRegion.getByText('Sesión activa', { exact: true }).waitFor({ timeout: 30_000 });
    await stateRegion.getByText('Terminó de prepararse con la cuenta de su proveedor.', { exact: true }).waitFor({ timeout: 30_000 });
    await capture('Q01-ficha-estado-final');

    evidence.login = { opened: true, waitingOperation: true, providerAuthenticationPerformed: true, pasteViaBrowser: true,
      rejectedAttempt: { observed: 'FIXTURE_LOGIN_REJECTED', postStatus: rejectedHttp.status(), session: rejected,
        persistedStatus: 'awaiting_auth', admitted: false, profileExists: false, released: true },
      postStatus: secondStartedHttp.status(), session: verified, reservation: await reservation(), runtime: await providerRuntime(),
      sameOperationResumed: true, dbRow, sheetLifecycle: 'Sesión activa' };
  }, 420_000);

  it('Q02/Q03/Q04: abre terminal, chat y contexto del agente elegido por sus enlaces', async () => {
    const { page, tenantId } = active();
    const targets = [
      { label: `Abrir terminal de ${tenantId}/${alias}`, pathname: '/terminal', query: '', heading: 'Terminal de agentes', id: 'Q02' },
      { label: `Abrir chat de ${tenantId}/${alias}`, pathname: '/messages', query: '', heading: alias, id: 'Q03' },
      { label: `Perfil y contexto de ${tenantId}/${alias}`, pathname: '/messages', query: '?view=context', heading: `Perfil y contexto de ${alias}`, id: 'Q04' },
    ];
    for (const target of targets) {
      await unchanged(async () => {
        const sheet = await openSheet();
        await sheet.getByRole('link', { name: target.label, exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 })
          .toBe(`${target.pathname}/${encodeURIComponent(tenantId)}/${encodeURIComponent(alias)}`);
        expect(new URL(page.url()).search).toBe(target.query);
        await page.getByRole('heading', { name: target.heading, exact: true }).waitFor({ timeout: 30_000 });
        if (target.id === 'Q02') await page.getByText('La terminal no está disponible en este servidor', { exact: true }).waitFor({ timeout: 20_000 });
        if (target.id === 'Q03') await page.getByLabel(`Mensaje para ${alias}`, { exact: true }).waitFor({ timeout: 20_000 });
        if (target.id === 'Q04') {
          await page.getByRole('region', { name: `Perfil y contexto de ${alias}`, exact: true }).waitFor({ timeout: 20_000 });
          await page.getByRole('alert').filter({ hasText: 'No se encontró el agente, su ubicación o el backup.' }).waitFor({ timeout: 20_000 });
        }
        await capture(`${target.id}-enlace`);
      });
    }
    evidence.navigation = targets.map(({ id, pathname, query }) => ({ id, pathname, query, enqueued: 0 }));
  }, 240_000);

  it('Q05/Q06: Arrancar y Detener solo preseleccionan la operación y no tocan el runtime', async () => {
    const { tenantId } = active();
    const before = await docker(['inspect', '--format', '{{.State.StartedAt}}', container]);
    for (const [label, kind, id] of [['Arrancar', 'start', 'Q05'], ['Detener', 'stop', 'Q06']] as const) {
      await unchanged(async () => {
        const sheet = await openSheet();
        await sheet.getByRole('button', { name: label, exact: true }).click();
        const panel = sheet.getByRole('region', { name: `Operación de ${tenantId}/${alias}`, exact: true });
        expect(await panel.getByLabel('¿Qué quieres hacer?').inputValue()).toBe(kind);
        expect(await panel.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
        await capture(`${id}-preseleccion`);
      });
    }
    expect(await docker(['inspect', '--format', '{{.State.Running}}', container])).toBe('true');
    expect(await docker(['inspect', '--format', '{{.State.StartedAt}}', container])).toBe(before);
    evidence.power = { selected: ['start', 'stop'], enqueued: 0, containerStillRunning: true, startedAtUnchanged: true };
  }, 180_000);

  it('Q07: Retirar o eliminar guía al retiro real y después a Eliminar definitivamente', async () => {
    const { page, tenantId, computer } = active();
    let sheet = await openSheet();
    const before = await operationCount();
    await sheet.getByRole('button', { name: `Eliminar agente ${tenantId}/${alias}`, exact: true }).click();
    const dialog = page.getByRole('dialog', { name: `Eliminar agente ${tenantId}/${alias}`, exact: true });
    const panel = dialog.getByRole('region', { name: `Operación de ${tenantId}/${alias}`, exact: true });
    await panel.waitFor({ timeout: 20_000 });
    expect(await operationCount()).toBe(before);
    await capture('Q07-retiro-guiado');
    await cancelQueuedMaintenance(panel);
    const preview = panel.getByRole('button', { name: 'Previsualizar operación', exact: true });
    await expect.poll(() => preview.isDisabled(), { timeout: 30_000 }).toBe(false);
    await preview.click();
    const confirm = panel.getByRole('button', { name: 'Confirmar operación', exact: true });
    await expect.poll(() => confirm.isDisabled(), { timeout: 30_000 }).toBe(false);
    const retirementResponse = (page as unknown as AuthPage).waitForResponse(response => response.request().method() === 'POST'
      && new URL(response.url()).pathname === '/v3/console/fleet/operations', { timeout: 30_000 });
    await confirm.click();
    const retirementHttp = await retirementResponse;
    expect(retirementHttp.status()).toBe(202);
    const retirement = await retirementHttp.json() as { operation_id: string; operation: { id: string; kind: string; target: unknown } };
    expect(retirement.operation).toMatchObject({ id: retirement.operation_id, kind: 'retire', target: { resource: 'agent', tenant_id: tenantId, alias } });
    await expect.poll(async () => (await coverageOperations(active(), alias)).find(row => row.id === retirement.operation_id)?.status,
      { timeout: 180_000 }).toBe('succeeded');
    const row = (await computer.pool.query<{ enabled: boolean; retired: boolean }>(
      'SELECT enabled,retired_at IS NOT NULL AS retired FROM agents WHERE tenant_id=$1 AND alias=$2', [tenantId, alias],
    )).rows[0];
    expect(row).toEqual({ enabled: false, retired: true });
    const observed = await retiredRuntime();
    expect(observed).toEqual({ processes: 0, credentials: false });
    sheet = await openSheet();
    await sheet.getByRole('button', { name: `Eliminar agente ${tenantId}/${alias}`, exact: true }).click();
    await dialog.getByRole('region', { name: 'Recursos que se borrarán', exact: true }).waitFor({ timeout: 20_000 });
    expect(await dialog.getByRole('button', { name: 'Confirmar operación', exact: true }).isDisabled()).toBe(true);
    await capture('Q07-eliminar-definitivamente');
    expect(await operationCount()).toBe(before + 1);
    evidence.removal = { draftRedirected: true, retireSucceeded: true, retirementId: retirement.operation_id,
      retiredRow: row, observed, purgeOpened: true, purgeEnqueued: false };
    active().errors.assertClean();
  }, 360_000);
});
