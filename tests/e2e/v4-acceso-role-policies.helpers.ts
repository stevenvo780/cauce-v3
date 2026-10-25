import type { DatabasePool } from '@cauce/store';
import { expect } from 'vitest';
import type { V4Page } from './v4-console-real-browser.helpers.js';
import { companyCapture } from './v4-acceso-companies.helpers.js';

export async function exerciseRolePolicies(page: V4Page, pool: DatabasePool): Promise<void> {
  const role = 'zz-canary-e2e-a1-acceso-1025b-policy';
  const panel = page.getByRole('region', { name: 'Permisos por rol', exact: true });
  const createButton = panel.getByRole('button', { name: 'Crear política de rol', exact: true });
  await createButton.waitFor();
  await createButton.click();
  const create = panel.getByRole('form', { name: 'Crear política de rol', exact: true });
  await create.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect(await create.count()).toBe(0);
  await createButton.click();
  await create.getByLabel('Id del rol', { exact: true }).fill('Rol inválido');
  await create.getByRole('button', { name: 'Confirmar creación', exact: true }).click();
  await create.getByRole('alert').filter({ hasText: 'Id del rol:' }).waitFor();
  await companyCapture(page, '18-role-validation-desktop-1440x900');
  await create.getByLabel('Id del rol', { exact: true }).fill(role);
  await create.getByLabel('Permitir ruta', { exact: true }).check();
  await create.getByRole('button', { name: 'Confirmar creación', exact: true }).click();
  await create.waitFor({ state: 'hidden' });
  const row = panel.getByRole('row').filter({ hasText: role });
  await row.waitFor();
  const query = () => pool.query<{ allow_route: boolean; allow_read: boolean; allow_control: boolean; allow_notify: boolean }>(
    'SELECT allow_route,allow_read,allow_control,allow_notify FROM role_policies WHERE role=$1', [role]);
  expect((await query()).rows).toEqual([{ allow_route: true, allow_read: false, allow_control: false, allow_notify: false }]);
  await row.getByRole('button', { name: `Editar rol ${role}`, exact: true }).click();
  const edit = panel.getByRole('form', { name: `Editar rol ${role}`, exact: true });
  expect(await edit.getByLabel('Id del rol', { exact: true }).isDisabled()).toBe(true);
  await edit.getByLabel('Permitir lectura', { exact: true }).check();
  await edit.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect((await query()).rows[0]?.allow_read).toBe(false);
  await row.getByRole('button', { name: `Editar rol ${role}`, exact: true }).click();
  for (const label of ['Permitir lectura', 'Permitir control', 'Permitir aviso proactivo']) {
    await edit.getByLabel(label, { exact: true }).check();
  }
  await edit.getByRole('button', { name: 'Confirmar edición', exact: true }).click();
  await edit.waitFor({ state: 'hidden' });
  expect((await query()).rows).toEqual([{ allow_route: true, allow_read: true, allow_control: true, allow_notify: true }]);
  await companyCapture(page, '19-role-edited-desktop-1440x900');
  await page.setViewportSize({ width: 390, height: 844 });
  await companyCapture(page, '20-role-edited-mobile-390x844');
  await page.setViewportSize({ width: 1440, height: 900 });
  await row.getByRole('button', { name: `Eliminar rol ${role}`, exact: true }).click();
  const confirmation = panel.getByRole('alertdialog', { name: `Eliminar rol ${role}`, exact: true });
  await confirmation.getByRole('button', { name: 'Cancelar', exact: true }).click();
  expect((await query()).rowCount).toBe(1);
  await row.getByRole('button', { name: `Eliminar rol ${role}`, exact: true }).click();
  await confirmation.getByRole('button', { name: 'Confirmar eliminación', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  expect((await query()).rowCount).toBe(0);
}
