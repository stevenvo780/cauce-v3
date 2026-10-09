import { webcrypto } from 'node:crypto';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { RemovalDialog } from './RemovalDialog';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const target = { resource: 'room' as const, tenant_id: 'A', room_id: ' Sala ' };
const id = '33333333-3333-4333-8333-333333333333';
async function operation(input: FleetOperationRequest, status = 'queued', version = 1) {
  return { id, kind: input.kind, target: input.target, request_sha256: await fleetRequestHash(input), status, version,
    actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4, desired_revision: 5, applied_revision: null,
    steps: [{ name: 'fence', status: 'succeeded', evidence: { authority_verified: true } }, { name: 'stop', status: 'pending' }],
    error: null, created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
}
function renderDialog(kind: 'retire' | 'restore' | 'purge' = 'retire', history: unknown[] = [], capabilityAvailable = true) {
  server.use(http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
    http.get('http://localhost/v3/console/fleet/capability', () => capabilityAvailable ? HttpResponse.json({ available: true,
      actions: ['retire', 'restore', 'purge'], placements: [] }) : HttpResponse.json({}, { status: 404 })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: history })));
  renderWithApi(<ConsoleAccessBoundary><RemovalDialog target={target} kind={kind} revision={4} onClose={() => undefined} /></ConsoleAccessBoundary>);
}
function preview(canApply = true) {
  return http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
    const input = await request.json() as FleetOperationRequest;
    return HttpResponse.json({ kind: input.kind, target: input.target, expected_revision: input.expected_revision,
      request_sha256: await fleetRequestHash(input), steps: ['fence', 'stop'], can_apply: canApply,
      dependencies: [{ type: 'runtime', identity: { tenant_id: 'A', alias: 'worker', runtime_key: 'worker' }, blocking: !canApply }] });
  });
}
it('shows dependencies and preserves the exact room target without adding alias', async () => {
  renderDialog();
  server.use(preview());
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Previsualizar retiro' }));
  expect(await screen.findByLabelText('Previsualización operativa')).toHaveTextContent('worker');
  expect(screen.getByLabelText('Solicitud de retiro')).toHaveTextContent('"room_id": " Sala "');
  expect(screen.getByLabelText('Solicitud de retiro')).not.toHaveTextContent('"alias"');
  expect(screen.getByRole('button', { name: 'Encolar retiro' })).toBeEnabled();
});
it('keeps a host failure and partial fence visible and requires a current CAS version to resume', async () => {
  renderDialog();
  let input: FleetOperationRequest;
  const controls: unknown[] = [];
  server.use(preview(), http.post('http://localhost/v3/console/fleet/operations', async ({ request }) => {
    input = await request.json() as FleetOperationRequest;
    return HttpResponse.json({ operation_id: id, status: 'queued', operation: await operation(input) }, { status: 202 });
  }), http.get(`http://localhost/v3/console/fleet/operations/${id}`, async () => HttpResponse.json({
    ...await operation(input, 'failed', 2), error: { code: 'HOST_UNAVAILABLE', step: 'stop', retryable: true } })),
    http.post(`http://localhost/v3/console/fleet/operations/${id}/resume`, async ({ request }) => {
      controls.push(await request.json()); return HttpResponse.json(await operation(input, 'queued', 3));
    }));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Previsualizar retiro' }));
  await screen.findByLabelText('Previsualización operativa');
  await user.click(screen.getByRole('button', { name: 'Encolar retiro' }));
  await screen.findByLabelText('Operación de flota');
  await user.click(screen.getByRole('button', { name: 'Releer operación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('HOST_UNAVAILABLE');
  expect(screen.getByLabelText('Operación de flota')).toHaveTextContent('Cierre de entregas: Acreditado');
  await user.click(screen.getByRole('button', { name: 'Reanudar operación' }));
  await waitFor(() => { expect(controls).toEqual([{ expected_version: 2 }]); });
});
it('blocks purge when dependencies are present', async () => {
  renderDialog('purge');
  server.use(preview(false));
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: 'Previsualizar eliminación definitiva' }));
  expect(await screen.findByLabelText('Previsualización operativa')).toHaveTextContent('Bloquea esta operación');
  expect(screen.getByRole('button', { name: 'Encolar eliminación definitiva' })).toBeDisabled();
});
it('fails closed when capability is missing even with config.write', async () => {
  renderDialog('retire', [], false);
  expect(await screen.findByText(/El servidor no acredita capacidades operativas/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previsualizar retiro' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Encolar retiro' })).toBeDisabled();
});
it('loads durable group history after reopening and restores without promising to start its agents', async () => {
  const input: FleetOperationRequest = { kind: 'restore', target, parameters: {}, expected_revision: 4, idempotency_key: 'request_key' };
  const stored = await operation(input, 'succeeded', 7);
  renderDialog('restore', [stored]);
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: `Abrir operación ${id}` }));
  const dialog = within(screen.getByRole('dialog'));
  expect(dialog.getByText(/Los agentes conservan la admisión deshabilitada/)).toBeInTheDocument();
  expect(dialog.queryByRole('button', { name: 'Iniciar' })).not.toBeInTheDocument();
});
