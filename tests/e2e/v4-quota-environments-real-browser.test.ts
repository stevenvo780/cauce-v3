import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { seedQuotaHost } from './v4-console-real-browser.quotas.js';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES, login,
  openRegistration, PATTERN_DEFECT_RULE, type V4Page,
} from './v4-console-real-browser.helpers.js';
import { finishQuotaOperation, quotaCanaryPerson, seedQuotaCompanyAdmin } from './v4-quota-environments-real-browser.fixtures.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const owner = quotaCanaryPerson('owner', run);
const foreignOwner = quotaCanaryPerson('foreign-owner', run);
const accountLabel = `zz-canary-account-${run}`;
const quotaHost = `zz-canary-quota-host-${run}`;
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

const active = () => { if (!fixture) throw new Error('quota browser fixture is not initialized'); return fixture; };
const pool = () => active().database.pool;
const base = () => active().baseUrl;
const companyOwnerPage = () => { if (!ownerPage) throw new Error('quota company owner has no page'); return ownerPage; };

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
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('entornos de cuota V4 en navegador real contra gateway y PostgreSQL reales', () => {
  it('el dueño crea la cuenta y rechaza un nombre de entorno inválido en español', async () => {
    const page = await freshPage('quota-owner');
    ownerPage = page;
    await step(page, 'registro de empresa y dueño', async () => register(page, owner));

    await seedQuotaHost(pool(), { companyId: owner.company.slug, ownerEmail: owner.email, hostId: quotaHost });
    await pool().query(`UPDATE fleet_hosts SET display_name=$2 WHERE host_id=$1`, [quotaHost, quotaHostName]);
    await pool().query(`UPDATE fleet_host_enrollments SET display_name=$2 WHERE host_id=$1`, [quotaHost, quotaHostName]);

    await step(page, 'registrar cuenta para el entorno', async () => {
      await page.goto(`${base()}/my-quotas`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Mis cuotas', exact: true }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('button', { name: 'Registrar cuenta', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
      await page.getByRole('button', { name: 'Registrar cuenta', exact: true }).click();
      const form = page.getByRole('form', { name: 'Registrar cuenta de cuotas' });
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
    expect(account).toMatchObject({ provider: 'codex', version: expect.any(Number) });

    await step(page, 'el servidor rechaza un nombre de entorno de más de 80 caracteres', async () => {
      const form = page.getByRole('form', { name: 'Crear entorno de cuotas' });
      await form.locator('select').nth(0).selectOption(accountId);
      await form.locator('select').nth(1).selectOption(quotaHost);
      const invalidLabel = 'x'.repeat(81);
      await page.evaluate((value: string) => {
        const input = document.querySelector('form[aria-label="Crear entorno de cuotas"] input') as HTMLInputElement | null;
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
        if (!input || !setter) throw new Error('quota environment label input is unavailable');
        setter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, invalidLabel);
      expect(await form.getByLabel('Nombre del entorno', { exact: true }).inputValue()).toBe(invalidLabel);
      errors.expectHttpError('/v3/console/quota-environments', 400);
      await form.getByRole('button', { name: 'Crear entorno', exact: true }).click();
      const alert = page.getByRole('alert');
      await alert.waitFor({ timeout: 20_000 });
      expect(await alert.innerText()).toBe('El servidor rechazó los datos enviados. Revísalos e inténtalo de nuevo.');
      expect((await quotaSnapshot(page)).environments.some(item => item.label === invalidLabel)).toBe(false);
      await form.getByLabel('Nombre del entorno', { exact: true }).fill('');
    });
  });

  it('el dueño crea, edita y elimina su entorno con confirmación persistida', async () => {
    const page = companyOwnerPage();
    await step(page, 'crear entorno', async () => createEnvironment(page, ownerEnvironment));
    const created = await quotaSnapshot(page);
    const environment = created.environments.find(item => item.label === ownerEnvironment);
    expect(environment).toMatchObject({ account_id: accountId, host_id: quotaHost, status: 'pending' });
    ownerEnvironmentId = environment?.id ?? '';
    expect(ownerEnvironmentId).not.toBe('');
    expect(created.operations.find(item => item.environment_id === ownerEnvironmentId)).toMatchObject({ action: 'create', status: 'pending' });

    expect(await finishQuotaOperation(pool(), run, quotaHost, 'create')).toBe(ownerEnvironmentId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Preparado', { exact: true }).waitFor({ timeout: 20_000 });
    await step(page, 'editar entorno', async () => editEnvironment(page, ownerEnvironment, ownerEnvironmentEdited));
    let state = await quotaSnapshot(page);
    const edited = state.environments.find(item => item.id === ownerEnvironmentId);
    expect(edited).toMatchObject({ label: ownerEnvironmentEdited, status: 'ready' });
    expect(edited?.version).toBeGreaterThan(environment?.version ?? 0);

    await step(page, 'eliminar entorno', async () => deleteEnvironment(page, ownerEnvironmentEdited));
    state = await quotaSnapshot(page);
    expect(state.operations.find(item => item.environment_id === ownerEnvironmentId)).toMatchObject({ action: 'delete', status: 'pending' });
    expect(await finishQuotaOperation(pool(), run, quotaHost, 'delete')).toBe(ownerEnvironmentId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('article', { name: `Entorno ${ownerEnvironmentEdited}`, exact: true })
      .getByText('Eliminado', { exact: true }).waitFor({ timeout: 20_000 });
    const persisted = await pool().query<{ label: string; status: string }>(
      'SELECT label,status FROM quota_environments WHERE id=$1 AND company_id=$2', [ownerEnvironmentId, owner.company.slug]);
    expect(persisted.rows).toEqual([{ label: ownerEnvironmentEdited, status: 'deleted' }]);
    expect((await pool().query<{ status: string }>(
      "SELECT status FROM quota_environment_operations WHERE environment_id=$1 AND action='delete'", [ownerEnvironmentId])).rows).toEqual([{ status: 'done' }]);
  });

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
    errors.expectHttpError(`/v3/console/quota-environments/${ownerEnvironmentId}`, 404);
    const directMutation = await apiMutation(page, 'PATCH', `/v3/console/quota-environments/${ownerEnvironmentId}`, {
      expected_version: 3, label: `zz-canary-foreign-takeover-${run}`,
    });
    expect(directMutation.status).toBe(404);
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
    const deniedAccountDelete = await apiDelete(page, `/v3/console/quota-accounts/${accountId}?expected_version=${accountVersion}`);
    expect(deniedAccountDelete.status).toBe(403);
    expect((await apiGet(page, '/v3/console/quota-accounts')).body as unknown as { accounts: { label: string }[] })
      .toMatchObject({ accounts: [{ label: accountLabel }] });

    await step(page, 'crear entorno con rol company_admin', async () => createEnvironment(page, adminEnvironment));
    const created = await quotaSnapshot(page);
    const environment = created.environments.find(item => item.label === adminEnvironment);
    expect(environment).toMatchObject({ account_id: accountId, host_id: quotaHost, status: 'pending' });
    const environmentId = environment?.id ?? '';
    expect(environmentId).not.toBe('');
    expect(await finishQuotaOperation(pool(), run, quotaHost, 'create')).toBe(environmentId);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('Preparado', { exact: true }).waitFor({ timeout: 20_000 });

    await step(page, 'editar entorno con rol company_admin', async () => editEnvironment(page, adminEnvironment, adminEnvironmentEdited));
    await step(page, 'eliminar entorno con rol company_admin', async () => deleteEnvironment(page, adminEnvironmentEdited));
    expect(await finishQuotaOperation(pool(), run, quotaHost, 'delete')).toBe(environmentId);
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
