import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { newTrustedPage, startConsoleFunctionalFixture } from './console-functional-browser.fixtures.js';
import {
  apiGet, asV4Page, bodySnippet, BrowserErrorLog, fillRegistration, HERMETIC_INSTANCE_RULES,
  login, openRegistration, PATTERN_DEFECT_RULE, syntheticPerson, validity,
  type IgnoredConsoleRule, type V4Locator, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

const run = randomUUID().replaceAll('-', '').slice(0, 8);
const evidence = join(process.cwd(), '.delegados/v4/recibos/e2e-a12-salas-arneses-1025');
const owner: V4Person = {
  ...syntheticPerson('salas', run),
  email: `zz-canary-salas-${run}@example.invalid`,
  name: `zz-canary salas ${run}`,
  company: { name: `zz-canary salas ${run}`, slug: `zz-canary-salas-${run}` },
};
const jsonRoom = `zz-canary-json-${run}`;
const teamRoom = `zz-canary-equipo-${run}`;
const retireRoom = `zz-canary-retiro-${run}`;
const VITE_HMR_SOCKS: IgnoredConsoleRule = {
  id: 'vite-hmr-socks',
  reason: 'the lab browser proxy cannot open the Vite module socket',
  matches: (text, url) => text.includes('ERR_SOCKS_CONNECTION_FAILED') && url.includes('/@vite/client'),
};
const errors = new BrowserErrorLog([...HERMETIC_INSTANCE_RULES, PATTERN_DEFECT_RULE, VITE_HMR_SOCKS]);

let fixture: Awaited<ReturnType<typeof startConsoleFunctionalFixture>> | undefined;
let pageA: V4Page | undefined;
let hub = '';

const active = (): NonNullable<typeof fixture> => {
  if (!fixture) throw new Error('salas fixture is not initialized');
  return fixture;
};
const pool = () => active().database.pool;
const base = (): string => active().baseUrl;
const ownerPage = (): V4Page => {
  if (!pageA) throw new Error('owner has no page yet');
  return pageA;
};

async function freshPage(label: string, viewport = { width: 1440, height: 900 }): Promise<V4Page> {
  const page = asV4Page(await newTrustedPage(active(), viewport));
  errors.watch(page, label);
  return page;
}

async function step<T>(page: V4Page, name: string, action: () => Promise<T>): Promise<T> {
  try { return await action(); }
  catch (cause) {
    throw new Error(`${name} failed at ${page.url()}: ${await bodySnippet(page)} || console=${JSON.stringify(errors.trace.slice(-12))}`, { cause });
  }
}

async function shot(page: V4Page, name: string): Promise<void> {
  await mkdir(evidence, { recursive: true, mode: 0o700 });
  await page.screenshot({ path: join(evidence, `${name}.png`), fullPage: true });
}

async function openConfig(page: V4Page, section: string): Promise<void> {
  await page.goto(`${base()}/config?seccion=${section}`, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: 'Ajustes', exact: true }).waitFor({ timeout: 20_000 });
}

async function roomState(id: string): Promise<{ label: string | null; enabled: boolean; retired: boolean } | undefined> {
  const rows = await pool().query<{ label: string | null; enabled: boolean; retired: boolean }>(
    'SELECT display_name AS label, enabled, retired_at IS NOT NULL AS retired FROM rooms WHERE tenant_id=$1 AND id=$2',
    [hub, id]);
  return rows.rows[0];
}

async function ownerRooms(): Promise<string[]> {
  const rows = await pool().query<{ room_id: string }>(
    `SELECT room_id FROM memberships WHERE tenant_id=$1 AND alias='owner' AND retired_at IS NULL ORDER BY room_id`,
    [hub]);
  return rows.rows.map((row) => row.room_id);
}

async function fanout(): Promise<number> {
  const rows = await pool().query<{ fanout: number }>(
    'SELECT max_fanout_per_turn::int AS fanout FROM agent_chain_policies WHERE id=$1', ['default']);
  return Number(rows.rows[0]?.fanout);
}

