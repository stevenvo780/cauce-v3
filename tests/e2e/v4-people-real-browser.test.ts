import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plazo } from '../helpers/plazos.js';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const evidence = join(process.cwd(), '.delegados/v4/recibos/e2e-a1-commit-1025/people');
function registration(label: string): V4Person {
  const person = syntheticPerson(`people-${label}`, run);
  const slug = `zz-canary-people-${label}-${run}`;
  return {
    ...person,
    email: `zz-canary-${label}-${run}@example.test`,
    name: `zz-canary-${label}-${run}`,
    company: { name: `zz-canary-empresa-${label}-${run}`, slug },
  };
}

const ownerA = registration('owner-a');
const ownerB = registration('owner-b');
const employee = {
  email: `zz-canary-person-${run}@example.test`,
  displayName: `zz-canary-person-${run}`,
  password: syntheticPerson('people-employee', run).password,
};
const guardAdmin = {
  email: `zz-canary-guard-admin-${run}@example.test`,
  displayName: `zz-canary-guard-admin-${run}`,
  password: syntheticPerson('people-guard-admin', run).password,
};
const personAlias = `zz-canary-agent-${run}`;
const errors = new BrowserErrorLog([
  ...HERMETIC_INSTANCE_RULES,
  PATTERN_DEFECT_RULE,
  expectedRoleForbidden('/v3/console/fleet/hosts', 'company-operator-host-inventory-403'),
  expectedRoleForbidden('/v3/console/fleet/hosts/enrollments', 'company-operator-host-enrollments-403'),
  expectedRoleForbidden('/v3/console/terminal/capability', 'reader-terminal-capability-403'),
  expectedRoleForbidden('/v3/console/fleet/capability', 'reader-fleet-capability-403'),
  expectedRoleForbidden('/v3/console/fleet/operations/recent', 'reader-fleet-history-403'),
  { id: 'revoked-person-message-poll-401', reason: 'un sondeo de mensajes en vuelo puede concluir tras revocar la sesión',
    matches: (text, url) => {
      try { return text.includes('status of 401') && new URL(url).pathname === '/v3/console/messages'; }
      catch { return false; }
    } },
]);
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let ownerPageA: V4Page | undefined;
let ownerPageB: V4Page | undefined;
let ownerAId = '';
let employeeId = '';
let employeeRevision = '';
let hubA = '';

interface PeopleInventoryPerson {
  id: string;
  email: string;
  role: 'operator' | 'reader';
  revision: string;
  active: boolean;
}

function isPeopleInventoryPerson(value: unknown): value is PeopleInventoryPerson {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  return typeof row.id === 'string' && typeof row.email === 'string'
    && (row.role === 'operator' || row.role === 'reader')
    && typeof row.revision === 'string' && typeof row.active === 'boolean';
}

function peopleItems(body: Record<string, unknown>): PeopleInventoryPerson[] {
  if (!Array.isArray(body.items)) throw new Error('people inventory did not include an item list');
  const rows: unknown[] = body.items;
  if (!rows.every(isPeopleInventoryPerson)) throw new Error('people inventory included an invalid row');
  return rows;
}

function active() {
  if (!fixture) throw new Error('V4 people fixture is not initialized');
  return fixture;
}

function base() { return active().baseUrl; }

async function capture(page: V4Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page.setViewportSize(viewport);
    await page.evaluate(() => {
      const target = document.querySelector('.people-admin [role="alert"]')
        ?? document.querySelector('.people-admin-confirm') ?? document.querySelector('.people-admin-form')
        ?? document.querySelector('.people-admin');
      target?.scrollIntoView({ block: 'center' });
    });
    await page.screenshot({ path: join(evidence, `${name}-${String(viewport.width)}.png`), fullPage: false });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  }
  await page.setViewportSize({ width: 1440, height: 900 });
}

function ownerAView() {
  if (!ownerPageA) throw new Error('owner A has no browser page');
  return ownerPageA;
}

