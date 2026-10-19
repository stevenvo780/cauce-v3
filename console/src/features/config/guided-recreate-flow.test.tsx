import { webcrypto } from 'node:crypto';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import type { FleetOperation, FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
vi.mock('../accounts/ProviderAuthTerminal', () => ({ ProviderAuthTerminal: () => null }));

const driftId = '11111111-1111-4111-8111-111111111111';
const newId = '22222222-2222-4222-8222-222222222222';
const sessionId = '00000000-0000-4000-8000-000000000051';
const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'zz-canary-worker' };
const snapshot: ConfigurationSnapshot = {
  revision: 4, role_policies: [{ role: 'agent' }], tenants: [{ id: 'A' }],
  rooms: [{ tenant_id: 'A', id: 'grp.test', display_name: 'Grupo test' }],
  agents: [{
    tenant_id: 'A', alias: 'zz-canary-worker', runtime_key: 'zz-canary-worker', harness_id: 'codex',
    display_name: 'Canary', primary_room_id: 'grp.test', primary_account_id: 'main', lifecycle_state: 'auth_pending',
    placement: {
      host_id: 'test-host', mode: 'container', container_name: 'zz-canary-worker', runtime_user: 'runner',
      systemd_user: 'runner', home_directory: '/home/runner', state_directory: '/state/zz-canary-worker',
    },
  }],
  memberships: [{ tenant_id: 'A', alias: 'zz-canary-worker', room_id: 'grp.test', role: 'agent', enabled: false }],
  harness_definitions: [{ id: 'codex' }], provider_accounts: [{ id: 'main', provider: 'codex' }],
};
const capability = {
  available: true, actions: ['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge'],
  placements: [{ host_id: 'test-host', modes: ['container'], runtime_users: ['runner'], systemd_users: ['runner'], home_roots: ['/home/runner'], state_roots: ['/state'] }],
};
const drift: FleetOperation = {
  id: driftId, kind: 'update', target, status: 'awaiting_auth', version: 2, request_sha256: 'a'.repeat(64),
  actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4, desired_revision: 5, applied_revision: null,
  steps: [{ name: 'authenticate', status: 'waiting' }], error: { code: 'RUNTIME_DRIFT', step: 'authenticate', retryable: false },
  created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z',
};
async function receipt(input: FleetOperationRequest, id: string, status: FleetOperation['status'], version: number): Promise<FleetOperation> {
  return {
    id, request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target, status, version,
    actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: input.expected_revision, desired_revision: 5,
    applied_revision: null, steps: [{ name: 'prepare', status: 'pending' }], error: null,
    created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z',
  };
}

function serveFlow(previewCanApply: () => boolean) {
  const order: string[] = [];
  let enqueued: FleetOperationRequest | undefined;
  server.use(
    http.get('http://localhost/v3/console/access', () => HttpResponse.json({ subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
    http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json(capability)),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [drift] })),
    http.get(`http://localhost/v3/console/fleet/operations/${driftId}`, () => HttpResponse.json(drift)),
    http.get(`http://localhost/v3/console/fleet/operations/${newId}`, async () => HttpResponse.json(enqueued ? await receipt(enqueued, newId, 'awaiting_auth', 1) : drift)),
    http.post(`http://localhost/v3/console/fleet/operations/${driftId}/cancel`, () => {
      order.push('cancel');
      return HttpResponse.json({ ...drift, status: 'cancelled', version: 3, error: null });
    }),
    http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
      order.push('preview');
      const input = await request.json() as FleetOperationRequest;
      return HttpResponse.json({
        request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target,
        expected_revision: input.expected_revision, steps: ['prepare', 'verify'], dependencies: [], can_apply: previewCanApply(), resources: [],
      });
    }),
    http.post('http://localhost/v3/console/fleet/operations', async ({ request }) => {
      order.push('enqueue');
      enqueued = await request.json() as FleetOperationRequest;
      const operation = await receipt(enqueued, newId, 'awaiting_auth', 1);
      return HttpResponse.json({ operation_id: newId, status: 'awaiting_auth', operation }, { status: 202 });
    }),
    http.get(`http://localhost/v3/console/provider-auth/operations/${newId}/scope`, () => HttpResponse.json({
      operation_id: newId, expected_operation_version: 1, request_id: 'guided-auth-test', provider_id: 'codex',
      account_id: 'main', harness_id: 'codex', host_id: 'test-host', runtime_user: 'runner', profile_id: 'private-guided-profile',
    })),
    http.post('http://localhost/v3/console/provider-auth/sessions', () => HttpResponse.json({
      session_id: sessionId, operation_id: newId, provider_id: 'codex', account_id: 'main', harness_id: 'codex',
      host_id: 'test-host', runtime_user: 'runner', profile_id: 'private-guided-profile', method: 'device',
      status: 'awaiting_login', expires_at: new Date(Date.now() + 60_000).toISOString(), cleanup_pending: false, error: null,
    })),
  );
  return { order, enqueued: () => enqueued };
}

