import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it, vi } from 'vitest';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { FleetAgent } from './fleet';
import { OperatorWorkspace } from './OperatorWorkspace';

const agent: FleetAgent = {
  id: 'Empresa:operador_principal', tenantId: 'Empresa', alias: 'operador_principal',
  roomIds: ['general'], roomMembership: { general: true }, leaseState: 'online',
};

function viewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query === '(max-width: 760px)' && width <= 760,
    media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

function renderWorkspace(props: Partial<Parameters<typeof OperatorWorkspace>[0]> = {}) {
  return renderWithApi(<OperatorWorkspace agents={[agent]} live={new Map()} summary="Flota"
    fleetLoading={false} onRefresh={vi.fn()} {...props} />);
}

beforeEach(() => { window.history.replaceState({}, '', '/terminal'); });

it.each([390, 760])('sin selección a %ipx permite elegir un agente por Chat sin abrir una sesión', async (width) => {
  viewport(width);
  let sessionPosts = 0;
  server.use(http.post('*/v3/console/terminal/sessions', () => {
    sessionPosts += 1;
    return new HttpResponse(null, { status: 500 });
  }));
  renderWorkspace();
  const picker = screen.getByRole('link', { name: 'Elegir agente' });
  expect(picker).toHaveAttribute('href', '/messages');
  expect(screen.queryByRole('list', { name: 'Agentes' })).not.toBeInTheDocument();
  picker.focus();
  await userEvent.setup().keyboard('{Enter}');
  await waitFor(() => { expect(window.location.pathname).toBe('/messages'); });
  expect(sessionPosts).toBe(0);
});

it.each([761, 1440])('a %ipx conserva la selección desde el sidebar sin otro selector', (width) => {
  viewport(width);
  renderWorkspace();
  expect(screen.getByRole('heading', { name: 'Elegí un agente en la barra lateral' })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Elegir agente' })).not.toBeInTheDocument();
});

it('no ofrece un agente ficticio cuando la flota está vacía', () => {
  viewport(390);
  renderWorkspace({ agents: [] });
  expect(screen.getByText('La flota no tiene agentes todavía.')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Elegir agente' })).not.toBeInTheDocument();
});

it('conserva la lectura pendiente de la flota sin inventar una selección', () => {
  viewport(390);
  renderWorkspace({ agents: [], fleetLoading: true });
  expect(screen.getByText('Leyendo la flota del servidor…')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Elegir agente' })).not.toBeInTheDocument();
});

it('conserva el error de flota sin presentarlo como ausencia de agentes', () => {
  viewport(390);
  renderWorkspace({ agents: [], fleetError: new Error('Sin conexión') });
  expect(screen.getByRole('alert')).toHaveTextContent('La flota no se pudo leer.');
  expect(screen.queryByRole('link', { name: 'Elegir agente' })).not.toBeInTheDocument();
});

it('un agente ya seleccionado mantiene su escenario en móvil', async () => {
  viewport(390);
  renderWorkspace({ agentId: agent.id });
  expect(await screen.findByRole('heading', { name: /operador_principal/ })).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: 'Elegir agente' })).not.toBeInTheDocument();
});
