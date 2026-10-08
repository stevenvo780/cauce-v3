import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { ConsoleAccessBoundary } from '../../api/console-access';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';
import { agentAction, openAgentMenu } from './agent-menu.test-helpers';

beforeEach(() => { window.history.replaceState({}, '', '/config?seccion=agentes'); });

function host(hostId: string, overrides: Record<string, unknown> = {}) {
  return {
    host_id: hostId, display_name: hostId, notes: '', enabled: true, status: 'reachable',
    status_source: 'controller', last_seen_at: null, registered: true, approved: true, version: 1, agents: [],
    ...overrides,
  };
}

const withRuntime: ConfigurationSnapshot = {
  revision: 3,
  agents: [
    { tenant_id: 'A', alias: 'one', display_name: 'Agente uno', harness_id: 'codex', enabled: true, host_id: 'edge-2', runtime_key: 'rk-one' },
    { tenant_id: 'A', alias: 'two', display_name: 'Agente dos', harness_id: 'codex', enabled: true, host_id: 'edge-1', runtime_key: null },
  ],
  memberships: [], rooms: [],
};

beforeEach(() => {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'Hub:operator', roles: ['operator'], permissions: ['config.read', 'config.write'],
    })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({
      available: false, actions: [], placements: [], reason: 'executor_unconfigured',
    })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  );
});

function row(name: string) {
  return within(screen.getByRole('list', { name: 'Agentes configurados' })).getByText(name).closest('li') as HTMLElement;
}

it('shows the computer of each agent and a disabled badge only for unusable computers', async () => {
  server.use(http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({
    hosts: [host('edge-2', { display_name: 'Laptop' , status: 'unreachable' }), host('edge-1', { display_name: 'Servidor' })],
  })));
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={withRuntime} /></ConsoleAccessBoundary>);
  expect(await within(row('Agente uno')).findByText('Deshabilitado: computadora sin conexión')).toBeInTheDocument();
  expect(within(row('Agente uno')).getByText('Laptop')).toBeInTheDocument();
  expect(within(row('Agente dos')).getByText('Servidor')).toBeInTheDocument();
  expect(within(row('Agente dos')).queryByText(/Deshabilitado: computadora/)).not.toBeInTheDocument();
});

it('badges an agent on a disabled computer as deshabilitada', async () => {
  server.use(http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({
    hosts: [host('edge-2', { enabled: false }), host('edge-1')],
  })));
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={withRuntime} /></ConsoleAccessBoundary>);
  expect(await within(row('Agente uno')).findByText('Deshabilitado: computadora deshabilitada')).toBeInTheDocument();
});

it('una lectura 403 de computadoras degrada en silencio: sin error ni insignias', async () => {
  server.use(http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ error: 'forbidden' }, { status: 403 })));
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={withRuntime} /></ConsoleAccessBoundary>);
  expect(await within(row('Agente uno')).findByText('edge-2')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(within(row('Agente uno')).queryByText(/Deshabilitado: computadora/)).not.toBeInTheDocument();
});

it('offers retire only for agents with a runtime and preselects retire in the lifecycle panel', async () => {
  server.use(http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [] })));
  const user = userEvent.setup();
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={withRuntime} /></ConsoleAccessBoundary>);
  await openAgentMenu(user, 'A/two');
  expect(screen.queryByRole('menuitem', { name: 'Retirar agente' })).not.toBeInTheDocument();
  await user.keyboard('{Escape}');
  await agentAction(user, 'A/one', 'Retirar agente');
  expect(screen.getByRole('combobox', { name: 'Acción operativa' })).toHaveValue('retire');
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByRole('dialog')).not.toBeInTheDocument(); });
  await agentAction(user, 'A/two', 'Editar registro');
  expect(within(screen.getByRole('dialog')).getByRole('button', { name: 'Eliminar registro' })).toBeEnabled();
});

it('labels the purge of a retired agent as Eliminar definitivamente', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={{
    revision: 3, agents: [], memberships: [], rooms: [],
    retired: { agents: [{ tenant_id: 'A', alias: 'old' }] },
  } as unknown as ConfigurationSnapshot} /></ConsoleAccessBoundary>);
  await user.click(await screen.findByRole('button', { name: 'Operar agente A/old' }));
  const select = screen.getByRole('combobox', { name: 'Acción operativa' });
  expect(within(select).getByRole('option', { name: 'Eliminar definitivamente' })).toBeInTheDocument();
  expect(screen.getByText(/«Eliminar definitivamente» purga el registro retirado/)).toBeInTheDocument();
});