function renderPanel() {
  return renderWithApi(<ConsoleAccessBoundary>
    <AgentLifecyclePanel snapshot={snapshot} target={target} initialOpen hideTrigger embedded />
  </ConsoleAccessBoundary>);
}

it('recreates a drifted zz-canary container and auto-opens login in one guided path', async () => {
  const flow = serveFlow(() => true);
  renderPanel();
  const user = userEvent.setup();
  const card = await screen.findByLabelText('Operación de flota');
  const guidedButton = within(card).getByRole('button', { name: 'Recrear contenedor e iniciar sesión' });
  expect(guidedButton).toHaveClass('bg-brand');
  expect(within(card).getByText('Requiere preparación')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Previsualizar operación' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Encolar operación' })).not.toBeInTheDocument();
  const cancel = within(card).getByRole('button', { name: 'Cancelar' });
  expect(cancel).not.toHaveClass('bg-brand');
  expect(cancel.className).toContain('underline');
  expect(screen.getByRole('button', { name: 'Releer operación' }).className).toContain('underline');
  await user.click(guidedButton);
  expect(await screen.findByRole('button', { name: 'Verificar conexión' })).toBeInTheDocument();
  expect(flow.order).toEqual(['cancel', 'preview', 'enqueue']);
  expect(flow.enqueued()).toMatchObject({
    kind: 'update', target,
    parameters: { memberships: [{ room_id: 'grp.test', role: 'agent', enabled: true }] },
  });
  const progress = within(card).getByLabelText('Pasos para recrear e iniciar sesión');
  expect(progress.querySelector('[data-step="cancel"]')).toHaveAttribute('data-status', 'done');
  expect(progress.querySelector('[data-step="preview"]')).toHaveAttribute('data-status', 'done');
  expect(progress.querySelector('[data-step="enqueue"]')).toHaveAttribute('data-status', 'done');
  expect(progress.querySelector('[data-step="follow"]')).toHaveAttribute('data-status', 'done');
  expect(progress.querySelector('[data-step="auth"]')).toHaveAttribute('data-status', 'current');
  expect(within(card).getByText(/Se abrió el inicio de sesión/)).toBeInTheDocument();
  expect(document.body.textContent).not.toContain('private-guided-profile');
});

it('stops at a blocked preview with a translated message and retries from preview', async () => {
  let previews = 0;
  const flow = serveFlow(() => { previews += 1; return previews > 1; });
  renderPanel();
  const user = userEvent.setup();
  const card = await screen.findByLabelText('Operación de flota');
  await user.click(within(card).getByRole('button', { name: 'Recrear contenedor e iniciar sesión' }));
  expect(await within(card).findByText(/todavía no se puede encolar/)).toBeInTheDocument();
  expect(flow.order).toEqual(['cancel', 'preview']);
  await user.click(within(card).getByRole('button', { name: 'Reintentar' }));
  expect(await screen.findByRole('button', { name: 'Verificar conexión' })).toBeInTheDocument();
  expect(flow.order).toEqual(['cancel', 'preview', 'preview', 'enqueue']);
});
