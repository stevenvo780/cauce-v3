import { webcrypto } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetOperation, FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentFleetOperation } from './AgentFleetOperation';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const snapshot: ConfigurationSnapshot = { revision: 4, tenants: [{ id: 'A' }], agents: [],
  retired: { tenants: [], rooms: [], memberships: [], agents: [{ tenant_id: 'A', alias: 'w', host_id: 'h', runtime_mode: 'container', container_name: 'ws-w' }] } };
interface Resource { type: string; name: string; action: string; reason: string }
const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'w' };

async function preview(resources: Resource[]) {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['purge'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
    http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest;
      return HttpResponse.json({ kind: input.kind, target: input.target, expected_revision: input.expected_revision,
        request_sha256: await fleetRequestHash(input), steps: ['fence'], can_apply: true, dependencies: [], resources });
    }),
  );
  renderWithApi(<ConsoleAccessBoundary>
    <AgentLifecyclePanel snapshot={snapshot} target={target} initialOpen hideTrigger embedded fixedKind initialKind="purge" />
  </ConsoleAccessBoundary>);
  const user = userEvent.setup();
  await screen.findByLabelText('Recursos que se borrarán');
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  return { user, plan: await screen.findByLabelText('Recursos físicos del plan') };
}

it('lists the server plan, keeps purge disabled until the exact alias is typed and links the backup', async () => {
  const { user, plan } = await preview([
    { type: 'container', name: 'ws-w', action: 'delete', reason: 'Contenedor propio' },
    { type: 'volume', name: 'ws-w-state', action: 'delete', reason: 'Volumen de estado' }]);
  expect(screen.getByLabelText('Recursos que se borrarán')).not.toHaveTextContent('ws-w-state');
  expect(plan).toHaveTextContent('Se borra: Contenedor ws-w');
  expect(plan).toHaveTextContent('Se borra: Volumen ws-w-state');
  expect(plan).toHaveTextContent('este es el plan, no el resultado');
  expect(screen.getByRole('link', { name: 'Descargar copia' })).toHaveAttribute('href', '/messages/A/w?view=context');
  const enqueue = screen.getByRole('button', { name: 'Encolar operación' });
  expect(enqueue).toBeDisabled();
  await user.type(screen.getByLabelText(/Escribe el alias/), 'W');
  expect(enqueue).toBeDisabled();
  await user.clear(screen.getByLabelText(/Escribe el alias/));
  await user.type(screen.getByLabelText(/Escribe el alias/), 'w');
  expect(enqueue).toBeEnabled();
});

it('shows a shared container as kept and a native directory as deleted', async () => {
  const { plan } = await preview([
    { type: 'container', name: 'ws-humanizar', action: 'keep', reason: 'Contenedor compartido' },
    { type: 'directory', name: '/srv/agents/w', action: 'delete', reason: 'Estado nativo' }]);
  expect(plan).toHaveTextContent('Se conserva: Contenedor ws-humanizar');
  expect(plan).toHaveTextContent('Se borra: Directorio /srv/agents/w');
});

it('reports the observed purge result when the operation finishes', () => {
  const operation: FleetOperation = { request_sha256: 'a'.repeat(64), id: '71000000-0000-4000-8000-000000000001', status: 'succeeded', version: 3,
    target, kind: 'purge', actor: { tenant_id: 'A', alias: 'op' }, expected_revision: 4, desired_revision: null, applied_revision: null,
    steps: [{ name: 'purge', status: 'succeeded' }], error: null, created_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z' };
  render(<AgentFleetOperation operation={operation} busy={false} current control={() => undefined} />);
  expect(screen.getByLabelText('Resultado de la purga')).toHaveTextContent('aún no detalla qué recursos físicos se borraron');
});

it('shows the resources the executor actually deleted', () => {
  const operation: FleetOperation = { request_sha256: 'a'.repeat(64), id: '71000000-0000-4000-8000-000000000001', status: 'succeeded', version: 3,
    target, kind: 'purge', actor: { tenant_id: 'A', alias: 'op' }, expected_revision: 4, desired_revision: null, applied_revision: null,
    steps: [{ name: 'purge', status: 'succeeded', evidence: { removed: [
      { type: 'container', name: 'ws-w' }, { type: 'volume', name: 'ws-w-state' }, { type: 'directory', name: '/srv/agents/w' }] } }],
    error: null, created_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z' };
  render(<AgentFleetOperation operation={operation} busy={false} current control={() => undefined} />);
  expect(screen.getByLabelText('Resultado de la purga')).toHaveTextContent('El ejecutor borró: Contenedor ws-w, Volumen ws-w-state, Directorio /srv/agents/w');
});

it('says when the executor finished without deleting a container or volume', () => {
  const operation: FleetOperation = { request_sha256: 'a'.repeat(64), id: '71000000-0000-4000-8000-000000000001', status: 'succeeded', version: 3,
    target, kind: 'purge', actor: { tenant_id: 'A', alias: 'op' }, expected_revision: 4, desired_revision: null, applied_revision: null,
    steps: [{ name: 'purge', status: 'succeeded', evidence: { removed: [] } }], error: null,
    created_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z' };
  render(<AgentFleetOperation operation={operation} busy={false} current control={() => undefined} />);
  expect(screen.getByLabelText('Resultado de la purga')).toHaveTextContent('no borró contenedores ni volúmenes propios');
});
