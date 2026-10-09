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
import { AgentRemovalDialog } from './AgentRemovalDialog';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const snapshot: ConfigurationSnapshot = { revision: 4, tenants: [{ id: 'A' }], agents: [{ tenant_id: 'A', alias: 'w', runtime_key: 'w' }] };
const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'w' };
const id = '44444444-4444-4444-8444-444444444444';
async function operation(kind: FleetOperationRequest['kind'], status: string, version: number, retryable = true) {
  const request = { kind, target, parameters: {}, expected_revision: 4, idempotency_key: 'fleet_x' };
  return { id, kind, target, request_sha256: await fleetRequestHash(request), status, version,
    actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4, desired_revision: 5, applied_revision: null,
    steps: [{ name: 'prepare', status: status === 'failed' ? 'failed' : 'pending' }],
    error: status === 'failed' ? { code: 'HOST_UNAVAILABLE', step: 'prepare', retryable } : null,
    created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
}
function renderDialog(history: unknown[]) {
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({
      subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({
      available: true, actions: ['create', 'retire', 'purge'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: history })),
    http.get('http://localhost/v3/console/config', () => HttpResponse.json(snapshot)),
  );
  renderWithApi(<ConsoleAccessBoundary>
    <AgentRemovalDialog tenantId="A" alias="w" retired={false} snapshot={snapshot} onReloaded={() => undefined} onClose={() => undefined} />
  </ConsoleAccessBoundary>);
}

it('asks to cancel a failed create before retiring, and lets the retire preview run once it reads cancelled', async () => {
  renderDialog([await operation('create', 'failed', 3)]);
  server.use(
    http.post(`http://localhost/v3/console/fleet/operations/${id}/cancel`, async () => HttpResponse.json(await operation('create', 'cancelled', 4))),
    http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
      const input = await request.json() as FleetOperationRequest;
      return HttpResponse.json({ kind: input.kind, target: input.target, expected_revision: input.expected_revision,
        request_sha256: await fleetRequestHash(input), steps: ['fence'], can_apply: true, dependencies: [] });
    }),
  );
  const user = userEvent.setup();
  expect(await screen.findByText('Hay una operación de preparación sin terminar; cancélala para poder retirar.')).toBeInTheDocument();
  const cancel = screen.getByRole('button', { name: 'Cancelar operación' });
  expect(cancel).toBeEnabled();
  expect(cancel).toHaveClass('primary');
  expect(screen.getByRole('button', { name: 'Reanudar operación' })).not.toHaveClass('primary');
  expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeDisabled();
  await user.click(cancel);
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeEnabled(); });
  expect(screen.queryByText(/sin terminar; cancélala/)).not.toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  expect(await screen.findByLabelText('Previsualización operativa')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeEnabled();
});

it('translates the server refusal of an unresolved operation when previewing', async () => {
  renderDialog([]);
  server.use(http.post('http://localhost/v3/console/fleet/operations/preview', () => HttpResponse.json(
    { error: 'conflict', message: 'target already has an unresolved fleet operation' }, { status: 409 })));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Previsualizar operación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('cancélala para poder retirar');
});

it('explains a resume refused after a revision change and makes cancelling the primary action', async () => {
  renderDialog([await operation('retire', 'failed', 3)]);
  server.use(http.post(`http://localhost/v3/console/fleet/operations/${id}/resume`, () => HttpResponse.json(
    { error: 'conflict', message: 'configuration revision changed; preview the operation again' }, { status: 409 })));
  const user = userEvent.setup();
  const resume = await screen.findByRole('button', { name: 'Reanudar operación' });
  expect(resume).toHaveClass('primary');
  await user.click(resume);
  expect(await screen.findByText('La configuración cambió desde que se lanzó; cancélala y vuelve a lanzarla.')).toBeInTheDocument();
  const cancel = screen.getByRole('button', { name: 'Cancelar operación' });
  expect(cancel).toBeEnabled();
  expect(cancel).toHaveClass('primary');
  expect(screen.getByRole('button', { name: 'Reanudar operación' })).toBeDisabled();
});
