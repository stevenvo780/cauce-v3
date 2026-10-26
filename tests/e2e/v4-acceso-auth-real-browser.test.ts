import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { buildGateway } from '../../services/gateway/src/app.js';
import { HashedMtlsIdentityFileProvider, MtlsAuthProvider, type AuthProvider } from '../../services/gateway/src/auth.js';
import { PostgresConsoleUserStore } from '../../services/gateway/src/console-users.js';
import { PasswordAuthProvider } from '../../services/gateway/src/password-auth.js';
import { isaTenant, newTrustedPage, startConsoleFunctionalFixture, type BrowserResponse } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, bodySnippet, fillRegistration, login, openRegistration, syntheticPerson, validity,
  type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const receipts = join(process.cwd(), '.delegados/v4/recibos/e2e-a1-commit-1025/auth');
const person = (label: string): V4Person => ({
  ...syntheticPerson(label, run), name: `zz-canary-acceso-${label}-${run}`,
  email: `zz-canary-acceso-${label}-${run}@example.test`,
  company: { name: `zz-canary-acceso-${label}-${run}`, slug: `zz-canary-acceso-${label}-${run}` },
});
const owner = person('owner');
const other = person('other');
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
const pageErrors: string[] = [];
const active = () => { if (!fixture) throw new Error('Access fixture unavailable'); return fixture; };

async function screenshot(page: V4Page, name: string): Promise<void> {
  await page.screenshot({ path: join(receipts, `${name}.png`), fullPage: true });
}

async function pageAt(width: number, height: number): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width, height }));
  page.on('pageerror', (error: unknown) => { pageErrors.push(error instanceof Error ? error.message : String(error)); });
  return page;
}

async function account(page: V4Page, name: string): Promise<void> {
  if (await page.getByRole('heading', { name: 'Cuenta y apariencia', exact: true }).isVisible()) return;
  const trigger = page.getByRole('button', { name: `Cuenta de ${name}`, exact: true });
  if (!await trigger.isVisible()) {
    await page.getByRole('button', { name: 'Más', exact: true }).click();
  }
  await trigger.click();
  await page.getByRole('heading', { name: 'Cuenta y apariencia', exact: true }).waitFor({ timeout: 15_000 });
}

async function register(page: V4Page, user: V4Person): Promise<void> {
  const form = await openRegistration(page, active().baseUrl);
  await fillRegistration(form, user);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
  expect((await apiGet(page, '/v3/auth/session')).body).toMatchObject({
    authenticated: true, name: user.name, authority: { role: 'company_owner', acting_company: user.company.slug },
  });
  expect((await active().database.pool.query(`SELECT u.email,a.role,c.name FROM console_users u
    JOIN company_admins a ON a.human_id=u.id AND a.company_id=u.company_id
    JOIN companies c ON c.id=u.company_id WHERE u.email=$1`, [user.email])).rows)
    .toEqual([{ email: user.email, role: 'owner', name: user.company.name }]);
}

async function withGateway(provider: AuthProvider, work: () => Promise<void>): Promise<void> {
  const { pki, database, gatewayUrl, baseUrl } = active();
  await active().app.close();
  const app = await buildGateway({ pool: database.pool, authProvider: provider, consoleOrigins: [baseUrl], https: {
    key: await readFile(pki.server.key), cert: await readFile(pki.server.cert), ca: await readFile(pki.ca.cert),
    requestCert: true, rejectUnauthorized: true,
  } });
  let failure: Error | undefined;
  const errors: unknown[] = [];
  try {
    await app.listen({ host: '127.0.0.1', port: Number(new URL(gatewayUrl).port) });
    await work();
  } catch (cause) { failure = cause instanceof Error ? cause : new Error('Temporary gateway failed', { cause }); }
  finally {
    const outcomes = await Promise.allSettled(active().contexts.splice(0).map(async context => context.close()));
    for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason);
    try { await app.close(); } catch (cause) { errors.push(cause); }
  }
  if (errors.length > 0) throw new AggregateError(failure === undefined ? errors : [failure, ...errors], 'Temporary gateway cleanup failed');
  if (failure !== undefined) throw failure;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('An owned PostgreSQL container is required');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('Mocks are forbidden');
  await mkdir(receipts, { recursive: true });
  fixture = await startConsoleFunctionalFixture({ sessionTtlMs: 90_000 });
}, 600_000);

