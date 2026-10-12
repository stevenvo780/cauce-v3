import { webcrypto } from 'node:crypto';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const row = (extra: Record<string, unknown>) => ({ tenant_id: 'A', alias: 'w', host_id: 'h', ...extra });
const snapshotOf = (agent: Record<string, unknown>): ConfigurationSnapshot => ({ revision: 4, tenants: [{ id: 'A' }], agents: [],
  retired: { tenants: [], rooms: [], memberships: [], agents: [agent] } });
const snapshot = snapshotOf(row({ runtime_mode: 'container', container_name: 'ws-w' }));
const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'w' };

it('names the container and volumes and keeps purge disabled until the exact alias is typed', async () => {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['purge'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
    http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest;
      return HttpResponse.json({ kind: input.kind, target: input.target, expected_revision: input.expected_revision,
        request_sha256: await fleetRequestHash(input), steps: ['fence'], can_apply: true, dependencies: [] });
    }),
  );
  renderWithApi(<ConsoleAccessBoundary>
    <AgentLifecyclePanel snapshot={snapshot} target={target} initialOpen hideTrigger embedded fixedKind initialKind="purge" />
  </ConsoleAccessBoundary>);
  const user = userEvent.setup();
  const resources = await screen.findByLabelText('Recursos que se borrarán');
  expect(resources).toHaveTextContent('ws-w');
  expect(resources).toHaveTextContent('ws-w-state');
  expect(resources).toHaveTextContent('ws-w-provider-profiles');
  expect(resources).toHaveTextContent('Si es propio del agente');
  expect(screen.getByRole('link', { name: 'Descargar copia' })).toHaveAttribute('href', '/messages/A/w?view=context');
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Previsualización operativa');
  const enqueue = screen.getByRole('button', { name: 'Encolar operación' });
  expect(enqueue).toBeDisabled();
  await user.type(screen.getByLabelText(/Escribe el alias/), 'W');
  expect(enqueue).toBeDisabled();
  await user.clear(screen.getByLabelText(/Escribe el alias/));
  await user.type(screen.getByLabelText(/Escribe el alias/), 'w');
  expect(enqueue).toBeEnabled();
});

function renderPurge(value: ConfigurationSnapshot) {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['purge'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  );
  renderWithApi(<ConsoleAccessBoundary>
    <AgentLifecyclePanel snapshot={value} target={target} initialOpen hideTrigger embedded fixedKind initialKind="purge" />
  </ConsoleAccessBoundary>);
  return screen.findByLabelText('Recursos que se borrarán');
}

it('describes a native agent by its host directories, not by a fake host: container', async () => {
  const resources = await renderPurge(snapshotOf(row({ runtime_mode: 'native', container_name: 'host:h', state_directory: '/srv/agents/w' })));
  expect(resources).toHaveTextContent('/srv/agents/w');
  expect(resources).toHaveTextContent('en el host h');
  expect(resources).not.toHaveTextContent('host:h');
  expect(resources).not.toHaveTextContent('provider-profiles');
});

it('treats a host: container_name as native even when runtime_mode is null (legacy row)', async () => {
  const resources = await renderPurge(snapshotOf(row({ runtime_mode: null, container_name: 'host:h' })));
  expect(resources).not.toHaveTextContent('host:h-state');
  expect(resources).toHaveTextContent('No hay contenedor ni volúmenes');
});

it('does not claim to delete a container it cannot show is owned, and says volumes are conditional', async () => {
  const resources = await renderPurge(snapshotOf(row({ runtime_mode: null, container_name: 'ws-humanizar' })));
  expect(resources).toHaveTextContent('Si es propio del agente');
  expect(resources).toHaveTextContent('compartido con otros agentes, se conserva');
  expect(resources).toHaveTextContent('si existe, ws-humanizar-provider-profiles');
});
