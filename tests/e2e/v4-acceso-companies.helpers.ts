import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { expect } from 'vitest';
import {
  apiGet, syntheticPerson, type V4Locator, type V4Page, type V4Person,
} from './v4-console-real-browser.helpers.js';

export const companiesReceiptDirectory = join(process.cwd(), '.delegados/v4/recibos/e2e-a1-acceso-1025b/companies');
const run = randomUUID().replaceAll('-', '').slice(0, 8);

export function companyPerson(label: string): V4Person {
  const prefix = `zz-canary-e2e-a1-acceso-1025b-${label}-${run}`;
  return { ...syntheticPerson(label, run), email: `${prefix}@example.invalid`, name: prefix,
    company: { name: prefix, slug: prefix } };
}

export async function openCompanies(page: V4Page, base: string): Promise<V4Locator> {
  await page.goto(`${base}/config?seccion=general`, { waitUntil: 'domcontentloaded' });
  const panel = page.getByRole('region', { name: 'Empresas', exact: true });
  await panel.getByRole('button', { name: 'Crear empresa', exact: true }).waitFor({ timeout: 30_000 });
  await panel.locator('button:enabled').filter({ hasText: 'Crear empresa' }).waitFor({ timeout: 30_000 });
  return panel;
}

export function companyRow(page: V4Page, name: string): V4Locator {
  return page.getByRole('region', { name: 'Empresas', exact: true }).getByRole('listitem').filter({ hasText: name });
}

export async function createCompany(page: V4Page, person: V4Person): Promise<void> {
  const panel = page.getByRole('region', { name: 'Empresas', exact: true });
  await panel.getByRole('button', { name: 'Crear empresa', exact: true }).click();
  const form = panel.getByRole('form', { name: 'Crear empresa y dueño', exact: true });
  for (const [label, value] of [
    ['Nombre de empresa', person.company.name], ['Identificador de empresa', person.company.slug],
    ['Nombre del dueño', person.name], ['Correo del dueño', person.email], ['Contraseña inicial', person.password],
  ] as const) await form.getByLabel(label, { exact: true }).fill(value);
  await form.getByRole('button', { name: 'Crear empresa y dueño', exact: true }).click();
  await panel.getByText('Empresa y cuenta de dueño creadas.', { exact: true }).waitFor({ timeout: 20_000 });
  await companyRow(page, person.company.name).waitFor({ timeout: 20_000 });
}

export async function companyState(page: V4Page, id: string, state: string): Promise<void> {
  await expect.poll(async () => {
    const response = await apiGet(page, `/v3/console/companies/${id}`);
    return { status: response.status, state: response.body.state };
  }).toEqual({ status: 200, state });
}

export async function confirmCompanyState(page: V4Page, person: V4Person, action: string, state: string): Promise<void> {
  await companyRow(page, person.company.name).getByRole('button', { name: action, exact: true }).click();
  const confirm = page.getByRole('region', { name: 'Confirmar estado de empresa', exact: true });
  const button = confirm.getByRole('button', { name: 'Confirmar cambio de empresa', exact: true });
  if (action === 'Deshabilitar' || action === 'Retirar') {
    expect(await button.isDisabled()).toBe(true);
    await confirm.getByRole('textbox').fill(`${person.company.slug} `);
    expect(await button.isDisabled()).toBe(true);
    await confirm.getByRole('textbox').fill(person.company.slug);
  }
  await button.click();
  await confirm.waitFor({ state: 'hidden', timeout: 20_000 });
  await companyState(page, person.company.slug, state);
}

export async function companyCapture(page: V4Page, name: string): Promise<void> {
  await mkdir(companiesReceiptDirectory, { recursive: true });
  await page.screenshot({ path: join(companiesReceiptDirectory, `${name}.png`), fullPage: true });
}