function ownerBView() {
  if (!ownerPageB) throw new Error('owner B has no browser page');
  return ownerPageB;
}

function expectedRoleForbidden(path: string, id: string): IgnoredConsoleRule {
  return { id, reason: 'el rol sin control recibe 403 al consultar una ruta protegida de la consola',
    matches: (text, url) => {
      try { return text.includes('status of 403') && new URL(url).pathname === path; }
      catch { return false; }
    } };
}

function unauthorizedCreatePayload() {
  return { email: `zz-canary-forbidden-${run}@example.test`, display_name: `zz-canary-forbidden-${run}`,
    role: 'operator', tenant_id: hubA, alias: personAlias, active: true, password: syntheticPerson('people-forbidden', run).password };
}

async function freshPage(label: string): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 }));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function registerOwner(page: V4Page, owner: V4Person): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: plazo(30_000) });
}

async function openSection(page: V4Page, section: string): Promise<void> {
  const target = `${base()}/config?seccion=${section}`;
  if (page.url() !== target) {
    await page.goto(target, { waitUntil: 'domcontentloaded' });
  }
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: plazo(20_000) });
}

async function openPeopleAdmin(page: V4Page): Promise<void> {
  await openSection(page, 'acceso');
  await page.getByRole('heading', { name: 'Personas', exact: true }).waitFor({ timeout: 15_000 });
  const adminRegion = page.getByRole('region', { name: 'Administración de personas', exact: true });
  if (await adminRegion.count() === 0) {
    await page.getByRole('button', { name: 'Administrar personas', exact: true }).click();
  }
  await adminRegion.waitFor({ timeout: 15_000 });
}

async function fillPersonForm(page: V4Page, email: string, password: string, displayName = employee.displayName): Promise<void> {
  const form = page.getByRole('form', { name: 'Invitar persona', exact: true });
  await form.getByLabel('Correo de acceso', { exact: true }).fill(email);
  await form.getByLabel('Nombre de persona', { exact: true }).fill(displayName);
  const selects = form.locator('select');
  await selects.nth(0).selectOption('operator');
  await selects.nth(1).selectOption(hubA);
  await selects.nth(2).selectOption(personAlias);
  await form.getByLabel('Contraseña inicial', { exact: true }).fill(password);
}

async function apiMutation(page: V4Page, path: string, method: 'POST' | 'PATCH', payload: unknown): Promise<number> {
  return page.evaluate(async ({ target, verb, body }: { target: string; verb: 'POST' | 'PATCH'; body: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, { method: verb, credentials: 'include', body,
      headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } });
    return response.status;
  }, { target: path, verb: method, body: JSON.stringify(payload) });
}

async function apiDelete(page: V4Page, path: string, payload: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  return page.evaluate(async ({ target, body }: { target: string; body: string }) => {
    const session = await (await fetch('/v3/auth/session', { credentials: 'include', cache: 'no-store' })).json() as { csrf_token?: string };
    const response = await fetch(target, { method: 'DELETE', credentials: 'include', body,
      headers: { 'Content-Type': 'application/json', 'X-Cauce-Console': '1', 'X-CSRF-Token': session.csrf_token ?? '' } });
    return { status: response.status, body: await response.json().catch(() => ({})) as Record<string, unknown> };
  }, { target: path, body: JSON.stringify(payload) });
}

function expectHttpError(path: string, status: number, count = 1): void {
  for (let index = 0; index < count; index += 1) errors.expectHttpError(path, status);
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  fixture = await startConsoleFunctionalFixture();

  ownerPageA = await freshPage('owner-a');
  await registerOwner(ownerAView(), ownerA);
  ownerPageB = await freshPage('owner-b');
  await registerOwner(ownerBView(), ownerB);

  const owner = await active().database.pool.query<{ id: string; tenant_id: string }>(
    'SELECT id::text,tenant_id FROM console_users WHERE email=$1', [ownerA.email]);
  expect(owner.rows).toHaveLength(1);
  ownerAId = owner.rows[0]?.id ?? '';
  expect(ownerAId).toMatch(/^[0-9a-f-]{36}$/u);
  hubA = owner.rows[0]?.tenant_id ?? '';
  expect(hubA).toMatch(/^hub-[a-f0-9]+$/u);
  await active().database.pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,container_name,runtime_user,home_directory,state_directory,company_id)
    VALUES($1,$2,'fake',$2,true,$3,'stev',$4,$5,$6)`,
  [hubA, personAlias, `zz-canary-runtime-${run}`, active().directory, `${active().directory}/state/${personAlias}`, ownerA.company.slug]);
  await active().database.pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role)
    VALUES($1,'office',$2,'operator')`, [hubA, personAlias]);
}, 600_000);