async function previewAndConfirm(scope: V4Locator, confirm: string): Promise<void> {
  await scope.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
  const apply = scope.getByRole('button', { name: confirm, exact: true });
  await expect.poll(async () => apply.isDisabled(), { timeout: 20_000 }).toBe(false);
  await apply.click();
}

async function jsonEditor(page: V4Page): Promise<V4Locator> {
  const editor = page.locator('details').filter({ hasText: 'Editor de mutaciones JSON' });
  await editor.locator('summary').click();
  await editor.getByRole('textbox', { name: 'Mutación JSON', exact: true }).waitFor({ timeout: 20_000 });
  return editor;
}

function fieldSelect(scope: V4Locator, label: string): V4Locator {
  return scope.locator('label').filter({ hasText: label }).locator('select');
}

async function closeDialog(dialog: V4Locator): Promise<void> {
  await dialog.getByRole('button', { name: 'Cerrar', exact: true }).nth(0).click();
}

async function openTeam(page: V4Page, id: string): Promise<V4Locator> {
  await openConfig(page, 'agentes');
  await page.getByRole('button', { name: `Editar equipo ${hub}/${id}`, exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('heading', { name: 'Editar equipo', exact: true }).waitFor({ timeout: 15_000 });
  return dialog;
}

beforeAll(async () => {
  if (process.env.CAUCE_TEST_DATABASE_URL) throw new Error('this E2E requires its own Testcontainers PostgreSQL');
  if (process.env.VITE_USE_MOCKS === 'true') throw new Error('mocks=false is required');
  fixture = await startConsoleFunctionalFixture();
}, 600_000);

afterAll(async () => {
  await fixture?.close();
}, 180_000);

describe('salas, equipos, general, avanzado y arneses en Chromium, gateway y PostgreSQL reales', () => {
  it('registra al dueño y General muestra el resumen y la política de cadena bloqueada', async () => {
    const page = await freshPage('owner');
    pageA = page;
    await step(page, 'registration', async () => {
      const form = await openRegistration(page, base());
      await fillRegistration(form, owner);
      await form.getByRole('button', { name: 'Crear cuenta y empresa', exact: true }).click();
      await page.getByRole('navigation', { name: 'Navegación principal', exact: true }).waitFor({ timeout: 30_000 });
    });
    const registered = await pool().query<{ tenant_id: string }>(
      'SELECT tenant_id FROM console_users WHERE email=$1', [owner.email]);
    expect(registered.rows).toHaveLength(1);
    hub = registered.rows[0]?.tenant_id ?? '';
    expect(hub).toMatch(/^hub-[a-f0-9]+$/u);
    expect((await apiGet(page, '/v3/auth/session')).body).toMatchObject({
      authenticated: true, authority: { role: 'company_owner', acting_company: owner.company.slug },
    });

    await step(page, 'general summary', async () => {
      await openConfig(page, 'general');
      await page.getByRole('heading', { name: 'General', exact: true }).waitFor({ timeout: 20_000 });
      const summary = page.getByLabel('Resumen de la configuración', { exact: true });
      await summary.getByRole('button', { name: /Salas/u }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => summary.innerText(), { timeout: 20_000 }).toContain('1');
      await page.getByText('¿Qué es esto?', { exact: true }).click();
      await page.getByText('políticas ponen los topes', { exact: false }).waitFor({ timeout: 15_000 });
      const editPolicy = page.getByRole('button', { name: 'Editar política de cadena default', exact: true });
      await editPolicy.waitFor({ timeout: 20_000 });
      expect(await editPolicy.isDisabled()).toBe(true);
      expect(await editPolicy.evaluate((element) => element.getAttribute('title') ?? '')).toContain('administrador de plataforma');
      await page.getByText('Solo el administrador de plataforma puede cambiar esta política.', { exact: true }).waitFor();
      await shot(page, 'general-escritorio');
      await summary.getByRole('button', { name: /Salas/u }).click();
      await page.getByRole('heading', { name: 'Espacios y salas', exact: true }).waitFor({ timeout: 15_000 });
      await openConfig(page, 'general');
      await page.getByLabel('Resumen de la configuración', { exact: true }).getByRole('button', { name: /Agentes registrados/u }).click();
      await page.getByRole('heading', { name: 'Agentes', exact: true }).waitFor({ timeout: 15_000 });
      await openConfig(page, 'general');
      await page.getByLabel('Resumen de la configuración', { exact: true }).getByRole('button', { name: /Permisos entre clientes/u }).click();
      await page.getByRole('heading', { name: 'Acceso y roles', exact: true }).waitFor({ timeout: 15_000 });
    });
    expect(await fanout()).toBe(6);
    expect(await roomState('office')).toMatchObject({ enabled: true, retired: false });
  }, 180_000);

  it('General en el teléfono usa el selector de sección', async () => {
    const page = await freshPage('general-mobile', { width: 390, height: 844 });
    await login(page, base(), owner);
    await step(page, 'general mobile', async () => {
      await openConfig(page, 'general');
      const section = page.locator('label').filter({ hasText: 'Sección' }).locator('select');
      await section.waitFor({ timeout: 20_000 });
      expect(await section.inputValue()).toBe('general');
      await shot(page, 'general-movil');
      await section.selectOption('arneses');
      await page.getByRole('heading', { name: 'Arneses', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByText('No eliges el programa aquí.', { exact: false }).waitFor({ timeout: 20_000 });
      await page.getByText('Solo el administrador de plataforma puede crear, editar o borrar definiciones de arnés.', { exact: false }).waitFor();
      expect(await page.getByRole('button', { name: 'Crear definición de arnés', exact: true }).count()).toBe(0);
      await shot(page, 'arneses-movil');
    });
  }, 180_000);

  it('Avanzado vacío rechaza JSON inválido y no escribe', async () => {
    const page = ownerPage();
    await step(page, 'empty history and invalid json', async () => {
      await openConfig(page, 'avanzado');
      await page.getByRole('heading', { name: 'Avanzado', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByText('No hay revisiones.', { exact: true }).waitFor({ timeout: 20_000 });
      await page.getByText('Deshacer restituye la FILA COMPLETA', { exact: false }).waitFor();
      await page.getByText('No hay operaciones recientes.', { exact: false }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: 'Releer', exact: true }).click();
      await page.getByText('No hay operaciones recientes.', { exact: false }).waitFor({ timeout: 20_000 });
      const editor = await jsonEditor(page);
      const markup = await fieldSelect(editor, 'Resource').evaluate((element) => element.outerHTML);
      const resources = [...markup.matchAll(/<option\b[^>]*>([^<]*)<\/option>/gu)].map((match) => match[1] ?? '');
      expect(resources).not.toContain('harness');
      expect(resources).toContain('room');
      await editor.getByRole('textbox', { name: 'Mutación JSON', exact: true }).fill('{');
      await editor.getByRole('button', { name: 'Preview / dry-run', exact: true }).click();
      await page.getByRole('alert').waitFor({ timeout: 15_000 });
      expect(await page.getByRole('alert').innerText()).not.toBe('');
      await shot(page, 'avanzado-json-invalido');
    });
    expect((await pool().query('SELECT 1 FROM config_revisions')).rowCount).toBe(0);
    expect((await pool().query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2', [hub, jsonRoom])).rowCount).toBe(0);
  }, 180_000);

  it('el administrador de plataforma edita la política, el historial la revierte y el JSON crea una sala', async () => {
    const page = ownerPage();
    const granted = await active().database.adminPool.query(
      'INSERT INTO platform_admins(human_id) SELECT id FROM console_users WHERE email=$1', [owner.email]);
    expect(granted.rowCount).toBe(1);
    expect((await apiGet(page, '/v3/auth/session')).body).toMatchObject({ authority: { role: 'platform_admin' } });
    const before = await fanout();

    await step(page, 'chain policy edit', async () => {
      await openConfig(page, 'general');
      await page.getByRole('button', { name: 'Editar política de cadena default', exact: true }).click();
      const form = page.getByRole('form', { name: 'Editar política de cadena', exact: true });
      const limit = form.getByLabel('Máximo de delegaciones por turno', { exact: true });
      await limit.fill('101');
      await form.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      expect((await validity(limit)).valid).toBe(false);
      expect(await fanout()).toBe(before);
      await limit.fill('7');
      await previewAndConfirm(form, 'Confirmar edición');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      await shot(page, 'general-politica');
    });
    expect(await fanout()).toBe(7);

    await step(page, 'rollback chain policy', async () => {
      await openConfig(page, 'avanzado');
      const row = page.locator('tr').filter({ hasText: 'update chain policy default' }).first();
      await row.waitFor({ timeout: 20_000 });
      await row.getByRole('button', { name: 'Preview', exact: true }).click();
      await page.getByLabel('Preview del rollback', { exact: true }).waitFor({ timeout: 20_000 });
      await shot(page, 'avanzado-rollback');
      await row.getByRole('button', { name: 'Rollback', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'revisión' }).waitFor({ timeout: 20_000 });
    });
    await expect.poll(fanout, { timeout: 20_000 }).toBe(before);

    await step(page, 'json room create and duplicate', async () => {
      const editor = await jsonEditor(page);
      await fieldSelect(editor, 'Resource').selectOption('room');
      await fieldSelect(editor, 'Action').selectOption('create');
      const mutation = JSON.stringify({
        resource: 'room', action: 'create', tenant_id: hub, id: jsonRoom,
        value: { display_name: 'Sala JSON', enabled: true },
      });
      await editor.getByRole('textbox', { name: 'Mutación JSON', exact: true }).fill(mutation);
      await editor.getByRole('button', { name: 'Preview / dry-run', exact: true }).click();
      await editor.getByLabel('Resultado de preview', { exact: true }).waitFor({ timeout: 20_000 });
      await editor.getByRole('button', { name: 'Aplicar atómico', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Cambio atómico aplicado' }).waitFor({ timeout: 20_000 });
      await shot(page, 'avanzado-sala-json');
      await editor.getByRole('textbox', { name: 'Mutación JSON', exact: true }).fill(mutation);
      errors.expectHttpError('/v3/console/config/changes', 409);
      await editor.getByRole('button', { name: 'Preview / dry-run', exact: true }).click();
      await editor.getByRole('alert').filter({ hasText: 'ya existe un registro con esa identidad' }).waitFor({ timeout: 20_000 });
    });
    expect(await roomState(jsonRoom)).toMatchObject({ label: 'Sala JSON', enabled: true, retired: false });
  }, 240_000);

  it('Nuevo equipo valida, descarta, crea y rechaza un id repetido', async () => {
    const page = ownerPage();
    await step(page, 'teams validation and create', async () => {
      await openConfig(page, 'agentes');
      await page.getByRole('heading', { name: 'Equipos', exact: true }).waitFor({ timeout: 20_000 });
      const listed = page.locator(`[data-team="${hub}/office"]`);
      await listed.waitFor({ timeout: 20_000 });
      await expect.poll(async () => listed.innerText(), { timeout: 20_000 }).toContain('1 miembro');
      await shot(page, 'equipos-escritorio');
      await page.getByRole('button', { name: 'Nuevo equipo', exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: 'Nuevo equipo', exact: true }).waitFor({ timeout: 15_000 });
      const emptySpace = dialog.getByLabel('Espacio', { exact: true });
      if (!(await emptySpace.isDisabled())) await emptySpace.selectOption(hub);
      await dialog.getByLabel('Nombre visible', { exact: true }).fill('Sin identificador');
      await dialog.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await expect.poll(async () => dialog.innerText(), { timeout: 15_000 }).toContain('Id de la sala/grupo');
      await shot(page, 'equipo-id-vacio');
      await dialog.getByRole('button', { name: 'Cancelar', exact: true }).click();
      await dialog.getByRole('button', { name: 'Descartar y cerrar', exact: true }).click();
      await expect.poll(async () => page.getByRole('dialog').count(), { timeout: 15_000 }).toBe(0);

      await page.getByRole('button', { name: 'Nuevo equipo', exact: true }).click();
      dialog = page.getByRole('dialog');
      const space = dialog.getByLabel('Espacio', { exact: true });
      if (!(await space.isDisabled())) await space.selectOption(hub);
      await dialog.getByLabel('Id de la sala/grupo', { exact: true }).fill(teamRoom);
      await dialog.getByLabel('Nombre visible', { exact: true }).fill('Sala equipo');
      await dialog.getByText('Ver los datos del cambio', { exact: true }).click();
      await expect.poll(async () => dialog.getByLabel('Mutación propuesta', { exact: true }).innerText(), { timeout: 15_000 }).toContain(teamRoom);
      await previewAndConfirm(dialog, 'Confirmar creación');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });

      await page.getByRole('button', { name: 'Nuevo equipo', exact: true }).click();
      dialog = page.getByRole('dialog');
      const again = dialog.getByLabel('Espacio', { exact: true });
      if (!(await again.isDisabled())) await again.selectOption(hub);
      await dialog.getByLabel('Id de la sala/grupo', { exact: true }).fill('office');
      await dialog.getByLabel('Nombre visible', { exact: true }).fill('Oficina duplicada');
      errors.expectHttpError('/v3/console/config/changes', 409);
      await dialog.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await dialog.getByRole('alert').filter({ hasText: 'ya existe un registro con esa identidad' }).waitFor({ timeout: 20_000 });
      await dialog.getByRole('button', { name: 'Cerrar', exact: true }).click();
      await dialog.getByRole('button', { name: 'Descartar y cerrar', exact: true }).click();
    });
    expect(await roomState(teamRoom)).toMatchObject({ label: 'Sala equipo', enabled: true, retired: false });
    expect((await pool().query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2', [hub, 'office'])).rowCount).toBe(1);
  }, 180_000);

  it('dos sesiones chocan al editar el mismo equipo y la fila queda en un solo nombre', async () => {
    const page = ownerPage();
    const other = await freshPage('other-editor');
    await login(other, base(), owner);
    await step(page, 'revision conflict', async () => {
      const stale = await openTeam(other, teamRoom);
      await stale.getByLabel('Nombre visible', { exact: true }).fill('Sala choque');
      const fresh = await openTeam(page, teamRoom);
      await fresh.getByLabel('Nombre visible', { exact: true }).fill('Sala firme');
      await previewAndConfirm(fresh, 'Confirmar edición');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      errors.expectHttpError('/v3/console/config/changes', 409);
      await stale.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      await stale.getByRole('group', { name: 'Conflicto de versión', exact: true }).waitFor({ timeout: 20_000 });
      await stale.getByText('Alguien cambió este dato mientras lo editabas.', { exact: false }).waitFor();
      await shot(other, 'equipo-conflicto');
    });
    expect(await roomState(teamRoom)).toMatchObject({ label: 'Sala firme' });
  }, 180_000);

  it('deshabilita y vuelve a habilitar el equipo', async () => {
    const page = ownerPage();
    await step(page, 'disable and enable team', async () => {
      const dialog = await openTeam(page, teamRoom);
      await dialog.getByLabel('Habilitado', { exact: true }).selectOption('false');
      await previewAndConfirm(dialog, 'Confirmar edición');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      await page.getByText('Deshabilitado', { exact: true }).waitFor({ timeout: 20_000 });
      await shot(page, 'equipo-deshabilitado');
      const again = await openTeam(page, teamRoom);
      await again.getByLabel('Habilitado', { exact: true }).selectOption('true');
      await previewAndConfirm(again, 'Confirmar edición');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
    });
    expect(await roomState(teamRoom)).toMatchObject({ enabled: true, retired: false });
  }, 180_000);

  it('mueve al dueño a la sala nueva y lo devuelve a office', async () => {
    const page = ownerPage();
    expect(await ownerRooms()).toEqual(['office']);
    await step(page, 'move owner to the new team', async () => {
      const dialog = await openTeam(page, 'office');
      await dialog.getByRole('region', { name: `Movimiento de miembros de ${hub}/office`, exact: true }).waitFor();
      await dialog.getByRole('combobox', { name: 'Miembro a mover' }).selectOption('owner');
      await dialog.getByRole('combobox', { name: 'Grupo de destino' }).selectOption(teamRoom);
      await dialog.getByRole('button', { name: 'Previsualizar movimiento atómico', exact: true }).click();
      const apply = dialog.getByRole('button', { name: 'Confirmar movimiento atómico', exact: true });
      await expect.poll(async () => apply.isDisabled(), { timeout: 20_000 }).toBe(false);
      await dialog.getByLabel('Movimiento atómico propuesto', { exact: true }).waitFor();
      await shot(page, 'equipo-movimiento');
      await apply.click();
      await dialog.getByRole('region', { name: `Movimiento de miembros de ${hub}/office`, exact: true })
        .getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      await closeDialog(dialog);
    });
    expect(await ownerRooms()).toEqual([teamRoom]);
    const primary = await pool().query<{ primary_room_id: string | null }>(
      'SELECT primary_room_id FROM agents WHERE tenant_id=$1 AND alias=$2', [hub, 'owner']);
    expect(primary.rows[0]?.primary_room_id).toBe(teamRoom);

    await step(page, 'move owner back to office', async () => {
      const dialog = await openTeam(page, teamRoom);
      await dialog.getByRole('combobox', { name: 'Miembro a mover' }).selectOption('owner');
      await dialog.getByRole('combobox', { name: 'Grupo de destino' }).selectOption('office');
      await dialog.getByRole('button', { name: 'Previsualizar movimiento atómico', exact: true }).click();
      const apply = dialog.getByRole('button', { name: 'Confirmar movimiento atómico', exact: true });
      await expect.poll(async () => apply.isDisabled(), { timeout: 20_000 }).toBe(false);
      await apply.click();
      await dialog.getByRole('region', { name: `Movimiento de miembros de ${hub}/${teamRoom}`, exact: true })
        .getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
    });
    expect(await ownerRooms()).toEqual(['office']);
  }, 180_000);

  it('añade, edita y quita una membresía desde el editor de grupo', async () => {
    const page = ownerPage();
    await step(page, 'membership add edit delete', async () => {
      const dialog = await openTeam(page, jsonRoom);
      await dialog.getByRole('button', { name: 'Añadir miembro a esta sala/grupo', exact: true }).click();
      await dialog.getByRole('heading', { name: 'Miembro del equipo · membresía', exact: true }).waitFor({ timeout: 15_000 });
      const create = dialog.getByRole('form', { name: 'Crear membresía', exact: true });
      await create.getByLabel('Alias del agente', { exact: true }).fill('owner');
      await previewAndConfirm(create, 'Confirmar creación');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });

      const edit = await openTeam(page, jsonRoom);
      await edit.getByRole('button', { name: 'Editar miembro owner', exact: true }).click();
      const member = edit.getByRole('form', { name: 'Editar membresía', exact: true });
      await member.getByLabel('Habilitado', { exact: true }).selectOption('false');
      await previewAndConfirm(member, 'Confirmar edición');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => (await pool().query<{ enabled: boolean }>(
        'SELECT enabled FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3',
        [hub, jsonRoom, 'owner'])).rows[0]?.enabled, { timeout: 20_000 }).toBe(false);

      const remove = await openTeam(page, jsonRoom);
      await remove.getByRole('button', { name: 'Eliminar miembro owner', exact: true }).click();
      const deletion = remove.getByRole('form', { name: 'Eliminar membresía', exact: true });
      await previewAndConfirm(deletion, 'Confirmar eliminación');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
    });
    const extra = await pool().query(
      'SELECT enabled FROM memberships WHERE tenant_id=$1 AND room_id=$2 AND alias=$3', [hub, jsonRoom, 'owner']);
    expect(extra.rowCount).toBe(0);
    expect(await ownerRooms()).toEqual(['office']);
  }, 180_000);

  it('no borra una sala con miembros y sí borra una sala vacía', async () => {
    const page = ownerPage();
    await step(page, 'delete blocked by membership', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: `Eliminar sala/grupo ${hub}/office`, exact: true }).click();
      const form = page.getByRole('form', { name: 'Eliminar sala/grupo', exact: true });
      errors.expectHttpError('/v3/console/config/changes', 409);
      await form.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
      const confirm = form.getByRole('button', { name: 'Confirmar eliminación', exact: true });
      await expect.poll(async () => (await form.getByRole('alert').count()) > 0 || !(await confirm.isDisabled()), { timeout: 20_000 }).toBe(true);
      if ((await form.getByRole('alert').count()) === 0) await confirm.click();
      await expect.poll(async () => form.getByRole('alert').first().innerText(), { timeout: 20_000 }).toMatch(/no se aplicó|bloquean|dependenc/iu);
      await shot(page, 'sala-con-miembros');
    });
    expect(await roomState('office')).toMatchObject({ retired: false });

    await step(page, 'delete empty room', async () => {
      await openConfig(page, 'espacios');
      await page.getByRole('button', { name: `Eliminar sala/grupo ${hub}/${jsonRoom}`, exact: true }).click();
      const form = page.getByRole('form', { name: 'Eliminar sala/grupo', exact: true });
      await previewAndConfirm(form, 'Confirmar eliminación');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
    });
    await expect.poll(async () => (await pool().query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2', [hub, jsonRoom])).rowCount, { timeout: 20_000 }).toBe(0);
  }, 180_000);

  it('retira una sala vacía y restauración y purga quedan bloqueadas sin ejecutor', async () => {
    const page = ownerPage();
    await step(page, 'retire empty team', async () => {
      await openConfig(page, 'agentes');
      await page.getByRole('button', { name: 'Nuevo equipo', exact: true }).click();
      const dialog = page.getByRole('dialog');
      const space = dialog.getByLabel('Espacio', { exact: true });
      if (!(await space.isDisabled())) await space.selectOption(hub);
      await dialog.getByLabel('Id de la sala/grupo', { exact: true }).fill(retireRoom);
      await dialog.getByLabel('Nombre visible', { exact: true }).fill('Sala retiro');
      await previewAndConfirm(dialog, 'Confirmar creación');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      await page.getByRole('button', { name: `Retirar equipo ${hub}/${retireRoom}`, exact: true }).click();
      const retire = page.getByRole('dialog');
      await retire.getByRole('heading', { name: 'Retirar equipo', exact: true }).waitFor({ timeout: 15_000 });
      await previewAndConfirm(retire, 'Confirmar retiro');
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      await page.getByRole('list', { name: 'Equipos retirados', exact: true }).getByText(`${hub}/${retireRoom}`).waitFor({ timeout: 20_000 });
      await shot(page, 'equipo-retirado');
    });
    expect(await roomState(retireRoom)).toMatchObject({ enabled: false, retired: true });

    await step(page, 'restore and purge blocked', async () => {
      await page.getByRole('button', { name: `Restaurar equipo ${hub}/${retireRoom}`, exact: true }).click();
      let dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: 'Restaurar grupo', exact: true }).waitFor({ timeout: 15_000 });
      await dialog.getByText('ejecutor', { exact: false }).waitFor({ timeout: 20_000 });
      await shot(page, 'equipo-restaurar-bloqueado');
      await closeDialog(dialog);
      await page.getByRole('button', { name: `Purgar equipo ${hub}/${retireRoom}`, exact: true }).click();
      dialog = page.getByRole('dialog');
      await dialog.getByRole('heading', { name: 'Purgar grupo', exact: true }).waitFor({ timeout: 15_000 });
      await dialog.getByText('ejecutor', { exact: false }).waitFor({ timeout: 20_000 });
      await shot(page, 'equipo-purgar-bloqueado');
      await closeDialog(dialog);
    });
    expect(await roomState(retireRoom)).toMatchObject({ retired: true });
    expect((await pool().query('SELECT 1 FROM rooms WHERE tenant_id=$1 AND id=$2 AND purged_at IS NULL', [hub, retireRoom])).rowCount).toBe(1);
  }, 180_000);

  it('Arneses muestra el manual de cada programa y no deja escribir el catálogo', async () => {
    const page = ownerPage();
    await step(page, 'harness catalog', async () => {
      await openConfig(page, 'arneses');
      await page.getByRole('heading', { name: 'Arneses', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('heading', { name: 'Qué lee cada arnés de verdad', exact: true }).waitFor({ timeout: 20_000 });
      for (const [label, path] of [
        ['Claude Code', '<HOME>/.claude/CLAUDE.md'],
        ['Codex', '<HOME>/.codex/AGENTS.md'],
        ['OpenClaw', '<WORKSPACE_OPENCLAW>/AGENTS.md'],
        ['Grok', '<WORKSPACE_GROK>/AGENTS.md'],
        ['Muse', '<WORKSPACE_MUSE>/AGENTS.md'],
        ['Hermes', '<HOME>/AGENTS.md'],
      ] as const) {
        await page.getByRole('heading', { name: label, exact: true }).waitFor();
        await page.getByText(path, { exact: true }).waitFor();
      }
      await page.getByText('No eliges el programa aquí.', { exact: false }).waitFor();
      await page.getByRole('heading', { name: 'Definiciones de arnés', exact: true }).waitFor({ timeout: 20_000 });
      await page.getByRole('cell', { name: 'claude', exact: true }).waitFor();
      const create = page.getByRole('button', { name: 'Crear definición de arnés', exact: true });
      await create.waitFor({ timeout: 20_000 });
      expect(await create.isDisabled()).toBe(true);
      await page.getByText('Todo arnés con descriptor publicado ya tiene definición.', { exact: true }).waitFor();

      await page.getByRole('button', { name: 'Editar arnés fake', exact: true }).click();
      const edit = page.getByRole('form', { name: 'Editar arnés fake', exact: true });
      await edit.getByLabel('Nombre visible', { exact: true }).fill(`zz-canary fake ${run}`);
      await edit.getByRole('button', { name: 'Confirmar edición', exact: true }).click();
      await page.getByRole('cell', { name: `zz-canary fake ${run}`, exact: true }).waitFor({ timeout: 20_000 });

      await page.getByRole('button', { name: 'Eliminar arnés fake2', exact: true }).click();
      const removal = page.getByRole('alertdialog', { name: 'Eliminar arnés fake2', exact: true });
      await removal.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
      await page.getByRole('status').filter({ hasText: 'Aplicado en revisión' }).waitFor({ timeout: 20_000 });
      await expect.poll(async () => page.getByRole('button', { name: 'Crear definición de arnés', exact: true }).isDisabled(), { timeout: 20_000 }).toBe(false);

      await page.getByRole('button', { name: 'Crear definición de arnés', exact: true }).click();
      const form = page.getByRole('form', { name: 'Crear definición de arnés', exact: true });
      await form.getByLabel('Id del arnés', { exact: true }).selectOption('fake2');
      await form.getByLabel('Nombre visible', { exact: true }).fill(`zz-canary fake2 ${run}`);
      await form.getByRole('button', { name: 'Confirmar creación', exact: true }).click();
      await page.getByRole('cell', { name: `zz-canary fake2 ${run}`, exact: true }).waitFor({ timeout: 20_000 });
      await shot(page, 'arneses-escritorio');
    });
    const definitions = await pool().query<{ id: string; display_name: string }>(
      'SELECT id, display_name FROM harness_definitions ORDER BY id');
    const byId = new Map(definitions.rows.map((row) => [row.id, row.display_name]));
    expect(byId.get('claude')).toBe('Claude Code');
    expect(byId.get('codex')).toBe('Codex');
    expect(byId.get('fake')).toBe(`zz-canary fake ${run}`);
    expect(byId.get('fake2')).toBe(`zz-canary fake2 ${run}`);
  }, 180_000);

  it('no quedan errores inesperados del navegador', () => {
    errors.assertClean();
  });
});
