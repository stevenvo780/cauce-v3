import { webcrypto } from 'node:crypto';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetOperation, FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { ApiProvider } from '../../api/context';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi, testApi } from '../../test/render';
import { AgentFleetOperation } from './AgentFleetOperation';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const snapshot: ConfigurationSnapshot = { revision: 4, tenants: [{ id: 'A' }], agents: [],
  retired: { tenants: [], rooms: [], memberships: [], agents: [{ tenant_id: 'A', alias: 'w', host_id: 'h', runtime_mode: 'container', container_name: 'ws-w' }] } };
interface Resource { type: string; name: string; action: string; reason: string }
const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'w' };

async function preview(resources: Resource[], embedded = true) {
  const requests: FleetOperationRequest[] = [];
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['purge'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
    http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest;
      requests.push(input);
      return HttpResponse.json({ kind: input.kind, target: input.target, expected_revision: input.expected_revision,
        request_sha256: await fleetRequestHash(input), steps: ['fence'], can_apply: true, dependencies: [], resources });
    }),
  );
  const view = (selected = target, currentSnapshot = snapshot) => <ConsoleAccessBoundary>
    <AgentLifecyclePanel snapshot={currentSnapshot} target={selected} initialOpen hideTrigger={embedded} embedded={embedded} fixedKind initialKind="purge" />
  </ConsoleAccessBoundary>;
  const result = renderWithApi(view());
  const user = userEvent.setup();
  await screen.findByLabelText('Recursos que se borrarán');
  await user.type(screen.getByLabelText(/Escribe el alias/), 'w');
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  return { user, requests, plan: await screen.findByLabelText('Recursos físicos del plan'),
    changeTarget: (selected: typeof target) => { result.rerender(<ApiProvider api={testApi}>{view(selected)}</ApiProvider>); },
    changeRevision: (revision: number) => { result.rerender(<ApiProvider api={testApi}>{view(target, { ...snapshot, revision })}</ApiProvider>); } };
}

it('lists the server plan, keeps purge disabled until the exact alias is typed and links the backup', async () => {
  const { user, plan } = await preview([
    { type: 'container', name: 'ws-w', action: 'delete', reason: 'Contenedor propio' },
    { type: 'volume', name: 'ws-w-state', action: 'delete', reason: 'Volumen de estado' },
    { type: 'volume', name: 'ws-w-provider-profiles', action: 'delete', reason: 'Perfil del proveedor' }]);
  const enqueued: FleetOperationRequest[] = [];
  server.use(http.post('http://localhost/v3/console/fleet/operations', async ({ request }) => {
    const input = await request.json() as FleetOperationRequest;
    enqueued.push(input);
    const operation: FleetOperation = { id: '71000000-0000-4000-8000-000000000001', request_sha256: await fleetRequestHash(input),
      target: input.target, kind: input.kind, expected_revision: input.expected_revision, status: 'queued', version: 0,
      actor: { tenant_id: 'A', alias: 'op' }, desired_revision: null, applied_revision: null,
      steps: [{ name: 'purge', status: 'pending' }], error: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() };
    return HttpResponse.json({ operation_id: operation.id, status: operation.status, operation }, { status: 202 });
  }));
  expect(screen.getByLabelText('Recursos que se borrarán')).not.toHaveTextContent('ws-w-state');
  expect(plan).toHaveTextContent('Se borrará: contenedor ws-w');
  expect(plan).toHaveTextContent('volumen ws-w-state');
  expect(plan).toHaveTextContent('volumen ws-w-provider-profiles');
  expect(screen.getByLabelText('Previsualización operativa')).toHaveTextContent('Esto es el plan');
  expect(screen.getByRole('link', { name: 'Descargar copia' })).toHaveAttribute('href', '/messages/A/w?view=context');
  const enqueue = screen.getByRole('button', { name: 'Encolar operación' });
  await user.clear(screen.getByLabelText(/Escribe el alias/));
  expect(enqueue).toBeDisabled();
  await user.click(enqueue);
  for (const alias of ['W', 'ww', ' w', 'w ']) {
    await user.clear(screen.getByLabelText(/Escribe el alias/));
    await user.type(screen.getByLabelText(/Escribe el alias/), alias);
    expect(enqueue).toBeDisabled();
    await user.click(enqueue);
  }
  expect(enqueued).toEqual([]);
  await user.clear(screen.getByLabelText(/Escribe el alias/));
  await user.type(screen.getByLabelText(/Escribe el alias/), 'w');
  expect(enqueue).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Recursos físicos del plan');
  expect(enqueue).toBeEnabled();
  await user.click(enqueue);
  expect(await screen.findByLabelText('Operación de flota')).toHaveTextContent('En cola');
  expect(enqueued).toHaveLength(1);
  expect(enqueued[0]).toMatchObject({ kind: 'purge', target, expected_revision: 4, parameters: { confirm_alias: 'w' } });
  expect(screen.getByLabelText(/Escribe el alias/)).toHaveValue('');
});

it('shows a shared container as kept and a native directory as deleted', async () => {
  const { plan } = await preview([
    { type: 'container', name: 'ws-humanizar', action: 'keep', reason: 'Contenedor compartido' },
    { type: 'directory', name: '/srv/agents/w', action: 'delete', reason: 'Estado nativo' }]);
  expect(plan).toHaveTextContent('Se conservará: contenedor ws-humanizar');
  expect(plan).toHaveTextContent('Se borrará: directorio /srv/agents/w');
});

