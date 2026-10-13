import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture, type BrowserSocket } from './console-functional-browser.fixtures.js';
import { join } from 'node:path';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login,
  openRegistration, PATTERN_DEFECT_RULE, type V4Page,
} from './v4-console-real-browser.helpers.js';
import { prepareQuotaDockerImage, removeQuotaDockerImage, quotaCanaryPerson, seedQuotaCompanyAdmin, startQuotaDockerHost } from './v4-quota-environments-real-browser.fixtures.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const owner = quotaCanaryPerson('owner', run);
const foreignOwner = quotaCanaryPerson('foreign-owner', run);
const accountLabel = `zz-canary-account-${run}`;
const quotaHost = `${owner.company.slug}-quota_host_${run}`;
const quotaHostName = `zz-canary-quota-host-name-${run}`;
const ownerEnvironment = `zz-canary-owner-environment-${run}`;
const ownerEnvironmentEdited = `zz-canary-owner-environment-edited-${run}`;
const adminEnvironment = `zz-canary-admin-environment-${run}`;
const adminEnvironmentEdited = `zz-canary-admin-environment-edited-${run}`;
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let ownerPage: V4Page | undefined;
let accountId = '';
let accountVersion = 0;
let ownerEnvironmentId = '';
let quotaImage: Awaited<ReturnType<typeof prepareQuotaDockerImage>>;
let quotaHostRuntime: Awaited<ReturnType<typeof startQuotaDockerHost>> | undefined;
const evidenceDirectory = join(process.cwd(), 'ops/artifacts/quota-real-browser', run);

const active = () => { if (!fixture) throw new Error('quota browser fixture is not initialized'); return fixture; };
const pool = () => active().database.pool;
const base = () => active().baseUrl;
const companyOwnerPage = () => { if (!ownerPage) throw new Error('quota company owner has no page'); return ownerPage; };
const hostRuntime = () => { if (!quotaHostRuntime) throw new Error('quota Docker host is not initialized'); return quotaHostRuntime; };

interface QuotaStreamFrame { payload: string | Buffer }
interface QuotaStreamSocket extends BrowserSocket {
  on(event: 'close', handler: (socket: BrowserSocket) => void): void;
  on(event: 'socketerror', handler: () => void): void;
  on(event: 'framereceived', handler: (frame: QuotaStreamFrame) => void): void;
  off(event: 'close' | 'socketerror', handler: () => void): void;
  off(event: 'framereceived', handler: (frame: QuotaStreamFrame) => void): void;
}

function waitForQuotaAuthenticationStream(page: V4Page): Promise<void> {
  const expectedHost = new URL(page.url()).host;
  const watched = page as V4Page & { off(event: 'websocket', handler: (socket: BrowserSocket) => void): void };
  return new Promise((resolve, reject) => {
    let socket: QuotaStreamSocket | undefined;
    let ready = false; let output = false;
    const finish = (error?: Error) => {
      clearTimeout(timer); watched.off('websocket', opened);
      socket?.off('framereceived', received); socket?.off('socketerror', failed); socket?.off('close', closed);
      if (error) reject(error); else resolve();
    };
    const received = ({ payload }: QuotaStreamFrame) => {
      if (Buffer.isBuffer(payload)) output ||= payload.length > 0;
      else {
        try {
          const control = JSON.parse(payload) as Record<string, unknown>;
          if (Object.keys(control).length !== 1 || control.type !== 'ready') throw new Error('invalid control');
          ready = true;
        } catch { finish(new Error('quota authentication stream sent an invalid control')); return; }
      }
      if (ready && output) finish();
    };
    const failed = () => { finish(new Error('quota authentication stream failed before readiness and output')); };
    const closed = () => { finish(new Error('quota authentication stream closed before readiness and output')); };
    const opened = (candidate: BrowserSocket) => {
      let url: URL;
      try { url = new URL(candidate.url()); } catch { return; }
      if (socket || url.protocol !== 'wss:' || url.host !== expectedHost
        || !/^\/v3\/console\/provider-auth\/sessions\/[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}\/stream$/u.test(url.pathname)) return;
      socket = candidate as QuotaStreamSocket;
      socket.on('framereceived', received); socket.on('socketerror', failed); socket.on('close', closed);
    };
    const timer = setTimeout(() => { finish(new Error('quota authentication stream did not become ready with output')); }, 30_000);
    page.on('websocket', opened);
  });
}

