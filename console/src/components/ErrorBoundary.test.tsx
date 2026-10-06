import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ErrorBoundary } from './ErrorBoundary';
import { App } from '../App';
import { OperatorWorkspace } from '../features/terminal/OperatorWorkspace';
import type { FleetAgent } from '../features/terminal/fleet';
import { renderWithApi } from '../test/render';

const MENSAJE_CRUDO = 'texto del servidor que el panel no debe mostrar';

/*
 * The session stage is replaced by a subtree that throws while rendering: that is the unexpected
 * PTY frame or the resize race this boundary exists for, without provoking one from a real socket.
 */
vi.mock('../features/terminal/SessionStage', () => ({
  SessionStage: () => { throw new TypeError('marco PTY con forma inesperada'); },
}));

/* The route-level boundary needs a routed view that throws, and the notice has to name it. */
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
    id: 'Steven:zeus',
    tenantId: 'Steven',
    alias: 'zeus',
    roomIds: [],
    roomMembership: {},
    leaseState: 'unknown',
  };
}

it('en la terminal del operador, un fallo de la sesión queda contenido en su panel', async () => {
  const agente = agenteDePrueba();
  renderWithApi(
    <div>
      <p>flota de agentes</p>
      <OperatorWorkspace
        agents={[agente]}
        agentId={agente.id}
        live={new Map()}
        messages={{ loading: false, reload: () => Promise.resolve({ error: new Error('sin lectura') }) }}
        summary="1 agente"
        fleetLoading={false}
        onRefresh={() => undefined}
      />
    </div>,
  );

  const aviso = await screen.findByRole('alert');
  expect(aviso).toHaveTextContent('La terminal del agente no se pudo dibujar');
  expect(aviso).toHaveTextContent('TypeError');
  expect(aviso).not.toHaveTextContent('marco PTY con forma inesperada');
  expect(screen.getByText('flota de agentes')).toBeInTheDocument();
});

it('en el armazón, un fallo de la terminal deja operativa la navegación y la lista de agentes', async () => {
  window.history.pushState({}, '', '/terminal/Steven/kant');
  renderWithApi(<App />);

  const aviso = await screen.findByRole('alert', {}, { timeout: 10_000 });
  expect(aviso).toHaveTextContent('La terminal del agente no se pudo dibujar');
  const nav = screen.getByRole('navigation', { name: /navegación principal/i });
  expect(within(nav).getByRole('link', { name: 'Chat' })).toBeEnabled();
  const roster = await screen.findByRole('list', { name: 'Agentes' });
  const kant = await within(roster).findByRole('link', { name: /^kant/ });
  expect(kant).toHaveAttribute('href', '/terminal/Steven/kant');

  const otro = await within(roster).findByRole('link', { name: /^argos/ });
  await userEvent.click(otro);
  expect(window.location.pathname).toBe('/terminal/Steven/argos');
});

it('en el armazón, una vista que revienta no se lleva la navegación y el aviso la nombra', async () => {
  window.history.pushState({}, '', '/ayuda');
  renderWithApi(<App />);

  const aviso = await screen.findByRole('alert');
  expect(aviso).toHaveTextContent('Ayuda no se pudo dibujar');
  expect(aviso).toHaveTextContent('/ayuda');
  expect(aviso).not.toHaveTextContent(MENSAJE_CRUDO);
  expect(screen.getByRole('navigation', { name: /navegación principal/i })).toBeInTheDocument();
});
