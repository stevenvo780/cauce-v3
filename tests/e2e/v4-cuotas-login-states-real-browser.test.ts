import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserPage, BrowserResponse } from './console-functional-browser.fixtures.js';
import { prepareFake2QuotaImage } from './v4-cuotas-fake2.fixtures.js';
import { readLoginAccountInAgent } from './v4-cuotas-login-agent-reading.js';
import { quotaCanaryPerson, startQuotaDockerHost, type QuotaDockerImage } from './v4-quota-environments-real-browser.fixtures.js';
import { apiGet, asV4Page, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login, openRegistration, type V4Page } from './v4-console-real-browser.helpers.js';

vi.stubEnv('CAUCE_PLAZOS_FACTOR', process.env.CAUCE_PLAZOS_FACTOR ?? '3');
const { newTrustedPage, startConsoleFunctionalFixture } = await import('./console-functional-browser.fixtures.js');
const execute = promisify(execFile);
const task = 'e2e-a7c-login-definitivo-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${task}-login-${run}`;
const owner = quotaCanaryPerson(`${task}-login`, run);
const hostId = `${owner.company.slug}-host`;
const evidence = join(process.cwd(), '.delegados/v4/recibos', task, 'login', `login-${run}`);
const providerPath = `/v3/zz-canary-provider-${run}`;
let quotaReadBroken = false;
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, {
  id: 'owned-quota-read-relation-unavailable', reason: 'a relation is temporarily unavailable in the isolated database after authentication',
  matches: (text, url) => quotaReadBroken && text.includes('status of 500')
    && ['/v3/console/quota-accounts', '/v3/console/quota-environments'].includes(new URL(url).pathname),
}]);
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let runtime: Awaited<ReturnType<typeof startQuotaDockerHost>> | undefined;
let image: QuotaDockerImage | undefined;
let page: V4Page;
let ready = false;
let sequence = 0;
let accountId = '';
let accountLabel = '';
let environmentId = '';
let environmentLabel = '';
let sessionId = '';
let providerVisits = 0;
let pausedContainer: string | undefined;
let diagnosticCookie = '';
const channelRequests = new Map<string, { started: number; route: string; action: string; code: string | null }>();
const channelTrace: { at: string; route: string; action: string; status: number; elapsed_ms: number; code: string | null }[] = [];
const channelFailures: typeof channelTrace = [];
const verificationResponses = new Map<string, { at: string; status: number }>();
const channelActions = new Set(['register', 'exchange', 'claim', 'renew', 'execution', 'resume_authentication', 'finish', 'fail', 'capabilities', 'heartbeat']);
const channelCodes = new Set(['quota_auth_unavailable', 'host_channel_unavailable', 'forbidden', 'conflict', 'unavailable',
  'AUTHORITY_REVOKED', 'HOST_UNAVAILABLE', 'SESSION_EXPIRED', 'FST_ERR_VALIDATION']);

interface InteractivePage extends V4Page {
  mouse: { move(x: number, y: number, options?: { steps: number }): Promise<void>; down(): Promise<void>; up(): Promise<void>; click(x: number, y: number): Promise<void> };
  keyboard: { press(key: string): Promise<void> };
  waitForEvent(event: 'popup', options: { timeout: number }): Promise<BrowserPage>;
}
interface AuthenticationRow { id: string; status: string; error_code: string | null; expires_at: string | null; updated_at: Date }
interface LoginProcess { pid: number; start_ticks: string; role: 'launcher' | 'double' }
interface CdpSession {
  send(method: string, parameters?: Record<string, unknown>): Promise<unknown>;
  on(event: string, callback: (value: unknown) => void): void;
  detach(): Promise<void>;
}
const active = () => { if (!fixture) throw new Error('login state fixture unavailable'); return fixture; };
const host = () => { if (!runtime) throw new Error('login state host unavailable'); return runtime; };
const record = async (name: string, value: unknown) => writeFile(join(evidence, `${name}.json`), `${JSON.stringify(value, null, 2)}\n`);
const loginPanel = () => page.getByRole('region', { name: `Inicio de sesión de ${accountLabel}`, exact: true });

