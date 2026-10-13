import { screen } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import type { FleetActivityAgent } from '../../api/types';
import { server } from '../../mocks/server';
import { AgentTip } from '../office/AgentTip';
import { renderLive } from './render-live';

vi.mock('../office/OfficeGame', () => ({
  OfficeGame: ({ agents }: { agents: Parameters<typeof AgentTip>[0]['agent'][] }) => (
    <div data-testid="tips">{agents.map((agent) => <div key={agent.id}><AgentTip agent={agent} /></div>)}</div>
  ),
}));

it('el tooltip de la oficina muestra el nombre del grupo secundario, no su clave', async () => {
  const agent: FleetActivityAgent = {
    tenant_id: 'Hospital', alias: 'operador', display_name: 'operador', registered: true, agent_enabled: true,
    presence: { online: true }, work_state: 'idle', in_flight: 0, queued: 0, flags: [],
  };
  const member = { alias: 'operador', enabled: true, registered: true, agent_enabled: true };
  server.use(
    http.get('http://localhost/v3/console/activity', () => HttpResponse.json({ observed_at: new Date().toISOString(), agents: [agent], totals: { agents: 1, in_flight: 0, queued: 0 } })),
    http.get('http://localhost/v3/console/topology', () => HttpResponse.json({ tenants: [{ id: 'Hospital', rooms: [
      { id: 'grp.hospital', label: 'Hospital', members: [member] },
      { id: 'grp.infra', label: 'Infraestructura', members: [member] },
    ] }] })),
  );
  renderLive();
  expect(await screen.findByText(/también en Infraestructura/)).toBeInTheDocument();
  expect(screen.queryByText(/grp\.infra/)).toBeNull();
});
