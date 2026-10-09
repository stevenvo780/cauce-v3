import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';
import { openAgentSheet } from './agent-menu.test-helpers';

const host = { host_id: 'torre', display_name: 'Torre', notes: '', enabled: true, status: 'reachable',
  status_source: 'controller', last_seen_at: null, registered: true, approved: true, version: 1, agents: [] };
const snapshot: ConfigurationSnapshot = {
  revision: 4,
  agents: [
    { tenant_id: 'A', alias: 'one', display_name: 'Agente uno', harness_id: 'codex', enabled: true, max_concurrent_deliveries: 1 },
    { tenant_id: 'A', alias: 'run', display_name: 'Agente run', harness_id: 'codex', enabled: true, max_concurrent_deliveries: 1, runtime_key: 'rk', host_id: null },
    { tenant_id: 'A', alias: 'placed', display_name: 'Agente placed', harness_id: 'codex', enabled: true, max_concurrent_deliveries: 1, runtime_key: 'rk2', host_id: 'torre' },
  ],
  memberships: [{ tenant_id: 'A', alias: 'one', room_id: 'grp.a', enabled: true }],
  rooms: [{ tenant_id: 'A', id: 'grp.a', display_name: 'Grupo A', enabled: true }, { tenant_id: 'A', id: 'grp.b', display_name: 'Grupo B', enabled: true }],
};

beforeEach(() => {
  window.history.replaceState({}, '', '/config?seccion=agentes');
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Hub:operator', roles: ['operator'], permissions: ['config.read', 'config.write'],
    })),
    http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [host] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({
      available: false, actions: [], placements: [], reason: 'executor_unconfigured',
    })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  );
});

function renderSection() {
  return renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
}

it('the whole tile opens the agent sheet with its facts, and the URL records it', async () => {
  const user = userEvent.setup();
  renderSection();
  const sheet = await openAgentSheet(user, 'A/one');
  expect(sheet.getByRole('heading', { name: 'Agente uno' })).toBeInTheDocument();
  expect(sheet.getAllByRole('tab').map((tab) => tab.textContent)).toEqual(['Resumen', 'Registro', 'Operación', 'Grupos']);
  expect(sheet.getByText('codex', { selector: 'dd' })).toBeInTheDocument();
  expect(sheet.getByRole('link', { name: 'Perfil y contexto de A/one' })).toHaveAttribute('href', '/messages/A/one?view=context');
  expect(new URLSearchParams(window.location.search).get('agente')).toBe('A/one');
  expect(screen.queryByRole('textbox', { name: 'Nombre visible' })).not.toBeInTheDocument();
});

it('the deep link opens the sheet and closing it removes the param', async () => {
  window.history.replaceState({}, '', '/config?seccion=agentes&agente=A/one');
  const user = userEvent.setup();
  renderSection();
  expect(await screen.findByRole('heading', { name: 'Agente uno' })).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Cerrar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(window.location.search).toBe('?seccion=agentes');
});

it('a deep link to an agent that does not exist opens nothing and drops the param', async () => {
  window.history.replaceState({}, '', '/config?seccion=agentes&agente=A/ghost');
  renderSection();
  await screen.findByRole('list', { name: 'Agentes configurados' });
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  await waitFor(() => { expect(window.location.search).toBe('?seccion=agentes'); });
});

