import type { DatabasePool } from '@cauce/store';
import { expect } from 'vitest';
import type { V4Locator, V4Page } from './v4-console-real-browser.helpers.js';
import { companyCapture, companyPerson } from './v4-acceso-companies.helpers.js';

const from = companyPerson('from').company.slug;
const to = 'Steven';
const alias = 'zz-canary-access';

async function apply(form: V4Locator, confirmation: string): Promise<void> {
  const confirm = form.getByRole('button', { name: confirmation, exact: true });
  expect(await confirm.isDisabled()).toBe(true);
  await form.getByRole('button', { name: 'Previsualizar cambio', exact: true }).click();
  try {
    await expect.poll(() => confirm.isDisabled(), { timeout: 20_000 }).toBe(false);
  } catch (cause) {
    throw new Error(`configuration preview did not enable confirmation: ${await form.innerText()}`, { cause });
  }
  await confirm.click();
  await form.waitFor({ state: 'hidden', timeout: 20_000 });
}

export async function exerciseChainPolicy(page: V4Page, pool: DatabasePool): Promise<void> {
  const previous = (await pool.query<{ max_fanout_per_turn: number }>('SELECT max_fanout_per_turn FROM agent_chain_policies WHERE id=\'default\'')).rows[0];
  if (!previous) throw new Error('default chain policy is missing');
  const next = previous.max_fanout_per_turn === 7 ? 8 : 7;
  const panel = page.getByRole('region', { name: 'Política de cadena', exact: true });
  await panel.getByRole('button', { name: /^Editar política de cadena/u }).click();
  const form = page.getByRole('form', { name: 'Editar política de cadena', exact: true });
  await form.getByLabel('Máximo de delegaciones por turno', { exact: true }).fill(String(next));
  await form.getByText('Ver los datos del cambio', { exact: true }).click();
  await companyCapture(page, '12-chain-policy-preview-desktop-1440x900');
  await apply(form, 'Confirmar edición');
  expect((await pool.query<{ max_fanout_per_turn: number }>('SELECT max_fanout_per_turn FROM agent_chain_policies WHERE id=\'default\'')).rows[0]?.max_fanout_per_turn).toBe(next);
}

