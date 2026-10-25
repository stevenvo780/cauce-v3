import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { enrollComputer, FIXTURE_PROVIDER_IDENTITY, startComputerHarness,
  type ComputerHarness } from '../../services/gateway/src/fleet/host-computer.fixtures.js';
import { createSelfSignedCert } from '../terminal-pty/certs.mjs';
import { startTrustedBrowser, type TrustedBrowser } from './console-functional-browser.fixtures.js';
import { invalidateCanaryBundle } from './h6d-bundle-negative.js';
import { reserveNamedLoopbackPorts } from './port-reservation.js';
import { apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  openRegistration, syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';
import { standardRecoveryBundle } from './v4-reiniciar-agente-standard.fixtures.js';

const OWNER = 'h6d-reinicio-v4-1025';
const RUN = randomUUID().slice(0, 8);
const PREFIX = `zz-canary-${OWNER}-cause-${RUN}`;
const ALIAS = `cause${RUN}`;
const KEY = `physical-${RUN}`;
const EVIDENCE = join(process.cwd(), '.delegados/v4/recibos', OWNER, `e2e-cause-${RUN}`);
const consoleRequire = createRequire(join(process.cwd(), 'console/package.json'));
let harness: ComputerHarness | undefined;
let trusted: TrustedBrowser | undefined;
let vite: { close(): Promise<void>; listen(): Promise<void> } | undefined;
let page: V4Page | undefined;
let directory = '';
let baseUrl = '';
let tenant = '';
let room = '';
let host = '';
let account = '';
let policy = '';
const evidence: Record<string, unknown> = { run: RUN, owner: OWNER, effect: 'real bundle pin rejection after UI preview' };
const browserErrors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES,
  { id: 'terminal-targets-unavailable', reason: 'hermetic gateway without the optional terminal relay',
    matches: (text, url) => text.includes('status of 501') && new URL(url).pathname === '/v3/console/terminal/targets' }]);

interface Operation { id: string; status: string; version: number; error: unknown; steps: { name: string; status: string }[] }
function active() { if (!harness) throw new Error('computer fixture absent'); return harness; }
function view() { if (!page) throw new Error('browser absent'); return page; }

async function capture(name: string) {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await view().setViewportSize(viewport);
    const cause = view().getByText(/^Causa: runtime_bundle_changed/u);
    if (await cause.count()) await cause.evaluate(element => { element.scrollIntoView({ block: 'center' }); });
    await view().screenshot({ path: join(EVIDENCE, `${name}-${String(viewport.width)}x${String(viewport.height)}.png`) });
  }
  await view().setViewportSize({ width: 1440, height: 900 });
}

async function operations(): Promise<Operation[]> {
  const response = await apiGet(view(), `/v3/console/fleet/operations?resource=agent&tenant_id=${tenant}&alias=${ALIAS}`);
  expect(response.status).toBe(200);
  return response.body.operations as Operation[];
}

