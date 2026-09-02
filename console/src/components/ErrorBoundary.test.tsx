import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { App } from '../App';
import { OperatorWorkspace } from '../features/terminal/OperatorWorkspace';
import type { FleetAgent } from '../features/terminal/fleet';
import { renderWithApi } from '../test/render';

const MENSAJE_CRUDO = 'texto del servidor que el panel no debe mostrar';

/*
 * The grid is replaced by a subtree that throws while rendering: that is the unexpected PTY frame
 * or the resize race this boundary exists for, without having to provoke one from a real socket.
 */
vi.mock('../features/terminal/GridContainer', () => ({
  GridContainer: () => { throw new TypeError('marco PTY con forma inesperada'); },
}));

/* The route-level boundary needs a routed view that throws; `/ayuda` is the one with no label. */
vi.mock('../features/help/HelpPage', () => ({
  HelpPage: () => { throw new TypeError(MENSAJE_CRUDO); },
}));

let falla = true;

function Inestable() {
  if (falla) throw new TypeError(MENSAJE_CRUDO);
  return <p>terminal montada</p>;
}

beforeEach(() => {
  falla = true;
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
  window.history.pushState({}, '', '/terminal/Steven/zeus');
});

it('contiene el fallo: el hermano sigue en pantalla y el error no se lleva la vista entera', () => {
  render(
    <div>
      <ErrorBoundary label="La terminal del agente"><Inestable /></ErrorBoundary>
      <p>flota de agentes</p>
    </div>,
  );

  expect(screen.getByRole('alert')).toBeInTheDocument();
  expect(screen.getByText('flota de agentes')).toBeInTheDocument();
  expect(screen.queryByText('terminal montada')).toBeNull();
});

it('anuncia el fallo con el rótulo, el nombre del error y la ruta, sin el cuerpo del mensaje', () => {
  render(<ErrorBoundary label="La terminal del agente"><Inestable /></ErrorBoundary>);

  const aviso = screen.getByRole('alert');
  expect(within(aviso).getByRole('heading', { level: 2 })).toHaveTextContent('La terminal del agente');
  expect(aviso).toHaveTextContent('TypeError');
  expect(aviso).toHaveTextContent('/terminal/Steven/zeus');
  expect(aviso).not.toHaveTextContent(MENSAJE_CRUDO);
});

it('el botón de reintento vuelve a montar el hijo y avisa a quien lo envuelve', async () => {
  const user = userEvent.setup();
  const onReset = vi.fn();
  render(<ErrorBoundary label="La terminal del agente" onReset={onReset}><Inestable /></ErrorBoundary>);

  falla = false;
  await user.click(within(screen.getByRole('alert')).getByRole('button'));

  expect(await screen.findByText('terminal montada')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(onReset).toHaveBeenCalledTimes(1);
});

it('cambiar `resetKey` limpia un límite atascado: navegar no deja la vista muerta', async () => {
  const { rerender } = render(
    <ErrorBoundary label="La terminal del agente" resetKey="/terminal/Steven/zeus"><Inestable /></ErrorBoundary>,
  );
  expect(screen.getByRole('alert')).toBeInTheDocument();

  falla = false;
  rerender(
    <ErrorBoundary label="La terminal del agente" resetKey="/terminal/Miguel/kratos"><Inestable /></ErrorBoundary>,
  );

  expect(await screen.findByText('terminal montada')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
});

function agenteDePrueba(): FleetAgent {
  return {
    id: 'Steven/zeus',
    tenantId: 'Steven',
    alias: 'zeus',
    roomIds: [],
    roomMembership: {},
    leaseState: 'unknown',
  };
}

it('en la terminal del operador, un fallo del grid deja viva la flota de al lado', async () => {
  const agente = agenteDePrueba();
  renderWithApi(
    <OperatorWorkspace agents={[agente]} initialAgentId={agente.id} adapters={[]} fleetLoading={false} />,
  );

  await waitFor(() => { expect(screen.getByRole('alert')).toBeInTheDocument(); });
  expect(screen.getByRole('alert')).toHaveTextContent('La terminal del agente');
  expect(screen.getByRole('button', { name: /abrir sesión con zeus/i })).toBeInTheDocument();
});

it('en el armazón, una vista que revienta no se lleva la navegación ni el rótulo por defecto', async () => {
  window.history.pushState({}, '', '/ayuda');
  renderWithApi(<App />);

  const aviso = await screen.findByRole('alert');
  expect(aviso).toHaveTextContent('Esta vista no se pudo dibujar');
  expect(aviso).toHaveTextContent('/ayuda');
  expect(aviso).not.toHaveTextContent(MENSAJE_CRUDO);
  expect(screen.getByRole('navigation', { name: /navegación principal/i })).toBeInTheDocument();
});
