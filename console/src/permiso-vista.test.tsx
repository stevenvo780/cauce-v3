import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { ConsolePermission } from './api/types';
import { App } from './App';
import { CHECKING_RELAY_STATE } from './features/terminal/relay-status';
import { server } from './mocks/server';
import { NAV_ENTRIES } from './nav';
import {
  terminalNavAvailability,
} from './router';
import { renderWithApi } from './test/render';

/**
 * Matriz permiso→vista de la consola (T050). Lo verificado por lectura de `console/src`:
 *
 * NAV (`nav.ts` + `router.ts`): `config` permanece navegable porque su lectura la decide el GET;
 * `config.write` solo gobierna las acciones internas. `terminal` la gobierna la
 * topología del relay PTY (`deriveTerminalRelayState`), NO `ultimate-terminal.connect`.
 * El resto no lo gobierna nada: `hidden` es siempre `false`.
 * RUTAS (`App.tsx`): ningún permiso oculta ni redirige una vista. `/config` sin
 * `config.write` abre igual, en solo lectura; lo mismo `/queues` sin `delivery.*` y
 * `/messages` sin `message.publish`.
 * DENTRO DE LA VISTA (la vista abre; lo que se inhabilita es la acción; suites que lo
 * cubren): messages/`message.publish` → composer inerte (sin suite dedicada, gap);
 * queues/`delivery.replay`+`delivery.cancel` → botones inertes y `dlq.resolve` → sin
 * panel DLQ ni GET al endpoint (`colas-operativas.test.tsx`, `OperationalDlqPanel.test.tsx`);
 * config/`config.write` → todos los canales en solo lectura (`ConfigPage.tables.test.tsx`,
 * `Interruptores.test.tsx`, `ConfigPage.test.tsx`); config/lectura 403 → panel
 * `SinPermisoDeLectura` (`ConfigPage.test.tsx`); accounts/`config.write` vía
 * `useConfigMutation.canWrite` → `MutationBar` inerte (sin suite dedicada, gap);
 * live-contexto/`config.write` → perfil/manual/ficheros/restauración inertes
 * (`ContextoTab.test.tsx`, `FicherosTab.test.tsx`, `HistorialDeContexto.test.tsx`);
 * terminal/`ultimate-terminal.connect` → `ultimateTerminalGate` cerrado (`plugin.test.ts`).
 *
 * ROLES: ninguna vista ni el menú ramifica por `roles`; solo se muestran
 * (`PermissionBadge`, línea de permiso de config, inspector de terminal). Lo que decide
 * es el array `permissions` del snapshot `/v3/console/access`.
 *
 * SIN LECTOR EN `console/src` (declarados en `ConsolePermission`, presentes en el mock
 * pleno, pero ninguna vista los consulta): `config.rollback` (el rollback de config lo
 * gobierna `config.write`) y `job.create` (la vista de jobs se retiró).
 */

/** El set pleno del mock (`mocks/handlers.ts`): los 8 permisos declarados. */
const PERMISOS_PLENOS: readonly ConsolePermission[] = [
  'message.publish', 'delivery.replay', 'delivery.cancel', 'job.create',
  'config.write', 'config.rollback', 'dlq.resolve', 'ultimate-terminal.connect',
];

/**
 * Qué gobierna cada entrada del menú en `useNavAvailability`. Si se agrega una vista
 * al menú sin registrarla acá, el primer test lo dice.
 */
const GOBIERNO_NAV: Record<string, 'config.write' | 'relay' | null> = {
  live: null,
  accounts: null,
  messages: null,
  queues: null,
  observability: null,
  config: null,
  terminal: 'relay',
  ayuda: null,
};

function servirAcceso(permissions: readonly string[] | null, roles: readonly string[] | null = ['operator']) {
  server.use(http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'T050:matriz', roles, permissions, observed_at: new Date().toISOString(),
  })));
}

function servirRelayDisponible() {
  server.use(http.get('*/v3/console/terminal/capability', () => HttpResponse.json({
    available: true, reason: 'Relay de terminales disponible.',
  })));
}

async function esperarLaFlota() {
  await screen.findByRole('heading', { level: 1, name: 'Oficina' }, { timeout: 10_000 });
  await userEvent.click(screen.getByRole('button', { name: 'Gestión' }));
}

function barra(): HTMLElement {
  return screen.getByRole('navigation', { name: /principal/i });
}

it('la matriz cubre cada entrada del menú, ni una más ni una menos', () => {
  expect(Object.keys(GOBIERNO_NAV).sort()).toEqual(NAV_ENTRIES.map((entrada) => entrada.id).sort());
});

it('terminalNavAvailability: checking y available navegan; unavailable inhabilita con el motivo del relay', () => {
  expect(terminalNavAvailability({ status: 'available', reason: 'Relay disponible.' }))
    .toEqual({ hidden: false, disabled: false });
  expect(terminalNavAvailability(CHECKING_RELAY_STATE)).toEqual({ hidden: false, disabled: false });
  expect(terminalNavAvailability({ status: 'unavailable', cause: 'no-desplegado', reason: 'Sin relay.' }))
    .toEqual({ hidden: false, disabled: true, reason: 'Sin relay.' });
});

it('operador pleno: las nueve entradas habilitadas y «Ajustes» navega', async () => {
  servirAcceso(PERMISOS_PLENOS);
  servirRelayDisponible();
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  await esperarLaFlota();
  const nav = barra();
  for (const entrada of NAV_ENTRIES) {
    expect(within(nav).getByRole('link', { name: entrada.label })).not.toHaveAttribute('aria-disabled');
  }
  await userEvent.click(within(nav).getByRole('link', { name: 'Ajustes' }));
  expect(window.location.pathname).toBe('/config');
});

