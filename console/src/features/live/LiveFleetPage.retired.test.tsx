import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { FleetActivityAgent } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

it('la pantalla no convierte los nombres históricos retirados en una caída de los tres agentes actuales', async () => {
  const agents: FleetActivityAgent[] = ['operador', 'teseo', 'perseo', 'backend', 'frontend'].map((alias, index) => ({
    tenant_id: 'Hospital', alias, display_name: alias, registered: true, agent_enabled: index < 3,
    presence: { online: index < 3 }, work_state: 'idle', in_flight: 0, queued: 0,
    flags: index < 3 ? [] : ['never_connected'],
  }));
  server.use(
    http.get('http://localhost/v3/console/activity', () => HttpResponse.json({ observed_at: new Date().toISOString(), agents, totals: { agents: 5, in_flight: 0, queued: 0 } })),
    http.get('http://localhost/v3/console/topology', () => HttpResponse.json({ tenants: [{ id: 'Hospital', rooms: [{ id: 'grp.hospital', members: agents.map((a) => ({ alias: a.alias, enabled: a.agent_enabled, registered: true, agent_enabled: a.agent_enabled })) }] }] })),
  );
  renderWithApi(<LiveFleetPage />);
  const verdict = await screen.findByLabelText('Veredicto de la flota');
  await waitFor(() => { expect(verdict).toHaveAttribute('data-tone', 'ok'); });
  expect(document.querySelectorAll('tr[data-agent-key]')).toHaveLength(3);
  expect(document.querySelector('tr[data-agent-key="Hospital/backend"]')).toBeNull();
  expect(document.querySelector('tr[data-agent-key="Hospital/frontend"]')).toBeNull();
  expect(verdict).toHaveTextContent('3 conectados');
});
