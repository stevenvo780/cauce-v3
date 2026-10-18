import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { FleetActivityAgent } from '../../api/types';
import { server } from '../../mocks/server';
import { renderLive } from './render-live';

it('los agentes registrados deshabilitados se ven caídos: sin ciclo de vida en la actividad no se distinguen de un borrador nuevo', async () => {
  const agents: FleetActivityAgent[] = ['operador', 'teseo', 'perseo', 'backend', 'frontend'].map((alias, index) => ({
    tenant_id: 'Hospital', alias, display_name: alias, registered: true, agent_enabled: index < 3,
    presence: { online: index < 3 }, work_state: 'idle', in_flight: 0, queued: 0,
    flags: index < 3 ? [] : ['never_connected'],
  }));
  server.use(
    http.get('http://localhost/v3/console/activity', () => HttpResponse.json({ observed_at: new Date().toISOString(), agents, totals: { agents: 5, in_flight: 0, queued: 0 } })),
    http.get('http://localhost/v3/console/topology', () => HttpResponse.json({ tenants: [{ id: 'Hospital', rooms: [{ id: 'grp.hospital', members: agents.map((a) => ({ alias: a.alias, enabled: a.agent_enabled, registered: true, agent_enabled: a.agent_enabled })) }] }] })),
  );
  renderLive();
  const verdict = await screen.findByLabelText('Veredicto de la flota');
  await waitFor(() => { expect(verdict).toHaveAttribute('data-tone', 'alerta'); });
  const lista = screen.getByRole('listbox', { name: /oficina con \d+ agentes/i });
  expect(within(lista).getAllByRole('option')).toHaveLength(5);
  expect(within(lista).getByRole('option', { name: /^backend:/ })).toBeInTheDocument();
  expect(verdict).toHaveTextContent(/necesitan atención/);
});

it('en local: el borrador se ve, el retirado no se ve y el activo se ve', async () => {
  const agents: FleetActivityAgent[] = [
    { tenant_id: 'Steven', alias: 'borrador', display_name: 'borrador', registered: true, agent_enabled: false, lifecycle_state: 'draft', presence: { online: false }, work_state: 'idle', in_flight: 0, queued: 0, flags: ['never_connected'] },
    { tenant_id: 'Steven', alias: 'retirado', display_name: 'retirado', registered: true, agent_enabled: false, lifecycle_state: 'retired', presence: { online: false }, work_state: 'idle', in_flight: 0, queued: 0, flags: ['never_connected'] },
    { tenant_id: 'Steven', alias: 'activo', display_name: 'activo', registered: true, agent_enabled: true, lifecycle_state: 'ready', presence: { online: true }, work_state: 'idle', in_flight: 0, queued: 0, flags: [] },
  ];
  server.use(
    http.get('http://localhost/v3/console/activity', () => HttpResponse.json({ observed_at: new Date().toISOString(), agents, totals: { agents: 3, in_flight: 0, queued: 0 } })),
    http.get('http://localhost/v3/console/topology', () => HttpResponse.json({ tenants: [{ id: 'Steven', rooms: [{ id: 'office', members: agents.map((a) => ({ alias: a.alias, enabled: true, registered: true, agent_enabled: a.agent_enabled })) }] }] })),
  );
  renderLive();
  const lista = await screen.findByRole('listbox', { name: /oficina con \d+ agentes/i });
  await waitFor(() => { expect(within(lista).getAllByRole('option')).toHaveLength(2); });
  expect(within(lista).getByRole('option', { name: /^borrador:/ })).toBeInTheDocument();
  expect(within(lista).getByRole('option', { name: /^activo:/ })).toBeInTheDocument();
  expect(within(lista).queryByRole('option', { name: /^retirado:/ })).not.toBeInTheDocument();
});
