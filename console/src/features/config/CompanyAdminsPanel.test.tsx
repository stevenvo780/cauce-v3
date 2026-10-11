import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { CompanyAdminsPanel } from './CompanyAdminsPanel';

it('no proyecta las personas de la empresa actuada como candidatas de una empresa distinta', async () => {
  let peopleReads = 0;
  server.use(http.get('*/v3/console/companies/two/admins', () => HttpResponse.json({ company_id: 'two', items: [],
    capabilities: { grant_admin: true, grant_owner: true, revoke: true } })),
  http.get('*/v3/console/people', () => { peopleReads += 1; return HttpResponse.json({ items: [] }); }));
  renderWithApi(<CompanyAdminsPanel companyId="two" canAssignPeople={false} />);
  expect(await screen.findByText(/Selecciona esta empresa en el menú de cuenta/u)).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Persona' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Guardar autoridad' })).toBeDisabled();
  expect(peopleReads).toBe(0);
});
