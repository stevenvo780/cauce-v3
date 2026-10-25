import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { plazo } from '../helpers/plazos.js';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import { apiGet, asV4Page, fillRegistration, login, openRegistration, syntheticPerson, type V4Page } from './v4-console-real-browser.helpers.js';

const run = randomUUID().slice(0, 8);
const prefix = `zz-canary-e2e-a1-acceso-1025b-${run}`;
const owner = { ...syntheticPerson('people-flows', run), email: `${prefix}@example.test`, name: prefix,
  company: { name: prefix, slug: prefix } };
const invited = { email: `${prefix}-invite@example.test`, name: `${prefix}-invite`, password: syntheticPerson('invited', run).password };
const evidence = join(process.cwd(), '.delegados/v4/recibos/e2e-a1-acceso-1025b/people');
let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let browser: V4Page | undefined;
let invitedBrowser: V4Page | undefined;
let personId = '';
let tenantId = '';
const pageErrors: string[] = [];
const missingTerminalRoutes: string[] = [];
function active() { if (!fixture) throw new Error('people flows fixture is unavailable'); return fixture; }
function page() { if (!browser) throw new Error('people flows page is unavailable'); return browser; }
function watch(target: V4Page): V4Page {
  target.on('pageerror', error => { pageErrors.push(error instanceof Error ? error.message : String(error)); });
  target.on('response', response => {
    const path = new URL(response.url()).pathname;
    if (response.status() === 404 && ['/v3/console/terminal/grants', '/v3/console/terminal/targets'].includes(path)) {
      missingTerminalRoutes.push(`${String(response.status())} ${path}`);
    }
  });
  return target;
}
const inventory = () => page().getByRole('region', { name: 'Administración de personas', exact: true });
const row = () => inventory().getByRole('row').filter({ hasText: invited.email });
const personForm = () => page().getByRole('form', { name: `Editar persona ${invited.email}`, exact: true });

async function capture(name: string): Promise<void> {
  await mkdir(evidence, { recursive: true });
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    await page().setViewportSize(viewport);
    await page().evaluate(() => {
      const target = document.querySelector('.people-admin [role="alert"]')
        ?? document.querySelector('[aria-label="Conflicto de versión"]')
        ?? document.querySelector('.people-admin-confirm') ?? document.querySelector('.people-admin-form')
        ?? document.querySelector('.people-admin');
      target?.scrollIntoView({ block: 'center' });
    });
    await page().screenshot({ path: join(evidence, `${name}-${String(viewport.width)}.png`), fullPage: false });
    expect(await page().evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewport.width);
  }
  await page().setViewportSize({ width: 1440, height: 900 });
}
async function openPeople(target = page()): Promise<void> {
  await target.goto(`${active().baseUrl}/config?seccion=acceso`, { waitUntil: 'domcontentloaded' });
  await target.getByRole('button', { name: 'Administrar personas', exact: true }).click();
  await target.getByRole('region', { name: 'Administración de personas', exact: true }).waitFor();
  await target.getByRole('row').filter({ hasText: owner.email }).waitFor();
}
async function stored(): Promise<{ display_name: string; active: boolean; alias: string; role: string; tenant_id: string }> {
  const result = await active().database.pool.query<{ display_name: string; active: boolean; alias: string; role: string; tenant_id: string }>(
    'SELECT display_name,active,alias,role,tenant_id FROM console_users WHERE id=$1', [personId]);
  const resultRow = result.rows[0];
  if (!resultRow) throw new Error('invited person did not persist');
  return resultRow;
}
async function confirmAccess(action: 'Retirar' | 'Restaurar' | 'Purgar'): Promise<void> {
  await row().getByRole('button', { name: `${action} persona ${invited.email}`, exact: true }).click();
  await page().getByRole('button', { name: 'Confirmar cambio de persona', exact: true }).click();
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL || process.env.VITE_USE_MOCKS === 'true') throw new Error('isolated real PostgreSQL and mocks=false are required');
  fixture = await startConsoleFunctionalFixture();
  browser = watch(asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 })));
  const form = await openRegistration(page(), active().baseUrl);
  await fillRegistration(form, owner);
  await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
  await page().getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: plazo(30_000) });
  const result = await active().database.pool.query<{ tenant_id: string }>('SELECT tenant_id FROM console_users WHERE email=$1', [owner.email]);
  tenantId = result.rows[0]?.tenant_id ?? '';
  expect(tenantId).toMatch(/^hub-/u);
}, 600_000);
afterAll(async () => { await fixture?.close(); }, 180_000);