async function assertContainerIsolation(environmentId: string): Promise<void> {
  const observed = await hostRuntime().inspect(environmentId);
  expect(observed).toMatchObject({ present: true, volume_present: true, image: quotaImage.image,
    user: '1000:1000', readonly_rootfs: true, privileged: false, memory: 512 * 1024 * 1024, pids_limit: 128 });
  expect(observed.cap_drop).toEqual(['ALL']);
  expect(observed.security_opt?.some(value => value.startsWith('no-new-privileges'))).toBe(true);
  expect(observed.mounts?.map(mount => mount.destination).sort()).toEqual(['/cauce/executor', '/cauce/lifecycle', '/home/node']);
  expect(observed.mounts?.find(mount => mount.destination === '/home/node')).toMatchObject({ type: 'volume', writable: true });
  expect(observed.mounts?.find(mount => mount.destination === '/cauce/executor'))
    .toMatchObject({ type: 'bind', writable: false, source: join(process.cwd(), 'ops/cli') });
  expect(observed.mounts?.find(mount => mount.destination === '/cauce/lifecycle'))
    .toMatchObject({ type: 'bind', writable: false, source: join(process.cwd(), 'ops/container-runtime') });
  for (const path of ['/tmp', '/run']) expect(observed.tmpfs?.[path]).toContain('noexec');
}

async function assertContainerRemoved(environmentId: string): Promise<void> {
  expect(await hostRuntime().inspect(environmentId)).toMatchObject({ present: false, volume_present: false });
}

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 1000 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function register(page: V4Page, person: typeof owner): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, person);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function apiMutation(page: V4Page, method: 'POST' | 'PATCH', path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async ({ target, verb, body }: { target: string; verb: 'POST' | 'PATCH'; body: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, { method: verb, credentials: 'include', body,
      headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
  }, { target: path, verb: method, body: JSON.stringify(payload) });
}

async function apiDelete(page: V4Page, path: string): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async (target: string) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, { method: 'DELETE', credentials: 'include',
      headers: { 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
  }, path);
}

interface QuotaEnvironmentView { id: string; account_id: string; host_id: string; label: string; status: string; version: number }
interface QuotaEnvironmentSnapshot { environments: QuotaEnvironmentView[]; operations: { environment_id: string; action: string; status: string }[] }

async function quotaSnapshot(page: V4Page): Promise<QuotaEnvironmentSnapshot> {
  const response = await apiGet(page, '/v3/console/quota-environments');
  expect(response.status).toBe(200);
  return response.body as unknown as QuotaEnvironmentSnapshot;
}

async function createEnvironment(page: V4Page, label: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Crear entorno de cuotas' });
  await form.locator('select').nth(0).selectOption(accountId);
  await form.locator('select').nth(1).selectOption(quotaHost);
  await form.getByLabel('Nombre del entorno', { exact: true }).fill(label);
  await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
  await page.getByRole('article', { name: `Entorno ${label}`, exact: true }).waitFor({ timeout: 20_000 });
}

async function editEnvironment(page: V4Page, oldLabel: string, newLabel: string): Promise<void> {
  const card = page.getByRole('article', { name: `Entorno ${oldLabel}`, exact: true });
  await card.getByRole('button', { name: 'Editar entorno', exact: true }).click();
  const form = page.getByRole('form', { name: 'Editar entorno de cuotas' });
  await form.getByLabel('Nombre del entorno', { exact: true }).fill(newLabel);
  await form.getByRole('button', { name: 'Guardar entorno', exact: true }).click();
  await page.getByText('Configuración del entorno guardada.', { exact: true }).waitFor({ timeout: 20_000 });
  await page.getByRole('article', { name: `Entorno ${newLabel}`, exact: true }).waitFor({ timeout: 20_000 });
}