afterAll(async () => { await fixture?.close(); }, 180_000);

describe('personas V4 en navegador real contra gateway y PostgreSQL reales', () => {
  it('correo mal formado: el formulario muestra el rechazo en español', async () => {
    const page = ownerAView();
    await step(page, 'invalid person email', async () => {
      await openPeopleAdmin(page);
      await page.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('button', { name: 'Invitar persona', exact: true }).click();
      const form = page.getByRole('form', { name: 'Invitar persona', exact: true });
      await fillPersonForm(page, 'correo-invalido', employee.password);
      await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      expect(await form.getByLabel('Correo de acceso', { exact: true }).evaluate(element => element.validity.valid)).toBe(false);
      const alert = form.getByRole('alert');
      expect(await alert.count()).toBeGreaterThan(0);
      expect((await alert.innerText()).toLocaleLowerCase()).toMatch(/correo|direcci[oó]n/u);
      await capture(page, 'people-invalid-email');
    });
  });

  it('contraseña corta: rechaza desde la UI con mensaje en español', async () => {
    const page = ownerAView();
    await step(page, 'short person password', async () => {
      await openPeopleAdmin(page);
      await page.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('button', { name: 'Invitar persona', exact: true }).click();
      await fillPersonForm(page, employee.email, 'corta');
      const form = page.getByRole('form', { name: 'Invitar persona', exact: true });
      await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      expect(await form.getByRole('alert').innerText()).toContain('La contraseña debe tener entre 12 y 1024 caracteres.');
      expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1', [employee.email])).rowCount).toBe(0);
    });
  });

  it('crea una persona operadora, aplica su rol, cambia a lector y revoca su acceso al desactivarla', async () => {
    const owner = ownerAView();
    await step(owner, 'create person from owner UI', async () => {
      await openPeopleAdmin(owner);
      await owner.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('button', { name: 'Invitar persona', exact: true }).click();
      await fillPersonForm(owner, employee.email, employee.password);
      await owner.getByRole('form', { name: 'Invitar persona', exact: true })
        .getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      await owner.getByText('Persona creada. Inventario releído.', { exact: true }).waitFor({ timeout: 20_000 });
      const row = owner.getByRole('row').filter({ hasText: employee.email });
      await row.waitFor({ timeout: 15_000 });
      expect(await row.innerText()).toContain('Operador');
      await capture(owner, 'people-created-operator');
    });

    const inventory = await apiGet(owner, '/v3/console/people');
    expect(inventory.status).toBe(200);
    const people = peopleItems(inventory.body);
    const created = people.find(person => person.email === employee.email);
    expect(created).toMatchObject({ role: 'operator' });
    if (!created) throw new Error('owner inventory did not return the created person');
    employeeId = created.id;
    employeeRevision = created.revision;

    const personPage = await freshPage('new-person');
    await step(personPage, 'operator session and allowed permissions', async () => {
      await login(personPage, base(), { ...employee, name: employee.displayName, company: { name: '', slug: '' } });
      const access = await apiGet(personPage, '/v3/console/access');
      expect(access.status).toBe(200);
      expect(access.body.roles).toContain('operator');
      expect(access.body.permissions).toContain('message.publish');
      expect(access.body.permissions).toContain('config.write');

      expectHttpError('/v3/console/people', 403, 3);
      await openPeopleAdmin(personPage);
      expect(await personPage.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('alert').innerText()).toContain('Esta cuenta no tiene autoridad para administrar personas.');
      expect(await personPage.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('button', { name: 'Invitar persona', exact: true }).isDisabled()).toBe(true);
      expect(await apiMutation(personPage, '/v3/console/people', 'POST', unauthorizedCreatePayload())).toBe(403);
      expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1',
        [`zz-canary-forbidden-${run}@example.test`])).rowCount).toBe(0);
    });

    await step(owner, 'owner changes role to reader in the UI', async () => {
      const row = owner.getByRole('row').filter({ hasText: employee.email });
      await row.getByRole('button', { name: `Editar persona ${employee.email}`, exact: true }).click();
      const form = owner.getByRole('form', { name: `Editar persona ${employee.email}`, exact: true });
      await form.locator('select').nth(0).selectOption('reader');
      await form.getByRole('button', { name: 'Guardar persona', exact: true }).click();
      await owner.getByText('Persona actualizada. Inventario releído.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await owner.getByRole('row').filter({ hasText: employee.email }).innerText()).toContain('Lector');
    });

    await step(personPage, 'reload and observe changed role', async () => {
      expectHttpError('/v3/console/access', 401);
      const staleAccess = await apiGet(personPage, '/v3/console/access');
      expect([401, 403]).toContain(staleAccess.status);
      await personPage.reload({ waitUntil: 'domcontentloaded' });
      await personPage.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
      await login(personPage, base(), { ...employee, name: employee.displayName, company: { name: '', slug: '' } });
      const access = await apiGet(personPage, '/v3/console/access');
      expect(access.status).toBe(200);
      expect(access.body.permissions).not.toContain('message.publish');
      expect(access.body.permissions).not.toContain('config.write');

      await openSection(personPage, 'agentes');
      const writeNotice = personPage.getByRole('note').filter({ hasText: 'Rol de esta sesión' });
      await writeNotice.waitFor({ timeout: 15_000 });
      const notice = await writeNotice.innerText();
      expect(notice).toContain('Solo lectura:');
      expect(notice).toContain('Rol de esta sesión');

      expectHttpError('/v3/console/people', 403, 3);
      await openPeopleAdmin(personPage);
      expect(await personPage.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('alert').innerText()).toContain('Esta cuenta no tiene autoridad para administrar personas.');
      expect(await personPage.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('button', { name: 'Invitar persona', exact: true }).isDisabled()).toBe(true);
      expect(await apiMutation(personPage, '/v3/console/people', 'POST', unauthorizedCreatePayload())).toBe(403);
      expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1',
        [`zz-canary-forbidden-${run}@example.test`])).rowCount).toBe(0);
    });

    await step(owner, 'owner retires the person in the UI', async () => {
      const row = owner.getByRole('row').filter({ hasText: employee.email });
      await row.getByRole('button', { name: `Retirar persona ${employee.email}`, exact: true }).click();
      const confirmation = owner.getByRole('region', { name: 'Confirmar cambio de acceso', exact: true });
      expect(await confirmation.innerText()).toContain('Se revocan sesiones y accesos anteriores.');
      await capture(owner, 'people-retire-confirmation');
      await confirmation.getByRole('button', { name: 'Confirmar cambio de persona', exact: true }).click();
      await owner.getByText('Acceso de persona retirado. Inventario releído.', { exact: true }).waitFor({ timeout: 20_000 });
    });

    await step(personPage, 'inactive session and refused sign in', async () => {
      await personPage.goto('about:blank', { waitUntil: 'domcontentloaded' });
      await personPage.goto(base(), { waitUntil: 'domcontentloaded' });
      await personPage.getByLabel('Correo', { exact: true }).waitFor({ timeout: 20_000 });
      expectHttpError('/v3/console/access', 401);
      expect([401, 403]).toContain((await apiGet(personPage, '/v3/console/access')).status);
      expectHttpError('/v3/auth/login', 401);
      await personPage.getByLabel('Correo', { exact: true }).fill(employee.email);
      await personPage.getByLabel('Contraseña', { exact: true }).fill(employee.password);
      await personPage.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      expect(await personPage.getByRole('alert').innerText()).toContain('Correo o contraseña incorrectos.');
      expect(await apiGet(personPage, '/v3/auth/session')).toMatchObject({
        status: 200, body: { authenticated: false, login_mode: 'password' },
      });
      expect(await personPage.getByRole('navigation', { name: 'Navegación principal', exact: true }).count()).toBe(0);
    });
  }, 180_000);

  it('una empresa distinta no lista a la persona y su edición directa recibe 404', async () => {
    const page = ownerBView();
    await step(page, 'cross-company people isolation', async () => {
      await openPeopleAdmin(page);
      const inventory = await apiGet(page, '/v3/console/people');
      expect(inventory.status).toBe(200);
      const items = peopleItems(inventory.body);
      expect(items.some(person => person.email === ownerB.email)).toBe(true);
      expect(items.some(person => person.email === employee.email)).toBe(false);
      expect(await page.getByText(employee.email, { exact: true }).count()).toBe(0);
      const path = `/v3/console/people/${employeeId}`;
      expectHttpError(path, 404);
      expect(await apiMutation(page, path, 'PATCH', { expected_revision: employeeRevision, display_name: 'zz-canary-unauthorized-edit' })).toBe(404);
    });
  });

  it('restaura una persona y purga un registro retirado desde la UI con persistencia durable', async () => {
    const owner = ownerAView();
    await step(owner, 'restore person from owner UI', async () => {
      await openPeopleAdmin(owner);
      const row = owner.getByRole('row').filter({ hasText: employee.email });
      expect(await row.innerText()).toContain('Retirada');
      await row.getByRole('button', { name: `Restaurar persona ${employee.email}`, exact: true }).click();
      const confirmation = owner.getByRole('region', { name: 'Confirmar cambio de acceso', exact: true });
      expect(await confirmation.innerText()).toContain('La cuenta podrá abrir una nueva sesión.');
      await confirmation.getByRole('button', { name: 'Confirmar cambio de persona', exact: true }).click();
      await owner.getByText('Acceso de persona restaurado. Inventario releído.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await row.innerText()).toContain('Habilitada');
      await owner.reload({ waitUntil: 'domcontentloaded' });
      await openPeopleAdmin(owner);
      expect(await owner.getByRole('row').filter({ hasText: employee.email }).innerText()).toContain('Habilitada');
    });
    const restored = await active().database.pool.query<{ active: boolean; role: string }>(
      'SELECT active,role FROM console_users WHERE id=$1', [employeeId]);
    expect(restored.rows).toEqual([{ active: true, role: 'reader' }]);

    const purgeEmail = `zz-canary-purge-${run}@example.test`;
    const purgeAlias = `zz-purge-${run}`;
    const seeded = await active().database.adminPool.query<{ id: string }>(`INSERT INTO console_users
      (email,email_normalized,password_hash,display_name,role,tenant_id,alias,active,company_id)
      SELECT $1,lower($1),'$scrypt$' || repeat('x',48),$2,'reader',tenant_id,$3,false,company_id
      FROM console_users WHERE id=$4 RETURNING id::text`,
    [purgeEmail, `zz-canary-purge-${run}`, purgeAlias, ownerAId]);
    expect(seeded.rowCount).toBe(1);
    await step(owner, 'purge retired person from owner UI', async () => {
      await owner.reload({ waitUntil: 'domcontentloaded' });
      await openPeopleAdmin(owner);
      const row = owner.getByRole('row').filter({ hasText: purgeEmail });
      expect(await row.innerText()).toContain('Retirada');
      await row.getByRole('button', { name: `Purgar persona ${purgeEmail}`, exact: true }).click();
      const confirmation = owner.getByRole('region', { name: 'Confirmar cambio de acceso', exact: true });
      expect(await confirmation.innerText()).toContain('El registro se borra solo si no quedan históricos ni dependencias.');
      await capture(owner, 'people-purge-confirmation');
      await confirmation.getByRole('button', { name: 'Confirmar cambio de persona', exact: true }).click();
      await owner.getByText('Registro de persona purgado. Inventario releído.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await owner.getByText(purgeEmail, { exact: true }).count()).toBe(0);
      await owner.reload({ waitUntil: 'domcontentloaded' });
      await openPeopleAdmin(owner);
      expect(await owner.getByText(purgeEmail, { exact: true }).count()).toBe(0);
    });
    expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1', [purgeEmail])).rowCount).toBe(0);
  }, 180_000);

  it('protege en la consola al último owner contra degradación, retiro y purga', async () => {
    const owner = ownerAView();
    await step(owner, 'create a separate platform guard actor inside the company', async () => {
      await openPeopleAdmin(owner);
      await owner.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('button', { name: 'Invitar persona', exact: true }).click();
      await fillPersonForm(owner, guardAdmin.email, guardAdmin.password, guardAdmin.displayName);
      await owner.getByRole('form', { name: 'Invitar persona', exact: true })
        .getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      await owner.getByText('Persona creada. Inventario releído.', { exact: true }).waitFor({ timeout: 20_000 });
      expect(await owner.getByRole('row').filter({ hasText: guardAdmin.email }).innerText()).toContain('Operador');
    });
    const grant = await active().database.adminPool.query(
      'INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1', [guardAdmin.email]);
    expect(grant.rowCount).toBe(1);
    const platform = await freshPage('platform-owner');
    await login(platform, base(), { ...guardAdmin, name: guardAdmin.displayName, company: ownerA.company });
    expect(await apiGet(platform, '/v3/auth/session')).toMatchObject({
      status: 200, body: { authority: { acting_company: ownerA.company.slug, platform_override: false } },
    });
    const configuration = await apiGet(platform, '/v3/console/config');
    expect(configuration.status).toBe(200);
    expect(configuration.body.tenants).toEqual(expect.arrayContaining([expect.objectContaining({ id: hubA, enabled: true })]));
    expect(configuration.body.agents).toEqual(expect.arrayContaining([expect.objectContaining({ tenant_id: hubA, alias: personAlias, enabled: true })]));
    const companyAdmins = await active().database.pool.query<{ human_id: string; role: string }>(
      `SELECT human_id::text,role FROM company_admins WHERE company_id=$1 AND role IN ('owner','admin')`, [ownerA.company.slug]);
    expect(companyAdmins.rows).toEqual([{ human_id: ownerAId, role: 'owner' }]);

    await step(platform, 'deny degrading the last owner from platform UI', async () => {
      await openPeopleAdmin(platform);
      const row = platform.getByRole('row').filter({ hasText: ownerA.email });
      await row.getByRole('button', { name: `Editar persona ${ownerA.email}`, exact: true }).click();
      const form = platform.getByRole('form', { name: `Editar persona ${ownerA.email}`, exact: true });
      const selects = form.locator('select');
      await selects.nth(0).selectOption('reader');
      const tenantSelect = selects.nth(1);
      expect(await tenantSelect.innerText()).toContain(hubA);
      await tenantSelect.selectOption(hubA);
      const identitySelect = selects.nth(2);
      expect(await identitySelect.innerText()).toContain(personAlias);
      await identitySelect.selectOption(personAlias);
      expectHttpError(`/v3/console/people/${ownerAId}`, 409);
      await form.getByRole('button', { name: 'Guardar persona', exact: true }).click();
      const alert = platform.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('alert');
      await alert.waitFor({ timeout: 15_000 });
      expect(await alert.innerText()).toContain('último administrador');
      await platform.reload({ waitUntil: 'domcontentloaded' });
      await openPeopleAdmin(platform);
      const afterReload = platform.getByRole('row').filter({ hasText: ownerA.email });
      expect(await afterReload.innerText()).toContain('Dueño de empresa');
      expect(await afterReload.innerText()).toContain('Habilitada');
    });
    const afterDegrade = await active().database.pool.query<{ role: string; active: boolean }>(
      'SELECT role,active FROM console_users WHERE id=$1', [ownerAId]);
    expect(afterDegrade.rows).toEqual([{ role: 'operator', active: true }]);

    await step(platform, 'deny retiring the last owner from platform UI', async () => {
      const row = platform.getByRole('row').filter({ hasText: ownerA.email });
      await row.getByRole('button', { name: `Retirar persona ${ownerA.email}`, exact: true }).click();
      const confirmation = platform.getByRole('region', { name: 'Confirmar cambio de acceso', exact: true });
      expect(await confirmation.innerText()).toContain('Se revocan sesiones y accesos anteriores.');
      expectHttpError(`/v3/console/people/${ownerAId}`, 409);
      await confirmation.getByRole('button', { name: 'Confirmar cambio de persona', exact: true }).click();
      const alert = platform.getByRole('region', { name: 'Administración de personas', exact: true }).getByRole('alert');
      await alert.waitFor({ timeout: 15_000 });
      expect(await alert.innerText()).toContain('último administrador');
      await platform.reload({ waitUntil: 'domcontentloaded' });
      await openPeopleAdmin(platform);
      const afterReload = platform.getByRole('row').filter({ hasText: ownerA.email });
      expect(await afterReload.innerText()).toContain('Habilitada');
    });
    const afterRetire = await active().database.pool.query<{ active: boolean }>(
      'SELECT active FROM console_users WHERE id=$1', [ownerAId]);
    expect(afterRetire.rows).toEqual([{ active: true }]);

    await step(platform, 'deny purging the active last owner through the authenticated browser request', async () => {
      await platform.reload({ waitUntil: 'domcontentloaded' });
      await openPeopleAdmin(platform);
      const row = platform.getByRole('row').filter({ hasText: ownerA.email });
      expect(await row.innerText()).toContain('Habilitada');
      expect(await row.getByRole('button', { name: `Purgar persona ${ownerA.email}`, exact: true }).count()).toBe(0);
      const inventory = await apiGet(platform, '/v3/console/people');
      expect(inventory.status).toBe(200);
      const lastOwner = peopleItems(inventory.body).find(person => person.id === ownerAId);
      if (!lastOwner) throw new Error('people inventory omitted the protected owner');
      expect(lastOwner).toMatchObject({ role: 'operator', active: true });
      const purgePath = `/v3/console/people/${ownerAId}/purge`;
      expectHttpError(purgePath, 409);
      const denied = await apiDelete(platform, purgePath, { expected_revision: lastOwner.revision });
      expect(denied.status).toBe(409);
      expect(denied.body.reason).toBe('still_active');
      expect(denied.body.message).toBe('Primero retira la cuenta. Purgar solo aplica a una persona ya retirada.');
      await platform.reload({ waitUntil: 'domcontentloaded' });
      await openPeopleAdmin(platform);
      const afterReload = platform.getByRole('row').filter({ hasText: ownerA.email });
      expect(await afterReload.innerText()).toContain('Habilitada');
    });
    const protectedOwner = await active().database.pool.query<{ role: string; active: boolean }>(
      'SELECT role,active FROM console_users WHERE id=$1', [ownerAId]);
    expect(protectedOwner.rows).toEqual([{ role: 'operator', active: true }]);
    const retainedAdmin = await active().database.pool.query<{ human_id: string; role: string }>(
      'SELECT human_id::text,role FROM company_admins WHERE company_id=$1 AND human_id=$2', [ownerA.company.slug, ownerAId]);
    expect(retainedAdmin.rows).toEqual([{ human_id: ownerAId, role: 'owner' }]);
  }, 180_000);

  it('no quedan errores inesperados del navegador', () => {
    process.stdout.write(`V4 people e2e tolerated console messages: ${JSON.stringify(Object.fromEntries(errors.ignored))}\n`);
    errors.assertClean();
  });
});
