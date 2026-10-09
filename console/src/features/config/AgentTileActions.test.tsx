import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';

const snapshot: ConfigurationSnapshot = {
  revision: 4,
  agents: [
    { tenant_id: 'A', alias: 'one', display_name: 'Agente uno', harness_id: 'codex', enabled: true, max_concurrent_deliveries: 1 },
    { tenant_id: 'A', alias: 'run', display_name: 'Agente run', harness_id: 'codex', enabled: true, max_concurrent_deliveries: 1, runtime_key: 'rk', host_id: null },
  ],
  memberships: [{ tenant_id: 'A', alias: 'one', room_id: 'grp.a', enabled: true }, { tenant_id: 'A', alias: 'ghost', room_id: 'grp.a', enabled: true }],
  rooms: [{ tenant_id: 'A', id: 'grp.a', display_name: 'Grupo A', enabled: true }],
  retired: { tenants: [], rooms: [], memberships: [], agents: [{ tenant_id: 'A', alias: 'old', display_name: 'Viejo' }] },
};

function serve(permissions: string[], actions: string[] = []) {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({ subject: 'Hub:operator', roles: ['operator'], permissions })),
    http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: actions.length > 0, actions, placements: [], ...(actions.length ? {} : { reason: 'executor_unconfigured' }) })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  );
}
function renderSection() {
  return renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
}

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=agentes'); });

it('«Editar» on the tile opens the sheet on the Registro tab', async () => {
  serve(['config.read', 'config.write']);
  const user = userEvent.setup();
  renderSection();
  const edit = await screen.findByRole('button', { name: 'Editar agente A/one' });
  await waitFor(() => { expect(edit).toBeEnabled(); });
  await user.click(edit);
  expect(await screen.findByRole('tab', { name: 'Registro', selected: true })).toBeInTheDocument();
  expect(await screen.findByRole('textbox', { name: 'Nombre visible' })).toBeInTheDocument();
});

it('«Preparar» on the tile opens the sheet on the Operación tab', async () => {
  serve(['config.read', 'config.write']);
  const user = userEvent.setup();
  renderSection();
  const prepare = await screen.findByRole('button', { name: 'Preparar agente A/one' });
  await waitFor(() => { expect(prepare).toBeEnabled(); });
  await user.click(prepare);
  expect(await screen.findByRole('tab', { name: 'Operación', selected: true })).toBeInTheDocument();
});

it('«Retirar» exists only for an agent with a runtime and opens its retire flow', async () => {
  serve(['config.read', 'config.write'], ['retire']);
  const user = userEvent.setup();
  renderSection();
  const retire = await screen.findByRole('button', { name: 'Retirar agente A/run' });
  await waitFor(() => { expect(retire).toBeEnabled(); });
  expect(screen.queryByRole('button', { name: 'Retirar agente A/one' })).not.toBeInTheDocument();
  await user.click(retire);
  expect(await screen.findByRole('tab', { name: 'Operación', selected: true })).toBeInTheDocument();
  expect(await screen.findByRole('option', { name: 'Retirar', selected: true })).toBeInTheDocument();
});

it('an agent without runtime shows «Eliminar», which opens the registry where the record is deleted, and says why', async () => {
  serve(['config.read', 'config.write']);
  const user = userEvent.setup();
  renderSection();
  const remove = await screen.findByRole('button', { name: 'Eliminar agente A/one' });
  await waitFor(() => { expect(remove).toBeEnabled(); });
  expect(remove).toHaveAttribute('title', expect.stringContaining('Sin ejecución que retirar'));
  await user.click(remove);
  expect(await screen.findByRole('tab', { name: 'Registro', selected: true })).toBeInTheDocument();
  expect(await screen.findByRole('button', { name: 'Eliminar registro' })).toBeInTheDocument();
});

it('«Eliminar definitivamente» on a retired agent opens the purge flow', async () => {
  serve(['config.read', 'config.write']);
  const user = userEvent.setup();
  renderSection();
  const purge = await screen.findByRole('button', { name: 'Eliminar definitivamente A/old' });
  await waitFor(() => { expect(purge).toBeEnabled(); });
  await user.click(purge);
  expect(await screen.findByRole('option', { name: 'Eliminar definitivamente', selected: true })).toBeInTheDocument();
});

it('without config.write every write button is disabled and states the reason; member-only agents get none', async () => {
  serve(['config.read']);
  renderSection();
  const edit = await screen.findByRole('button', { name: 'Editar agente A/one' });
  await waitFor(() => { expect(edit).toBeDisabled(); expect(edit).toHaveAttribute('title', expect.stringMatching(/permiso|lectura/i)); });
  for (const name of ['Preparar agente A/one', 'Eliminar agente A/one', 'Retirar agente A/run', 'Eliminar definitivamente A/old']) {
    const button = screen.getByRole('button', { name });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', edit.getAttribute('title'));
  }
  expect(screen.queryByRole('button', { name: 'Editar agente A/ghost' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Acciones visibles de A/ghost' })).not.toBeInTheDocument();
});

it('«Retirar» follows the fleet retire capability, not the registry delete capability', async () => {
  serve(['config.read', 'config.write'], ['update']);
  renderSection();
  const retire = await screen.findByRole('button', { name: 'Retirar agente A/run' });
  await waitFor(() => { expect(retire).toBeDisabled(); });
  expect(retire).toHaveAttribute('title', expect.stringContaining('no acredita el retiro'));
});
