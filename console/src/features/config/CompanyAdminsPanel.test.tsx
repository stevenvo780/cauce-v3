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

const SIN_CAPACIDADES = { create: false, update: false, retire: false, restore: false, purge: false };

it('dice que no hay administradores ni personas elegibles cuando las dos lecturas llegan vacías', async () => {
  server.use(http.get('*/v3/console/companies/two/admins', () => HttpResponse.json({ company_id: 'two', items: [],
    capabilities: { grant_admin: true, grant_owner: true, revoke: true } })),
  http.get('*/v3/console/people', () => HttpResponse.json({ items: [], capabilities: SIN_CAPACIDADES })));
  renderWithApi(<CompanyAdminsPanel companyId="two" canAssignPeople />);
  expect(await screen.findByText(/Todavía no hay dueños ni administradores asignados/u)).toBeVisible();
  expect(await screen.findByText(/No hay personas activas elegibles para asignar/u)).toBeVisible();
});

it('anuncia la lectura de personas mientras el selector está deshabilitado', async () => {
  server.use(http.get('*/v3/console/companies/two/admins', () => HttpResponse.json({ company_id: 'two', items: [],
    capabilities: { grant_admin: true, grant_owner: true, revoke: true } })),
  http.get('*/v3/console/people', async () => {
    await new Promise(resolve => { setTimeout(resolve, 600); });
    return HttpResponse.json({ items: [], capabilities: SIN_CAPACIDADES });
  }));
  renderWithApi(<CompanyAdminsPanel companyId="two" canAssignPeople />);
  expect(await screen.findByText(/Leyendo personas elegibles…/u)).toBeVisible();
  expect(screen.getByRole('combobox', { name: 'Persona' })).toBeDisabled();
  expect(await screen.findByText(/No hay personas activas elegibles para asignar/u)).toBeVisible();
});