it('asks inside the sheet before discarding an unsaved registry draft, and keeps it across tabs', async () => {
  const confirm = vi.spyOn(window, 'confirm');
  const user = userEvent.setup();
  renderSection();
  const sheet = await openAgentSheet(user, 'A/one');
  await user.click(sheet.getByRole('tab', { name: 'Registro' }));
  const name = await sheet.findByRole('textbox', { name: 'Nombre visible' });
  await user.clear(name);
  await user.type(name, 'Pendiente');
  await user.click(sheet.getByRole('tab', { name: 'Resumen' }));
  await user.click(sheet.getByRole('tab', { name: 'Registro' }));
  expect(sheet.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Pendiente');

  await user.keyboard('{Escape}');
  expect(await screen.findByText(/Tenés cambios sin guardar/)).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Seguir editando' }));
  expect(screen.queryByText(/Tenés cambios sin guardar/)).not.toBeInTheDocument();
  expect(sheet.getByRole('textbox', { name: 'Nombre visible' })).toHaveValue('Pendiente');

  await user.click(screen.getByRole('button', { name: 'Cerrar' }));
  await user.click(await screen.findByRole('button', { name: 'Descartar y cerrar' }));
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(window.location.search).toBe('?seccion=agentes');
  expect(confirm).not.toHaveBeenCalled();
});

it('closes without asking when nothing was edited', async () => {
  const user = userEvent.setup();
  renderSection();
  const sheet = await openAgentSheet(user, 'A/one');
  await user.click(sheet.getByRole('tab', { name: 'Registro' }));
  await sheet.findByRole('textbox', { name: 'Nombre visible' });
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  expect(screen.queryByText(/Tenés cambios sin guardar/)).not.toBeInTheDocument();
});

it('a runtime agent without a computer must pick one: no «Sin computadora», with its help text', async () => {
  const user = userEvent.setup();
  renderSection();
  const sheet = await openAgentSheet(user, 'A/run');
  await user.click(sheet.getByRole('tab', { name: 'Registro' }));
  await sheet.findByRole('combobox', { name: /Computadora/ });
  expect(sheet.queryByRole('option', { name: 'Sin computadora' })).not.toBeInTheDocument();
  expect(sheet.getByRole('option', { name: 'Elige una computadora' })).toBeInTheDocument();
  expect(sheet.getByText(/Asigna la computadora donde ya corre este agente/)).toBeInTheDocument();
});

it('a runtime agent with a computer shows it read-only inside the sheet', async () => {
  const user = userEvent.setup();
  renderSection();
  const sheet = await openAgentSheet(user, 'A/placed');
  await user.click(sheet.getByRole('tab', { name: 'Registro' }));
  const form = await sheet.findByRole('region', { name: 'Registro de A/placed' });
  expect(within(form).queryByRole('combobox', { name: /Computadora/ })).not.toBeInTheDocument();
  await waitFor(() => { expect(within(form).getByText(/Computadora: Torre/)).toBeInTheDocument(); });
});

it('lists the groups of the agent in its Grupos tab', async () => {
  const user = userEvent.setup();
  renderSection();
  const sheet = await openAgentSheet(user, 'A/one');
  await user.click(sheet.getByRole('tab', { name: 'Grupos' }));
  const list = await sheet.findByRole('list', { name: 'Grupos de A/one' });
  expect(within(list).getByText('Grupo A')).toBeInTheDocument();
  expect(sheet.getByRole('region', { name: 'Mover a otro grupo' })).toBeInTheDocument();
});

it('asks before discarding a pending group move chosen in the Grupos tab', async () => {
  const user = userEvent.setup();
  renderSection();
  const sheet = await openAgentSheet(user, 'A/one');
  await user.click(sheet.getByRole('tab', { name: 'Grupos' }));
  await user.selectOptions(await sheet.findByLabelText('Grupo de destino'), 'grp.b');
  await user.keyboard('{Escape}');
  expect(await screen.findByText(/Tenés cambios sin guardar/)).toBeInTheDocument();
  expect(screen.getByRole('dialog')).toBeInTheDocument();
});

it('opens the removal guide on the first click when the sheet was opened from the URL', async () => {
  window.history.replaceState({}, '', '/config?seccion=agentes&agente=A/run');
  const user = userEvent.setup();
  renderSection();
  await user.click(await screen.findByRole('button', { name: 'Eliminar agente A/run' }));
  expect(await screen.findByRole('heading', { name: 'Eliminar agente A/run' })).toBeInTheDocument();
  expect(screen.getByLabelText('Pasos para eliminar el agente')).toBeInTheDocument();
});

it('keeps the removal guide open when focus leaves it right after it opens', async () => {
  window.history.replaceState({}, '', '/config?seccion=agentes&agente=A/run');
  const user = userEvent.setup();
  renderSection();
  await user.click(await screen.findByRole('button', { name: 'Eliminar agente A/run' }));
  const guide = await screen.findByLabelText('Pasos para eliminar el agente');
  const outside = document.createElement('button');
  document.body.append(outside);
  act(() => { outside.focus(); });
  await new Promise((resolve) => { setTimeout(resolve, 50); });
  expect(guide).toBeInTheDocument();
  expect(screen.getByRole('heading', { name: 'Eliminar agente A/run' })).toBeInTheDocument();
  outside.remove();
});
