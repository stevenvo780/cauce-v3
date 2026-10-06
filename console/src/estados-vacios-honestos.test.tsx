import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { HarnessStrip } from './features/landing/HarnessStrip';
import { mockActivity, mockMessages, mockStatus, topology } from './mocks/data';
import { renderLive } from './features/live/render-live';
import { server } from './mocks/server';
import { AgentList } from './shell/AgentList';
import { FleetProvider } from './shell/fleet';
import { renderWithApi } from './test/render';

/** The control plane answers every source with an empty but well-formed snapshot. */
function servirFlotaVacia() {
  server.use(
    http.get('*/v3/status', () => HttpResponse.json({ ...mockStatus(), presence: [] })),
    http.get('*/v3/console/topology', () => HttpResponse.json({ ...topology, tenants: [], acl_edges: [] })),
    http.get('*/v3/console/activity', () => HttpResponse.json({ ...mockActivity(), agents: [] })),
    http.get('*/v3/console/messages', () => HttpResponse.json({ ...mockMessages(), items: [] })),
  );
}

it('un manifest leído y vacío no se presenta como un fallo de lectura', () => {
  render(<HarnessStrip adapters={[]} />);

  expect(screen.getByText('El servidor devolvió cero tipos de arnés declarados.')).toBeInTheDocument();
  expect(screen.queryByText(/no se pudo leer la lista/i)).not.toBeInTheDocument();
});

it('una oficina leída y vacía no se presenta como una lectura fallida', async () => {
  servirFlotaVacia();
  renderLive();

  expect(await screen.findByText(/No hay ningún agente en la oficina/i)).toBeInTheDocument();
  expect(screen.queryByText(/no se pudo leer/i)).not.toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
});

it('un roster vacío distingue ausencia de agentes de un filtro sin coincidencias', async () => {
  servirFlotaVacia();
  const user = userEvent.setup();
  renderWithApi(<FleetProvider><AgentList routeId="messages" /></FleetProvider>);

  expect(await screen.findByText('Sin agentes en la flota.')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();

  await user.type(screen.getByRole('searchbox', { name: 'Buscar agente' }), 'nadie');

  expect(screen.getByText('Ningún agente coincide.')).toBeInTheDocument();
  expect(screen.queryByText('Sin agentes en la flota.')).not.toBeInTheDocument();
});
