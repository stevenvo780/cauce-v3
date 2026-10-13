import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, BrowserErrorLog, bodySnippet, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, type IgnoredConsoleRule, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
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
let employeeId = '';
let employeeRevision = '';
let hubA = '';

function active() {
  if (!fixture) throw new Error('V4 people fixture is not initialized');
  return fixture;
}

function base() { return active().baseUrl; }

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

async function registerOwner(page: V4Page, owner: V4Person): Promise<void> {
  const form = await openRegistration(page, base());
  await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
}

async function openSection(page: V4Page, section: string): Promise<void> {
  await page.goto(`${base()}/config?seccion=${section}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
}

async function openPeopleAdmin(page: V4Page): Promise<void> {
  await openSection(page, 'acceso');
  await page.getByRole('heading', { name: 'Personas', exact: true }).waitFor({ timeout: 15_000 });
  await page.getByRole('button', { name: 'Administrar personas', exact: true }).click();
  await page.getByRole('region', { name: 'Administración de personas', exact: true }).waitFor({ timeout: 15_000 });
}

async function fillPersonForm(page: V4Page, email: string, password: string): Promise<void> {
  const form = page.getByRole('form', { name: 'Crear persona', exact: true });
  await form.getByLabel('Correo de acceso', { exact: true }).fill(email);
  await form.getByLabel('Nombre de persona', { exact: true }).fill(employee.displayName);
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

  const owner = await active().database.pool.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM console_users WHERE email=$1', [ownerA.email]);
  expect(owner.rows).toHaveLength(1);
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
  // Defecto real: el campo type=email bloquea onSubmit y no deja mostrar el mensaje propio en español.
  it.fails('correo mal formado: el formulario muestra el rechazo en español', async () => {
    const page = ownerAView();
    await step(page, 'invalid person email', async () => {
      await openPeopleAdmin(page);
      await page.getByRole('button', { name: 'Crear persona', exact: true }).click();
      const form = page.getByRole('form', { name: 'Crear persona', exact: true });
      await fillPersonForm(page, 'correo-invalido', employee.password);
      await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      expect(await form.getByLabel('Correo de acceso', { exact: true }).evaluate(element => element.validity.valid)).toBe(false);
      const alert = form.getByRole('alert');
      expect(await alert.count()).toBeGreaterThan(0);
      expect((await alert.innerText()).toLocaleLowerCase()).toMatch(/correo|direcci[oó]n/u);
    });
  });

  it('contraseña corta: rechaza desde la UI con mensaje en español', async () => {
    const page = ownerAView();
    await step(page, 'short person password', async () => {
      await openPeopleAdmin(page);
      await page.getByRole('button', { name: 'Crear persona', exact: true }).click();
      await fillPersonForm(page, employee.email, 'corta');
      const form = page.getByRole('form', { name: 'Crear persona', exact: true });
      await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      expect(await form.getByRole('alert').innerText()).toContain('La contraseña debe tener entre 12 y 1024 caracteres.');
      expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1', [employee.email])).rowCount).toBe(0);
    });
  });

  it('crea una persona operadora, aplica su rol, cambia a lector y revoca su acceso al desactivarla', async () => {
    const owner = ownerAView();
    await step(owner, 'create person from owner UI', async () => {
      await openPeopleAdmin(owner);
      await owner.getByRole('button', { name: 'Crear persona', exact: true }).click();
      await fillPersonForm(owner, employee.email, employee.password);
      await owner.getByRole('form', { name: 'Crear persona', exact: true })
        .getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
      await owner.getByText('Persona creada. Inventario releído.', { exact: true }).waitFor({ timeout: 20_000 });
      const row = owner.getByRole('row').filter({ hasText: employee.email });
      await row.waitFor({ timeout: 15_000 });
      expect(await row.innerText()).toContain('Operador');
    });

    const inventory = await apiGet(owner, '/v3/console/people');
    expect(inventory.status).toBe(200);
    const people = inventory.body.items as { id: string; email: string; role: string; revision: string }[];
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
      expect(await personPage.getByRole('alert').innerText()).toContain('Esta cuenta no tiene autoridad para administrar personas.');
      expect(await personPage.getByRole('button', { name: 'Crear persona', exact: true }).isDisabled()).toBe(true);
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
      const writeNotice = personPage.getByRole('note').filter({ hasText: 'RBAC config.write' });
      await writeNotice.waitFor({ timeout: 15_000 });
      const notice = await writeNotice.innerText();
      expect(notice).toContain('Solo lectura:');
      expect(notice).toContain('RBAC config.write');

      expectHttpError('/v3/console/people', 403, 3);
      await openPeopleAdmin(personPage);
      expect(await personPage.getByRole('alert').innerText()).toContain('Esta cuenta no tiene autoridad para administrar personas.');
      expect(await personPage.getByRole('button', { name: 'Crear persona', exact: true }).isDisabled()).toBe(true);
      expect(await apiMutation(personPage, '/v3/console/people', 'POST', unauthorizedCreatePayload())).toBe(403);
      expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1',
        [`zz-canary-forbidden-${run}@example.test`])).rowCount).toBe(0);
    });

    await step(owner, 'owner retires the person in the UI', async () => {
      const row = owner.getByRole('row').filter({ hasText: employee.email });
      await row.getByRole('button', { name: `Retirar persona ${employee.email}`, exact: true }).click();
      const confirmation = owner.getByRole('region', { name: 'Confirmar cambio de acceso', exact: true });
      expect(await confirmation.innerText()).toContain('Se revocan sesiones y accesos anteriores.');
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
      const items = inventory.body.items as { email: string }[];
      expect(items.some(person => person.email === ownerB.email)).toBe(true);
      expect(items.some(person => person.email === employee.email)).toBe(false);
      expect(await page.getByText(employee.email, { exact: true }).count()).toBe(0);
      const path = `/v3/console/people/${employeeId}`;
      expectHttpError(path, 404);
      expect(await apiMutation(page, path, 'PATCH', { expected_revision: employeeRevision, display_name: 'zz-canary-unauthorized-edit' })).toBe(404);
    });
  });

  it('no quedan errores inesperados del navegador', () => {
    process.stdout.write(`V4 people e2e tolerated console messages: ${JSON.stringify(Object.fromEntries(errors.ignored))}\n`);
    errors.assertClean();
  });
});
