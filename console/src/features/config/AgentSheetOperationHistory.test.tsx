import { webcrypto } from 'node:crypto';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentesSection } from './AgentesSection';
import { openAgentSheet } from './agent-menu.test-helpers';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
const snapshot: ConfigurationSnapshot = {
  revision: 4,
  agents: [{ tenant_id: 'A', alias: 'run', display_name: 'Agente run', harness_id: 'codex', enabled: true, max_concurrent_deliveries: 1, runtime_key: 'rk', host_id: 'torre' }],
  memberships: [], rooms: [],
};

it('opening an operation from the history keeps the sheet and ?agente= and shows the operation panel', async () => {
  window.history.replaceState({}, '', '/config?seccion=agentes');
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'run' };
  const input: FleetOperationRequest = { kind: 'start', target, parameters: {}, expected_revision: 4, idempotency_key: 'history_key' };
  const waiting = { id, request_sha256: await fleetRequestHash(input), kind: 'start', target, status: 'awaiting_auth', version: 2,
    actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4, desired_revision: 5, applied_revision: null,
    steps: [{ name: 'prepare', status: 'pending' }], error: null, created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({ subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
    http.get('http://localhost/v3/console/fleet/hosts', () => HttpResponse.json({ hosts: [] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({ available: true, actions: ['start', 'update', 'retire'], placements: [] })),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [{ ...waiting, id: other, created_at: '2026-10-07T13:00:00Z' }, waiting] })),
    http.get(`http://localhost/v3/console/provider-auth/operations/${id}/scope`, () => HttpResponse.json({
      operation_id: id, expected_operation_version: 2, request_id: 'auth-history-test', provider_id: 'codex', account_id: 'main',
      harness_id: 'codex', host_id: 'test-host', runtime_user: 'runner', profile_id: 'private-test-profile' })),
  );
  const user = userEvent.setup();
  renderWithApi(<ConsoleAccessBoundary><AgentesSection snapshot={snapshot} /></ConsoleAccessBoundary>);
  const sheet = await openAgentSheet(user, 'A/run');
  await user.click(sheet.getByRole('tab', { name: 'Operación' }));
  await user.click(await sheet.findByText('Historial operativo durable'));
  const order = () => sheet.getAllByRole('button', { name: /^Abrir operación / }).map((button) => button.getAttribute('aria-label'));
  const before = order();
  await user.click(await sheet.findByRole('button', { name: `Abrir operación ${id}` }));
  expect(await sheet.findByLabelText('Operación de flota')).toBeInTheDocument();
  expect(await within(screen.getByRole('dialog')).findByRole('heading', { name: 'Autenticar la cuenta principal' })).toBeInTheDocument();
  await waitFor(() => { expect(screen.getByRole('dialog')).toBeInTheDocument(); });
  expect(new URLSearchParams(window.location.search).get('agente')).toBe('A/run');
  expect(order()).toEqual(before);
});
