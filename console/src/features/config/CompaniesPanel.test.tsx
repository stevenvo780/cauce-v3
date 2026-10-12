import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { CompanySessionProvider } from '../auth/company-session';
import { CompaniesPanel } from './CompaniesPanel';
import { COMPANY_SLUG_PATTERN } from './form-patterns';

type Role = 'platform_admin' | 'company_owner' | 'company_admin';

function renderAs(role: Role) {
  server.use(http.get('*/v3/console/companies', () => HttpResponse.json({ home_company: 'one', acting_company: 'one', role,
    scope: role === 'platform_admin' ? 'platform' : 'company', platform_override: false,
    companies: [{ id: 'one', name: 'Empresa uno', state: 'enabled', version: 1 }] })));
  renderWithApi(<CompanySessionProvider state={{ authenticated: true, authority: { role,
    scope: role === 'platform_admin' ? 'platform' : 'company', home_company: 'one', acting_company: 'one', platform_override: false } }}>
    <CompaniesPanel />
  </CompanySessionProvider>);
}

it.each<Role>(['company_owner', 'company_admin'])('no ofrece crear empresas a %s: solo la plataforma las crea', async (role) => {
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
