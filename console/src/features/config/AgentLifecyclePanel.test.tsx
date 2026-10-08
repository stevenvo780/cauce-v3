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
import { AgentLifecyclePanel } from './AgentLifecyclePanel';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const snapshot: ConfigurationSnapshot = { revision: 4, tenants: [{ id: 'A' }], agents: [],
  rooms: [{ tenant_id: 'A', id: ' Sala ', display_name: 'Sala' }, { tenant_id: 'A', id: 'Sala', display_name: 'Sala' }],
  memberships: [], harness_definitions: [{ id: 'codex' }], provider_accounts: [{ id: 'main' }] };
const capability = { available: true, actions: ['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge'],
  placements: [{ host_id: 'test-host', modes: ['native'], runtime_users: ['runner'], systemd_users: ['runner'],
    home_roots: ['/home/runner'], state_roots: ['/state'] }] };
const id = '11111111-1111-4111-8111-111111111111';
async function receipt(input: FleetOperationRequest, status = 'queued', version = 0) {
  return { id, request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target,
    status, version, actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4, desired_revision: 5,
    applied_revision: null, steps: [{ name: 'prepare', status: 'pending' }], error: null,
    created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
}
function renderPanel(target?: { resource: 'agent'; tenant_id: string; alias: string }) {
  server.use(http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
  http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json(capability)),
  http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })));
  return renderWithApi(<ConsoleAccessBoundary><AgentLifecyclePanel snapshot={snapshot} target={target} /></ConsoleAccessBoundary>);
}
async function fill() {
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Preparar agente' }));
  await waitFor(() => { expect(screen.getByRole('combobox', { name: 'Host operativo' })).toHaveTextContent('test-host'); });
  await user.selectOptions(screen.getByRole('combobox', { name: 'Espacio de trabajo operativo' }), 'A');
  await user.type(screen.getByRole('textbox', { name: 'Alias operativo' }), 'new-worker');
  await user.type(screen.getByRole('textbox', { name: 'Clave física de ejecución' }), 'new-worker');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Arnés operativo' }), 'codex');
  await user.click(screen.getByRole('checkbox', { name: 'Incluir Sala · " Sala "' }));
  await user.type(screen.getByRole('textbox', { name: 'Rol en " Sala "' }), 'rol con espacios');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Grupo primario' }), ' Sala ');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Host operativo' }), 'test-host');
  await user.selectOptions(screen.getByRole('combobox', { name: 'Usuario operativo' }), 'runner');
  await user.type(screen.getByRole('textbox', { name: 'Directorio personal operativo' }), '/home/runner');
  await user.type(screen.getByRole('textbox', { name: 'Directorio de estado operativo' }), '/state/new-worker');
  return user;
}
function previewRoute() {
  return http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
    const input = await request.json() as FleetOperationRequest;
    return HttpResponse.json({ request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target,
      expected_revision: input.expected_revision, steps: ['prepare', 'verify'], dependencies: [], can_apply: true });
  });
}
it('prepares an agent without an active runtime and binds exact memberships to an accepted operation', async () => {
  renderPanel();
  let captured: FleetOperationRequest | undefined;
  server.use(previewRoute(), http.post('http://localhost/v3/console/fleet/operations', async ({ request }) => {
    captured = await request.json() as FleetOperationRequest;
    return HttpResponse.json({ operation_id: id, status: 'queued', operation: await receipt(captured) }, { status: 202 });
  }));
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  expect(await screen.findByLabelText('Previsualización operativa')).toHaveTextContent('Huella exacta:');
  await user.click(screen.getByRole('button', { name: 'Encolar operación' }));
  expect(await screen.findByLabelText('Operación de flota')).toHaveTextContent(/En cola/);
  expect(screen.queryByText('Listo')).not.toBeInTheDocument();
  expect(captured).toMatchObject({ kind: 'create', target: { tenant_id: 'A', alias: 'new-worker' }, parameters: {
    primary_room_id: ' Sala ', memberships: [{ room_id: ' Sala ', role: 'rol con espacios', enabled: true }] } });
});
it('invalidates preview on edits and keeps one idempotency key when a lost enqueue is retried', async () => {
  renderPanel();
  const bodies: FleetOperationRequest[] = [];
  server.use(previewRoute(), http.post('http://localhost/v3/console/fleet/operations', async ({ request }) => {
    const input = await request.json() as FleetOperationRequest;
    bodies.push(input);
    return bodies.length === 1 ? HttpResponse.json({ error: 'conflict', message: 'idempotent receipt delayed' }, { status: 409 })
      : HttpResponse.json({ operation_id: id, status: 'queued', operation: await receipt(input) }, { status: 202 });
  }));
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Previsualización operativa');
  await user.type(screen.getByRole('textbox', { name: 'Nombre visible operativo' }), 'Worker');
  expect(screen.queryByLabelText('Previsualización operativa')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Previsualización operativa');
  await user.click(screen.getByRole('button', { name: 'Encolar operación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('idempotent receipt delayed');
  await user.click(screen.getByRole('button', { name: 'Encolar operación' }));
  await screen.findByLabelText('Operación de flota');
  expect(bodies[1]).toEqual(bodies[0]);
});
it('fails closed when the capability is absent and does not infer it from config.write', async () => {
  renderPanel();
  server.use(http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({}, { status: 404 })));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Preparar agente' }));
  expect(await screen.findByText(/El servidor no acredita capacidades operativas/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeDisabled();
});
it('reads durable history and performs cancel/resume using the latest operation version', async () => {
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
  const input: FleetOperationRequest = { kind: 'stop', target, parameters: {}, expected_revision: 4, idempotency_key: 'request_key' };
  const queued = await receipt(input, 'queued', 3);
  const controls: unknown[] = [];
  renderPanel(target);
  server.use(http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [queued] })),
    http.get(`http://localhost/v3/console/fleet/operations/${id}`, () => HttpResponse.json({ ...queued, version: 4, status: 'awaiting_auth' })),
    http.get(`http://localhost/v3/console/provider-auth/operations/${id}/scope`, () => HttpResponse.json({
      operation_id: id, expected_operation_version: 4, request_id: 'auth-recovery-test', provider_id: 'codex', account_id: 'main',
      harness_id: 'codex', host_id: 'test-host', runtime_user: 'runner', profile_id: 'private-test-profile' })),
    http.post(`http://localhost/v3/console/fleet/operations/${id}/cancel`, async ({ request }) => {
      controls.push(await request.json()); return HttpResponse.json({ ...queued, version: 4, status: 'cancelling' });
    }), http.post(`http://localhost/v3/console/fleet/operations/${id}/resume`, async ({ request }) => {
      controls.push(await request.json()); return HttpResponse.json({ ...queued, version: 5, status: 'running' });
    }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Operar agente A/one' }));
  await user.click(await screen.findByRole('button', { name: `Abrir operación ${id}` }));
  await user.click(within(screen.getByLabelText('Operación de flota')).getByRole('button', { name: 'Cancelar operación' }));
  await screen.findByText(/Cancelación en curso/);
  await user.click(screen.getByRole('button', { name: 'Releer operación' }));
  await screen.findByText(/Esperando autenticación/);
  await user.click(screen.getByRole('button', { name: 'Reanudar operación' }));
  await screen.findByText(/En ejecución/);
  expect(controls).toEqual([{ expected_version: 3 }, { expected_version: 4 }]);
});
it('authenticates within the operation and resumes manually only with its reread version', async () => {
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
  const waiting = await receipt({ kind: 'start', target, parameters: {}, expected_revision: 4, idempotency_key: 'auth_flow_key' }, 'awaiting_auth', 2);
  const resumed: unknown[] = [];
  renderPanel(target);
  server.use(http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [waiting] })),
    http.get(`http://localhost/v3/console/fleet/operations/${id}`, () => HttpResponse.json({ ...waiting, version: 4 })),
    http.get(`http://localhost/v3/console/provider-auth/operations/${id}/scope`, () => HttpResponse.json({
      operation_id: id, expected_operation_version: 2, request_id: 'auth-integrated-test', provider_id: 'codex', account_id: 'main',
      harness_id: 'codex', host_id: 'test-host', runtime_user: 'runner', profile_id: 'private-test-profile' })),
    http.post('http://localhost/v3/console/provider-auth/sessions', () => HttpResponse.json({
      session_id: '00000000-0000-4000-8000-000000000051', operation_id: id, provider_id: 'codex', account_id: 'main',
      harness_id: 'codex', host_id: 'test-host', runtime_user: 'runner', profile_id: 'private-test-profile', method: 'device',
      status: 'authenticated', expires_at: new Date(Date.now() + 60_000).toISOString(), cleanup_pending: false, error: null })),
    http.post(`http://localhost/v3/console/fleet/operations/${id}/resume`, async ({ request }) => {
      resumed.push(await request.json()); return HttpResponse.json({ ...waiting, version: 5, status: 'running' });
    }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Operar agente A/one' }));
  await user.click(await screen.findByRole('button', { name: `Abrir operación ${id}` }));
  await user.click(await screen.findByRole('button', { name: 'Conectar cuenta' }));
  await screen.findByText(/Operación releída en versión 4/i);
  expect(resumed).toEqual([]);
  expect(document.body.textContent).not.toContain('private-test-profile');
  await user.click(screen.getByRole('button', { name: 'Reanudar operación' }));
  await screen.findByText(/En ejecución/);
  expect(resumed).toEqual([{ expected_version: 4 }]);
});
it('rejects a mismatched preview receipt without enabling enqueue', async () => {
  renderPanel();
  server.use(http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
    const input = await request.json() as FleetOperationRequest;
    return HttpResponse.json({ request_sha256: 'a'.repeat(64), kind: input.kind, target: input.target,
      expected_revision: 4, steps: ['prepare'], dependencies: [], can_apply: true });
  }));
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/recibo.*no acredita/);
  expect(screen.getByRole('button', { name: 'Encolar operación' })).toBeDisabled();
});
it('polls durable progress and refuses a changed request hash', async () => {
  renderPanel();
  let accepted: Awaited<ReturnType<typeof receipt>> | undefined;
  server.use(previewRoute(), http.post('http://localhost/v3/console/fleet/operations', async ({ request }) => {
    accepted = await receipt(await request.json() as FleetOperationRequest);
    return HttpResponse.json({ operation_id: id, status: 'queued', operation: accepted }, { status: 202 });
  }), http.get(`http://localhost/v3/console/fleet/operations/${id}`, () => HttpResponse.json({ ...accepted,
    request_sha256: 'b'.repeat(64), version: 1, status: 'succeeded', applied_revision: 5 })));
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Previsualización operativa');
  await user.click(screen.getByRole('button', { name: 'Encolar operación' }));
  await screen.findByLabelText('Operación de flota');
  expect(await screen.findByRole('alert')).toHaveTextContent(/estado distinto del recibo/);
  expect(screen.getByLabelText('Operación de flota')).toHaveTextContent(/En cola/);
  expect(screen.getByRole('button', { name: 'Cancelar operación' })).toBeDisabled();
});
it('retains the receipt after CAS conflict and rereads before retrying controls', async () => {
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
  const input: FleetOperationRequest = { kind: 'stop', target, parameters: {}, expected_revision: 4, idempotency_key: 'request_key' };
  const queued = await receipt(input, 'queued', 3);
  const versions: number[] = [];
  renderPanel(target);
  server.use(http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [queued] })),
    http.get(`http://localhost/v3/console/fleet/operations/${id}`, () => HttpResponse.json({ ...queued, version: 6 })),
    http.post(`http://localhost/v3/console/fleet/operations/${id}/cancel`, async ({ request }) => {
      const body = await request.json() as { expected_version: number };
      versions.push(body.expected_version);
      return versions.length === 1 ? HttpResponse.json({ error: 'conflict', message: 'version changed' }, { status: 409 })
        : HttpResponse.json({ ...queued, version: 7, status: 'cancelled' });
    }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Operar agente A/one' }));
  await user.click(await screen.findByRole('button', { name: `Abrir operación ${id}` }));
  await user.click(screen.getByRole('button', { name: 'Cancelar operación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('version changed');
  expect(screen.getByRole('button', { name: 'Cancelar operación' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Releer operación' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Cancelar operación' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Cancelar operación' }));
  await screen.findByText(/Cancelada/);
  expect(versions).toEqual([3, 6]);
});
