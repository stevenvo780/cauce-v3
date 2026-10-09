import { screen, waitFor, within } from '@testing-library/react';
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

it('«Eliminar» on an agent with a runtime opens the removal guide at the retire step, without an action selector', async () => {
  serve(['config.read', 'config.write'], ['retire']);
  const user = userEvent.setup();
  renderSection();
  const remove = await screen.findByRole('button', { name: 'Eliminar agente A/run' });
  await waitFor(() => { expect(remove).toBeEnabled(); });
  expect(screen.queryByRole('button', { name: 'Retirar agente A/run' })).not.toBeInTheDocument();
  await user.click(remove);
  const dialog = await screen.findByRole('dialog', { name: 'Eliminar agente A/run' });
  expect(within(dialog).getByText('Paso actual')).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Previsualizar operación' })).toBeInTheDocument();
  expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
  expect(within(dialog).queryByText(/La purga elimina el registro retirado/)).not.toBeInTheDocument();
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

it('«Eliminar definitivamente» on a retired agent opens the removal guide at the purge step', async () => {
  serve(['config.read', 'config.write']);
  const user = userEvent.setup();
  renderSection();
  const purge = await screen.findByRole('button', { name: 'Eliminar definitivamente A/old' });
  await waitFor(() => { expect(purge).toBeEnabled(); });
  await user.click(purge);
  const dialog = await screen.findByRole('dialog', { name: 'Eliminar agente A/old' });
  expect(within(dialog).getByText('Hecho')).toBeInTheDocument();
  expect(await within(dialog).findByText(/La purga elimina el registro retirado/)).toBeInTheDocument();
  expect(within(dialog).queryByRole('combobox')).not.toBeInTheDocument();
});

it('without config.write every write button is disabled and states the reason; member-only agents get none', async () => {
  serve(['config.read']);
  renderSection();
  const edit = await screen.findByRole('button', { name: 'Editar agente A/one' });
  await waitFor(() => { expect(edit).toBeDisabled(); expect(edit).toHaveAttribute('title', expect.stringMatching(/permiso|lectura/i)); });
  for (const name of ['Preparar agente A/one', 'Eliminar agente A/one', 'Eliminar agente A/run', 'Eliminar definitivamente A/old']) {
    const button = screen.getByRole('button', { name });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute('title', edit.getAttribute('title'));
  }
  expect(screen.queryByRole('button', { name: 'Editar agente A/ghost' })).not.toBeInTheDocument();
  expect(screen.queryByRole('group', { name: 'Acciones visibles de A/ghost' })).not.toBeInTheDocument();
});

it('«Eliminar» on a runtime agent depends only on write access: the dialog explains a missing retire capability', async () => {
  serve(['config.read', 'config.write'], ['update']);
  const user = userEvent.setup();
  renderSection();
  const remove = await screen.findByRole('button', { name: 'Eliminar agente A/run' });
  await waitFor(() => { expect(remove).toBeEnabled(); });
  await user.click(remove);
  const dialog = await screen.findByRole('dialog', { name: 'Eliminar agente A/run' });
  expect(await within(dialog).findByText(/no está disponible en el ejecutor publicado/)).toBeInTheDocument();
  expect(within(dialog).getByRole('button', { name: 'Previsualizar operación' })).toBeDisabled();
});

it('«Retirar agente» stays in the tile menu and still follows the fleet retire capability', async () => {
  serve(['config.read', 'config.write'], ['update']);
  const user = userEvent.setup();
  renderSection();
  await user.click(await screen.findByRole('button', { name: 'Acciones de A/run' }));
  const item = await screen.findByRole('menuitem', { name: 'Retirar agente' });
  await waitFor(() => { expect(item).toHaveAttribute('aria-disabled', 'true'); });
});
