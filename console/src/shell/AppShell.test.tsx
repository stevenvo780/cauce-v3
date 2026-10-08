import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { NAV_ENTRIES, PRIMARY_NAV_IDS } from '../nav';
import { TerminalRelayProvider } from '../features/terminal/relay-status';
import { server } from '../mocks/server';
import { renderWithApi } from '../test/render';
import { AppShell } from './AppShell';
import { FleetProvider } from './fleet';

const LABELS = Object.fromEntries(NAV_ENTRIES.map((entry) => [entry.id, entry.label]));
const PRIMARY = PRIMARY_NAV_IDS.map((id) => LABELS[id]);
const GESTION = NAV_ENTRIES.filter((entry) => !PRIMARY_NAV_IDS.includes(entry.id)).map((entry) => entry.label);

function mockViewport(width: number) {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('1100px') ? width <= 1100 : query.includes('760px') && width <= 760,
    media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
}

function renderShell(props: Partial<Parameters<typeof AppShell>[0]> = {}) {
  return renderWithApi(
    <TerminalRelayProvider>
      <FleetProvider>
        <AppShell routeId="messages" account={<button type="button">Cuenta de prueba</button>} {...props}>
          <main>contenido</main>
        </AppShell>
      </FleetProvider>
    </TerminalRelayProvider>,
  );
}

function nav(): HTMLElement {
  return screen.getByRole('navigation', { name: 'Navegación principal' });
}

function labels(container: HTMLElement): (string | null)[] {
  return within(container).queryAllByRole('link').map((link) => link.textContent);
}

beforeEach(() => {
  window.history.pushState({}, '', '/messages');
});

it('en escritorio hay una sola barra: secciones, agentes y cuenta, más el salto al contenido', async () => {
  renderShell();

  expect(screen.getAllByRole('navigation', { name: 'Navegación principal' })).toHaveLength(1);
  expect(screen.getByRole('link', { name: 'Saltar al contenido' })).toHaveAttribute('href', '#main-content');
  expect(labels(nav())).toEqual(PRIMARY);
  expect(await screen.findByRole('list', { name: 'Agentes' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Cuenta de prueba' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: 'Cauce, ir al chat' })).toHaveAttribute('href', '/messages');
});

it('marca con aria-current la sección abierta y solo esa', () => {
  renderShell({ routeId: 'live' });

  expect(within(nav()).getByRole('link', { name: 'Oficina' })).toHaveAttribute('aria-current', 'page');
  expect(within(nav()).getByRole('link', { name: 'Chat' })).not.toHaveAttribute('aria-current');
  expect(within(nav()).getByRole('link', { name: 'Terminal' })).not.toHaveAttribute('aria-current');
});

it('«Gestión» arranca plegada en las secciones principales y se despliega con su botón', async () => {
  const user = userEvent.setup();
  renderShell();
  const toggle = within(nav()).getByRole('button', { name: 'Gestión' });

  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(labels(nav())).toEqual(PRIMARY);

  await user.click(toggle);

  expect(toggle).toHaveAttribute('aria-expanded', 'true');
  expect(labels(nav())).toEqual([...PRIMARY, ...GESTION]);
  expect(toggle).toHaveFocus();
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
  expect(labels(nav())).toEqual(PRIMARY);
});

it('«Gestión» se abre sola cuando la sección activa pertenece al grupo', () => {
  renderShell({ routeId: 'accounts' });

  expect(within(nav()).getByRole('button', { name: 'Gestión' })).toHaveAttribute('aria-expanded', 'true');
  expect(within(nav()).getByRole('link', { name: 'Cuentas y cuotas' })).toHaveAttribute('aria-current', 'page');
});

it('«Gestión» se abre al llegar a una sección del grupo y respeta el pliegue manual en las demás', async () => {
  const user = userEvent.setup();
  const { rerender } = renderShell();
  expect(within(nav()).getByRole('button', { name: 'Gestión' })).toHaveAttribute('aria-expanded', 'false');

  rerender(
    <TerminalRelayProvider>
      <FleetProvider>
        <AppShell routeId="queues" account={null}><main>contenido</main></AppShell>
      </FleetProvider>
    </TerminalRelayProvider>,
  );
  const toggle = within(nav()).getByRole('button', { name: 'Gestión' });
  await waitFor(() => { expect(toggle).toHaveAttribute('aria-expanded', 'true'); });
  await user.click(toggle);
  expect(toggle).toHaveAttribute('aria-expanded', 'false');
});

it('navegar con un clic cambia la URL sin recargar la página', async () => {
  const user = userEvent.setup();
  renderShell();

  await user.click(within(nav()).getByRole('link', { name: 'Oficina' }));

  expect(window.location.pathname).toBe('/live');
});

it('«Terminal» queda inhabilitada con el motivo del relay cuando el canal PTY no existe', async () => {
  server.use(http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
    available: false, capabilities: [], reason: 'Relay no desplegado en este test.',
  })));
  const user = userEvent.setup();
  renderShell();

  const terminal = within(nav()).getByRole('link', { name: 'Terminal' });
  await waitFor(() => { expect(terminal).toHaveAttribute('aria-disabled', 'true'); });
  expect(terminal).toHaveAttribute('title', expect.stringContaining('Relay no desplegado'));
  await user.click(terminal);
  expect(window.location.pathname).toBe('/messages');
});

