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
const snapshot: ConfigurationSnapshot = { revision: 4, tenants: [{ id: 'A' }], agents: [],
  retired: { tenants: [], rooms: [], memberships: [], agents: [{ tenant_id: 'A', alias: 'w', placement: { host_id: 'h', mode: 'container', container_name: 'ws-w' } }] } };
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
