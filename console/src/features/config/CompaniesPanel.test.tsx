import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import type { CompanyRecord } from '../../api/client/company-client';
import type { ConsoleAuthorityRole } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { CompanySessionProvider } from '../auth/company-session';
import { CompaniesPanel } from './CompaniesPanel';
import { COMPANY_SLUG_PATTERN } from './form-patterns';

const ONE: CompanyRecord = { id: 'one', name: 'Empresa uno', state: 'enabled', version: 1 };

function renderAs(role: ConsoleAuthorityRole, companies: CompanyRecord[] = [ONE]) {
  const scope = role === 'platform_admin' ? 'platform' : role === 'company_owner' || role === 'company_admin' ? 'company' : 'tenant';
  server.use(http.get('*/v3/console/companies', () => HttpResponse.json({ home_company: 'one', acting_company: 'one', role,
    scope, platform_override: false, companies })));
  renderWithApi(<CompanySessionProvider state={{ authenticated: true, authority: { role,
    scope, home_company: 'one', acting_company: 'one', platform_override: false } }}>
    <CompaniesPanel />
  </CompanySessionProvider>);
}

async function row(name: string) {
  return within((await screen.findByText(name)).closest('li') ?? document.body);
}

it.each<ConsoleAuthorityRole>(['company_owner', 'company_admin'])('no ofrece crear empresas a %s: solo la plataforma las crea', async (role) => {
  renderAs(role);
  expect(await screen.findByText('Empresa uno')).toBeVisible();
  expect(screen.queryByRole('button', { name: 'Crear empresa' })).toBeNull();
  expect(screen.queryByRole('form', { name: 'Crear empresa y dueño' })).toBeNull();
});

it('la plataforma abre el alta con el mismo patrón de identificador que valida el servidor', async () => {
  const user = userEvent.setup();
  renderAs('platform_admin');
  expect(await screen.findByText('Empresa uno')).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Crear empresa' }));
  expect(screen.getByRole('form', { name: 'Crear empresa y dueño' })).toBeVisible();
  expect(screen.getByLabelText('Identificador de empresa')).toHaveAttribute('pattern', COMPANY_SLUG_PATTERN);
});

it('el dueño solo retira su empresa escribiendo su identificador y tras el aviso de que pierde el acceso', async () => {
  const user = userEvent.setup();
  let retired: string | undefined;
  server.use(http.delete('*/v3/console/companies/one', ({ request }) => {
    retired = new URL(request.url).search;
    return HttpResponse.json({ ...ONE, state: 'retired', version: 2 });
  }));
  renderAs('company_owner');
  const company = await row('Empresa uno');
  expect(company.queryByRole('button', { name: 'Habilitar' })).toBeNull();
  await user.click(company.getByRole('button', { name: 'Retirar' }));
  const confirmation = screen.getByRole('region', { name: 'Confirmar estado de empresa' });
  expect(confirmation).toHaveTextContent('perderás el acceso a la consola');
  expect(confirmation).toHaveTextContent('Solo un administrador de plataforma puede volver a habilitarla o restaurarla');
  const confirm = within(confirmation).getByRole('button', { name: 'Confirmar cambio de empresa' });
  expect(confirm).toBeDisabled();
  await user.type(within(confirmation).getByLabelText(/Escribe el identificador/), 'on');
  expect(confirm).toBeDisabled();
  await user.type(within(confirmation).getByLabelText(/Escribe el identificador/), 'e');
  await user.click(confirm);
  expect(await screen.findByText('Estado de empresa actualizado.')).toBeVisible();
  expect(retired).toBe('?expected_version=1');
});

it('deshabilitar también exige escribir el identificador y envía el estado disabled', async () => {
  const user = userEvent.setup();
  let body: unknown;
  server.use(http.patch('*/v3/console/companies/one', async ({ request }) => {
    body = await request.json();
    return HttpResponse.json({ ...ONE, state: 'disabled', version: 2 });
  }));
  renderAs('company_owner');
  await user.click((await row('Empresa uno')).getByRole('button', { name: 'Deshabilitar' }));
  const confirmation = screen.getByRole('region', { name: 'Confirmar estado de empresa' });
  expect(within(confirmation).getByRole('button', { name: 'Confirmar cambio de empresa' })).toBeDisabled();
  await user.type(within(confirmation).getByLabelText(/Escribe el identificador/), 'one');
  await user.click(within(confirmation).getByRole('button', { name: 'Confirmar cambio de empresa' }));
  expect(await screen.findByText('Estado de empresa actualizado.')).toBeVisible();
  expect(body).toEqual({ expected_version: 1, state: 'disabled' });
});