async function capture(name: string, target = page, anchor?: () => Promise<void>) {
  for (const [size, suffix] of [[{ width: 1440, height: 900 }, 'desktop'], [{ width: 390, height: 844 }, 'mobile']] as const) {
    await target.setViewportSize(size);
    await anchor?.();
    await target.screenshot({ path: join(evidence, `${String(sequence)}-${name}-${suffix}.png`), fullPage: false });
    expect(await target.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  }
  await target.setViewportSize({ width: 1440, height: 900 });
}

async function authentication(): Promise<AuthenticationRow> {
  const row = (await active().database.pool.query<AuthenticationRow>(`SELECT id,status,error_code,result->>'expires_at' AS expires_at,updated_at
    FROM quota_environment_operations WHERE environment_id=$1 AND action='authenticate' ORDER BY created_at DESC,id DESC LIMIT 1`, [environmentId])).rows[0];
  if (!row) throw new Error('authentication operation absent');
  return row;
}

async function diagnosticSession() {
  if (!diagnosticCookie) {
    const authenticated = await active().app.inject({ method: 'POST', url: '/v3/auth/login',
      headers: { origin: active().baseUrl }, payload: { email: owner.email, password: owner.password } });
    expect(authenticated.statusCode).toBe(200);
    const setCookie = authenticated.headers['set-cookie'];
    const cookie = (Array.isArray(setCookie) ? setCookie : [setCookie]).filter((value): value is string => typeof value === 'string')
      .map(value => value.split(';', 1)[0]).join('; ');
    if (!cookie) throw new Error('independent diagnostic authentication absent');
    diagnosticCookie = cookie;
  }
  const response = await active().app.inject({ method: 'GET', url: `/v3/console/provider-auth/sessions/${sessionId}`,
    headers: { cookie: diagnosticCookie } });
  return { status: response.statusCode, body: response.json<Record<string, unknown>>() };
}

async function processes(target = environmentId): Promise<LoginProcess[]> {
  const observed = await host().inspect(target);
  expect(observed.present).toBe(true);
  const program = `import json,pathlib
found=[]
for entry in pathlib.Path('/proc').iterdir():
    if not entry.name.isdigit(): continue
    try:
        args=(entry/'cmdline').read_bytes().split(b'\\0')
        role='launcher' if args[:2]==[b'/usr/local/bin/claude',b'login'] else 'double' if args[:3]==[b'/usr/bin/python3',b'/usr/local/lib/cauce-fake2.py',b'login'] else None
        if role:
            ticks=(entry/'stat').read_text().rsplit(')',1)[1].split()[19]
            found.append({'pid':int(entry.name),'start_ticks':ticks,'role':role})
    except (FileNotFoundError,ProcessLookupError,PermissionError): pass
print(json.dumps(sorted(found,key=lambda item:item['role'])))`;
  const response = await execute('docker', ['exec', '--user', '1000:1000', observed.container_name, '/usr/bin/python3', '-I', '-B', '-c', program], { timeout: 15_000 });
  return JSON.parse(response.stdout) as LoginProcess[];
}

async function post(path: string) {
  return page.evaluate(async target => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token: string };
    const response = await fetch(target, { method: 'POST', credentials: 'include', headers: {
      'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token }, body: '{}' });
    return { status: response.status, body: await response.json() as Record<string, unknown> };
  }, path);
}

async function startLogin(trigger?: () => Promise<void>, observe?: () => Promise<void>) {
  let resolve: (() => void) | undefined;
  const attached = new Promise<void>(done => { resolve = done; });
  page.on('websocket', socket => {
    const match = /\/provider-auth\/sessions\/([a-f0-9-]{36})\/stream$/u.exec(new URL(socket.url()).pathname);
    if (!match?.[1]) return;
    sessionId = match[1];
    let output = false; let confirmed = false;
    (socket as unknown as { on(event: 'framereceived', callback: (frame: { payload: string | Buffer }) => void): void }).on('framereceived', ({ payload }) => {
      if (Buffer.isBuffer(payload)) output ||= payload.length > 0;
      else confirmed ||= payload === '{"type":"ready"}';
      if (output && confirmed) resolve?.();
    });
  });
  await (trigger ? trigger() : loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).click());
  await observe?.();
  await Promise.race([attached, new Promise<never>((_done, reject) => { const timer = setTimeout(() => { reject(new Error('login terminal did not attach')); }, 30_000); timer.unref(); })]);
  await expect.poll(async () => (await processes()).map(item => item.role), { timeout: 15_000 }).toEqual(['double', 'launcher']);
  const current = await apiGet(page, `/v3/console/provider-auth/sessions/${sessionId}`);
  expect(current).toMatchObject({ status: 200, body: { status: 'awaiting_login', cleanup_pending: false } });
  const operation = await authentication();
  await record(`${String(sequence)}-started`, { operation, session: current.body, processes: await processes() });
  return operation;
}

async function cancelLogin() {
  await page.getByRole('dialog').getByRole('button', { name: 'Cancelar conexión', exact: true }).click();
  await page.getByRole('dialog').getByText('Conexión cancelada', { exact: true }).waitFor({ timeout: 30_000 });
  expect((await host().waitOperation(environmentId, 'authenticate', { status: 'failed' })).error_code).toBe('AUTH_CANCELLED');
  await expect.poll(processes, { timeout: 15_000 }).toEqual([]);
  await record(`${String(sequence)}-cancelled`, { operation: await authentication(), processes: await processes() });
}

async function approveLogin(identity: string) {
  const terminal = page.getByRole('dialog').getByLabel('Terminal privada de autenticación', { exact: true });
  const textarea = terminal.locator('textarea') as unknown as { pressSequentially(text: string): Promise<void>; press(key: string): Promise<void> };
  await textarea.pressSequentially('APROBAR'); await textarea.press('Enter');
  await terminal.getByText('fake2: sesion autorizada', { exact: true }).waitFor({ timeout: 15_000 });
  const observed = await host().inspect(environmentId);
  await expect.poll(async () => {
    try {
      await execute('docker', ['exec', '--user', '1000:1000', observed.container_name, 'test', '-s', '/home/node/.fake2-session'], { timeout: 10_000 });
      return true;
    } catch { return false; }
  }, { timeout: 15_000 }).toBe(true);
  await execute('docker', ['exec', '--user', '1000:1000', observed.container_name, '/usr/bin/python3', '-I', '-B', '-c',
    'import pathlib,sys;pathlib.Path("/home/node/.fake2-session").write_text(sys.argv[1])', identity], { timeout: 15_000 });
}

beforeAll(async () => {
  await mkdir(evidence, { recursive: true });
  fixture = await startConsoleFunctionalFixture({ browserLifetimeSeconds: 1800, sessionTtlMs: 1_800_000, configureGateway: app => {
    app.addHook('preHandler', async request => {
      const route = request.routeOptions.url;
      if (typeof route !== 'string' || !route.startsWith('/v3/fleet/hosts/:host_id/')) return;
      const action: unknown = (request.body as { payload?: { action?: unknown } } | undefined)?.payload?.action;
      channelRequests.set(request.id, { started: Date.now(), route,
        action: typeof action === 'string' && channelActions.has(action) ? action : 'other', code: null });
    });
    app.addHook('onSend', async (request, reply, payload) => {
      const trace = channelRequests.get(request.id);
      if (trace && reply.statusCode >= 400 && typeof payload === 'string' && payload.length <= 1024) {
        try {
          const code: unknown = (JSON.parse(payload) as { error?: unknown }).error;
          if (typeof code === 'string' && channelCodes.has(code)) trace.code = code;
        } catch { /* Only known public error codes enter the diagnostic trace. */ }
      }
      return payload;
    });
    app.addHook('onResponse', async (request, reply) => {
      if (request.method === 'POST' && request.routeOptions.url === '/v3/console/provider-auth/sessions/:id/verify') {
        const id: unknown = (request.params as { id?: unknown }).id;
        if (typeof id === 'string') verificationResponses.set(id, { at: new Date().toISOString(), status: reply.statusCode });
        if (verificationResponses.size > 64) { const first = verificationResponses.keys().next().value; if (first) verificationResponses.delete(first); }
      }
      const trace = channelRequests.get(request.id);
      if (!trace) return;
      channelRequests.delete(request.id);
      const event = { at: new Date().toISOString(), route: trace.route, action: trace.action,
        status: reply.statusCode, elapsed_ms: Date.now() - trace.started, code: trace.code };
      if (trace.route.endsWith('/quota-auth')) { channelTrace.push(event); if (channelTrace.length > 512) channelTrace.shift(); }
      if (reply.statusCode >= 400) { channelFailures.push(event); if (channelFailures.length > 64) channelFailures.shift(); }
    });
    app.get(providerPath, async (_request, reply) => {
      providerVisits += 1;
      await record('provider-visits', { count: providerVisits, path: providerPath });
      return reply.type('text/html').send('<!doctype html><html lang="es"><title>Proveedor fake2 local</title><h1>Proveedor fake2 local</h1><label>Texto copiado<textarea aria-label="Texto copiado"></textarea></label></html>');
    });
  } });
  image = await prepareFake2QuotaImage(evidence, prefix, task, `${fixture.baseUrl}${providerPath}`);
  await record('image', { image: image.image, tag: image.tag });
  await record('sources', { sha: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(), sources: Object.fromEntries(await Promise.all([
    'tests/e2e/v4-cuotas-login-states-real-browser.test.ts', 'tests/e2e/v4-cuotas-fake2.fixtures.ts',
    'tests/e2e/v4-cuotas-login-agent-reading.ts', 'console/src/features/accounts/AgentQuotaDetail.tsx',
    'console/src/features/accounts/AccountAuthenticationNotice.tsx',
    'services/gateway/src/fleet/quota-auth-broker.ts', 'services/gateway/src/fleet/provider-login.ts',
    'services/gateway/src/fleet/quota-auth-host.ts', 'services/gateway/src/fleet/quota-auth-contracts.ts',
    'services/gateway/src/console/provider-auth.sessions.ts', 'console/src/features/accounts/AccountLogin.tsx',
    'console/src/features/accounts/MyQuotasPage.tsx', 'tests/e2e/browser-owned-lifecycle.ts',
    'tests/e2e/console-functional-browser.fixtures.ts', 'ops/cli/quota_runtime.py',
  ].map(async path => [path, sha(await readFile(path))] as const))), console_session_ttl_ms: 1_800_000, browser_lifetime_seconds: 1800 });
  page = asV4Page(await newTrustedPage(fixture, { width: 1440, height: 900 })); ready = true;
  errors.watch(page, 'login-states');
  const registration = await openRegistration(page, fixture.baseUrl);
  await fillRegistration(registration, owner);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  runtime = await startQuotaDockerHost(fixture, owner, hostId, image, evidence);
}, 600_000);

beforeEach(async () => {
  sequence += 1; sessionId = '';
  accountLabel = `${prefix}-account-${String(sequence)}`;
  environmentLabel = `${prefix}-environment-${String(sequence)}`;
  await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
  await expect.poll(async () => page.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
  await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
  const accountForm = page.getByRole('form', { name: 'Registrar cuenta de cuotas', exact: true });
  await accountForm.getByLabel('Nombre de la cuenta', { exact: true }).fill(accountLabel);
  await accountForm.locator('select').selectOption('claude');
  await accountForm.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
  await page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }).waitFor({ timeout: 20_000 });
  const accounts = await apiGet(page, '/v3/console/quota-accounts');
  const account = (accounts.body as unknown as { accounts: { id: string; label: string }[] }).accounts.find(item => item.label === accountLabel);
  if (!account) throw new Error('login account absent');
  accountId = account.id;
  const form = page.getByRole('form', { name: 'Crear entorno de cuotas', exact: true });
  await form.locator('select').nth(0).selectOption(accountId);
  await form.locator('select').nth(1).selectOption(hostId);
  await form.getByLabel('Nombre del entorno', { exact: true }).fill(environmentLabel);
  await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
  await page.getByRole('article', { name: `Entorno ${environmentLabel}`, exact: true }).waitFor({ timeout: 20_000 });
  const snapshot = await apiGet(page, '/v3/console/quota-environments');
  const environment = (snapshot.body as unknown as { environments: { id: string; label: string }[] }).environments.find(item => item.label === environmentLabel);
  if (!environment) throw new Error('login environment absent');
  environmentId = environment.id;
  await host().waitOperation(environmentId, 'create');
  await page.reload({ waitUntil: 'domcontentloaded' });
});

