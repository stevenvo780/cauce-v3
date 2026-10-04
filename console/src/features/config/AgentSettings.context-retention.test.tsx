import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { perfilAplicado } from '../live/perfil-fixtures';
import { ConfigPage } from './ConfigPage';

const initial = {
  revision: 1,
  agents: [
    { tenant_id: 'A', alias: 'same', display_name: 'Agente A', harness_id: 'codex', enabled: true },
    { tenant_id: 'B', alias: 'same', display_name: 'Agente B', harness_id: 'codex', enabled: true },
  ],
  memberships: [],
  rooms: [],
};

it('retains the canonical draft across a missing registry snapshot and isolates an equal alias in another tenant', async () => {
  let current = initial;
  let configReads = 0;
  const profileReads: string[] = [];
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Steven:operator', roles: ['operator'], permissions: ['config.read', 'config.write'],
    })),
    http.get('http://localhost/v3/console/config', () => {
      configReads += 1;
      return HttpResponse.json(current);
    }),
    http.get('http://localhost/v3/console/tenants/:tenantId/agents/:alias/perfil', ({ params }) => {
      const tenantId = String(params.tenantId);
      const alias = String(params.alias);
      profileReads.push(`${tenantId}/${alias}`);
      return HttpResponse.json(perfilAplicado(4, { tenant_id: tenantId, alias }));
    }),
  );

  const user = userEvent.setup();
  renderWithApi(<ConfigPage />);
  await user.click(await screen.findByRole('button', { name: 'Abrir contexto de A/same' }));
  const profilePurpose = await screen.findByLabelText(/^Identidad y propósito/i);
  await user.type(profilePurpose, 'borrador canónico A');

  current = {
    ...initial,
    revision: 2,
    agents: initial.agents.filter((agent) => agent.tenant_id !== 'A'),
  };
  const readsBeforeRemoval = configReads;
  await user.click(screen.getByRole('button', { name: 'Actualizar' }));
  const recovery = await screen.findByRole('button', { name: 'Volver al inventario y conservar borrador' });
  expect(configReads).toBeGreaterThan(readsBeforeRemoval);
  expect(await screen.findByRole('alert')).toHaveTextContent(/borrador sigue conservado/);
  await waitFor(() => { expect(recovery).toHaveFocus(); });
  await user.click(recovery);
  expect(screen.getByRole('searchbox')).toHaveFocus();

  await user.click(await screen.findByRole('button', { name: 'Abrir contexto de B/same' }));
  expect(await screen.findByLabelText(/^Identidad y propósito/i)).toHaveValue('');
  expect(screen.getByRole('heading', { name: 'Agente B · Contexto' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Volver a agentes' }));

  current = initial;
  const readsBeforeReturn = configReads;
  await user.click(screen.getByRole('button', { name: 'Actualizar' }));
  await screen.findByRole('button', { name: 'Abrir contexto de A/same' });
  expect(configReads).toBeGreaterThan(readsBeforeReturn);
  await user.click(await screen.findByRole('button', { name: 'Abrir contexto de A/same' }));
  expect(await screen.findByLabelText(/^Identidad y propósito/i)).toHaveValue('borrador canónico A');
  expect(screen.getByRole('heading', { name: 'Agente A · Contexto' })).toHaveFocus();
  expect(profileReads).toEqual(['A/same', 'B/same', 'A/same']);
});
