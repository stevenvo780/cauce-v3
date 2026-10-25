import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { canonicalJson, sha256Hex } from '../../packages/protocol/src/canonical.js';
import { docker, FIXTURE_PROVIDER_IDENTITY, hostEnrollments, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { inviteSetupHost } from '../../services/gateway/src/fleet/host-setup.fixtures.js';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type V4Locator, type V4Page } from './v4-console-real-browser.helpers.js';

const execute = promisify(execFile);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
const owner = 'e2e-a2-cobertura-w-1025';
const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-${owner}-${run}`;
const alias = `${prefix}-x`;
const runtime = `x-${run}`;
const container = `${prefix}-${runtime}`;
const markerPath = `/home/cauce/.cauce/${runtime}/preserved-marker`;
const network = `${prefix}-base`;
const extraNetwork = `${prefix}-extra`;
const receiptDirectory = join(process.cwd(), '.delegados/v4/recibos', owner, 'x', run);
const person = { ...syntheticPerson('extensions', run), name: prefix, email: `${prefix}@example.test`,
  company: { name: prefix, slug: prefix } };
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE, {
  id: 'offline-send', reason: 'Chromium is deliberately offline for the idempotent resend',
  matches: text => text.includes('net::ERR_INTERNET_DISCONNECTED'),
}]);
interface Operation {
  id: string; kind: string; status: string; request_sha256: string; error: unknown;
  steps: { name: string; status: string; evidence?: Record<string, unknown> }[];
}
const evidence: Record<string, unknown> = { run, owner, mocks: false, screenshots: [],
  functions: Object.fromEntries(Array.from({ length: 25 }, (_, index) => [`X${String(index + 1).padStart(2, '0')}`,
    { result: 'FALLA', details: 'Recorrido todavía no ejecutado.' }])) };
let computer: ComputerHarness | undefined;
let trusted: TrustedBrowser | undefined;
let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
let page: V4Page | undefined;
let directory = '';
let origin = '';
let tenant = '';
let hostId = '';
let room = '';
let mountRoot = '';
const accountId = `${prefix}-account`;
const active = () => { if (!computer) throw new Error('extension computer unavailable'); return computer; };
const view = () => { if (!page) throw new Error('extension browser unavailable'); return page; };
const sheet = () => view().getByRole('dialog', { name: `Ampliaciones ${run}`, exact: true });
const functions = evidence.functions as Record<string, unknown>;
const pass = (ids: string[], details: unknown) => { for (const id of ids) functions[id] = { result: 'PASA', details }; };

async function capture(name: string, focus?: V4Locator): Promise<void> {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await view().setViewportSize(viewport);
    if (focus) await focus.evaluate(element => { element.scrollIntoView({ block: 'start' }); });
    await view().screenshot({ path: join(receiptDirectory, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`), fullPage: true });
    (evidence.screenshots as string[]).push(`${name}-${String(viewport.width)}x${String(viewport.height)}.png`);
    if (viewport.width === 390) {
      const geometry = await view().evaluate(() => ({ viewport: innerWidth,
        width: document.documentElement.scrollWidth,
        dialogs: Array.from(document.querySelectorAll('[role=dialog]')).map(element => ({
          width: element.clientWidth, scrollWidth: element.scrollWidth,
        })),
        previews: Array.from(document.querySelectorAll('section[aria-label="Previsualización operativa"]')).map(element => ({
          width: element.clientWidth, scrollWidth: element.scrollWidth,
        })),
        operations: Array.from(document.querySelectorAll('section[aria-label="Operación de flota"]')).map(element => ({
          left: element.getBoundingClientRect().left, right: element.getBoundingClientRect().right,
          width: element.clientWidth, scrollWidth: element.scrollWidth,
        })),
      }));
      evidence[`${name}-mobile-geometry`] = geometry;
      expect(geometry.width).toBeLessThanOrEqual(390);
      for (const dialog of geometry.dialogs) expect(dialog.scrollWidth).toBeLessThanOrEqual(dialog.width + 1);
      if (name.endsWith('-preview')) {
        expect(geometry.dialogs).toHaveLength(1); expect(geometry.previews).toHaveLength(1);
        expect(geometry.previews[0]?.scrollWidth).toBeLessThanOrEqual((geometry.previews[0]?.width ?? 0) + 1);
      }
      if (name.endsWith('-applied')) expect(geometry.operations.length).toBeGreaterThan(0);
      for (const operation of geometry.operations) {
        expect(operation.left).toBeGreaterThanOrEqual(0);
        expect(operation.right).toBeLessThanOrEqual(391);
        expect(operation.scrollWidth).toBeLessThanOrEqual(operation.width + 1);
      }
    }
  }
  await view().setViewportSize({ width: 1440, height: 900 });
}
async function captureOperationDetails(name: string, operation: Operation): Promise<void> {
  const panel = sheet().getByRole('region', { name: 'Operación de flota', exact: true }).filter({ hasText: operation.id });
  const details = panel.locator('details').first();
  if (!await details.evaluate(element => element.hasAttribute('open'))) await panel.getByText('Detalles técnicos', { exact: true }).click();
  const pre = panel.locator('pre'); await pre.waitFor(); expect(await pre.count()).toBe(1);
  evidence[`${name}-details-have-physical-names`] = { container: (await pre.innerText()).includes(container) };
  await capture(`${name}-details-start`, panel);
  await view().setViewportSize({ width: 390, height: 844 });
  const geometry = await panel.evaluate(async element => {
    const body = element.closest<HTMLElement>('.overflow-y-auto');
    const popup = element.closest<HTMLElement>('[role=dialog]');
    const content = element.querySelector<HTMLElement>('pre');
    if (!body || !popup || !content) throw new Error('operation scroll regions are missing');
    const bounds = (node: HTMLElement) => ({ left: node.getBoundingClientRect().left, right: node.getBoundingClientRect().right,
      top: node.getBoundingClientRect().top, bottom: node.getBoundingClientRect().bottom, width: node.clientWidth, scrollWidth: node.scrollWidth });
    const start = { body: bounds(body), panel: bounds(element), pre: bounds(content), popup: bounds(popup) };
    body.scrollTop = body.scrollHeight;
    await new Promise<void>(resolve => { requestAnimationFrame(() => { resolve(); }); });
    return { start, end: { body: bounds(body), panel: bounds(element), pre: bounds(content), popup: bounds(popup) },
      scrollTop: body.scrollTop, maxScroll: body.scrollHeight - body.clientHeight };
  });
  evidence[`${name}-expanded-mobile-geometry`] = geometry;
  for (const phase of [geometry.start, geometry.end]) {
    for (const region of [phase.popup, phase.body, phase.panel, phase.pre]) expect(region.scrollWidth).toBeLessThanOrEqual(region.width + 1);
    expect(phase.pre.left).toBeGreaterThanOrEqual(phase.panel.left - 1);
    expect(phase.pre.right).toBeLessThanOrEqual(phase.panel.right + 1);
  }
  expect(geometry.scrollTop).toBeGreaterThan(0); expect(Math.abs(geometry.scrollTop - geometry.maxScroll)).toBeLessThanOrEqual(1);
  expect(geometry.end.pre.bottom).toBeLessThanOrEqual(geometry.end.body.bottom + 1);
  expect(geometry.end.pre.bottom).toBeGreaterThan(geometry.end.body.top);
  expect(geometry.end.panel.bottom).toBeLessThanOrEqual(geometry.end.body.bottom + 1);
  await view().screenshot({ path: join(receiptDirectory, `${name}-details-end-390x844.png`) });
  (evidence.screenshots as string[]).push(`${name}-details-end-390x844.png`);
  await view().setViewportSize({ width: 1440, height: 900 });
  await panel.getByText('Detalles técnicos', { exact: true }).click();
}
async function enabled(locator: V4Locator): Promise<void> {
  await expect.poll(() => locator.isDisabled(), { timeout: 40_000 }).toBe(false);
}
async function operations(): Promise<Operation[]> {
  return (await active().pool.query<Operation>(`SELECT id,kind,status,request_hash AS request_sha256,error,steps FROM fleet_operations
    WHERE target->>'tenant_id'=$1 AND target->>'alias'=$2 ORDER BY created_at DESC`, [tenant, alias])).rows;
}
async function waitOperation(known: Set<string>, kind: string): Promise<Operation> {
  const deadline = Date.now() + 240_000;
  while (Date.now() < deadline) {
    const current = (await operations()).find(value => !known.has(value.id) && value.kind === kind);
    if (current && ['succeeded', 'failed', 'cancelled'].includes(current.status)) {
      evidence[`operation-${current.id}`] = current;
      expect(current.status, JSON.stringify(current.error)).toBe('succeeded');
      return current;
    }
    await view().waitForTimeout(1_000);
  }
  throw new Error(`the ${kind} operation did not reach a terminal state`);
}
async function openExtensions(): Promise<void> {
  await view().goto(`${origin}/config?seccion=agentes&agente=${encodeURIComponent(`${tenant}/${alias}`)}`, { waitUntil: 'domcontentloaded' });
  await sheet().waitFor({ timeout: 30_000 });
  await sheet().getByRole('tab', { name: 'Ampliaciones', exact: true }).click();
  await sheet().getByRole('heading', { name: /^Ampliaciones activas/u }).waitFor();
}
async function add(label: string, fields: [string, string][] = [], selection?: [string, string]): Promise<void> {
  await sheet().getByRole('button', { name: `Añadir ampliación ${label}`, exact: true }).click();
  if (selection) await sheet().getByRole('combobox', { name: selection[0], exact: true }).selectOption(selection[1]);
  for (const [field, value] of fields) await sheet().getByLabel(field, { exact: true }).fill(value);
  await sheet().getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
}
async function discard(): Promise<void> {
  await sheet().getByRole('button', { name: 'Descartar borrador', exact: true }).click();
}
async function apply(name: string, offline = false): Promise<Operation> {
  const known = new Set((await operations()).map(value => value.id));
  const preview = sheet().getByRole('button', { name: 'Vista previa', exact: true });
  await enabled(preview); await preview.click();
  const button = sheet().getByRole('button', { name: 'Aplicar y recrear', exact: true });
  await enabled(button);
  await sheet().getByText('Detalles técnicos de la solicitud', { exact: true }).click();
  const input = JSON.parse(await sheet().getByLabel('Solicitud de ampliaciones', { exact: true }).innerText()) as Record<string, unknown>;
  evidence[`${name}-request`] = input;
  await capture(`${name}-preview`, sheet().getByRole('region', { name: 'Previsualización operativa', exact: true }));
  await capture(`${name}-request`, sheet().getByLabel('Solicitud de ampliaciones', { exact: true }));
  if (offline) {
    const context = view().context() as ReturnType<V4Page['context']> & { setOffline(value: boolean): Promise<void> };
    const unit = `cauce-v3-host-executor-${person.company.slug}-${hostId}.service`;
    const inspectedUnit = await active().onComputer(['systemctl', '--user', 'show', unit,
      '--property=Id', '--property=LoadState', '--property=ActiveState', '--property=FragmentPath', '--property=ExecStart']);
    expect(inspectedUnit.code).toBe(0);
    const unitFields = Object.fromEntries(inspectedUnit.stdout.trim().split('\n').map(line => {
      const equals = line.indexOf('='); return [line.slice(0, equals), line.slice(equals + 1)];
    }));
    expect(unitFields).toMatchObject({ Id: unit, LoadState: 'loaded', ActiveState: 'active' });
    expect(unitFields.FragmentPath).toBe(`/home/cauce/.config/systemd/user/${unit}`);
    expect(unitFields.ExecStart).toContain(`${active().installRoot}/`);
    evidence[`${name}-owned-executor`] = { unit, computer: active().container, fragmentPath: unitFields.FragmentPath, commandUsesOwnedInstallRoot: true };
    expect((await active().onComputer(['systemctl', '--user', 'stop', unit])).code).toBe(0);
    try {
      await context.setOffline(true);
      try {
        await button.click();
        await sheet().getByRole('button', { name: 'Reintentar envío', exact: true }).waitFor({ timeout: 20_000 });
        const frozen = JSON.parse(await sheet().getByLabel('Solicitud de ampliaciones', { exact: true }).innerText()) as Record<string, unknown>;
        expect(canonicalJson(frozen)).toEqual(canonicalJson(input)); expect(frozen.idempotency_key).toBe(input.idempotency_key);
        evidence[`${name}-offline-request`] = frozen;
        expect(await operations()).toHaveLength(known.size); await capture(`${name}-offline`);
      } finally { await context.setOffline(false); }
      const resend = sheet().getByRole('button', { name: 'Reintentar envío', exact: true });
      await enabled(resend); await resend.click();
      const submitted = sheet().getByLabel('Solicitud de ampliaciones enviada', { exact: true });
      await submitted.waitFor({ state: 'attached', timeout: 30_000 });
      if (!await submitted.evaluate(element => element.closest('details')?.hasAttribute('open'))) {
        await sheet().getByText('Detalles técnicos de la solicitud enviada', { exact: true }).click();
      }
      const sent = JSON.parse(await submitted.innerText()) as Record<string, unknown>;
      expect(canonicalJson(sent)).toEqual(canonicalJson(input)); expect(sent.idempotency_key).toBe(input.idempotency_key);
      evidence[`${name}-submitted-request`] = sent;
      const queued = (await operations()).find(value => !known.has(value.id));
      expect(queued?.status).toBe('queued'); expect(queued?.request_sha256).toBe(sha256Hex(input));
      await capture(`${name}-submitted`, submitted);
      const replay = await view().evaluate(async (request: Record<string, unknown>) => {
        const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
        const response = await fetch('/v3/console/fleet/operations', { method: 'POST', credentials: 'include',
          headers: { 'content-type': 'application/json', 'x-cauce-console': '1', 'x-csrf-token': session.csrf_token ?? '' }, body: JSON.stringify(request) });
        const body = await response.json() as { operation_id?: string; operation?: { request_sha256?: string } };
        return { status: response.status, operationId: body.operation_id, requestHash: body.operation?.request_sha256 };
      }, sent);
      expect(replay).toEqual({ status: 202, operationId: queued?.id, requestHash: sha256Hex(input) });
      expect(await operations()).toHaveLength(known.size + 1); evidence[`${name}-replay`] = replay;
    } finally {
      await context.setOffline(false);
      expect((await active().onComputer(['systemctl', '--user', 'start', unit])).code).toBe(0);
      expect((await active().onComputer(['systemctl', '--user', 'is-active', unit])).stdout.trim()).toBe('active');
      evidence[`${name}-executor-resumed`] = true;
    }
  } else await button.click();
  const operation = await waitOperation(known, 'update');
  expect(operation.request_sha256).toBe(sha256Hex(input));
  await sheet().getByRole('heading', { name: /^Ampliaciones activas/u }).waitFor({ timeout: 30_000 });
  await sheet().getByRole('button', { name: 'Releer operación', exact: true }).click();
  await sheet().getByRole('button', { name: 'Releer inventario', exact: true }).click();
  await capture(`${name}-applied`, sheet().getByRole('region', { name: 'Operación de flota', exact: true }));
  await captureOperationDetails(name, operation);
  expect((await operations()).filter(value => value.request_sha256 === operation.request_sha256)).toHaveLength(1);
  return operation;
}
async function inspect(): Promise<Record<string, unknown>> {
  const raw = JSON.parse(await docker(['inspect', container])) as Record<string, unknown>[];
  const result = raw[0]; if (!result) throw new Error('agent container missing');
  const state = result.State as { Running: boolean; Status: string; ExitCode: number };
  return { Id: result.Id, State: { Running: state.Running, Status: state.Status, ExitCode: state.ExitCode },
    HostConfig: result.HostConfig, Mounts: result.Mounts, NetworkSettings: result.NetworkSettings };
}
async function storedExtensions(): Promise<unknown[]> {
  return (await active().pool.query<{ extensions: unknown[] }>('SELECT extensions FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows[0]?.extensions ?? [];
}

beforeAll(async () => {
  if (process.env.CAUCE_REQUIRE_TESTCONTAINERS !== '1' || process.env.DATABASE_URL || process.env.CAUCE_TEST_DATABASE_URL) {
    throw new Error('extension E2E requires isolated Testcontainers PostgreSQL');
  }
  await mkdir(receiptDirectory, { recursive: true, mode: 0o700 });
  evidence.source = { revision: (await execute('git', ['rev-parse', 'HEAD'])).stdout.trim(),
    driver_sha256: createHash('sha256').update(await readFile(join(process.cwd(), 'tests/e2e/v4-agentes-x-real-browser.test.ts'))).digest('hex') };
  directory = await mkdtemp(join(tmpdir(), 'cauce-x-browser-'));
  const ca = join(directory, 'ca.crt'), caKey = join(directory, 'ca.key'), key = join(directory, 'tls.key'), cert = join(directory, 'tls.crt');
  await execute('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '2', '-keyout', caKey,
    '-out', ca, '-subj', '/CN=Cauce extensions E2E CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
  const config = join(directory, 'tls.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nprompt=no\nreq_extensions=ext\n[dn]\nCN=localhost\n[ext]\nsubjectAltName=DNS:localhost,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n');
  await execute('openssl', ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', join(directory, 'tls.csr'), '-config', config]);
  await execute('openssl', ['x509', '-req', '-in', join(directory, 'tls.csr'), '-CA', ca, '-CAkey', caKey, '-CAcreateserial',
    '-out', cert, '-days', '2', '-sha256', '-extfile', config, '-extensions', 'ext']);
  await chmod(caKey, 0o600); await chmod(key, 0o600);
  const ports = await reserveNamedLoopbackPorts(['frontend'] as const); await ports.releaseAll();
  origin = `https://localhost:${String(ports.ports.frontend)}`;
  for (const name of [network, extraNetwork]) await docker(['network', 'create', '--label', `cauce.e2e.owner=${owner}`, name]);
  computer = await startComputerHarness({ prefix, consoleOrigins: [origin], workRoot: '/datos', agentNetwork: { name: network }, resourceOwner: owner,
    extraSourceFiles: ['services/gateway/src/fleet/space-backup.failure.ts'] });
  vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
    configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
    cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true, watch: null, hmr: false,
      https: { key: await readFile(key), cert: await readFile(cert) }, proxy: { '/v3': { target: computer.gatewayUrl, changeOrigin: false, ws: true } } },
  });
  await vite.listen();
  trusted = await startTrustedBrowser(ca, directory, [ports.ports.frontend, Number(new URL(computer.gatewayUrl).port)]);
  const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  page = asV4Page(await context.newPage()); errors.watch(page, 'extension-owner');
  const form = await openRegistration(page, origin); await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const login = await computer.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin }, payload: { email: person.email, password: person.password } });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers['set-cookie'];
  const session = { origin, cookie: (Array.isArray(cookies) ? cookies : cookies ? [cookies] : []).map(value => value.split(';', 1)[0]).join('; '),
    'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token };
  hostId = `${prefix}-pc`;
  const invitation = await inviteSetupHost(computer.app, session, hostId);
  const enrolled = await computer.cli(['enroll', '--gateway', computer.gatewayUrl, '--invitation-stdin'], JSON.stringify(invitation));
  expect(enrolled.code).toBe(0);
  mountRoot = join(computer.installRoot, 'canary-mount');
  const preparedRoot = await computer.onComputer(['mkdir', '-p', mountRoot]); expect(preparedRoot.code).toBe(0);
  await computer.onComputer(['python3', '-c', 'import pathlib,sys;pathlib.Path(sys.argv[1],"marker").write_text("MOUNT-CANARY")', mountRoot]);
  const allowed = { types: ['mount', 'network', 'resources', 'ssh', 'mcp', 'tools', 'full_control', 'browser', 'docker'],
    mount_roots: [mountRoot], networks: [extraNetwork], docker_access: ['read', 'control'] };
  await computer.pool.query('UPDATE fleet_hosts SET extensions_allowed=$2::jsonb WHERE host_id=$1', [hostId, JSON.stringify(allowed)]);
  const setup = await computer.cli(['setup', '--install-root', computer.installRoot]);
  if (setup.code !== 0) throw new Error(`extension setup failed: ${setup.stderr}`);
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    ready = (await hostEnrollments(active(), session)).enrollments.some(value => value.host_id === hostId && value.executor_ready);
    if (ready) break;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  expect(ready).toBe(true);
  tenant = (await computer.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id ?? '';
  room = (await computer.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id ?? '';
  await computer.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES($1,'codex',$2,$3,'env_path','CAUCE_E2E_EXTENSION_PROFILE_PATH',true)`, [accountId, FIXTURE_PROVIDER_IDENTITY, tenant]);
  evidence.allowed = allowed;
}, 900_000);

afterAll(async () => {
  const failures: unknown[] = [];
  if (page && functions.X01 && !(evidence.baseline)) {
    evidence.bootstrapPage = await bodySnippet(page);
    await page.screenshot({ path: join(receiptDirectory, 'bootstrap-failure.png'), fullPage: true }).catch(() => undefined);
  }
  if (computer) {
    evidence.operations = await operations().catch(() => []);
    evidence.journal = (await computer.onComputer(['journalctl', '--user', '--no-pager', '-n', '100'])).stdout;
  }
  evidence.browser = { unexpected: errors.unexpected, ignored: Object.fromEntries(errors.ignored) };
  for (const action of [async () => trusted?.close(), async () => vite?.close(), async () => {
    if (computer) {
      evidence.cleanup = await computer.close();
      expect(evidence.cleanup).toEqual({ containers: '', volumes: '', images: '' });
    }
  }, ...[extraNetwork, network].map(name => async () => { await docker(['network', 'rm', name]); }), async () => {
    if (directory) await rm(directory, { recursive: true, force: true });
  }]) { try { await action(); } catch (error) { failures.push(String(error)); } }
  evidence.cleanupFailures = failures;
  await writeFile(join(receiptDirectory, 'receipt.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  expect(failures).toEqual([]);
}, 300_000);

describe.sequential('Ampliaciones desde Chromium con ejecutor Docker real', () => {
  it('crea el agente real y acredita el perfil base sin ampliaciones', async () => {
    try {
      await view().goto(`${origin}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await view().getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = view().getByRole('dialog', { name: 'Añadir agente', exact: true });
      await dialog.getByRole('combobox', { name: 'Espacio de trabajo', exact: true }).selectOption(tenant);
      await dialog.getByLabel('Alias', { exact: true }).fill(alias);
      await dialog.getByLabel('Nombre visible', { exact: true }).fill(`Ampliaciones ${run}`);
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('combobox', { name: 'Tipo de agente (opcional)', exact: true }).selectOption('codex');
      const placement = dialog.getByRole('combobox', { name: 'Computadora (opcional)', exact: true });
      await placement.locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
      await placement.selectOption(hostId);
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('combobox', { name: 'Grupo inicial (opcional)', exact: true }).selectOption(room);
      await dialog.getByRole('button', { name: 'Siguiente', exact: true }).click();
      await dialog.getByRole('button', { name: 'Previsualizar alta', exact: true }).click();
      const register = dialog.getByRole('button', { name: 'Crear registro', exact: true });
      await enabled(register); await register.click();
      await dialog.getByText(`Registro creado: ${tenant}/${alias}.`, { exact: true }).waitFor({ timeout: 30_000 });
      await expect.poll(async () => (await active().pool.query('SELECT 1 FROM memberships WHERE tenant_id=$1 AND alias=$2 AND room_id=$3',
        [tenant, alias, room])).rows.length, { timeout: 30_000 }).toBe(1);
      expect((await active().pool.query('SELECT host_id,runtime_key,enabled FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows)
        .toEqual([{ host_id: hostId, runtime_key: null, enabled: false }]);
      expect(await operations()).toEqual([]);
      await capture('W29-registry-created');
      await dialog.getByRole('button', { name: 'Preparar en la computadora', exact: true }).click();
      const create = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
      await create.getByLabel('Espacio de trabajo operativo').selectOption(tenant);
      await create.getByLabel('Alias operativo').fill(alias);
      await create.getByLabel('Nombre visible operativo').fill(`Ampliaciones ${run}`);
      await create.getByLabel('Clave física de ejecución').fill(runtime);
      await create.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
      await create.getByLabel('Grupo primario').selectOption(room);
      await create.getByLabel('Host operativo').locator(`option[value="${hostId}"]`).waitFor({ state: 'attached', timeout: 30_000 });
      await create.getByLabel('Host operativo').selectOption(hostId);
      await create.getByLabel('Plantilla de ejecución').selectOption('0');
      await create.getByLabel('Cuenta principal de ejecución').selectOption(accountId);
      const known = new Set((await operations()).map(value => value.id));
      const preview = create.getByRole('button', { name: 'Previsualizar operación', exact: true });
      await enabled(preview); await preview.click();
      const confirm = create.getByRole('button', { name: 'Confirmar operación', exact: true }); await enabled(confirm); await confirm.click();
      const created = await waitOperation(known, 'create');
      evidence.baseline = await inspect(); expect(await storedExtensions()).toEqual([]);
      expect((evidence.baseline as Record<string, unknown>).State).toMatchObject({ Running: true });
      evidence.W29 = { result: 'PASA', operation: created.id, observed: (await active().pool.query(
        'SELECT host_id,runtime_key,enabled,lifecycle_state FROM agents WHERE tenant_id=$1 AND alias=$2', [tenant, alias])).rows };
      await openExtensions(); await capture('01-base');
    } catch (error) { evidence.failure = { error: String(error), page: await bodySnippet(view()) }; await capture('failure-create'); throw error; }
  }, 400_000);

  it('valida formatos, duplicados y política sin persistir los borradores rechazados', async () => {
    expect(evidence.baseline, 'the real agent must have been created').toBeDefined();
    await openExtensions();
    await sheet().getByText(/El ordenador admite:/u).waitFor();
    const invalid: [string, [string, string][], string, [string, string]?][] = [
      ['Montaje', [['Origen en el ordenador', 'relative'], ['Destino en el contenedor', '/workspace/x']], 'deben ser rutas absolutas'],
      ['Red adicional', [['Nombre de la red Docker', 'bad network']], 'Indica el nombre de la red'],
      ['Recursos', [['CPU', '0']], 'La CPU debe ser'],
      ['Recursos', [['Memoria', '0g']], 'La memoria debe tener'],
      ['Recursos', [['Procesos (máx. 4096)', '4097']], 'Los procesos deben ser'],
      ['SSH saliente', [['Destinos (uno por línea, usuario@host[:puerto])', 'cauce@localhost\ncauce@localhost']], 'sin repetir'],
      ['Servidor MCP', [['Nombre', 'canary'], ['Comando', 'node'], ['Variables de entorno (solo nombres, nunca valores)', 'SECRET=value']], 'nunca valores'],
      ['Herramientas', [['Paquetes con versión fija (uno por línea)', 'npm:canary@latest']], 'versión exacta'],
      ['Navegador', [['Host del navegador', 'localhost'], ['Puerto CDP', '0']], 'puerto válido', ['Modo', 'ssh_tunnel']],
    ];
    for (const [label, fields, error, selection] of invalid) {
      await sheet().getByRole('button', { name: `Añadir ampliación ${label}`, exact: true }).click();
      if (selection) await sheet().getByRole('combobox', { name: selection[0], exact: true }).selectOption(selection[1]);
      for (const [field, value] of fields) await sheet().getByLabel(field, { exact: true }).fill(value);
      await sheet().getByRole('button', { name: 'Añadir al borrador', exact: true }).click();
      await sheet().getByRole('alert').filter({ hasText: error }).waitFor();
      await sheet().getByRole('button', { name: 'Cancelar', exact: true }).click();
    }
    await add('GPU');
    const preview = sheet().getByRole('button', { name: 'Vista previa', exact: true });
    errors.expectHttpError('/v3/console/fleet/operations/preview', 409);
    await enabled(preview); await preview.click();
    await sheet().getByText(/no admite la ampliación gpu/u).waitFor();
    await capture('02-gpu-policy-rejected'); await discard();
    const duplicates: [string, [string, string][]][] = [
      ['Montaje', [['Origen en el ordenador', mountRoot], ['Destino en el contenedor', '/workspace/x']]],
      ['Red adicional', [['Nombre de la red Docker', extraNetwork]]],
      ['Servidor MCP', [['Nombre', 'canary'], ['Comando', 'node']]],
      ['Recursos', [['CPU', '1']]],
    ];
    for (const [label, fields] of duplicates) {
      await add(label, fields); await add(label, fields);
      await sheet().getByRole('alert').filter({ hasText: 'Ya hay una ampliación' }).waitFor();
      await sheet().getByRole('button', { name: 'Cancelar', exact: true }).click(); await discard();
    }
    await add('Navegador', [['Host del navegador', 'localhost'], ['Puerto CDP', '9222']], ['Modo', 'ssh_tunnel']);
    await sheet().getByRole('alert').filter({ hasText: 'necesita la ampliación SSH' }).waitFor();
    await sheet().getByRole('button', { name: 'Cancelar', exact: true }).click();
    const drafts: [string, [string, string][], [string, string]?][] = [
      ['Docker', [], ['Acceso', 'read']], ['Docker', [], ['Acceso', 'control']],
      ['Navegador', [], ['Modo', 'sidecar']],
      ['Herramientas', [['Paquetes con versión fija (uno por línea)', 'pip:six==1.17.0']]],
      ['Respaldo Muse', [['Alias del otro agente del par', `partner-${run}`], ['Modelo Muse', 'muse-spark-1.3']]],
    ];
    for (const [label, fields, selection] of drafts) {
      await add(label, fields, selection);
      await sheet().getByRole('heading', { name: 'Borrador de ampliaciones (1)', exact: true }).waitFor();
      await capture(`03-draft-${label.replaceAll(' ', '-').toLowerCase()}-${selection?.[1] ?? 'valid'}`);
      await discard();
    }
    await add('SSH saliente', [['Destinos (uno por línea, usuario@host[:puerto])', 'cauce@localhost:22']]);
    await add('Navegador', [['Host del navegador', 'localhost'], ['Puerto CDP', '9222']], ['Modo', 'ssh_tunnel']);
    await sheet().getByRole('heading', { name: 'Borrador de ampliaciones (2)', exact: true }).waitFor();
    await capture('03-tunnel-with-ssh-draft'); await discard();
    await capture('03-validation');
    expect(await storedExtensions()).toEqual([]);
    expect(await operations()).toHaveLength(1);
    pass(['X16', 'X17', 'X19'], { negatives: invalid.map(value => value[0]), duplicateIdentities: ['mount target', 'network name', 'mcp name', 'resources type'], persisted: [] });
    functions.X06 = { result: 'FALLA', details: 'GPU añadida y vista previa rechazada por política real; laboratorio sin GPU física admitida.' };
    functions.X09 = { result: 'FALLA', details: 'Borradores Docker read/control ejercidos; proxy físico no probado. El daemon compartido exige aislamiento antes de admitir Docker.' };
    functions.X10 = { result: 'FALLA', details: 'Borrador sidecar ejercido; Chromium sidecar físico no probado.' };
    functions.X11 = { result: 'FALLA', details: 'Túnel sin SSH rechazado; borrador válido con SSH y host/puerto. Conexión remota no probada.' };
    functions.X13 = { result: 'FALLA', details: 'Paquete sin pin rechazado, pin exacto aceptado en borrador; instalación física no probada.' };
    functions.X14 = { result: 'FALLA', details: 'Alias/modelo Muse ejercidos en borrador; par OpenClaw/Muse físico no disponible en este fixture Codex.' };
  }, 180_000);

  it('aplica montajes ro/rw, red, recursos, SSH, MCP y control total conservando volúmenes y solicitud al reintentar', async () => {
    expect(evidence.baseline, 'the real agent must have been created').toBeDefined();
    try {
      await add('Montaje', [['Origen en el ordenador', mountRoot], ['Destino en el contenedor', '/workspace/readonly']]);
      await add('Montaje', [['Origen en el ordenador', mountRoot], ['Destino en el contenedor', '/workspace/writable']], ['Modo', 'rw']);
      await add('Red adicional', [['Nombre de la red Docker', extraNetwork]]);
      await add('Recursos', [['Memoria', '512m'], ['CPU', '1.5'], ['Procesos (máx. 4096)', '256']]);
      await add('SSH saliente', [['Destinos (uno por línea, usuario@host[:puerto])', 'cauce@localhost:22']]);
      await add('Servidor MCP', [['Nombre', 'canary'], ['Comando', 'node'], ['Argumentos (uno por línea)', '--version'], ['Variables de entorno (solo nombres, nunca valores)', 'ZZ_CANARY']]);
      await add('Control total');
      const aliasInput = sheet().getByLabel(`Escribe el alias ${alias} para confirmar el control total`, { exact: true });
      await aliasInput.fill('incorrect'); expect(await sheet().getByRole('button', { name: 'Vista previa', exact: true }).isDisabled()).toBe(true);
      await aliasInput.fill(alias);
      await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
        'import pathlib,sys;pathlib.Path(sys.argv[1]).write_text("PRESERVED")', markerPath]);
      const operation = await apply('04-main', true);
      const after = await inspect(); evidence.main = after;
      expect(after.Id).not.toBe((evidence.baseline as Record<string, unknown>).Id);
      expect(after.State).toMatchObject({ Running: true });
      const config = after.HostConfig as { Memory: number; NanoCpus: number; PidsLimit: number; ReadonlyRootfs: boolean; CapDrop: string[] | null; Privileged: boolean };
      expect(config).toMatchObject({ Memory: 536870912, NanoCpus: 1500000000, PidsLimit: 256, ReadonlyRootfs: false, Privileged: false });
      expect(config.CapDrop ?? []).toEqual([]);
      expect(Object.keys((after.NetworkSettings as { Networks: Record<string, unknown> }).Networks).sort()).toEqual([extraNetwork, network].sort());
      const observed = JSON.parse(await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
        'import json,pathlib,sys;ro=pathlib.Path("/workspace/readonly");rw=pathlib.Path("/workspace/writable");rw.joinpath("written").write_text("RW");failed=False\ntry:ro.joinpath("forbidden").write_text("FAIL")\nexcept OSError:failed=True\nprint(json.dumps({"ro":ro.joinpath("marker").read_text(),"rw":rw.joinpath("written").read_text(),"roRejected":failed,"preserved":pathlib.Path(sys.argv[1]).read_text()}))', markerPath])) as Record<string, unknown>;
      expect(observed).toEqual({ ro: 'MOUNT-CANARY', rw: 'RW', roRejected: true, preserved: 'PRESERVED' }); evidence.observed = observed;
      const profile = await docker(['exec', '--user', 'cauce', container, 'python3', '-c',
        'import pathlib,tomllib;root=pathlib.Path("/home/cauce/.cauce-profiles");files=list(root.rglob("config.toml"));expected={"command":"node","args":["--version"],"env":{"ZZ_CANARY":"${ZZ_CANARY}"}};print("MCP-CONFIGURED" if any(tomllib.loads(p.read_text()).get("mcp_servers",{}).get("canary")==expected for p in files) else "MCP-MISSING")']);
      expect(profile).toBe('MCP-CONFIGURED'); evidence.mcpConfigured = true;
      await sheet().getByText('Clave pública SSH', { exact: true }).waitFor();
      const publicKey = sheet().locator('code').filter({ hasText: 'ssh-ed25519' });
      expect(await publicKey.innerText()).toMatch(/^ssh-ed25519 /u);
      expect(await sheet().innerText()).toMatch(/Huella: SHA256:/u);
      expect(operation.steps.some(step => !!step.evidence?.extensions_receipt)).toBe(true);
      const beforeMounts = (evidence.baseline as { Mounts: { Name?: string; Type: string }[] }).Mounts.filter(value => value.Type === 'volume').map(value => value.Name).sort();
      const afterMounts = (after.Mounts as { Name?: string; Type: string }[]).filter(value => value.Type === 'volume').map(value => value.Name).sort();
      expect(afterMounts).toEqual(beforeMounts);
      expect(await storedExtensions()).toHaveLength(7);
      pass(['X03', 'X04', 'X05', 'X08', 'X12', 'X15', 'X20', 'X21', 'X22', 'X24', 'X25'], { operation: operation.id, runtime: observed, volumeNames: afterMounts });
      functions.X07 = { result: 'FALLA', details: 'Destinos validados, duplicados rechazados, clave y huella físicas; sesión SSH remota no ejecutada.' };
      await capture('05-physical-receipt');
    } catch (error) { evidence.failure = { error: String(error), page: await bodySnippet(view()) }; await capture('failure-apply'); throw error; }
  }, 500_000);

  it('retira todas las ampliaciones y recrea el perfil seguro conservando el estado', async () => {
    expect(evidence.main, 'the real extension update must have succeeded').toBeDefined();
    for (const label of ['Montaje', 'Montaje', 'Red adicional', 'Recursos', 'SSH saliente', 'Servidor MCP', 'Control total']) {
      await sheet().getByRole('button', { name: `Quitar ampliación ${label}`, exact: true }).first().click();
    }
    await sheet().getByText(/se retirarán todas las ampliaciones/u).waitFor();
    const operation = await apply('06-safe');
    const after = await inspect(); evidence.safe = after;
    expect(after.State).toMatchObject({ Running: true });
    expect(after.HostConfig).toMatchObject({ Memory: 0, NanoCpus: 0, PidsLimit: 128, ReadonlyRootfs: true, CapDrop: ['ALL'], Privileged: false });
    expect(Object.keys((after.NetworkSettings as { Networks: Record<string, unknown> }).Networks)).toEqual([network]);
    expect(await docker(['exec', '--user', 'cauce', container, 'cat', markerPath])).toBe('PRESERVED');
    expect(await storedExtensions()).toEqual([]);
    pass(['X18'], { operation: operation.id, safeProfile: true, preserved: true });
    functions.X01 = { result: 'FALLA', details: 'Estados activas0, borrador y activas7 probados con runtime; servidor no publicado no reproducido sin mocks.' };
    functions.X02 = { result: 'FALLA', details: 'Política de host publicada comprobada y gpu rechazada; estado no publicado no reproducido sin mocks.' };
    errors.assertClean();
  }, 400_000);
});