it('sin config.write: «Ajustes» sigue navegable y la vista decide el acceso de lectura', async () => {
  servirAcceso(['message.publish'], ['agent']);
  servirRelayDisponible();
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  await esperarLaFlota();
  const nav = barra();
  const config = within(nav).getByRole('link', { name: 'Ajustes' });
  await waitFor(() => { expect(config).not.toHaveAttribute('aria-disabled'); });
  for (const entrada of NAV_ENTRIES.filter((candidate) => candidate.id !== 'config')) {
    expect(within(nav).getByRole('link', { name: entrada.label })).not.toHaveAttribute('aria-disabled');
  }
  await userEvent.click(config);
  expect(window.location.pathname).toBe('/config');
});

it('sin permisos de acción: el menú deja abrir la vista y la escritura falla cerrada', async () => {
  servirAcceso([], []);
  servirRelayDisponible();
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  await esperarLaFlota();
  const nav = barra();
  expect(within(nav).getAllByRole('link').map((enlace) => enlace.textContent).sort())
    .toEqual(NAV_ENTRIES.map((entrada) => entrada.label).sort());
  const config = within(nav).getByRole('link', { name: 'Ajustes' });
  await waitFor(() => { expect(config).not.toHaveAttribute('aria-disabled'); });
  for (const entrada of NAV_ENTRIES.filter((candidate) => candidate.id !== 'config')) {
    expect(within(nav).getByRole('link', { name: entrada.label })).not.toHaveAttribute('aria-disabled');
  }
});

it('permiso no acreditado (null): «Ajustes» sigue navegable en el menú', async () => {
  servirAcceso(null, null);
  servirRelayDisponible();
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  await esperarLaFlota();
  const config = within(barra()).getByRole('link', { name: 'Ajustes' });
  await waitFor(() => { expect(config).not.toHaveAttribute('aria-disabled'); });
  await userEvent.click(config);
  expect(window.location.pathname).toBe('/config');
});

it('los roles y los permisos de escritura no gobiernan la navegación a Configuración', async () => {
  servirRelayDisponible();
  servirAcceso(PERMISOS_PLENOS, ['agent']);
  window.history.pushState({}, '', '/live');
  const primera = renderWithApi(<App />);

  await esperarLaFlota();
  expect(within(barra()).getByRole('link', { name: 'Ajustes' })).not.toHaveAttribute('aria-disabled');
  primera.unmount();

  servirAcceso([], ['operator']);
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  await esperarLaFlota();
  const config = within(barra()).getByRole('link', { name: 'Ajustes' });
  await waitFor(() => { expect(config).not.toHaveAttribute('aria-disabled'); });
});

it('«Terminal» en el menú lo gobierna el relay, no ultimate-terminal.connect', async () => {
  servirAcceso(PERMISOS_PLENOS, ['operator']);
  window.history.pushState({}, '', '/live');
  const primera = renderWithApi(<App />);

  await esperarLaFlota();
  const sinRelay = within(barra()).getByRole('link', { name: 'Terminal' });
  await waitFor(() => { expect(sinRelay).toHaveAttribute('aria-disabled', 'true'); });
  expect(sinRelay).toHaveAttribute('title', expect.stringContaining('PTY'));
  primera.unmount();

  servirAcceso(PERMISOS_PLENOS.filter((permiso) => permiso !== 'ultimate-terminal.connect'), ['operator']);
  servirRelayDisponible();
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  await esperarLaFlota();
  const conRelay = within(barra()).getByRole('link', { name: 'Terminal' });
  await waitFor(() => { expect(conRelay).not.toHaveAttribute('aria-disabled'); });
});

it('ruta /config sin config.write: abre en solo lectura, no 404 ni redirección', async () => {
  servirAcceso(['message.publish'], ['agent']);
  servirRelayDisponible();
  window.history.pushState({}, '', '/config');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Ajustes' }, { timeout: 10_000 }))
    .toBeInTheDocument();
  expect(await screen.findByText(/Solo lectura:/, {}, { timeout: 10_000 })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Agentes' }));
  expect(await screen.findByRole('list', { name: 'Agentes configurados' })).toBeInTheDocument();
  for (const control of screen.queryAllByRole('switch')) expect(control).toBeDisabled();
  await userEvent.click(screen.getByRole('tab', { name: 'Espacios y salas' }));
  for (const crear of await screen.findAllByRole('button', { name: /^Crear$/ })) expect(crear).toBeDisabled();
  await userEvent.click(screen.getByRole('tab', { name: 'Avanzado' }));
  expect(await screen.findByRole('button', { name: /Aplicar atómico/ }, { timeout: 10_000 })).toBeDisabled();
  expect(window.location.pathname).toBe('/config');
  expect(screen.queryByRole('heading', { level: 1, name: /ruta no encontrada/i })).not.toBeInTheDocument();
});

it.each([
  ['/queues', /^colas y dlq/i],
  ['/messages', /con quién trabajamos hoy/i],
] as const)('ruta %s sin permisos de acción: la vista abre igual (lo inerte es la acción)', async (ruta, titulo) => {
  servirAcceso([], []);
  servirRelayDisponible();
  window.history.pushState({}, '', ruta);
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: titulo }, { timeout: 10_000 })).toBeInTheDocument();
  expect(window.location.pathname).toBe(ruta);
  expect(screen.queryByRole('heading', { level: 1, name: /ruta no encontrada/i })).not.toBeInTheDocument();
});