afterEach(async () => {
  const outcomes = await Promise.allSettled((fixture?.contexts.splice(0) ?? []).map(async context => context.close()));
  const errors: unknown[] = [];
  for (const outcome of outcomes) if (outcome.status === 'rejected') errors.push(outcome.reason);
  if (errors.length > 0) throw new AggregateError(errors, 'Browser context cleanup failed');
});

afterAll(async () => {
  try {
    await fixture?.close();
    await writeFile(join(receipts, 'cleanup.json'), JSON.stringify({
      database: fixture?.database.container.getId(), browser: fixture?.browserContainer, closed: true,
    }, null, 2));
  }
  finally { expect(pageErrors).toEqual([]); }
}, 180_000);

describe('acceso con Chromium, gateway y PostgreSQL reales', () => {
  it('valida registro y credenciales, persiste perfil y tema, cambia de cuenta y cierra la sesión en escritorio', async () => {
    const page = await pageAt(1440, 900);
    try {
      await page.goto(active().baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).waitFor({ timeout: 20_000 });
      expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(false);
      await screenshot(page, 'desktop-login');
      const form = await openRegistration(page, active().baseUrl);
      await fillRegistration(form, { ...owner, password: 'short' });
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      expect((await validity(form.getByLabel('Contraseña', { exact: true }))).valid).toBe(false);
      await fillRegistration(form, { ...owner, company: { ...owner.company, slug: 'Invalid Company' } });
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      expect((await validity(form.getByLabel('Identificador de empresa', { exact: true }))).valid).toBe(false);
      await screenshot(page, 'desktop-registration-validation');
      await fillRegistration(form, { ...owner, name: '   ' });
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('alert').waitFor({ timeout: 15_000 });
      expect(await page.getByRole('alert').innerText()).toContain('Revisa correo, nombre, contraseña');
      expect((await active().database.pool.query('SELECT id FROM companies WHERE id=$1', [owner.company.slug])).rowCount).toBe(0);
      await form.getByRole('button', { name: 'Ya tengo una cuenta', exact: true }).click();
      await page.getByLabel('Correo', { exact: true }).fill(owner.email);
      await page.getByLabel('Contraseña', { exact: true }).fill(owner.password);
      await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      await page.getByRole('alert').waitFor({ timeout: 15_000 });
      expect(await page.getByLabel('Contraseña', { exact: true }).inputValue()).toBe('');
      expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(false);
      await screenshot(page, 'desktop-login-rejected');

      await register(page, owner);
      await account(page, owner.name);
      const company = page.getByRole('region', { name: 'Empresa de la sesión', exact: true });
      expect(await company.getByLabel('Empresa', { exact: true }).isDisabled()).toBe(true);
      await page.getByText('Identidad técnica', { exact: true }).waitFor({ timeout: 15_000 });
      await screenshot(page, 'desktop-account');
      await page.getByRole('button', { name: 'Cerrar cuenta y apariencia', exact: true }).click();
      await page.getByRole('button', { name: `Cuenta de ${owner.name}`, exact: true }).press('ArrowDown');
      await page.getByRole('heading', { name: 'Cuenta y apariencia', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Editar nombre', exact: true }).click();
      await page.getByLabel('Tu nombre', { exact: true }).fill('   ');
      await page.getByRole('button', { name: 'Guardar nombre', exact: true }).click();
      await page.getByText('El nombre debe tener entre 1 y 120 caracteres.', { exact: true }).waitFor();
      await screenshot(page, 'desktop-profile-validation');
      await page.getByLabel('Tu nombre', { exact: true }).fill('x'.repeat(121));
      await page.getByRole('button', { name: 'Guardar nombre', exact: true }).click();
      expect((await apiGet(page, '/v3/auth/session')).body.name).toBe(owner.name);
      await page.getByRole('button', { name: 'Cancelar edición', exact: true }).click();
      expect((await apiGet(page, '/v3/auth/session')).body.name).toBe(owner.name);
      await page.getByRole('button', { name: 'Editar nombre', exact: true }).click();
      await page.getByLabel('Tu nombre', { exact: true }).fill(`${owner.name} edited`);
      await page.getByRole('button', { name: 'Guardar nombre', exact: true }).click();
      await page.getByText('Nombre guardado', { exact: true }).waitFor({ timeout: 15_000 });
      const edited = `${owner.name} edited`;
      expect((await apiGet(page, '/v3/auth/session')).body.name).toBe(edited);
      expect((await active().database.pool.query<{ display_name: string }>(
        'SELECT display_name FROM console_users WHERE email=$1', [owner.email])).rows[0]?.display_name).toBe(edited);
      for (const [label, theme] of [['Oscuro', 'dark'], ['Claro', 'light'], ['Sistema', null]] as const) {
        await page.getByRole('button', { name: label, exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe(theme);
      }
      expect(await page.evaluate(() => localStorage.getItem('cauce.tema'))).toBe('sistema');
      await screenshot(page, 'desktop-profile-saved');
      await page.getByRole('button', { name: 'Cambiar cuenta', exact: true }).click();
      await page.getByRole('button', { name: 'Cancelar cambio', exact: true }).click();
      expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(true);
      await page.getByRole('button', { name: 'Cambiar cuenta', exact: true }).click();
      await screenshot(page, 'desktop-switch-account-confirmation');
      await page.getByRole('button', { name: 'Cerrar sesión y continuar', exact: true }).click();
      await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
      expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(false);
      expect((await page.context().cookies(active().baseUrl)).some(cookie => cookie.name === '__Host-cauce_session')).toBe(false);
      await login(page, active().baseUrl, owner);
      await account(page, edited);
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
      expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(false);
    } catch (cause) {
      await screenshot(page, 'desktop-failure');
      throw new Error(`Desktop access failed: ${await bodySnippet(page)}`, { cause });
    }
  });

  it('rechaza duplicados, registra desde móvil y mantiene el perfil legible sin desbordar', async () => {
    const page = await pageAt(390, 844);
    try {
      const form = await openRegistration(page, active().baseUrl);
      await fillRegistration(form, { ...other, email: owner.email });
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('alert').waitFor({ timeout: 15_000 });
      expect(await page.getByRole('alert').innerText()).toContain('ya están en uso');
      expect((await active().database.pool.query('SELECT id FROM companies WHERE id=$1', [other.company.slug])).rowCount).toBe(0);
      await screenshot(page, 'mobile-registration-duplicate');
      await fillRegistration(form, { ...other, company: { ...other.company, slug: owner.company.slug } });
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await expect.poll(async () => form.getByLabel('Contraseña', { exact: true }).inputValue(), { timeout: 15_000 }).toBe('');
      expect(await page.getByRole('alert').innerText()).toContain('ya están en uso');
      expect((await active().database.pool.query('SELECT id FROM console_users WHERE email=$1', [other.email])).rowCount).toBe(0);
      await register(page, other);
      await account(page, other.name);
      await screenshot(page, 'mobile-account');
      await page.getByRole('button', { name: 'Editar nombre', exact: true }).click();
      await page.getByLabel('Tu nombre', { exact: true }).fill(`${other.name} móvil`);
      await page.getByLabel('Tu nombre', { exact: true }).press('Escape');
      expect((await apiGet(page, '/v3/auth/session')).body.name).toBe(other.name);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await page.getByRole('button', { name: 'Cerrar cuenta y apariencia', exact: true }).click();
    } catch (cause) {
      await screenshot(page, 'mobile-failure');
      throw new Error(`Mobile access failed: ${await bodySnippet(page)}`, { cause });
    }
  });

  it('el límite real de registro se explica sin crear una empresa parcial', async () => {
    const page = await pageAt(390, 844);
    const denied = person('rate');
    const form = await openRegistration(page, active().baseUrl);
    await fillRegistration(form, denied);
    await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
    await page.getByRole('alert').waitFor({ timeout: 15_000 });
    expect(await page.getByRole('alert').innerText()).toContain('Demasiados intentos de registro');
    expect((await active().database.pool.query('SELECT id FROM companies WHERE id=$1', [denied.company.slug])).rowCount).toBe(0);
    await screenshot(page, 'mobile-registration-rate-limit');
  });

  it('el selector de plataforma cambia de empresa y vuelve a origen sin alterar la identidad humana', async () => {
    await active().database.pool.query(`INSERT INTO platform_admins(human_id)
      SELECT id FROM console_users WHERE email=$1`, [owner.email]);
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    const name = String((await apiGet(page, '/v3/auth/session')).body.name);
    await account(page, name);
    const select = page.getByRole('region', { name: 'Empresa de la sesión', exact: true }).getByLabel('Empresa', { exact: true });
    await expect.poll(() => select.isDisabled(), { timeout: 15_000 }).toBe(false);
    await select.selectOption(other.company.slug);
    await expect.poll(async () => (await apiGet(page, '/v3/auth/session')).body.authority, { timeout: 15_000 })
      .toMatchObject({ role: 'platform_admin', acting_company: other.company.slug, platform_override: true });
    await account(page, name);
    await page.getByText('Estás operando otra empresa con autoridad de plataforma.', { exact: true }).waitFor();
    await screenshot(page, 'desktop-platform-override');
    await page.getByRole('region', { name: 'Empresa de la sesión', exact: true }).getByLabel('Empresa', { exact: true })
      .selectOption(owner.company.slug);
    await expect.poll(async () => (await apiGet(page, '/v3/auth/session')).body.authority, { timeout: 15_000 })
      .toMatchObject({ acting_company: owner.company.slug, platform_override: false });
    expect((await apiGet(page, '/v3/auth/session')).body.subject).toBe(owner.email);
  });

  it('relee las empresas tras un fallo real de PostgreSQL sin perder la sesión', async () => {
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    const name = String((await apiGet(page, '/v3/auth/session')).body.name);
    const blocker = await active().database.pool.connect();
    const company = page.getByRole('region', { name: 'Empresa de la sesión', exact: true });
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE companies IN ACCESS EXCLUSIVE MODE');
      await account(page, name);
      expect(await company.getByLabel('Empresa', { exact: true }).isDisabled()).toBe(true);
      await screenshot(page, 'desktop-companies-loading');
      await company.getByRole('alert').waitFor({ timeout: 40_000 });
      expect(await company.getByRole('alert').innerText()).toContain('No se pudieron leer las empresas');
      await screenshot(page, 'desktop-companies-error');
      await expect.poll(() => company.getByRole('button', { name: 'Releer empresas', exact: true }).isDisabled(),
        { timeout: 40_000 }).toBe(false);
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
    }
    await company.getByRole('button', { name: 'Releer empresas', exact: true }).click();
    await expect.poll(() => company.getByLabel('Empresa', { exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);
    expect((await apiGet(page, '/v3/console/companies')).status).toBe(200);
    expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(true);
    await screenshot(page, 'desktop-companies-recovered');
  });

  it('muestra la verificación pendiente, cierra ante un timeout real del servidor y recupera con Reintentar', async () => {
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    const blocker = await active().database.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE console_users IN ACCESS EXCLUSIVE MODE');
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByText('Verificando tu sesión con el servidor…', { exact: true }).waitFor({ timeout: 15_000 });
      await screenshot(page, 'desktop-session-checking');
      await page.setViewportSize({ width: 390, height: 844 });
      await screenshot(page, 'mobile-session-checking');
      await page.getByRole('heading', { name: 'No se pudo verificar la sesión', exact: true }).waitFor({ timeout: 40_000 });
      expect(await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).count()).toBe(0);
      await screenshot(page, 'mobile-session-error');
      await page.setViewportSize({ width: 1440, height: 900 });
      await screenshot(page, 'desktop-session-error');
    } finally {
      await blocker.query('ROLLBACK');
      blocker.release();
    }
    await page.getByRole('button', { name: 'Reintentar', exact: true }).click();
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 20_000 });
    expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(true);
  });

  it('el login bloquea sus controles hasta recibir la respuesta real de PostgreSQL', async () => {
    const page = await pageAt(390, 844);
    await page.goto(active().baseUrl, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('Correo', { exact: true }).fill(owner.email);
    await page.getByLabel('Contraseña', { exact: true }).fill(owner.password);
    const blocker = await active().database.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE console_users IN ACCESS EXCLUSIVE MODE');
      await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      await page.getByRole('button', { name: 'Entrando…', exact: true }).waitFor();
      expect(await page.getByLabel('Correo', { exact: true }).isDisabled()).toBe(true);
      expect(await page.getByLabel('Contraseña', { exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).isDisabled()).toBe(true);
      await screenshot(page, 'mobile-login-busy');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 20_000 });
    expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(true);
  });

  it('un fallo real al guardar el perfil conserva el nombre y permite reintentar', async () => {
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    const name = String((await apiGet(page, '/v3/auth/session')).body.name);
    await account(page, name);
    const rejected = `zz-canary-profile-rejected-${run}`;
    await active().database.adminPool.query(`ALTER TABLE console_users ADD CONSTRAINT zz_canary_profile_reject
      CHECK (display_name NOT LIKE 'zz-canary-profile-rejected-%') NOT VALID`);
    const blocker = await active().database.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('SELECT id FROM console_users WHERE email=$1 FOR UPDATE', [owner.email]);
      await page.getByRole('button', { name: 'Editar nombre', exact: true }).click();
      await page.getByLabel('Tu nombre', { exact: true }).fill(rejected);
      await page.getByRole('button', { name: 'Guardar nombre', exact: true }).click();
      await page.getByRole('button', { name: 'Guardando…', exact: true }).waitFor();
      expect(await page.getByLabel('Tu nombre', { exact: true }).isDisabled()).toBe(true);
      await screenshot(page, 'desktop-profile-busy');
      await blocker.query('ROLLBACK');
      await page.getByRole('alert').waitFor({ timeout: 15_000 });
      expect((await apiGet(page, '/v3/auth/session')).body.name).toBe(name);
      expect((await active().database.pool.query<{ display_name: string }>(
        'SELECT display_name FROM console_users WHERE email=$1', [owner.email])).rows[0]?.display_name).toBe(name);
      await screenshot(page, 'desktop-profile-error');
    } finally {
      await blocker.query('ROLLBACK'); blocker.release();
      await active().database.adminPool.query('ALTER TABLE console_users DROP CONSTRAINT zz_canary_profile_reject');
    }
    await page.getByLabel('Tu nombre', { exact: true }).fill(name);
    await page.getByRole('button', { name: 'Guardar nombre', exact: true }).click();
    await page.getByText('Nombre guardado', { exact: true }).waitFor({ timeout: 15_000 });
    expect((await apiGet(page, '/v3/auth/session')).body.name).toBe(name);
  });

  it('el cierre bloquea controles y permite reintentar tras perder la conexión real', async () => {
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    await account(page, String((await apiGet(page, '/v3/auth/session')).body.name));
    const blocker = await active().database.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE console_users IN ACCESS EXCLUSIVE MODE');
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      await page.getByRole('button', { name: 'Cerrando…', exact: true }).waitFor();
      expect(await page.getByRole('button', { name: 'Cerrando…', exact: true }).isDisabled()).toBe(true);
      expect(await page.getByRole('button', { name: 'Cambiar cuenta', exact: true }).isDisabled()).toBe(true);
      await screenshot(page, 'desktop-logout-busy');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
    await login(page, active().baseUrl, owner);
    await account(page, String((await apiGet(page, '/v3/auth/session')).body.name));
    await page.getByText('El servidor usa esta identidad para enrutar y comprobar permisos. No es el nombre de la persona.', { exact: true })
      .waitFor({ timeout: 20_000 });
    const context = page.context() as ReturnType<V4Page['context']> & { setOffline(value: boolean): Promise<void> };
    try {
      await context.setOffline(true);
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'Failed to fetch' }).waitFor({ timeout: 15_000 });
      await screenshot(page, 'desktop-logout-error');
    } finally { await context.setOffline(false); }
    expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(true);
    await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
    await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
    expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(false);
  });

  it('el registro explica la pérdida real de conexión y el timeout sin crear filas parciales', async () => {
    const page = await pageAt(390, 844);
    const pending = person('unavailable');
    const form = await openRegistration(page, active().baseUrl);
    const context = page.context() as ReturnType<V4Page['context']> & { setOffline(value: boolean): Promise<void> };
    await fillRegistration(form, pending);
    try {
      await context.setOffline(true);
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'No se pudo contactar con el servidor' }).waitFor({ timeout: 15_000 });
      expect(await form.getByLabel('Contraseña', { exact: true }).inputValue()).toBe('');
      await screenshot(page, 'mobile-registration-offline');
    } finally { await context.setOffline(false); }
    await fillRegistration(form, pending);
    const blocker = await active().database.pool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE companies IN ACCESS EXCLUSIVE MODE');
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await form.getByRole('button', { name: 'Creando cuenta y empresa…', exact: true }).waitFor();
      for (const label of ['Tu nombre', 'Correo', 'Contraseña', 'Nombre de empresa', 'Identificador de empresa']) {
        expect(await form.getByLabel(label, { exact: true }).isDisabled()).toBe(true);
      }
      expect(await form.getByRole('button', { name: 'Ya tengo una cuenta', exact: true }).isDisabled()).toBe(true);
      await screenshot(page, 'mobile-registration-busy');
      await page.getByRole('alert').filter({ hasText: 'Antes de reintentar, prueba a iniciar sesión' }).waitFor({ timeout: 40_000 });
      await screenshot(page, 'mobile-registration-timeout');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    expect((await active().database.pool.query('SELECT id FROM companies WHERE id=$1', [pending.company.slug])).rowCount).toBe(0);
    expect((await active().database.pool.query('SELECT id FROM console_users WHERE email=$1', [pending.email])).rowCount).toBe(0);
  });

  it('el registro informa indisponibilidad real de PostgreSQL sin crear una cuenta parcial', async () => {
    const page = await pageAt(390, 844);
    const unavailable = person('server');
    const form = await openRegistration(page, active().baseUrl);
    await fillRegistration(form, unavailable);
    await active().database.adminPool.query('ALTER TABLE companies RENAME TO zz_canary_companies_unavailable');
    try {
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'El registro no está disponible ahora' }).waitFor({ timeout: 15_000 });
      await screenshot(page, 'mobile-registration-server-error');
    } finally {
      await active().database.adminPool.query('ALTER TABLE zz_canary_companies_unavailable RENAME TO companies');
    }
    expect((await active().database.pool.query('SELECT id FROM companies WHERE id=$1', [unavailable.company.slug])).rowCount).toBe(0);
    expect((await active().database.pool.query('SELECT id FROM console_users WHERE email=$1', [unavailable.email])).rowCount).toBe(0);
  });

  it('el menú reintenta la identidad técnica tras recuperar la tabla real de permisos', async () => {
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    const name = String((await apiGet(page, '/v3/auth/session')).body.name);
    await active().database.adminPool.query('ALTER TABLE role_policies RENAME TO zz_canary_role_policies_unavailable');
    try {
      await page.reload({ waitUntil: 'domcontentloaded' });
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 20_000 });
      await account(page, name);
      await page.getByText('No se pudo verificar la identidad técnica.', { exact: true }).waitFor({ timeout: 20_000 });
      expect((await apiGet(page, '/v3/console/access')).status).toBe(400);
      await screenshot(page, 'desktop-identity-error');
    } finally {
      await active().database.adminPool.query('ALTER TABLE zz_canary_role_policies_unavailable RENAME TO role_policies');
    }
    await page.getByRole('button', { name: 'Reintentar identidad', exact: true }).click();
    await page.getByText('El servidor usa esta identidad para enrutar y comprobar permisos. No es el nombre de la persona.', { exact: true })
      .waitFor({ timeout: 20_000 });
    expect((await apiGet(page, '/v3/console/access')).status).toBe(200);
    await screenshot(page, 'desktop-identity-recovered');
  });

  it('el selector rechaza un destino deshabilitado después de cargar la lista y conserva la empresa de origen', async () => {
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    await account(page, String((await apiGet(page, '/v3/auth/session')).body.name));
    const company = page.getByRole('region', { name: 'Empresa de la sesión', exact: true });
    const select = company.getByLabel('Empresa', { exact: true });
    await expect.poll(() => select.isDisabled(), { timeout: 15_000 }).toBe(false);
    await active().database.pool.query('UPDATE companies SET enabled=false WHERE id=$1', [other.company.slug]);
    try {
      await select.selectOption(other.company.slug);
      await company.getByRole('alert').filter({ hasText: 'Tu sesión no tiene autoridad para cambiar de empresa' })
        .waitFor({ timeout: 15_000 });
      expect((await apiGet(page, '/v3/auth/session')).body.authority).toMatchObject({
        acting_company: owner.company.slug, platform_override: false,
      });
      await screenshot(page, 'desktop-company-destination-disabled');
      await company.getByRole('button', { name: 'Releer empresas', exact: true }).click();
      await expect.poll(() => select.locator(`option[value="${other.company.slug}"]`).isDisabled(), { timeout: 15_000 }).toBe(true);
    } finally {
      await active().database.pool.query('UPDATE companies SET enabled=true WHERE id=$1', [other.company.slug]);
    }
  });

  it('el selector vuelve a la autoridad vigente cuando se revoca el rol de plataforma en PostgreSQL', async () => {
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    const name = String((await apiGet(page, '/v3/auth/session')).body.name);
    await account(page, name);
    const select = page.getByRole('region', { name: 'Empresa de la sesión', exact: true }).getByLabel('Empresa', { exact: true });
    await expect.poll(() => select.isDisabled(), { timeout: 15_000 }).toBe(false);
    await active().database.pool.query('INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1', [other.email]);
    try {
      await active().database.pool.query('DELETE FROM platform_admins WHERE human_id=(SELECT id FROM console_users WHERE email=$1)', [owner.email]);
      await select.selectOption(other.company.slug);
      await expect.poll(async () => (await apiGet(page, '/v3/auth/session')).body.authority, { timeout: 15_000 })
        .toMatchObject({ role: 'company_owner', acting_company: owner.company.slug, platform_override: false });
      await page.getByRole('heading', { name: 'Cuenta y apariencia', exact: true }).waitFor({ state: 'hidden', timeout: 15_000 });
      await account(page, name);
      expect(await page.getByRole('region', { name: 'Empresa de la sesión', exact: true }).getByLabel('Empresa', { exact: true }).isDisabled())
        .toBe(true);
      await screenshot(page, 'desktop-platform-authority-revoked');
    } finally {
      await active().database.pool.query('INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1 ON CONFLICT DO NOTHING', [owner.email]);
      await active().database.pool.query('DELETE FROM platform_admins WHERE human_id=(SELECT id FROM console_users WHERE email=$1)', [other.email]);
    }
  });

  it('una sesión vencida vuelve al formulario sin conservar la consola', async () => {
    const page = await pageAt(1440, 900);
    await login(page, active().baseUrl, owner);
    const session = await apiGet(page, '/v3/auth/session');
    if (typeof session.body.expires_at !== 'string') throw new Error('Missing server expiration');
    const remaining = Date.parse(session.body.expires_at) - Date.now() + 1_000;
    if (remaining > 0) await page.waitForTimeout(remaining);
    await page.evaluate(() => { window.dispatchEvent(new Event('focus')); });
    await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 15_000 });
    expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(false);
    expect(await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).count()).toBe(0);
    await screenshot(page, 'desktop-session-expired');
    await page.setViewportSize({ width: 390, height: 844 });
    await screenshot(page, 'mobile-session-expired');
  });

  it('una empresa retirada cierra las vistas protegidas y permite cerrar la sesión en escritorio y móvil', async () => {
    await active().database.pool.query('UPDATE companies SET enabled=false,retired_at=clock_timestamp() WHERE id=$1', [other.company.slug]);
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const page = await pageAt(viewport.width, viewport.height);
      await page.goto(active().baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByLabel('Correo', { exact: true }).fill(other.email);
      await page.getByLabel('Contraseña', { exact: true }).fill(other.password);
      await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      await page.getByRole('heading', { name: 'Tu cuenta no tiene acceso vigente', exact: true }).waitFor({ timeout: 20_000 });
      expect((await apiGet(page, '/v3/auth/session')).body).toMatchObject({ authenticated: true, authority: { role: 'none' } });
      expect((await apiGet(page, '/v3/console/companies')).status).toBe(403);
      expect(await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).count()).toBe(0);
      await screenshot(page, `${viewport.width === 390 ? 'mobile' : 'desktop'}-retired-company`);
      await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).click();
      await page.getByLabel('Correo', { exact: true }).waitFor({ timeout: 15_000 });
      expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(false);
    }
  });

  it('una cuenta creada conserva el registro cuando el límite real de login impide la entrada automática', async () => {
    const provider = new PasswordAuthProvider({ users: new PostgresConsoleUserStore(active().database.pool), signingKey: randomBytes(32) });
    await provider.ready();
    await withGateway(provider, async () => {
      const page = await pageAt(390, 844);
      const user = person('automatic');
      const loginResponses: number[] = [];
      page.on('response', (value: unknown) => {
        const response = value as BrowserResponse;
        if (new URL(response.url()).pathname === '/v3/auth/login' && response.request().method() === 'POST') {
          loginResponses.push(response.status());
        }
      });
      await page.goto(active().baseUrl, { waitUntil: 'domcontentloaded' });
      for (let attempt = 0; attempt < 9; attempt += 1) {
        await page.getByLabel('Correo', { exact: true }).fill(user.email);
        await page.getByLabel('Contraseña', { exact: true }).fill(user.password);
        await page.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
        await expect.poll(() => page.getByLabel('Contraseña', { exact: true }).inputValue(), { timeout: 15_000 }).toBe('');
        await page.getByRole('alert').waitFor({ timeout: 15_000 });
      }
      expect(loginResponses.at(-1)).toBe(429);
      expect(await page.getByRole('alert').innerText()).toContain('Demasiados intentos fallidos');
      const form = await openRegistration(page, active().baseUrl);
      await fillRegistration(form, user);
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'No se pudo iniciar sesión automáticamente' }).waitFor({ timeout: 20_000 });
      await page.getByText('Cuenta y empresa creadas.', { exact: true }).waitFor();
      expect((await active().database.pool.query(`SELECT a.role,c.id FROM console_users u
        JOIN company_admins a ON a.human_id=u.id AND a.company_id=u.company_id
        JOIN companies c ON c.id=u.company_id WHERE u.email=$1`, [user.email])).rows)
        .toEqual([{ role: 'owner', id: user.company.slug }]);
      expect((await apiGet(page, '/v3/auth/session')).body.authenticated).toBe(false);
      await screenshot(page, 'mobile-registration-auto-login-error');
      await page.getByRole('button', { name: 'Ir a iniciar sesión', exact: true }).click();
      await page.getByLabel('Correo', { exact: true }).waitFor();
    });
  });

  it('el gateway mTLS real informa la ausencia de login y el menú ofrece apariencia sin cierre de usuario', async () => {
    await active().database.pool.query(`INSERT INTO agents(
      tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory)
      VALUES ($1,'e2eproxy','fake',$2,true,$2,'stev',$3,$3)`,
    [isaTenant.tenant, `zz-canary-acceso-mtls-${run}`, active().directory]);
    await active().database.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
      VALUES ($1,$2,'e2eproxy','adapter')`, [isaTenant.tenant, isaTenant.room]);
    const provider = new MtlsAuthProvider(new HashedMtlsIdentityFileProvider(active().pki.identityPath));
    await withGateway(provider, async () => {
      const page = await pageAt(1440, 900);
      await page.goto(active().baseUrl, { waitUntil: 'domcontentloaded' });
      await page.getByText('Esta consola no tiene login de usuario.', { exact: true }).waitFor({ timeout: 20_000 });
      expect((await apiGet(page, '/v3/console/access')).status).toBe(200);
      for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
        await page.setViewportSize(viewport);
        const trigger = page.getByRole('button', { name: 'Cuenta y apariencia', exact: true });
        if (!await trigger.isVisible()) await page.getByRole('button', { name: 'Más', exact: true }).click();
        await trigger.click();
        await page.getByText('Sin login de verdad: no hay sesión de usuario que cerrar.', { exact: true }).waitFor();
        expect(await page.getByRole('button', { name: 'Cerrar sesión', exact: true }).count()).toBe(0);
        expect(await page.getByRole('button', { name: 'Cambiar cuenta', exact: true }).count()).toBe(0);
        await page.getByRole('button', { name: 'Oscuro', exact: true }).click();
        expect(await page.evaluate(() => document.documentElement.getAttribute('data-theme'))).toBe('dark');
        await screenshot(page, viewport.width === 390 ? 'mobile-unmanaged-account' : 'desktop-unmanaged-account');
        await page.getByRole('button', { name: 'Cerrar cuenta y apariencia', exact: true }).click();
      }
    });
  });
});