export async function exerciseAccessTables(page: V4Page, pool: DatabasePool, base: string, email: string): Promise<void> {
  const actor = (await pool.query<{ company_id: string }>('SELECT company_id FROM console_users WHERE email=$1', [email])).rows[0];
  if (!actor) throw new Error('platform fixture actor is missing');
  await pool.query('INSERT INTO tenants(id,company_id) VALUES($1,$2)', [from, actor.company_id]);
  await pool.query(`INSERT INTO agents(tenant_id,alias,harness_id,display_name,enabled,company_id) VALUES($1,$2,'fake2',$2,false,$3)`, [from, alias, actor.company_id]);
  await pool.query('INSERT INTO rooms(tenant_id,id) VALUES($1,$2)', [from, 'zz-canary-access-notices']);
  await pool.query(`INSERT INTO memberships(tenant_id,room_id,alias,role,enabled)
    VALUES($1,$2,$3,'agent_notify',true)`, [from, 'zz-canary-access-notices', alias]);
  await page.goto(`${base}/config?seccion=acceso`, { waitUntil: 'domcontentloaded' });
  const acl = page.getByRole('region', { name: 'Permisos entre clientes', exact: true });
  await acl.getByRole('button', { name: 'Crear permiso entre clientes', exact: true }).click();
  const create = page.getByRole('form', { name: 'Crear permiso entre clientes', exact: true });
  await create.getByLabel('Desde el espacio', { exact: true }).selectOption(from);
  await create.getByLabel('Hacia el espacio', { exact: true }).selectOption(to);
  await create.getByLabel('Permitir ruta', { exact: true }).selectOption('true');
  await apply(create, 'Confirmar creación');
  const query = () => pool.query<{ allow_route: boolean; allow_read: boolean }>('SELECT allow_route,allow_read FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', [from, to]);
  expect((await query()).rows).toEqual([{ allow_route: true, allow_read: false }]);
  const row = acl.getByRole('row').filter({ hasText: from });
  await row.getByRole('button', { name: /^Editar permiso entre clientes/u }).click();
  const edit = page.getByRole('form', { name: 'Editar permiso entre clientes', exact: true });
  await edit.getByLabel('Permitir lectura', { exact: true }).selectOption('true');
  await apply(edit, 'Confirmar edición');
  expect((await query()).rows).toEqual([{ allow_route: true, allow_read: true }]);
  for (const [label, column, value] of [
    ['Habilitado', 'enabled', false], ['Ruta', 'allow_route', false],
    ['Lectura', 'allow_read', false], ['Control', 'allow_control', true],
  ] as const) {
    await row.getByRole('switch', { name: new RegExp(`^${label} en`, 'u') }).click();
    await expect.poll(async () => (await pool.query<Record<string, boolean>>(
      'SELECT enabled,allow_route,allow_read,allow_control FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', [from, to])).rows[0]?.[column], { timeout: 20_000 }).toBe(value);
  }
  const control = row.getByRole('switch', { name: /^Control en/u });
  await control.click();
  const confirmation = page.getByRole('group', { name: 'Confirmar quitar el permiso de Control', exact: true });
  await confirmation.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect((await pool.query<{ allow_control: boolean }>('SELECT allow_control FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', [from, to])).rows[0]?.allow_control).toBe(true);
  await control.click();
  await confirmation.getByRole('button', { name: 'Quitar Control', exact: true }).click();
  await expect.poll(async () => (await pool.query<{ allow_control: boolean }>('SELECT allow_control FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2', [from, to])).rows[0]?.allow_control).toBe(false);
  await companyCapture(page, '13-access-acl-roles-desktop-1440x900');
  await row.getByRole('button', { name: /^Eliminar permiso entre clientes/u }).click();
  await apply(page.getByRole('form', { name: 'Eliminar permiso entre clientes', exact: true }), 'Confirmar eliminación');
  expect((await query()).rowCount).toBe(0);
  const destinations = page.getByRole('region', { name: 'Destinos de aviso proactivo', exact: true });
  await destinations.getByRole('button', { name: 'Crear destino de avisos', exact: true }).click();
  const destination = page.getByRole('form', { name: 'Crear destino de avisos', exact: true });
  await destination.getByLabel('Espacio', { exact: true }).selectOption(from);
  for (const [label, value] of [
    ['Alias del agente', alias], ['Identificador del destino', 'zz-canary-access'],
    ['Id numérico de conversación', '-1000000001'], ['Etiqueta visible', 'Destino canario'],
  ] as const) await destination.getByLabel(label, { exact: true }).fill(value);
  await apply(destination, 'Confirmar creación');
  const stored = () => pool.query<{ display_label: string }>('SELECT display_label FROM egress_destinations WHERE tenant_id=$1 AND alias=$2 AND handle=$3', [from, alias, 'zz-canary-access']);
  expect((await stored()).rows).toEqual([{ display_label: 'Destino canario' }]);
  const destinationRow = destinations.getByRole('row').filter({ hasText: 'zz-canary-access' });
  await destinationRow.getByRole('button', { name: /^Editar destino de avisos/u }).click();
  const editDestination = page.getByRole('form', { name: 'Editar destino de avisos', exact: true });
  await editDestination.getByLabel('Etiqueta visible', { exact: true }).fill('Destino editado');
  await apply(editDestination, 'Confirmar edición');
  expect((await stored()).rows).toEqual([{ display_label: 'Destino editado' }]);
  await companyCapture(page, '14-egress-desktop-1440x900');
  await page.setViewportSize({ width: 390, height: 844 });
  await companyCapture(page, '15-egress-mobile-390x844');
  await page.setViewportSize({ width: 1440, height: 900 });
  await destinationRow.getByRole('button', { name: /^Eliminar destino de avisos/u }).click();
  await apply(page.getByRole('form', { name: 'Eliminar destino de avisos', exact: true }), 'Confirmar eliminación');
  expect((await stored()).rowCount).toBe(0);
}