async function deleteEnvironment(page: V4Page, label: string): Promise<void> {
  const card = page.getByRole('article', { name: `Entorno ${label}`, exact: true });
  await card.getByRole('button', { name: 'Eliminar entorno', exact: true }).click();
  await page.getByRole('region', { name: 'Confirmar operación del entorno', exact: true })
    .getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await page.getByText('Eliminar entorno: solicitud registrada. Su estado aparece en el entorno.', { exact: true }).waitFor({ timeout: 20_000 });
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  quotaImage = await prepareQuotaDockerImage(evidenceDirectory);
  fixture = await startConsoleFunctionalFixture();
}, 900_000);

afterAll(async () => {
  try { await quotaHostRuntime?.close(); }
  finally {
    try { await fixture?.close(); }
    finally { if (quotaImage) await removeQuotaDockerImage(evidenceDirectory); }
  }
}, 180_000);

describe('entornos de cuota V4 en navegador real contra gateway y PostgreSQL reales', () => {
  it('el dueño crea la cuenta y rechaza un nombre de entorno inválido en español', async () => {
    const page = await freshPage('quota-owner');
    ownerPage = page;
    await step(page, 'registro de empresa y dueño', async () => register(page, owner));

    quotaHostRuntime = await startQuotaDockerHost(active(), owner, quotaHost, quotaImage, evidenceDirectory);
    await pool().query(`UPDATE fleet_hosts SET display_name=$2 WHERE host_id=$1`, [quotaHost, quotaHostName]);
    await pool().query(`UPDATE fleet_host_enrollments SET display_name=$2 WHERE host_id=$1`, [quotaHost, quotaHostName]);

    await step(page, 'registrar cuenta para el entorno', async () => {
      await page.goto(`${base()}/my-quotas`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      const form = page.getByRole('form', { name: 'Registrar cuenta de cuotas' });
      expect(await page.evaluate(() => {
        const select = document.querySelector<HTMLSelectElement>('form[aria-label="Registrar cuenta de cuotas"] select');
        if (!select) throw new Error('quota provider selector is unavailable');
        return Array.from(select.options, option => option.value);
      }))
        .not.toContain('gemini');
      await form.getByLabel('Nombre de la cuenta', { exact: true }).fill(accountLabel);
      await form.locator('select').selectOption('codex');
      await form.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      await page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }).waitFor({ timeout: 20_000 });
    });
    const accounts = await apiGet(page, '/v3/console/quota-accounts');
    expect(accounts.status).toBe(200);
    const rows = (accounts.body as unknown as { accounts: { id: string; label: string; provider: string; version: number }[] }).accounts;
    const account = rows.find(item => item.label === accountLabel);
    accountId = account?.id ?? '';
    accountVersion = account?.version ?? 0;
    expect(accountId).not.toBe('');
    expect(account?.provider).toBe('codex');
    expect(typeof account?.version).toBe('number');

    await step(page, 'el servidor rechaza un nombre de entorno de más de 80 caracteres', async () => {
      const form = page.getByRole('form', { name: 'Crear entorno de cuotas' });
      await form.locator('select').nth(0).selectOption(accountId);
      await form.locator('select').nth(1).selectOption(quotaHost);
      const invalidLabel = 'x'.repeat(81);
      await page.evaluate((value: string) => {
        const input = document.querySelector<HTMLInputElement>('form[aria-label="Crear entorno de cuotas"] input');
        if (!input || !Reflect.set(HTMLInputElement.prototype, 'value', value, input)) {
          throw new Error('quota environment label input is unavailable');
        }
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, invalidLabel);
      expect(await form.getByLabel('Nombre del entorno', { exact: true }).inputValue()).toBe(invalidLabel);
      errors.expectHttpError('/v3/console/quota-environments', 400);
      await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
      const alert = page.getByRole('alert');
      await alert.waitFor({ timeout: 20_000 });
      expect(await alert.innerText()).toBe('El servidor rechazó los datos enviados. Revísalos e inténtalo de nuevo.');
      expect((await quotaSnapshot(page)).environments.some(item => item.label === invalidLabel)).toBe(false);

      errors.expectHttpError('/v3/console/quota-environments', 400);
      const invalidHost = await apiMutation(page, 'POST', '/v3/console/quota-environments', {
        account_id: accountId, host_id: 'host inválido', label: `zz-canary-invalid-host-${run}`,
        idempotency_key: `zz-canary-invalid-host-${run}`,
      });
      expect(invalidHost.status).toBe(400);
      expect(invalidHost.body).toMatchObject({ error: 'invalid_request' });

      errors.expectHttpError('/v3/console/quota-environments', 400);
      const emptyName = await apiMutation(page, 'POST', '/v3/console/quota-environments', {
        account_id: accountId, host_id: quotaHost, label: '', idempotency_key: `zz-canary-empty-name-${run}`,
      });
      expect(emptyName.status).toBe(400);
      expect(emptyName.body).toMatchObject({ error: 'invalid_request' });

      const nameInput = form.getByLabel('Nombre del entorno', { exact: true });
      await nameInput.fill('');
      expect(await nameInput.evaluate(input => ({ required: input.required, valueMissing: input.validity.valueMissing })))
        .toEqual({ required: true, valueMissing: true });
      expect(await form.getByRole('button', { name: 'Crear entorno', exact: true }).isDisabled()).toBe(true);
      expect((await quotaSnapshot(page)).environments).toEqual([]);
    });
  });

  it('el dueño crea, edita y elimina su entorno con confirmación persistida', async () => {
    const page = companyOwnerPage();
    await step(page, 'crear entorno', async () => createEnvironment(page, ownerEnvironment));
    const created = await quotaSnapshot(page);
    const environment = created.environments.find(item => item.label === ownerEnvironment);
    expect(environment).toMatchObject({ account_id: accountId, host_id: quotaHost });
    ownerEnvironmentId = environment?.id ?? '';
    expect(ownerEnvironmentId).not.toBe('');
    expect(created.operations.find(item => item.environment_id === ownerEnvironmentId)).toMatchObject({ action: 'create' });

    const createReceipt = await hostRuntime().waitOperation(ownerEnvironmentId, 'create');
    expect(createReceipt.worker_id).toBe(`host-${quotaHost}`);
    expect(createReceipt.result.cli_version).toBe(quotaImage.versions.codex);
    await assertContainerIsolation(ownerEnvironmentId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Preparado', { exact: true }).waitFor({ timeout: 20_000 });
    await step(page, 'editar entorno y rechazar un nombre vacío tras recortar espacios', async () => {
      const card = page.getByRole('article', { name: `Entorno ${ownerEnvironment}`, exact: true });
      await card.getByRole('button', { name: 'Editar entorno', exact: true }).click();
      const form = page.getByRole('form', { name: 'Editar entorno de cuotas' });
      const nameInput = form.getByLabel('Nombre del entorno', { exact: true });
      await nameInput.fill('   ');
      expect(await nameInput.inputValue()).toBe('   ');
      errors.expectHttpError(`/v3/console/quota-environments/${ownerEnvironmentId}`, 400);
      await form.getByRole('button', { name: 'Guardar entorno', exact: true }).click();
      const alert = page.getByRole('alert');
      await alert.waitFor({ timeout: 20_000 });
      expect(await alert.innerText()).toBe('El servidor rechazó los datos enviados. Revísalos e inténtalo de nuevo.');
      expect((await quotaSnapshot(page)).environments.find(item => item.id === ownerEnvironmentId))
        .toMatchObject({ label: ownerEnvironment, status: 'ready' });

      await nameInput.fill(ownerEnvironmentEdited);
      await form.getByRole('button', { name: 'Guardar entorno', exact: true }).click();
      await page.getByText('Configuración del entorno guardada.', { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('article', { name: `Entorno ${ownerEnvironmentEdited}`, exact: true }).waitFor({ timeout: 20_000 });
    });
    let state = await quotaSnapshot(page);
    const edited = state.environments.find(item => item.id === ownerEnvironmentId);
    expect(edited).toMatchObject({ label: ownerEnvironmentEdited, status: 'ready' });
    expect(edited?.version).toBeGreaterThan(environment?.version ?? 0);

    await step(page, 'consulta negativa con el lector real sin una sesión del proveedor', async () => {
      await page.getByRole('article', { name: `Entorno ${ownerEnvironmentEdited}`, exact: true })
        .getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
      await hostRuntime().waitOperation(ownerEnvironmentId, 'query');
      const result = (await pool().query<{ result: { observation_status: string; provider_report: { ok: boolean; windows: unknown[] } } }>(
        "SELECT result FROM quota_environment_operations WHERE environment_id=$1 AND action='query' ORDER BY created_at DESC LIMIT 1",
        [ownerEnvironmentId])).rows[0]?.result;
      expect(result?.observation_status).toBe('error');
      expect(result?.provider_report).toMatchObject({ ok: false, windows: [] });
      expect((await pool().query('SELECT quota_identity_hash FROM provider_accounts WHERE id=$1', [accountId])).rows)
        .toEqual([{ quota_identity_hash: null }]);
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await step(page, 'actualizar el CLI real y consultar de nuevo', async () => {
      await page.getByRole('article', { name: `Entorno ${ownerEnvironmentEdited}`, exact: true })
        .getByRole('button', { name: 'Actualizar CLI', exact: true }).click();
      const updated = await hostRuntime().waitOperation(ownerEnvironmentId, 'update_cli');
      expect(updated.worker_id).toBe(`host-${quotaHost}`);
      expect(updated.result.cli_version).toMatch(/^codex-cli \d+\.\d+\.\d+/u);
      await assertContainerIsolation(ownerEnvironmentId);
      await page.reload({ waitUntil: 'domcontentloaded' });
      const previous = (await pool().query<{ id: string }>(
        "SELECT id FROM quota_environment_operations WHERE environment_id=$1 AND action='query' ORDER BY created_at DESC LIMIT 1", [ownerEnvironmentId])).rows[0];
      if (!previous) throw new Error('quota observation before CLI update is missing');
      await page.getByRole('article', { name: `Entorno ${ownerEnvironmentEdited}`, exact: true })
        .getByRole('button', { name: 'Consultar cuotas', exact: true }).click();
      const afterUpdate = await hostRuntime().waitOperation(ownerEnvironmentId, 'query', { afterId: previous.id });
      expect(afterUpdate.worker_id).toBe(`host-${quotaHost}`);
      expect(afterUpdate.result).toMatchObject({ cli_version: updated.result.cli_version,
        observation_status: 'error', provider_report: { ok: false, windows: [] } });
    });
    await page.reload({ waitUntil: 'domcontentloaded' });

    await step(page, 'eliminar entorno', async () => deleteEnvironment(page, ownerEnvironmentEdited));
    state = await quotaSnapshot(page);
    expect(state.operations.find(item => item.environment_id === ownerEnvironmentId)).toMatchObject({ action: 'delete' });
    await hostRuntime().waitOperation(ownerEnvironmentId, 'delete');
    await assertContainerRemoved(ownerEnvironmentId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('article', { name: `Entorno ${ownerEnvironmentEdited}`, exact: true })
      .getByText('Eliminado', { exact: true }).waitFor({ timeout: 20_000 });
    const persisted = await pool().query<{ label: string; status: string }>(
      'SELECT label,status FROM quota_environments WHERE id=$1 AND company_id=$2', [ownerEnvironmentId, owner.company.slug]);
    expect(persisted.rows).toEqual([{ label: ownerEnvironmentEdited, status: 'deleted' }]);
    expect((await pool().query<{ status: string }>(
      "SELECT status FROM quota_environment_operations WHERE environment_id=$1 AND action='delete'", [ownerEnvironmentId])).rows).toEqual([{ status: 'done' }]);
  }, 300_000);

  it('prepara la autenticación web con el CLI real y cancelar conserva la identidad sin verificar', async () => {
    const page = companyOwnerPage();
    const label = `zz-canary-login-environment-${run}`;
    await createEnvironment(page, label);
    const environment = (await quotaSnapshot(page)).environments.find(item => item.label === label);
    if (!environment) throw new Error('quota login environment was not created');
    await hostRuntime().waitOperation(environment.id, 'create');
    await page.reload({ waitUntil: 'domcontentloaded' });
    const card = page.getByRole('article', { name: `Entorno ${label}`, exact: true });
    await card.getByRole('button', { name: 'Autenticar cuenta', exact: true }).click();
    await page.getByRole('region', { name: 'Confirmar operación del entorno', exact: true })
      .getByRole('button', { name: 'Confirmar autenticación', exact: true }).click();
    await hostRuntime().waitOperation(environment.id, 'authenticate', { status: 'awaiting_auth' });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await Promise.all([
      waitForQuotaAuthenticationStream(page),
      card.getByRole('button', { name: 'Conectar cuenta', exact: true }).click(),
    ]);
    await card.getByLabel('Terminal privada de autenticación', { exact: true }).waitFor({ timeout: 30_000 });
    await card.getByRole('button', { name: 'Cancelar conexión', exact: true }).click();
    await card.getByText('Conexión cancelada', { exact: true }).waitFor({ timeout: 20_000 });
    await hostRuntime().waitOperation(environment.id, 'authenticate', { status: 'failed' });
    expect((await pool().query('SELECT quota_identity_hash,enabled FROM provider_accounts WHERE id=$1', [accountId])).rows)
      .toEqual([{ quota_identity_hash: null, enabled: false }]);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await deleteEnvironment(page, label);
    await hostRuntime().waitOperation(environment.id, 'delete');
    await assertContainerRemoved(environment.id);
  }, 180_000);

  it('una empresa distinta no ve ni puede modificar cuentas o entornos por la UI o la API', async () => {
    const page = await freshPage('quota-foreign-company');
    await step(page, 'registro de segunda empresa', async () => register(page, foreignOwner));
    await page.goto(`${base()}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    await page.getByText('Aún no hay cuentas. Registra una suscripción para empezar.', { exact: true }).waitFor({ timeout: 20_000 });
    await page.getByText('No hay entornos de consulta. Registra una cuenta y crea su entorno.', { exact: true }).waitFor({ timeout: 20_000 });
    expect(await page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true }).count()).toBe(0);
    expect(await page.getByRole('article', { name: `Entorno ${ownerEnvironmentEdited}`, exact: true }).count()).toBe(0);

    const accounts = await apiGet(page, '/v3/console/quota-accounts');
    const environments = await quotaSnapshot(page);
    expect(accounts.status).toBe(200);
    expect((accounts.body as unknown as { accounts: { id: string }[] }).accounts).toEqual([]);
    expect(environments.environments).toEqual([]);
    const foreignEnvironmentPath = `/v3/console/quota-environments/${ownerEnvironmentId}`;
    errors.expectHttpError(foreignEnvironmentPath, 404);
    const directRead = await apiGet(page, foreignEnvironmentPath);
    expect(directRead.status).toBe(404);
    errors.expectHttpError(foreignEnvironmentPath, 404);
    const directMutation = await apiMutation(page, 'PATCH', `/v3/console/quota-environments/${ownerEnvironmentId}`, {
      expected_version: 3, label: `zz-canary-foreign-takeover-${run}`,
    });
    expect(directMutation.status).toBe(404);
    errors.expectHttpError(foreignEnvironmentPath, 404);
    const directDelete = await apiDelete(page,
      `${foreignEnvironmentPath}?expected_version=1&idempotency_key=zz-canary-foreign-delete-${run}`);
    expect(directDelete.status).toBe(404);
    expect((await pool().query<{ label: string; status: string }>(
      'SELECT label,status FROM quota_environments WHERE id=$1 AND company_id=$2', [ownerEnvironmentId, owner.company.slug])).rows)
      .toEqual([{ label: ownerEnvironmentEdited, status: 'deleted' }]);
    errors.expectHttpError(`/v3/console/quota-accounts/${accountId}`, 404);
    const foreignAccountMutation = await apiMutation(page, 'PATCH', `/v3/console/quota-accounts/${accountId}`, {
      expected_version: accountVersion, label: `zz-canary-foreign-account-${run}`,
    });
    expect(foreignAccountMutation.status).toBe(404);
    expect((await pool().query('SELECT 1 FROM quota_environments WHERE id=$1 AND label=$2',
      [ownerEnvironmentId, `zz-canary-foreign-takeover-${run}`])).rowCount).toBe(0);
    expect((await pool().query('SELECT 1 FROM provider_accounts WHERE id=$1 AND label=$2',
      [accountId, `zz-canary-foreign-account-${run}`])).rowCount).toBe(0);
  });

  it('company_admin gestiona entornos, pero la UI y la API le niegan el CRUD de cuentas', async () => {
    const admin = await seedQuotaCompanyAdmin(pool(), owner, run);
    const page = await freshPage('quota-company-admin');
    await step(page, 'iniciar sesión como administrador de empresa', async () => login(page, base(), admin));
    await page.goto(`${base()}/my-quotas`, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
    expect((await apiGet(page, '/v3/auth/session')).body).toMatchObject({ authority: { role: 'company_admin', acting_company: owner.company.slug } });

    const accountCard = page.getByRole('article', { name: `Cuotas de ${accountLabel}`, exact: true });
    await accountCard.waitFor({ timeout: 20_000 });
    expect(await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled()).toBe(true);
    expect(await accountCard.getByRole('button', { name: 'Editar cuenta', exact: true }).isDisabled()).toBe(true);
    expect(await accountCard.getByRole('button', { name: 'Eliminar cuenta', exact: true }).isDisabled()).toBe(true);
    errors.expectHttpError('/v3/console/quota-accounts', 403);
    const deniedAccount = await apiMutation(page, 'POST', '/v3/console/quota-accounts', {
      provider: 'codex', label: `zz-canary-admin-forbidden-account-${run}`, idempotency_key: `zz-canary-${run}-admin-account`,
    });
    expect(deniedAccount.status).toBe(403);
    errors.expectHttpError(`/v3/console/quota-accounts/${accountId}`, 403);
    const deniedAccountEdit = await apiMutation(page, 'PATCH', `/v3/console/quota-accounts/${accountId}`, {
      expected_version: accountVersion, label: `zz-canary-admin-forbidden-edit-${run}`,
    });
    expect(deniedAccountEdit.status).toBe(403);
    errors.expectHttpError(`/v3/console/quota-accounts/${accountId}`, 403);
    const deniedAccountDelete = await apiDelete(page, `/v3/console/quota-accounts/${accountId}?expected_version=${String(accountVersion)}`);
    expect(deniedAccountDelete.status).toBe(403);
    const remainingAccounts = (await apiGet(page, '/v3/console/quota-accounts')).body as unknown as { accounts: { label: string }[] };
    expect(remainingAccounts.accounts.map(item => item.label)).toEqual([accountLabel]);

    await step(page, 'crear entorno con rol company_admin', async () => createEnvironment(page, adminEnvironment));
    const created = await quotaSnapshot(page);
    const environment = created.environments.find(item => item.label === adminEnvironment);
    expect(environment).toMatchObject({ account_id: accountId, host_id: quotaHost });
    const environmentId = environment?.id ?? '';
    expect(environmentId).not.toBe('');
    await hostRuntime().waitOperation(environmentId, 'create');
    await assertContainerIsolation(environmentId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Preparado', { exact: true }).waitFor({ timeout: 20_000 });

    await step(page, 'editar entorno con rol company_admin', async () => editEnvironment(page, adminEnvironment, adminEnvironmentEdited));
    await step(page, 'eliminar entorno con rol company_admin', async () => deleteEnvironment(page, adminEnvironmentEdited));
    await hostRuntime().waitOperation(environmentId, 'delete');
    await assertContainerRemoved(environmentId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('article', { name: `Entorno ${adminEnvironmentEdited}`, exact: true })
      .getByText('Eliminado', { exact: true }).waitFor({ timeout: 20_000 });
    expect((await pool().query<{ label: string; status: string }>(
      'SELECT label,status FROM quota_environments WHERE id=$1 AND company_id=$2', [environmentId, owner.company.slug])).rows)
      .toEqual([{ label: adminEnvironmentEdited, status: 'deleted' }]);
  });

  it('no deja errores inesperados en la consola del navegador', () => { errors.assertClean(); });

  it('no registra el error de consola del patrón de correo en Chromium', () => {
    expect(errors.ignored.get('invalid-pattern-attribute') ?? 0).toBe(0);
  });
});