afterEach(async ({ task: current }) => {
  if (pausedContainer) { await execute('docker', ['unpause', pausedContainer], { timeout: 15_000 }); pausedContainer = undefined; }
  await record(`${String(sequence)}-channel-trace`, { recent: channelTrace, failures: channelFailures,
    pending: [...channelRequests.values()].map(value => ({ route: value.route, action: value.action,
      started: new Date(value.started).toISOString(), elapsed_ms: Date.now() - value.started })) });
  if (current.result?.state !== 'fail' || !ready) return;
  await capture(`failed-${current.id}`).catch(() => undefined);
  await record(`failed-${current.id}`, { body: await page.locator('body').innerText().catch(() => null), errors: errors.trace,
    test_errors: current.result.errors?.map(error => ({ message: error.message, stack: error.stack })),
    operation: await authentication().catch(() => null),
    session: sessionId ? await apiGet(page, `/v3/console/provider-auth/sessions/${sessionId}`).catch(() => null) : null,
    independent_session: sessionId ? await diagnosticSession().catch(() => null) : null,
    processes: await processes().catch(() => null), audit: (await active().database.pool.query(
      "SELECT decision,metadata FROM audit_events WHERE company_id=$1 AND action='quota_environment.authentication' ORDER BY id", [owner.company.slug])).rows });
});