it('requires a new preview after closing, reopening and confirming the same alias', async () => {
  const { user, requests } = await preview([{ type: 'container', name: 'ws-w', action: 'delete', reason: 'Contenedor propio' }], false);
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeEnabled();
  await user.click(screen.getByRole('button', { name: 'Cerrar operaciones' }));
  await user.click(screen.getByRole('button', { name: 'Operar agente A/w' }));
  expect(screen.getByLabelText(/Escribe el alias/)).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  await user.type(screen.getByLabelText(/Escribe el alias/), 'w');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  expect(screen.queryByLabelText('Recursos físicos del plan')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Recursos físicos del plan');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeEnabled();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.idempotency_key).not.toBe(requests[0]?.idempotency_key);
});

it('does not revive a preview when an edited confirmation returns to the original alias', async () => {
  const { user, requests } = await preview([{ type: 'container', name: 'ws-w', action: 'delete', reason: 'Contenedor propio' }]);
  await user.type(screen.getByLabelText(/Escribe el alias/), 'rong');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  await user.clear(screen.getByLabelText(/Escribe el alias/));
  await user.type(screen.getByLabelText(/Escribe el alias/), 'w');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  expect(screen.queryByLabelText('Recursos físicos del plan')).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Recursos físicos del plan');
  expect(screen.getByLabelText(/Escribe el alias/)).toHaveValue('w');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeEnabled();
  expect(requests).toHaveLength(2);
  expect(requests[1]?.idempotency_key).not.toBe(requests[0]?.idempotency_key);
});

it('does not reuse confirmation for the same alias in another tenant', async () => {
  const { user, changeTarget } = await preview([{ type: 'container', name: 'ws-w', action: 'delete', reason: 'Contenedor propio' }]);
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeEnabled();
  changeTarget({ ...target, tenant_id: 'B' });
  expect(screen.getByLabelText(/Escribe el alias/)).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  changeTarget(target);
  await user.type(screen.getByLabelText(/Escribe el alias/), 'w');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  expect(screen.queryByLabelText('Recursos físicos del plan')).not.toBeInTheDocument();
});

it('reports the observed purge result when the operation finishes', () => {
  const operation: FleetOperation = { request_sha256: 'a'.repeat(64), id: '71000000-0000-4000-8000-000000000001', status: 'succeeded', version: 3,
    target, kind: 'purge', actor: { tenant_id: 'A', alias: 'op' }, expected_revision: 4, desired_revision: null, applied_revision: null,
    steps: [{ name: 'purge', status: 'succeeded' }], error: null, created_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z' };
  render(<AgentFleetOperation operation={operation} busy={false} current control={() => undefined} />);
  expect(screen.getByLabelText('Resultado de la purga')).toHaveTextContent('Terminó sin detallar qué recursos borró');
});

it('shows the resources the executor actually deleted', () => {
  const operation: FleetOperation = { request_sha256: 'a'.repeat(64), id: '71000000-0000-4000-8000-000000000001', status: 'succeeded', version: 3,
    target, kind: 'purge', actor: { tenant_id: 'A', alias: 'op' }, expected_revision: 4, desired_revision: null, applied_revision: null,
    steps: [{ name: 'purge', status: 'succeeded', evidence: { removed: [
      { type: 'container', name: 'ws-w' }, { type: 'volume', name: 'ws-w-state' }, { type: 'directory', name: '/srv/agents/w' }] } }],
    error: null, created_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z' };
  render(<AgentFleetOperation operation={operation} busy={false} current control={() => undefined} />);
  expect(screen.getByLabelText('Resultado de la purga')).toHaveTextContent('Borró el contenedor ws-w, el volumen ws-w-state y el directorio /srv/agents/w');
});

it('says when the executor finished without deleting a container or volume', () => {
  const operation: FleetOperation = { request_sha256: 'a'.repeat(64), id: '71000000-0000-4000-8000-000000000001', status: 'succeeded', version: 3,
    target, kind: 'purge', actor: { tenant_id: 'A', alias: 'op' }, expected_revision: 4, desired_revision: null, applied_revision: null,
    steps: [{ name: 'purge', status: 'succeeded', evidence: { removed: [] } }], error: null,
    created_at: '2026-10-12T10:00:00.000Z', updated_at: '2026-10-12T10:00:00.000Z' };
  render(<AgentFleetOperation operation={operation} busy={false} current control={() => undefined} />);
  expect(screen.getByLabelText('Resultado de la purga')).toHaveTextContent('No borró contenedores ni volúmenes');
});

it('clears confirmation and requires a new preview after the inventory revision changes', async () => {
  const { user, requests, changeRevision } = await preview([{ type: 'container', name: 'ws-w', action: 'delete', reason: 'Contenedor propio' }]);
  expect(screen.getByLabelText(/Escribe el alias/)).toHaveValue('w');
  changeRevision(5);
  expect(screen.getByLabelText(/Escribe el alias/)).toHaveValue('');
  expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  await user.type(screen.getByLabelText(/Escribe el alias/), 'w');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Recursos físicos del plan');
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeEnabled();
  expect(requests[1]).toMatchObject({ expected_revision: 5, parameters: { confirm_alias: 'w' } });
  expect(requests[1]?.idempotency_key).not.toBe(requests[0]?.idempotency_key);
});
