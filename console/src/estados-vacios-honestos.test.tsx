import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
import { topology } from './mocks/data';
import { HarnessStrip } from './features/landing/HarnessStrip';
import { LiveHypergraph } from './features/live/LiveHypergraph';
import { AgentRoster } from './features/messages/AgentRoster';

it('un manifest leído y vacío no se presenta como un fallo de lectura', () => {
  render(<HarnessStrip adapters={[]} />);

  expect(screen.getByText('El servidor devolvió cero tipos de arnés declarados.')).toBeInTheDocument();
  expect(screen.queryByText(/no se pudo leer la lista/i)).not.toBeInTheDocument();
});

it('una topología leída y vacía no se presenta como una lectura fallida', () => {
  render(
    <LiveHypergraph
      topology={{ ...topology, tenants: [], acl_edges: [] }}
      views={[]}
      edges={[]}
    />,
  );

  expect(screen.getByText(/El control plane informó cero salas/i)).toBeInTheDocument();
  expect(screen.queryByText(/no se pudo leer la topología/i)).not.toBeInTheDocument();
});

it('un roster vacío distingue ausencia de datos visibles de un filtro sin coincidencias', async () => {
  const user = userEvent.setup();
  render(<AgentRoster agents={[]} salud={{}} onSelect={() => undefined} loading={false} />);

  expect(screen.getByText(/No hay ningún agente visible en las fuentes que contestaron/i)).toBeInTheDocument();

  await user.type(screen.getByPlaceholderText('Buscar agente…'), 'nadie');

  expect(screen.getByText(/Ningún agente coincide con el filtro/i)).toBeInTheDocument();
});