it('una empresa deshabilitada se vuelve a habilitar sin retirarla antes', async () => {
  const user = userEvent.setup();
  let body: unknown;
  server.use(http.patch('*/v3/console/companies/two', async ({ request }) => {
    body = await request.json();
    return HttpResponse.json({ id: 'two', name: 'Empresa dos', state: 'enabled', version: 4 });
  }));
  renderAs('platform_admin', [ONE, { id: 'two', name: 'Empresa dos', state: 'disabled', version: 3 }]);
  const company = await row('Empresa dos');
  expect(company.getByRole('button', { name: 'Retirar' })).toBeEnabled();
  expect(company.queryByRole('button', { name: 'Deshabilitar' })).toBeNull();
  await user.click(company.getByRole('button', { name: 'Habilitar' }));
  const confirmation = screen.getByRole('region', { name: 'Confirmar estado de empresa' });
  expect(confirmation).not.toHaveTextContent('perderás el acceso');
  await user.click(within(confirmation).getByRole('button', { name: 'Confirmar cambio de empresa' }));
  expect(await screen.findByText('Estado de empresa actualizado.')).toBeVisible();
  expect(body).toEqual({ expected_version: 3, state: 'enabled' });
});

it('una empresa retirada solo ofrece restaurarla', async () => {
  renderAs('platform_admin', [ONE, { id: 'two', name: 'Empresa dos', state: 'retired', version: 3 }]);
  const company = await row('Empresa dos');
  expect(company.getByRole('button', { name: 'Restaurar' })).toBeEnabled();
  for (const name of ['Deshabilitar', 'Habilitar', 'Retirar']) expect(company.queryByRole('button', { name })).toBeNull();
});

it.each<ConsoleAuthorityRole>(['reader', 'tenant_operator'])('a %s le apaga «Autoridad de empresa» y le explica por qué', async (role) => {
  renderAs(role);
  expect((await row('Empresa uno')).getByRole('button', { name: 'Autoridad de empresa' })).toBeDisabled();
  expect(screen.getByText(/Solo dueños, administradores de empresa y la plataforma/)).toBeVisible();
});

it('el administrador de empresa sí abre la autoridad de su empresa', async () => {
  renderAs('company_admin');
  expect((await row('Empresa uno')).getByRole('button', { name: 'Autoridad de empresa' })).toBeEnabled();
  expect(screen.queryByText(/Solo dueños, administradores de empresa y la plataforma/)).toBeNull();
});

it.each([
  [409, 'conflict', 'La empresa cambió mientras la revisabas'],
  [403, 'forbidden', 'Tu sesión no tiene autoridad para este cambio de empresa'],
])('traduce el %i del servidor y nunca muestra su mensaje en inglés', async (status, error, text) => {
  const user = userEvent.setup();
  server.use(http.patch('*/v3/console/companies/one', () => HttpResponse.json({ error, message: 'company version changed; reload and retry' }, { status })));
  renderAs('company_owner');
  await user.click((await row('Empresa uno')).getByRole('button', { name: 'Editar' }));
  await user.click(screen.getByRole('button', { name: 'Guardar empresa' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(text);
  expect(alert).not.toHaveTextContent('reload and retry');
});

it('un fallo al leer las empresas se explica en español', async () => {
  server.use(http.get('*/v3/console/companies', () => HttpResponse.json({ error: 'forbidden', message: 'forbidden' }, { status: 403 })));
  renderWithApi(<CompanySessionProvider state={{ authenticated: true, authority: { role: 'reader', scope: 'tenant',
    home_company: 'one', acting_company: 'one', platform_override: false } }}><CompaniesPanel /></CompanySessionProvider>);
  expect(await screen.findByRole('alert')).toHaveTextContent('Tu sesión no puede ver las empresas.');
});