describe('invitaciones, cancelaciones y conflictos de personas con Chromium y PostgreSQL reales', () => {
  it('abre la invitación directa, valida datos y crea una identidad nueva retirada sin agente previo', async () => {
    await page().goto(`${active().baseUrl}/config?seccion=acceso`, { waitUntil: 'domcontentloaded' });
    await page().getByRole('button', { name: 'Invitar persona', exact: true }).click();
    const form = page().getByRole('form', { name: 'Invitar persona', exact: true });
    await form.waitFor();
    await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
    expect(await form.getByRole('alert').innerText()).toContain('correo válido');
    await form.getByLabel('Correo de acceso', { exact: true }).fill(invited.email);
    await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
    expect(await form.getByRole('alert').innerText()).toContain('nombre de 1 a 120 caracteres');
    expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1', [invited.email])).rowCount).toBe(0);
    await form.getByLabel('Nombre de persona', { exact: true }).fill(invited.name);
    await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
    expect(await form.getByRole('alert').innerText()).toContain('Elegí un espacio');
    await form.getByRole('combobox', { name: /^Espacio de la persona/u }).selectOption(tenantId);
    expect(await form.getByRole('combobox', { name: /^Identidad de la persona/u }).inputValue()).toBe('');
    await form.getByLabel('Contraseña inicial', { exact: true }).fill(invited.password);
    await form.getByLabel('Habilitar acceso al crear', { exact: true }).uncheck();
    await capture('people-invite-inactive-new-identity');
    await form.getByRole('button', { name: 'Crear cuenta de persona', exact: true }).click();
    await page().getByText('Persona creada. Inventario releído.', { exact: true }).waitFor();
    expect(await row().innerText()).toContain('Retirada');
    const response = await apiGet(page(), '/v3/console/people');
    expect(response.status).toBe(200);
    const result = await active().database.pool.query<{ id: string }>('SELECT id::text FROM console_users WHERE email=$1', [invited.email]);
    personId = result.rows[0]?.id ?? '';
    expect(await stored()).toMatchObject({ display_name: invited.name, active: false, role: 'reader' });
    expect((await stored()).alias).toMatch(/^zz-canary-/u);
    await page().getByRole('button', { name: 'Cerrar invitación', exact: true }).click();
    expect(await inventory().count()).toBe(0);
  }, 120_000);

  it('cancela formularios y cambios de acceso, relee y restaura sin recuperar sesiones anteriores', async () => {
    await openPeople();
    expect(await inventory().getByRole('button', { name: `Retirar persona ${owner.email}`, exact: true }).count()).toBe(0);
    await inventory().getByRole('button', { name: 'Invitar persona', exact: true }).click();
    const abandoned = page().getByRole('form', { name: 'Invitar persona', exact: true });
    await abandoned.getByLabel('Correo de acceso', { exact: true }).fill(`${prefix}-abandoned@example.test`);
    await abandoned.getByRole('button', { name: 'Cerrar edición de persona', exact: true }).click();
    expect((await active().database.pool.query('SELECT 1 FROM console_users WHERE email=$1', [`${prefix}-abandoned@example.test`])).rowCount).toBe(0);
    await row().getByRole('button', { name: `Restaurar persona ${invited.email}`, exact: true }).click();
    await page().getByRole('button', { name: 'Cancelar cambio de persona', exact: true }).click();
    expect((await stored()).active).toBe(false);
    await confirmAccess('Restaurar');
    await page().getByText('Acceso de persona restaurado. Inventario releído.', { exact: true }).waitFor();
    expect((await stored()).active).toBe(true);
    await row().getByRole('button', { name: `Editar persona ${invited.email}`, exact: true }).click();
    await personForm().getByLabel('Nombre de persona', { exact: true }).fill(`${invited.name}-unsaved`);
    await personForm().getByRole('button', { name: 'Cerrar edición de persona', exact: true }).click();
    expect((await stored()).display_name).toBe(invited.name);
    await row().getByRole('button', { name: `Retirar persona ${invited.email}`, exact: true }).click();
    await page().getByRole('button', { name: 'Cancelar cambio de persona', exact: true }).click();
    expect((await stored()).active).toBe(true);
    await inventory().getByRole('button', { name: 'Releer personas y permisos', exact: true }).click();
    await row().waitFor();
    await capture('people-cancel-and-reread');
    const reader = watch(asV4Page(await newTrustedPage(active(), { width: 390, height: 844 })));
    invitedBrowser = reader;
    await login(reader, active().baseUrl, { ...invited, company: owner.company });
    expect((await apiGet(reader, '/v3/auth/session')).body.authenticated).toBe(true);
    await page().getByRole('button', { name: 'Cerrar administración de personas', exact: true }).click();
    expect(await inventory().count()).toBe(0);
  }, 120_000);

  it('conserva el borrador ante CAS y permite descartar o reintentar explícitamente', async () => {
    const other = watch(asV4Page(await newTrustedPage(active(), { width: 1440, height: 900 })));
    await login(other, active().baseUrl, owner);
    await openPeople(); await openPeople(other);
    const otherForm = other.getByRole('form', { name: `Editar persona ${invited.email}`, exact: true });
    const editOther = async (name: string) => {
      await other.getByRole('row').filter({ hasText: invited.email }).getByRole('button', { name: `Editar persona ${invited.email}`, exact: true }).click();
      await otherForm.getByLabel('Nombre de persona', { exact: true }).fill(name);
      await otherForm.getByRole('button', { name: 'Guardar persona', exact: true }).click();
      await other.getByText('Persona actualizada. Inventario releído.', { exact: true }).waitFor();
    };
    await row().getByRole('button', { name: `Editar persona ${invited.email}`, exact: true }).click();
    await personForm().getByLabel('Nombre de persona', { exact: true }).fill(`${invited.name}-draft`);
    await editOther(`${invited.name}-other`);
    await personForm().getByRole('button', { name: 'Guardar persona', exact: true }).click();
    const conflict = page().getByRole('group', { name: 'Conflicto de versión', exact: true });
    await conflict.waitFor();
    expect(await conflict.innerText()).toContain(`${invited.name}-other`);
    expect(await personForm().getByLabel('Nombre de persona', { exact: true }).inputValue()).toBe(`${invited.name}-draft`);
    await capture('people-cas-preserved-draft');
    await conflict.getByRole('button', { name: 'Descartar mis cambios', exact: true }).click();
    expect(await personForm().getByLabel('Nombre de persona', { exact: true }).inputValue()).toBe(`${invited.name}-other`);
    await personForm().getByLabel('Nombre de persona', { exact: true }).fill(`${invited.name}-final`);
    await editOther(`${invited.name}-newer`);
    await personForm().getByRole('button', { name: 'Guardar persona', exact: true }).click();
    await conflict.waitFor();
    await conflict.getByRole('button', { name: 'Releer y reintentar con mis cambios', exact: true }).click();
    await page().getByText('Persona actualizada. Inventario releído.', { exact: true }).waitFor();
    expect((await stored()).display_name).toBe(`${invited.name}-final`);
    expect((await apiGet(page(), '/v3/console/people')).body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: personId, display_name: `${invited.name}-final` }),
    ]));
  }, 180_000);

  it('actualiza correo y contraseña y revoca la sesión anterior con persistencia releída por API', async () => {
    const oldEmail = invited.email;
    const oldPassword = invited.password;
    const newEmail = `${prefix}-changed@example.test`;
    const newPassword = syntheticPerson('changed-password', run).password;
    await row().getByRole('button', { name: `Editar persona ${invited.email}`, exact: true }).click();
    await personForm().getByLabel('Correo de acceso', { exact: true }).fill(newEmail);
    await personForm().getByLabel('Nueva contraseña (opcional)', { exact: true }).fill(newPassword);
    await capture('people-edit-credentials');
    await personForm().getByRole('button', { name: 'Guardar persona', exact: true }).click();
    await page().getByText('Persona actualizada. Inventario releído.', { exact: true }).waitFor();
    invited.email = newEmail;
    invited.password = newPassword;
    expect((await apiGet(page(), '/v3/console/people')).body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: personId, email: newEmail }),
    ]));
    if (!invitedBrowser) throw new Error('previous invited session is unavailable');
    expect((await apiGet(invitedBrowser, '/v3/auth/session')).body.authenticated).toBe(false);
    const fresh = watch(asV4Page(await newTrustedPage(active(), { width: 390, height: 844 })));
    await fresh.goto(active().baseUrl, { waitUntil: 'domcontentloaded' });
    for (const [email, password] of [[oldEmail, oldPassword], [newEmail, oldPassword]] as const) {
      await fresh.getByLabel('Correo', { exact: true }).fill(email);
      await fresh.getByLabel('Contraseña', { exact: true }).fill(password);
      await fresh.getByRole('button', { name: 'Iniciar sesión', exact: true }).click();
      await expect.poll(() => fresh.getByRole('button', { name: 'Iniciar sesión', exact: true }).isDisabled(), { timeout: plazo(15_000) }).toBe(false);
      await expect.poll(() => fresh.getByRole('alert').innerText(), { timeout: plazo(15_000) }).toContain('Correo o contraseña incorrectos.');
    }
    await login(fresh, active().baseUrl, { ...invited, company: owner.company });
    expect((await apiGet(fresh, '/v3/auth/session')).body.authenticated).toBe(true);
  }, 120_000);

  it('cambia identidad y espacio desde la edición, conserva la contraseña vacía y revoca cada sesión anterior', async () => {
    const targetTenant = `zz-canary-space-${run}`;
    const targetAlias = `zz-canary-identity-${run}`;
    const targetRoom = `zz-canary-room-${run}`;
    await active().database.pool.query('INSERT INTO tenants(id,company_id,display_name) VALUES($1,$2,$1)', [targetTenant, owner.company.slug]);
    await active().database.pool.query('INSERT INTO rooms(id,tenant_id) VALUES($1,$2)', [targetRoom, targetTenant]);
    await active().database.pool.query(`INSERT INTO agents(tenant_id,alias,display_name,enabled,harness_id,container_name,runtime_user,home_directory,state_directory,company_id)
      VALUES($1,$2,$2,true,'fake',$3,'stev',$4,$5,$6)`,
    [targetTenant, targetAlias, `${prefix}-runtime`, active().directory, `${active().directory}/state/${targetAlias}`, owner.company.slug]);
    await active().database.pool.query("INSERT INTO memberships(tenant_id,room_id,alias,role) VALUES($1,$2,$3,'operator')", [targetTenant, targetRoom, targetAlias]);
    await openPeople();
    const before = await stored();
    const previousSession = watch(asV4Page(await newTrustedPage(active(), { width: 390, height: 844 })));
    await login(previousSession, active().baseUrl, { ...invited, company: owner.company });
    expect((await apiGet(previousSession, '/v3/auth/session')).body.authenticated).toBe(true);
    await row().getByRole('button', { name: `Editar persona ${invited.email}`, exact: true }).click();
    await personForm().getByRole('combobox', { name: /^Identidad de la persona/u }).selectOption('');
    await personForm().getByRole('button', { name: 'Guardar persona', exact: true }).click();
    await page().getByText('Persona actualizada. Inventario releído.', { exact: true }).waitFor();
    const changedIdentity = await stored();
    expect(changedIdentity.tenant_id).toBe(before.tenant_id);
    expect(changedIdentity.alias).not.toBe(before.alias);
    expect((await apiGet(previousSession, '/v3/auth/session')).body.authenticated).toBe(false);
    await login(previousSession, active().baseUrl, { ...invited, company: owner.company });
    expect((await apiGet(previousSession, '/v3/auth/session')).body.authenticated).toBe(true);
    await row().getByRole('button', { name: `Editar persona ${invited.email}`, exact: true }).click();
    await personForm().getByRole('combobox', { name: /^Espacio de la persona/u }).selectOption(targetTenant);
    await personForm().getByRole('combobox', { name: /^Identidad de la persona/u }).selectOption(targetAlias);
    await capture('people-edit-space-and-identity');
    await personForm().getByRole('button', { name: 'Guardar persona', exact: true }).click();
    await page().getByText('Persona actualizada. Inventario releído.', { exact: true }).waitFor();
    expect(await stored()).toMatchObject({ tenant_id: targetTenant, alias: targetAlias, active: true });
    expect((await apiGet(page(), '/v3/console/people')).body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: personId, tenant_id: targetTenant, alias: targetAlias }),
    ]));
    expect((await apiGet(previousSession, '/v3/auth/session')).body.authenticated).toBe(false);
    await login(previousSession, active().baseUrl, { ...invited, company: owner.company });
    expect((await apiGet(previousSession, '/v3/auth/session')).body.authenticated).toBe(true);
    const memberships = await active().database.pool.query<{ tenant_id: string; actor_alias: string; enabled: boolean }>(
      'SELECT tenant_id,actor_alias,enabled FROM human_tenant_memberships WHERE human_id=$1 ORDER BY tenant_id', [personId]);
    expect(memberships.rows).toEqual(expect.arrayContaining([
      { tenant_id: before.tenant_id, actor_alias: changedIdentity.alias, enabled: false },
      { tenant_id: targetTenant, actor_alias: targetAlias, enabled: true },
    ]));
  }, 180_000);

  it('cancela la purga y rechaza borrar la membresía o auditoría histórica de una invitación retirada', async () => {
    await confirmAccess('Retirar');
    await page().getByText('Acceso de persona retirado. Inventario releído.', { exact: true }).waitFor();
    await row().getByRole('button', { name: `Purgar persona ${invited.email}`, exact: true }).click();
    await page().getByRole('button', { name: 'Cancelar cambio de persona', exact: true }).click();
    expect((await stored()).active).toBe(false);
    await confirmAccess('Purgar');
    await inventory().getByRole('alert').waitFor();
    expect(await inventory().getByRole('alert').innerText()).toContain('Esta consola no borra ese historial');
    expect((await stored()).active).toBe(false);
    expect(await inventory().getByRole('button', { name: 'Invitar persona', exact: true }).isDisabled()).toBe(true);
    await capture('people-protected-history');
    await inventory().getByRole('button', { name: 'Releer personas y permisos', exact: true }).click();
    await expect.poll(() => inventory().getByRole('button', { name: 'Invitar persona', exact: true }).isDisabled(), { timeout: plazo(15_000) }).toBe(false);
    expect(pageErrors).toEqual([]);
  }, 120_000);

  it('bloquea cambios durante una lectura real y permite recuperar el inventario tras perder la red', async () => {
    const blocker = await active().database.adminPool.connect();
    try {
      await blocker.query('BEGIN');
      await blocker.query('LOCK TABLE console_users IN ACCESS EXCLUSIVE MODE');
      const read = inventory().getByRole('button', { name: 'Releer personas y permisos', exact: true });
      await read.click();
      await inventory().getByText('Leyendo personas y permisos…', { exact: true }).waitFor();
      expect(await inventory().getByRole('button', { name: 'Invitar persona', exact: true }).isDisabled()).toBe(true);
      await capture('people-loading-disabled-controls');
    } finally { await blocker.query('ROLLBACK'); blocker.release(); }
    await expect.poll(() => inventory().getByRole('button', { name: 'Invitar persona', exact: true }).isDisabled(), { timeout: plazo(15_000) }).toBe(false);
    const context = page().context() as ReturnType<V4Page['context']> & { setOffline(value: boolean): Promise<void> };
    try {
      await context.setOffline(true);
      await inventory().getByRole('button', { name: 'Releer personas y permisos', exact: true }).click();
      await inventory().getByRole('alert').waitFor();
      expect(await inventory().getByRole('button', { name: 'Invitar persona', exact: true }).isDisabled()).toBe(true);
      await capture('people-network-error-disabled-controls');
    } finally { await context.setOffline(false); }
    await inventory().getByRole('button', { name: 'Releer personas y permisos', exact: true }).click();
    await expect.poll(() => inventory().getByRole('button', { name: 'Invitar persona', exact: true }).isDisabled(), { timeout: plazo(15_000) }).toBe(false);
    expect((await apiGet(page(), '/v3/console/people')).body.items).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: personId, active: false }),
    ]));
    expect(pageErrors).toEqual([]);
  }, 120_000);

  it('no quedan errores de página ni rutas ausentes del panel de concesiones', () => {
    expect(pageErrors).toEqual([]);
    expect(missingTerminalRoutes).toEqual([]);
  });
});