afterAll(async () => {
  if (pausedContainer) await execute('docker', ['unpause', pausedContainer], { timeout: 15_000 });
  try { await runtime?.close(); }
  finally {
    try { await fixture?.close(); }
    finally {
      try {
        if (image) {
          await execute('docker', ['image', 'rm', image.tag], { timeout: 30_000 });
          expect((await execute('docker', ['image', 'ls', '--filter', `reference=${image.tag}`, '--format', '{{.ID}}'], { timeout: 15_000 })).stdout.trim()).toBe('');
          await record('image-cleanup', { image_tag_removed_verified: true, tag: image.tag, image: image.image });
        }
      } finally { vi.unstubAllEnvs(); }
    }
  }
}, 180_000);

describe('estados reales del login de cuotas y su terminal privada', () => {
  it('observa las cargas reales, rechaza otra apertura del mismo perfil y la reintenta después de confirmar la parada', async () => {
    const originalId = environmentId;
    const originalLabel = environmentLabel;
    const alternativeLabel = `${environmentLabel}-second`;
    const form = page.getByRole('form', { name: 'Crear entorno de cuotas', exact: true });
    await form.locator('select').nth(0).selectOption(accountId);
    await form.locator('select').nth(1).selectOption(hostId);
    await form.getByLabel('Nombre del entorno', { exact: true }).fill(alternativeLabel);
    await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
    await page.getByRole('article', { name: `Entorno ${alternativeLabel}`, exact: true }).waitFor({ timeout: 20_000 });
    const snapshot = await apiGet(page, '/v3/console/quota-environments');
    const alternative = (snapshot.body as unknown as { environments: { id: string; label: string }[] }).environments.find(item => item.label === alternativeLabel);
    if (!alternative) throw new Error('second login environment absent');
    await host().waitOperation(alternative.id, 'create');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).selectOption(originalId);
    const originalPage = page;
    const cdp = await (page.context() as unknown as { newCDPSession(target: V4Page): Promise<CdpSession> }).newCDPSession(page);
    try {
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 500, downloadThroughput: 256_000, uploadThroughput: 256_000 });
      await startLogin(undefined, async () => {
        await page.getByRole('dialog').getByText('Pidiendo el inicio de sesión…', { exact: true }).waitFor({ timeout: 30_000 });
        await capture('requesting-login');
        await page.getByRole('dialog').getByText('Cargando terminal de autenticación…', { exact: true }).waitFor({ timeout: 45_000 });
        await capture('loading-real-terminal-module');
        await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      });
    } finally {
      await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
      await cdp.detach();
    }
    page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
    errors.watch(page, 'login-conflicting-context');
    await login(page, active().baseUrl, owner);
    await page.goto(`${active().baseUrl}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await loginPanel().getByLabel('Entorno u ordenador', { exact: true }).selectOption(alternative.id);
    environmentId = alternative.id; environmentLabel = alternativeLabel;
    errors.expectHttpError('/v3/console/provider-auth/sessions', 409);
    await loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Reintentar', exact: true }).waitFor({ timeout: 30_000 });
    expect(await processes()).toEqual([]);
    expect((await processes(originalId)).map(item => item.role)).toEqual(['double', 'launcher']);
    const before = await authentication();
    expect(before.status).toBe('awaiting_auth');
    await capture('opening-conflict');
    await record('opening-conflict', { operation: before, current_processes: await processes(), original_processes: await processes(originalId) });
    const alternativePage = page;
    page = originalPage; environmentId = originalId; environmentLabel = originalLabel;
    await (page as unknown as { bringToFront(): Promise<void> }).bringToFront();
    await cancelLogin();
    page = alternativePage; environmentId = alternative.id; environmentLabel = alternativeLabel;
    await (page as unknown as { bringToFront(): Promise<void> }).bringToFront();
    const recovered = await startLogin(() => page.getByRole('dialog').getByRole('button', { name: 'Reintentar', exact: true }).click());
    expect(recovered.id).toBe(before.id);
    await capture('opening-retried');
    await cancelLogin();
    errors.assertClean();
  }, 180_000);

  it('abre el enlace real del proveedor, selecciona y copia texto del terminal y confirma la parada de ambos procesos al cancelar', async () => {
    await startLogin();
    await (page.context() as unknown as { grantPermissions(permissions: string[], options: { origin: string }): Promise<void> })
      .grantPermissions(['clipboard-read', 'clipboard-write'], { origin: active().baseUrl });
    const interactive = page as InteractivePage;
    const line = page.locator('.provider-auth-terminal .xterm-rows > div').first();
    const bounds = await line.boundingBox();
    const cell = await page.locator('.provider-auth-terminal .xterm-char-measure-element').first().evaluate(element => ({
      width: element.getBoundingClientRect().width / Math.max(1, element.textContent.length),
    }));
    if (!bounds || cell.width <= 0) throw new Error('terminal text geometry absent');
    await interactive.mouse.move(bounds.x, bounds.y + bounds.height / 2);
    await interactive.mouse.down();
    await interactive.mouse.move(bounds.x + cell.width * 5, bounds.y + bounds.height / 2, { steps: 8 });
    await interactive.mouse.up();
    await expect.poll(async () => page.locator('.provider-auth-terminal .xterm-selection > div').count(), { timeout: 10_000 }).toBeGreaterThan(0);
    await interactive.keyboard.press('Control+Insert');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe('fake2');
    await capture('selected-text');
    const position = await page.evaluate(() => {
      const rows = Array.from(document.querySelectorAll('.provider-auth-terminal .xterm-rows > div'));
      const measure = document.querySelector('.provider-auth-terminal .xterm-char-measure-element')?.getBoundingClientRect();
      const measureText = document.querySelector('.provider-auth-terminal .xterm-char-measure-element')?.textContent ?? '';
      for (const row of rows) {
        const index = row.textContent.indexOf('https://');
        if (index >= 0 && measure) { const box = row.getBoundingClientRect(); return { x: box.x + (index + 2) * measure.width / Math.max(1, measureText.length), y: box.y + box.height / 2 }; }
      }
      return null;
    });
    if (!position) throw new Error('provider URL not painted in terminal');
    const popupWait = interactive.waitForEvent('popup', { timeout: 15_000 });
    await interactive.mouse.click(position.x, position.y);
    const popup = asV4Page(await popupWait);
    await popup.getByRole('heading', { name: 'Proveedor fake2 local', exact: true }).waitFor({ timeout: 20_000 });
    expect(popup.url()).toBe(`${active().baseUrl}${providerPath}`);
    expect(await popup.evaluate(() => window.opener === null)).toBe(true);
    expect(providerVisits).toBe(1);
    await popup.getByLabel('Texto copiado', { exact: true }).press('Control+v');
    expect(await popup.getByLabel('Texto copiado', { exact: true }).inputValue()).toBe('fake2');
    await capture('provider-link-opened', popup);
    await record('link-and-clipboard', { path: providerPath, visits: providerVisits, copied: 'fake2', copy_shortcut: 'Control+Insert', opener_null: true });
    await (page as unknown as { bringToFront(): Promise<void> }).bringToFront();
    await cancelLogin();
    await capture('cancelled-processes-gone');
    errors.assertClean();
  }, 120_000);

  it('muestra limpieza pendiente ante una parada físicamente imposible y sólo libera el perfil tras confirmarla realmente', async () => {
    await startLogin();
    const observed = await host().inspect(environmentId);
    pausedContainer = observed.container_name;
    await record('cleanup-before-pause', { observation: observed, processes: await processes() });
    await execute('docker', ['pause', pausedContainer], { timeout: 15_000 });
    try {
      await page.getByRole('dialog').getByRole('button', { name: 'Cancelar conexión', exact: true }).click();
      await page.getByRole('dialog').getByText(/El perfil sigue reservado/u).waitFor({ timeout: 40_000 });
      const pending = await apiGet(page, `/v3/console/provider-auth/sessions/${sessionId}`);
      expect(pending).toMatchObject({ status: 200, body: { status: 'failed', cleanup_pending: true, error: 'STOP_UNCONFIRMED' } });
      expect((await authentication()).status).toBe('awaiting_auth');
      const paused = (await execute('docker', ['inspect', '--format', '{{.State.Paused}}', pausedContainer], { timeout: 15_000 })).stdout.trim();
      expect(paused).toBe('true');
      await capture('cleanup-pending');
      await record('cleanup-pending', { session: pending.body, operation: await authentication(), paused });
    } finally { await execute('docker', ['unpause', pausedContainer], { timeout: 15_000 }); pausedContainer = undefined; }
    const recovered = await post(`/v3/console/provider-auth/sessions/${sessionId}/cancel`);
    await record('cleanup-retry', recovered);
    expect(recovered).toMatchObject({ status: 200, body: { status: 'cancelled', cleanup_pending: false } });
    await expect.poll(processes, { timeout: 15_000 }).toEqual([]);
    expect((await host().waitOperation(environmentId, 'authenticate', { status: 'failed' })).error_code).toBe('AUTH_CANCELLED');
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await startLogin();
    await cancelLogin();
    await capture('cleanup-recovered');
    errors.assertClean();
  }, 150_000);

  it('bloquea iniciar sesión durante otra operación real en cola y recupera la acción al terminarla', async () => {
    const previous = (await active().database.pool.query('SELECT id FROM quota_environment_operations WHERE environment_id=$1 AND action=\'authenticate\'', [environmentId])).rowCount;
    host().pause();
    try {
      await page.getByRole('article', { name: `Entorno ${environmentLabel}`, exact: true }).getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
      await page.reload({ waitUntil: 'domcontentloaded' });
      await loginPanel().getByText('El entorno de esta cuenta tiene otra operación en curso. Espera a que termine.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled()).toBe(true);
      const pending = (await active().database.pool.query("SELECT action,status FROM quota_environment_operations WHERE environment_id=$1 ORDER BY created_at DESC LIMIT 1", [environmentId])).rows;
      expect(pending).toEqual([{ action: 'query', status: 'pending' }]);
      expect((await active().database.pool.query('SELECT id FROM quota_environment_operations WHERE environment_id=$1 AND action=\'authenticate\'', [environmentId])).rowCount).toBe(previous);
      await capture('login-blocked-by-query');
      await record('login-blocked-by-query', { pending, authentication_count: previous });
    } finally { host().resume(); }
    await host().waitOperation(environmentId, 'query');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(async () => loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
    await startLogin();
    await cancelLogin();
    errors.assertClean();
  }, 120_000);

  it('conserva una autenticación verificada al fallar la relectura y rechaza después la identidad distinta del proveedor local', async () => {
    await startLogin();
    await approveLogin(`fake2-${run}-${String(sequence)}-accepted`);
    const relation = `zz_canary_quota_window_state_${run}`;
    const cdp = await (page.context() as unknown as { newCDPSession(target: V4Page): Promise<CdpSession> }).newCDPSession(page);
    let relationRenamed = false; let requestSent = false; let rendererPaused = false;
    let pauseRequested = false;
    cdp.on('Network.requestWillBeSent', value => {
      const request = (value as { request?: { method?: unknown; url?: unknown } }).request;
      if (request?.method === 'POST' && typeof request.url === 'string'
          && new URL(request.url).pathname === `/v3/console/provider-auth/sessions/${sessionId}/verify`) requestSent = true;
    });
    cdp.on('Debugger.paused', () => { rendererPaused = true; });
    const resume = async () => { if (pauseRequested) { await cdp.send('Debugger.resume'); pauseRequested = false; } };
    try {
      await cdp.send('Network.enable');
      await cdp.send('Debugger.enable');
      const response = (page as unknown as { waitForResponse(predicate: (value: BrowserResponse) => boolean,
        options: { timeout: number }): Promise<BrowserResponse> }).waitForResponse(value => value.request().method() === 'POST'
          && new URL(value.url()).pathname === `/v3/console/provider-auth/sessions/${sessionId}/verify`, { timeout: 45_000 });
      void response.catch(() => undefined);
      const clicking = page.getByRole('dialog').getByRole('button', { name: 'Verificar conexión', exact: true }).click();
      void clicking.catch(() => undefined);
      await expect.poll(() => requestSent, { timeout: 15_000 }).toBe(true);
      pauseRequested = true;
      await cdp.send('Debugger.pause');
      await expect.poll(() => rendererPaused, { timeout: 15_000 }).toBe(true);
      const pausedOperation = await authentication();
      expect(['running', 'awaiting_auth']).toContain(pausedOperation.status);
      await record('browser-paused-before-verify-result', { at: new Date().toISOString(), operation: pausedOperation });
      await expect.poll(() => verificationResponses.get(sessionId)?.status, { timeout: 45_000 }).toBe(200);
      const verifiedSession = await diagnosticSession();
      expect(verifiedSession).toMatchObject({ status: 200, body: { status: 'authenticated', cleanup_pending: false } });
      const operation = await host().waitOperation(environmentId, 'authenticate');
      expect(operation.result.authenticated_verified).toBe(true);
      const account = (await active().database.pool.query('SELECT enabled,quota_identity_hash IS NOT NULL AS verified FROM provider_accounts WHERE id=$1', [accountId])).rows;
      expect(account).toEqual([{ enabled: true, verified: true }]);
      await expect.poll(processes, { timeout: 15_000 }).toEqual([]);
      await record('verified-before-read-fault', { at: new Date().toISOString(), verify_response: verificationResponses.get(sessionId),
        session: verifiedSession, operation, account, processes: await processes(), renderer_paused: rendererPaused });
      const refresh = await active().app.inject({ method: 'GET', url: '/v3/console/quota-accounts',
        headers: { cookie: diagnosticCookie } });
      expect(refresh.statusCode).toBe(200);
      const automaticQuery = await host().waitOperation(environmentId, 'query', { afterId: operation.id });
      const windows = (await active().database.pool.query<{ remaining_percent: string; captured_at: Date; received_at: Date }>(
        'SELECT remaining_percent::text,captured_at,received_at FROM quota_window_state WHERE account_id=$1 ORDER BY window_minutes', [accountId])).rows;
      expect(windows.map(window => Number(window.remaining_percent))).toEqual([72, 91]);
      for (const window of windows) expect(Date.now() - window.captured_at.getTime()).toBeLessThan(60_000);
      const queryTimes = (await active().database.pool.query<{ created_at: Date; updated_at: Date }>(
        'SELECT created_at,updated_at FROM quota_environment_operations WHERE id=$1', [automaticQuery.id])).rows[0];
      const pending = (await active().database.pool.query(`SELECT id,environment_id,action,status FROM quota_environment_operations
        WHERE company_id=$1 AND status IN ('pending','running','awaiting_auth')`, [owner.company.slug])).rows;
      expect(pending).toEqual([]);
      await record('automatic-query-before-read-fault', { at: new Date().toISOString(), refresh_status: refresh.statusCode,
        operation: automaticQuery, operation_times: queryTimes, windows, pending });
      quotaReadBroken = true;
      await active().database.pool.query(`ALTER TABLE quota_window_state RENAME TO ${relation}`);
      relationRenamed = true;
      await record('read-fault-started', { at: new Date().toISOString(), operation: operation.id });
      await resume();
      await clicking;
      expect((await response).status()).toBe(200);
      await page.getByText('La sesión quedó verificada, pero no se pudo releer la cuenta. Pulsa «Actualizar cuotas y entornos».', { exact: true }).waitFor({ timeout: 40_000 });
      await capture('authenticated-read-failed', page, async () => {
        const card = page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true });
        await (card as unknown as { scrollIntoViewIfNeeded(): Promise<void> }).scrollIntoViewIfNeeded();
      });
      await record('authenticated-read-failed', { operation: await authentication(), account, processes: await processes() });
    } finally {
      try { if (relationRenamed) await active().database.pool.query(`ALTER TABLE ${relation} RENAME TO quota_window_state`); }
      finally {
        quotaReadBroken = false;
        try { await resume(); }
        finally { await cdp.detach(); }
      }
    }
    await page.getByRole('button', { name: 'Actualizar cuotas y entornos', exact: true }).click();
    await expect.poll(async () => page.getByText('La sesión quedó verificada, pero no se pudo releer la cuenta. Pulsa «Actualizar cuotas y entornos».', { exact: true }).count(), { timeout: 20_000 }).toBe(0);
    const before = (await active().database.pool.query<{ quota_identity_hash: string; enabled: boolean }>('SELECT quota_identity_hash,enabled FROM provider_accounts WHERE id=$1', [accountId])).rows[0];
    expect(before?.enabled).toBe(true);
    await capture('authenticated-read-recovered', page, async () => {
      const card = page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true });
      await (card as unknown as { scrollIntoViewIfNeeded(): Promise<void> }).scrollIntoViewIfNeeded();
      await card.getByText('Sesión iniciada y verificada.', { exact: true }).waitFor({ timeout: 20_000 });
      for (const [name, remaining] of [['5 h', '72'], ['Semanal', '91']] as const) {
        const meter = card.getByRole('meter', { name: `Restante ${name}`, exact: true });
        await meter.waitFor({ timeout: 20_000 });
        expect(await meter.evaluate(element => element.getAttribute('value'))).toBe(remaining);
        expect(await meter.evaluate(element => element.classList.contains('opacity-50'))).toBe(false);
      }
    });
    await readLoginAccountInAgent({ page, baseUrl: active().baseUrl, pool: active().database.pool, accountId, accountLabel,
      evidenceDirectory: join(evidence, 'agent-reading-verified'), stage: 'verified',
      operationId: (await authentication()).id, expectedRemaining: [72, 91] });
    await host().waitOperation(environmentId, 'query');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await expect.poll(async () => loginPanel().getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
    await startLogin();
    await approveLogin(`fake2-${run}-${String(sequence)}-different`);
    await page.getByRole('dialog').getByRole('button', { name: 'Verificar conexión', exact: true }).click();
    await page.getByRole('dialog').getByText('La cuenta aún no pasó una llamada funcional.', { exact: true }).waitFor({ timeout: 40_000 });
    const rejected = await host().waitOperation(environmentId, 'authenticate', { status: 'failed' });
    expect(rejected.error_code).toBe('STEP_FAILED');
    expect((await active().database.pool.query('SELECT quota_identity_hash,enabled FROM provider_accounts WHERE id=$1', [accountId])).rows).toEqual([before]);
    await expect.poll(processes, { timeout: 15_000 }).toEqual([]);
    await capture('different-provider-identity-rejected');
    await record('different-provider-identity-rejected', { operation: rejected.id, account_preserved: true, processes: await processes() });
    errors.assertClean();
  }, 180_000);

  it('rechaza la verificación de un contenedor con límites alterados y recupera el login al restaurar su forma aprobada', async () => {
    await startLogin();
    await approveLogin(`fake2-${run}-${String(sequence)}-runtime`);
    const observed = await host().inspect(environmentId);
    if (observed.pids_limit === undefined) throw new Error('owned container process limit absent');
    const changed = observed.pids_limit + 1;
    await execute('docker', ['update', '--pids-limit', String(changed), observed.container_name], { timeout: 15_000 });
    try {
      await page.getByRole('dialog').getByRole('button', { name: 'Verificar conexión', exact: true }).click();
      await page.getByRole('dialog').getByText('La cuenta aún no pasó una llamada funcional.', { exact: true }).waitFor({ timeout: 40_000 });
      const rejected = await host().waitOperation(environmentId, 'authenticate', { status: 'failed' });
      expect(rejected.error_code).toBe('STEP_FAILED');
      expect((await active().database.pool.query('SELECT enabled,quota_identity_hash IS NOT NULL AS verified FROM provider_accounts WHERE id=$1', [accountId])).rows)
        .toEqual([{ enabled: false, verified: false }]);
      await record('runtime-limit-rejected', { operation: rejected.id, approved: observed.pids_limit,
        observed: (await execute('docker', ['inspect', '--format', '{{.HostConfig.PidsLimit}}', observed.container_name], { timeout: 15_000 })).stdout.trim() });
      await capture('runtime-limit-rejected');
    } finally { await execute('docker', ['update', '--pids-limit', String(observed.pids_limit), observed.container_name], { timeout: 15_000 }); }
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await startLogin();
    await approveLogin(`fake2-${run}-${String(sequence)}-runtime`);
    await page.getByRole('dialog').getByRole('button', { name: 'Verificar conexión', exact: true }).click();
    await page.getByText('Sesión iniciada y verificada.', { exact: true }).waitFor({ timeout: 40_000 });
    expect((await host().waitOperation(environmentId, 'authenticate')).result.authenticated_verified).toBe(true);
    await expect.poll(processes, { timeout: 15_000 }).toEqual([]);
    await capture('runtime-limit-restored');
    errors.assertClean();
  }, 180_000);

  it('espera diez minutos reales, muestra la caducidad canónica y vuelve a autenticar después de acreditar la parada', async () => {
    const started = process.hrtime.bigint();
    const wallStarted = Date.now();
    const operation = await startLogin();
    if (!operation.expires_at) throw new Error('provider authentication deadline absent');
    const deadline = Date.parse(operation.expires_at);
    expect(deadline - operation.updated_at.getTime()).toBeGreaterThan(590_000);
    expect(deadline - operation.updated_at.getTime()).toBeLessThanOrEqual(600_000);
    const independentBefore = await diagnosticSession();
    expect(independentBefore).toMatchObject({ status: 200, body: { status: 'awaiting_login', cleanup_pending: false } });
    await record('expiry-before', { session: independentBefore, operation, processes: await processes() });
    await capture('awaiting-real-expiry');
    let nextLog = 30_000;
    while (Date.now() <= deadline + 1000) {
      await new Promise<void>(done => { setTimeout(done, 1000); });
      const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
      if (elapsed >= nextLog) { process.stdout.write(`E2E real provider expiry wait: elapsed_ms=${String(Math.floor(elapsed))}; ttl_seconds=600\n`); nextLog += 30_000; }
    }
    const elapsed = Number(process.hrtime.bigint() - started) / 1_000_000;
    await record('expiry-elapsed', { operation: operation.id, wall_started: new Date(wallStarted).toISOString(), expires_at: operation.expires_at,
      wall_elapsed_ms: Date.now() - wallStarted, monotonic_elapsed_ms: elapsed, provider_ttl_seconds: 600 });
    expect(elapsed).toBeGreaterThanOrEqual(600_000);
    await record('expiry-causal', { independent_session: await diagnosticSession(), operation: await authentication(),
      processes: await processes(), browser_body: await page.locator('body').innerText().catch(() => null),
      audit: (await active().database.pool.query("SELECT decision,metadata FROM audit_events WHERE company_id=$1 AND action='quota_environment.authentication' ORDER BY id", [owner.company.slug])).rows });
    let expired = await apiGet(page, `/v3/console/provider-auth/sessions/${sessionId}`);
    if (expired.status === 200 && expired.body.status !== 'expired') {
      await expect.poll(async () => {
        expired = await apiGet(page, `/v3/console/provider-auth/sessions/${sessionId}`);
        return { status: expired.status, snapshot: expired.body.status, pending: expired.body.cleanup_pending };
      }, { timeout: 30_000 }).toEqual({ status: 200, snapshot: 'expired', pending: false });
    }
    await record('expiry-session', expired);
    expect(expired).toMatchObject({ status: 200, body: { status: 'expired', error: 'SESSION_EXPIRED', cleanup_pending: false } });
    await page.getByRole('dialog').getByText('La conexión caducó. Relee la operación antes de continuar.', { exact: true }).waitFor({ timeout: 30_000 });
    await expect.poll(processes, { timeout: 20_000 }).toEqual([]);
    const snapshot = await apiGet(page, '/v3/console/quota-environments');
    expect(snapshot.status).toBe(200);
    expect(await authentication()).toMatchObject({ status: 'failed', error_code: 'AUTH_EXPIRED' });
    expect((await active().database.pool.query('SELECT enabled,quota_identity_hash IS NOT NULL AS verified FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ enabled: false, verified: false }]);
    await capture('expired-processes-gone');
    await record('expired-durable', { session: expired.body, operation: await authentication(), processes: await processes() });
    await page.getByRole('dialog').getByRole('button', { name: 'Cerrar', exact: true }).click();
    await readLoginAccountInAgent({ page, baseUrl: active().baseUrl, pool: active().database.pool, accountId, accountLabel,
      evidenceDirectory: join(evidence, 'agent-reading-expired'), stage: 'expired', operationId: operation.id,
      expiresAt: operation.expires_at });
    await page.reload({ waitUntil: 'domcontentloaded' });
    const retried = await startLogin();
    expect(retried.id).not.toBe(operation.id);
    await cancelLogin();
    await capture('expired-retried');
    errors.assertClean();
  }, 780_000);
});