async function cancel(id: string) {
  const operation = await apiGet(view(), `/v3/console/fleet/operations/${id}`);
  expect(operation.body.status).toBe('failed');
  const result = await view().evaluate(async argument => {
    const auth = await fetch('/v3/auth/session', { credentials: 'include' }).then(response => response.json()) as { csrf_token: string };
    const response = await fetch(`/v3/console/fleet/operations/${argument.id}/cancel`, { method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', 'x-csrf-token': auth.csrf_token }, body: JSON.stringify({ expected_version: argument.version }) });
    return response.status;
  }, { id, version: operation.body.version });
  expect(result).toBe(200);
  await expect.poll(async () => (await apiGet(view(), `/v3/console/fleet/operations/${id}`)).body.status,
    { timeout: 120_000 }).toBe('cancelled');
  return (await apiGet(view(), `/v3/console/fleet/operations/${id}`)).body;
}

beforeAll(async () => {
  await mkdir(EVIDENCE, { recursive: true, mode: 0o700 });
  console.info('H6D_CANARY', JSON.stringify({ run: RUN, prefix: PREFIX, alias: ALIAS, runtime_key: KEY }));
  directory = await mkdtemp(join(tmpdir(), 'zz-canary-h6d-cause-'));
  const tls = createSelfSignedCert({ directory });
  const ports = await reserveNamedLoopbackPorts(['frontend', 'spare'] as const);
  await ports.releaseAll(); baseUrl = `https://localhost:${String(ports.ports.frontend)}`;
  harness = await startComputerHarness({ prefix: PREFIX, consoleOrigins: [baseUrl], workRoot: '/datos', resourceOwner: OWNER,
    runtimeBundle: standardRecoveryBundle, extraSourceFiles: ['packages/store/src/context-version-reevaluation.ts'] });
  vite = await (consoleRequire('vite') as { createServer(config: Record<string, unknown>): Promise<NonNullable<typeof vite>> }).createServer({
    configFile: join(process.cwd(), 'console/vite.config.ts'), root: join(process.cwd(), 'console'), envDir: directory,
    cacheDir: join(directory, 'vite-cache'), server: { host: '127.0.0.1', port: ports.ports.frontend, strictPort: true,
      watch: null, hmr: false, https: { key: await readFile(tls.key_path), cert: await readFile(tls.cert_path) },
      proxy: { '/v3': { target: harness.gatewayUrl, changeOrigin: false, ws: true } } },
  });
  await vite.listen();
  trusted = await startTrustedBrowser(tls.cert_path, directory, [ports.ports.frontend, ports.ports.spare]);
  const context = await trusted.browser.newContext({ viewport: { width: 1440, height: 900 }, ignoreHTTPSErrors: false, serviceWorkers: 'block' });
  page = asV4Page(await context.newPage()); browserErrors.watch(page, 'h6d-cause');
  const person = syntheticPerson('h6d-cause', RUN);
  person.company = { name: `zz-canary-h6d-cause-${RUN}`, slug: `zz-h6d-cause-${RUN}` };
  const registration = await openRegistration(page, baseUrl);
  await fillRegistration(registration, person);
  await registration.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  const login = await harness.app.inject({ method: 'POST', url: '/v3/auth/login', headers: { origin: baseUrl },
    payload: { email: person.email, password: person.password } });
  expect(login.statusCode).toBe(200);
  const cookies = login.headers['set-cookie'];
  const cookie = (Array.isArray(cookies) ? cookies : cookies ? [cookies] : []).map(row => row.split(';', 1)[0]).join('; ');
  host = `${person.company.slug}-pc`;
  await enrollComputer(harness, { cookie, origin: baseUrl, 'x-csrf-token': login.json<{ csrf_token: string }>().csrf_token }, person.company.slug, host);
  policy = join(harness.installRoot, person.company.slug, host, 'executor-policy.json');
  tenant = (await harness.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [person.email])).rows[0]?.tenant_id ?? '';
  room = (await harness.pool.query<{ id: string }>('SELECT id FROM rooms WHERE tenant_id=$1 AND enabled ORDER BY id', [tenant])).rows[0]?.id ?? '';
  account = `zz-h6d-cause-${RUN}`;
  await harness.pool.query(`INSERT INTO provider_accounts(id,provider,external_account_id,payer_tenant_id,credential_ref_kind,credential_ref,enabled)
    VALUES($1,'codex',$2,$3,'env_path','CAUCE_E2E_RECOVERY_PROFILE_PATH',true)`, [account, FIXTURE_PROVIDER_IDENTITY, tenant]);
}, 900_000);

afterAll(async () => {
  const errors: unknown[] = [];
  const attempt = async (fn: () => Promise<unknown>) => { try { await fn(); } catch (error) { errors.push(error); } };
  evidence.browser_errors = browserErrors.unexpected;
  await attempt(async () => trusted?.close());
  await attempt(async () => vite?.close());
  await attempt(async () => { if (harness) evidence.cleanup = await harness.close(); });
  if (directory) await attempt(() => rm(directory, { recursive: true, force: true }));
  await writeFile(join(EVIDENCE, 'durable-receipts.json'), JSON.stringify(evidence, null, 2) + '\n', { mode: 0o600 });
  if (errors.length) throw new AggregateError(errors, 'h6d cause cleanup failed');
}, 300_000);

describe('causa tipada de una operación de flota en Chromium real', () => {
  it('rechaza el bundle cambiado después de preview y explica la causa en castellano y Detalles', async () => {
    const current = view();
    try {
      expect(ALIAS).not.toBe(KEY);
      await current.goto(`${baseUrl}/config?seccion=agentes`, { waitUntil: 'domcontentloaded' });
      await current.getByRole('button', { name: 'Añadir agente', exact: true }).click();
      const dialog = current.getByRole('dialog', { name: 'Añadir agente' });
      await dialog.getByText('Solo preparar, sin desplegar', { exact: true }).click();
      const form = dialog.getByRole('region', { name: 'Alta operativa de agente', exact: true });
      await form.getByLabel('Espacio de trabajo operativo').selectOption(tenant);
      await form.getByLabel('Alias operativo').fill(ALIAS);
      await form.getByLabel('Nombre visible operativo').fill(`Cause ${RUN}`);
      await form.getByLabel('Clave física de ejecución').fill(KEY);
      await form.getByRole('checkbox', { name: new RegExp(`· "${room}"$`, 'u') }).check();
      await form.getByLabel('Grupo primario').selectOption(room);
      await form.getByLabel('Host operativo').selectOption(host);
      await form.getByLabel('Plantilla de ejecución').selectOption('0');
      await form.getByLabel('Cuenta principal de ejecución').selectOption(account);
      await form.getByRole('button', { name: 'Previsualizar operación', exact: true }).click();
      const confirm = form.getByRole('button', { name: 'Confirmar operación', exact: true });
      await expect.poll(() => confirm.isDisabled(), { timeout: 30_000 }).toBe(false);
      await capture('01-valid-preview');
      const invalid = await invalidateCanaryBundle(active(), policy, RUN);
      evidence.bundle_injection = invalid.receipt;
      let failed: Operation | undefined;
      try {
        await confirm.click();
        await expect.poll(async () => { failed = (await operations())[0]; return failed?.status; }, { timeout: 120_000 }).toBe('failed');
        evidence.failed_operation = failed;
        expect(failed?.error).toMatchObject({ code: 'STEP_FAILED', reason: 'runtime_bundle_changed' });
        const operation = current.getByRole('region', { name: 'Operación de flota', exact: true });
        await expect.poll(() => operation.innerText(), { timeout: 30_000 })
          .toContain('Los archivos o la imagen de la ejecución no coinciden con la versión aprobada.');
        await operation.getByText('Detalles técnicos', { exact: true }).click();
        const details = await operation.innerText();
        expect(details).toContain('Causa: runtime_bundle_changed');
        expect(details).toContain('Código: STEP_FAILED');
        expect(details).not.toContain('fleet effect failed');
        expect(details).not.toContain('Traceback');
        evidence.visible_details = details;
        await capture('02-bundle-cause-details');
      } finally {
        evidence.bundle_restoration = await invalid.restore();
        failed ??= (await operations())[0];
        if (failed?.status === 'failed') evidence.cancellation = await cancel(failed.id);
      }
      browserErrors.assertClean();
    } catch (error) {
      evidence.operations_at_failure = await operations().catch(() => []);
      evidence.failure_body = await bodySnippet(current).catch(() => 'unavailable');
      evidence.failure_journal = (await active().onComputer(['journalctl', '--user', '--no-pager', '-n', '70'])).stdout
        .replace(/postgres(?:ql)?:\/\/\S+/giu, 'postgresql://redacted').replace(/Bearer\s+\S+/giu, 'Bearer redacted');
      await capture('failure').catch(() => undefined);
      console.info('H6D_CAUSE_FAILURE', JSON.stringify(evidence));
      throw error;
    }
  }, 300_000);
});