it('el botón de plegar deja la barra en riel y el atajo la despliega', async () => {
  const user = userEvent.setup();
  renderShell();

  await user.click(screen.getByRole('button', { name: 'Plegar barra lateral' }));
  const root = document.querySelector('[data-sidebar]');
  expect(root).toHaveAttribute('data-sidebar', 'rail');
  expect(within(nav()).getByRole('link', { name: 'Chat' })).toHaveAttribute('aria-label', 'Chat');
  expect(within(nav()).queryByRole('button', { name: 'Gestión' })).toBeNull();

  fireEvent.keyDown(window, { code: 'KeyB', altKey: true, shiftKey: true });
  await waitFor(() => { expect(root).toHaveAttribute('data-sidebar', 'expanded'); });
});

it('el atajo de la barra no se dispara mientras se escribe en un campo', async () => {
  const user = userEvent.setup();
  renderShell();
  const search = await screen.findByRole('searchbox', { name: 'Buscar agente' });
  await user.click(search);

  fireEvent.keyDown(search, { code: 'KeyB', altKey: true, shiftKey: true });

  expect(document.querySelector('[data-sidebar]')).toHaveAttribute('data-sidebar', 'expanded');
});

it('en tablet la barra es un riel de iconos con todas las secciones nombradas y sin plegable', async () => {
  mockViewport(900);
  renderShell();

  expect(document.querySelector('[data-sidebar]')).toHaveAttribute('data-sidebar', 'rail');
  expect(within(nav()).queryByRole('button', { name: 'Gestión' })).toBeNull();
  expect(screen.queryByRole('button', { name: /barra lateral/ })).toBeNull();
  const links = within(nav()).getAllByRole('link');
  expect(links.map((link) => link.getAttribute('aria-label'))).toEqual([...PRIMARY, ...GESTION]);
  const lista = await screen.findByRole('list', { name: 'Agentes' });
  expect(within(lista).getAllByRole('link')[0]).toHaveAttribute('aria-label', expect.stringContaining(' · '));
});

it('en el móvil no hay barra lateral: abajo van las tres secciones y «Más» abre Gestión con la cuenta', async () => {
  mockViewport(390);
  const user = userEvent.setup();
  renderShell();

  expect(document.querySelector('[data-sidebar]')).toHaveAttribute('data-sidebar', 'bottom');
  expect(screen.queryByRole('list', { name: 'Agentes' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Cuenta de prueba' })).toBeNull();
  expect(labels(nav())).toEqual(PRIMARY);

  await user.click(within(nav()).getByRole('button', { name: 'Más' }));

  const hoja = await screen.findByRole('dialog', { name: 'Gestión' });
  expect(labels(hoja)).toEqual(GESTION);
  expect(within(hoja).getByRole('button', { name: 'Cuenta de prueba' })).toBeInTheDocument();

  await user.click(within(hoja).getByRole('link', { name: 'Colas y DLQ' }));
  expect(window.location.pathname).toBe('/queues');
  await waitFor(() => { expect(screen.queryByRole('dialog', { name: 'Gestión' })).toBeNull(); });
});

it('en el móvil, «Más» queda marcado cuando la sección activa es de Gestión', () => {
  mockViewport(390);
  renderShell({ routeId: 'observability' });

  expect(within(nav()).getByRole('button', { name: 'Más' })).toHaveAttribute('aria-current', 'true');
  expect(within(nav()).getByRole('link', { name: 'Chat' })).not.toHaveAttribute('aria-current');
});

it('el aviso de la consola y el contenido se dibujan junto a la barra, no dentro', () => {
  renderShell({ notices: <p role="status">sin login</p> });

  expect(screen.getByText('sin login')).toHaveAttribute('role', 'status');
  expect(within(nav()).queryByText('sin login')).toBeNull();
  expect(screen.getByRole('main')).toHaveTextContent('contenido');
});
