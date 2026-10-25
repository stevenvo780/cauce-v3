import { webcrypto } from 'node:crypto';
import { useState, type ReactNode } from 'react';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { FleetCapabilitySchema, FleetOperationSchema, type FleetOperation, type FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { ConsoleAccessBoundary } from '../../api/console-access';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import type { ConfigurationSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { ApiProvider } from '../../api/context';
import { renderWithApi, testApi } from '../../test/render';
import { AgentLifecyclePanel } from './AgentLifecyclePanel';
import { useAgentLifecycle } from './use-agent-lifecycle';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const snapshot: ConfigurationSnapshot = { revision: 4, role_policies: [{ role: 'agent' }, { role: 'rol con espacios' }], tenants: [{ id: 'A' }], agents: [],
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
  await user.selectOptions(screen.getByRole('combobox', { name: 'Rol en " Sala "' }), 'rol con espacios');
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
  expect(await screen.findByLabelText('Previsualización operativa')).toHaveTextContent('Huella exacta');
  await user.click(screen.getByRole('button', { name: 'Confirmar operación' }));
  expect(await screen.findByLabelText('Operación de flota')).toHaveTextContent(/En cola/);
  expect(screen.queryByText('Listo')).not.toBeInTheDocument();
  expect(captured).toMatchObject({ kind: 'create', target: { tenant_id: 'A', alias: 'new-worker' }, parameters: {
    primary_room_id: ' Sala ', memberships: [{ room_id: ' Sala ', role: 'rol con espacios', enabled: true }] } });
});
it('relee la revisión y reintenta la primera vista previa tras otra operación, conservando lo rellenado', async () => {
  const revisions: number[] = [];
  server.use(http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
  http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json(capability)),
  http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })),
  http.get('http://localhost/v3/console/config', () => HttpResponse.json({ ...snapshot, revision: 5 })),
  http.post('http://localhost/v3/console/fleet/operations/preview', async ({ request }) => {
    const input = await request.json() as FleetOperationRequest;
    revisions.push(input.expected_revision);
    if (input.expected_revision !== 5) {
      return HttpResponse.json({ error: 'conflict', message: 'configuration revision changed; preview the operation again' }, { status: 409 });
    }
    return HttpResponse.json({ request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target,
      expected_revision: input.expected_revision, steps: ['prepare', 'verify'], dependencies: [], can_apply: true });
  }));
  function Wrapper() {
    const [current, setCurrent] = useState(snapshot);
    return <ConsoleAccessBoundary><AgentLifecyclePanel snapshot={current} onReloaded={setCurrent} /></ConsoleAccessBoundary>;
  }
  renderWithApi(<Wrapper />);
  const user = await fill();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  expect(await screen.findByLabelText('Previsualización operativa')).toHaveTextContent('Huella exacta');
  expect(revisions).toEqual([4, 5]);
  expect(screen.getByRole('textbox', { name: 'Alias operativo' })).toHaveValue('new-worker');
  expect(screen.getByRole('button', { name: 'Confirmar operación' })).toBeEnabled();
  expect(screen.queryByText(/La configuración cambió desde que se lanzó/)).not.toBeInTheDocument();
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
  expect(screen.getByRole('button', { name: 'Confirmar operación' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Previsualización operativa');
  await user.click(screen.getByRole('button', { name: 'Confirmar operación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('idempotent receipt delayed');
  await user.click(screen.getByRole('button', { name: 'Confirmar operación' }));
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
it('explains an unavailable executor in Spanish on the notice and the disabled action', async () => {
  renderPanel();
  server.use(http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json({
    available: false, actions: [], placements: [], reason: 'executor_unconfigured',
  })));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Preparar agente' }));
  expect(await screen.findByText(/ninguna computadora de esta empresa está conectada/)).toBeInTheDocument();
  expect(screen.queryByText(/executor_unconfigured/)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Previsualizar operación' })).toHaveAttribute('title', expect.stringContaining('ninguna computadora de esta empresa está conectada'));
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
  await user.click(await screen.findByRole('button', { name: 'Ver detalle de Detener a one' }));
  await user.click(within(screen.getByLabelText('Operación de flota')).getByRole('button', { name: 'Cancelar' }));
  await waitFor(() => { expect(controls).toEqual([{ expected_version: 3 }]); });
  await user.click(screen.getByRole('button', { name: 'Releer operación' }));
  await within(screen.getByLabelText('Operación de flota')).findByText(/Esperando tu acción/);
  await user.click(screen.getByRole('button', { name: 'Reanudar' }));
  await within(screen.getByLabelText('Operación de flota')).findByText(/En curso/);
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
  await user.click(await screen.findByRole('button', { name: 'Ver detalle de Iniciar a one' }));
  await user.click(await screen.findByRole('button', { name: 'Iniciar sesión' }));
  await screen.findByText(/Cuenta verificada/i);
  expect(resumed).toEqual([]);
  expect(document.body.textContent).not.toContain('private-test-profile');
  await user.click(screen.getByRole('button', { name: 'Reanudar' }));
  await within(screen.getByLabelText('Operación de flota')).findByText(/En curso/);
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
  expect(screen.getByRole('button', { name: 'Confirmar operación' })).toBeDisabled();
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
  await user.click(screen.getByRole('button', { name: 'Confirmar operación' }));
  await screen.findByLabelText('Operación de flota');
  expect(await screen.findByRole('alert')).toHaveTextContent(/estado distinto del recibo/);
  expect(screen.getByLabelText('Operación de flota')).toHaveTextContent(/En cola/);
  expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
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
  await user.click(await screen.findByRole('button', { name: 'Ver detalle de Detener a one' }));
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('version changed');
  expect(screen.getByRole('button', { name: 'Cancelar' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Releer operación' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Cancelar' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  await within(screen.getByLabelText('Operación de flota')).findByText(/Cancelada/);
  expect(versions).toEqual([3, 6]);
});
it('shows the newest pending operation on open and still refuses an older version of it', async () => {
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
  const queued = await receipt({ kind: 'stop', target, parameters: {}, expected_revision: 4, idempotency_key: 'request_key' }, 'queued', 3);
  renderPanel(target);
  server.use(http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [queued] })),
    http.get(`http://localhost/v3/console/fleet/operations/${id}`, () => HttpResponse.json({ ...queued, version: 1 })));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Operar agente A/one' }));
  const card = await screen.findByLabelText('Operación de flota');
  expect(card).toHaveTextContent(/En cola/);
  await user.click(screen.getByRole('button', { name: 'Releer operación' }));
  expect(await screen.findByRole('alert')).toHaveTextContent(/estado distinto del recibo o una versión anterior/);
});
it('lets the operator select, preview and enqueue stop while host maintenance has not prepared', async () => {
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
  const input: FleetOperationRequest = { kind: 'stop', target, parameters: {}, expected_revision: 4, idempotency_key: 'request_key' };
  const automatic = { ...await receipt(input, 'running', 1), kind: 'update', desired_revision: null,
    actor: { tenant_id: 'A', alias: 'one', actor_subject: 'host:test-host:approved-key' } };
  renderPanel(target);
  const enqueued: FleetOperationRequest[] = [];
  server.use(previewRoute(),
    http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [automatic] })),
    http.post('http://localhost/v3/console/fleet/operations', async ({ request }) => {
      const selected = await request.json() as FleetOperationRequest;
      enqueued.push(selected);
      const operation = { ...await receipt(selected), id: '55555555-5555-4555-8555-555555555555' };
      return HttpResponse.json({ operation_id: operation.id, status: operation.status, operation }, { status: 202 });
    }));
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Operar agente A/one' }));
  await screen.findByLabelText('Operación de flota');
  const action = screen.getByRole('combobox', { name: '¿Qué quieres hacer?' });
  expect(action).toBeEnabled();
  await user.selectOptions(action, 'stop');
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  await screen.findByLabelText('Previsualización operativa');
  await user.click(screen.getByRole('button', { name: 'Confirmar operación' }));
  await waitFor(() => { expect(enqueued).toHaveLength(1); });
  expect(enqueued[0]).toMatchObject({ kind: 'stop', target });
});
it('keeps the accepted manual operation and its inventory refresh when an old maintenance read finishes late', async () => {
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
  const input: FleetOperationRequest = { kind: 'stop', target, parameters: {}, expected_revision: 4, idempotency_key: 'request_key' };
  const automatic = FleetOperationSchema.parse({ ...await receipt(input, 'running', 1), kind: 'update', desired_revision: null,
    actor: { tenant_id: 'A', alias: 'one', actor_subject: 'host:test-host:approved-key' } });
  const manual = FleetOperationSchema.parse({ ...await receipt(input, 'queued', 1), id: '55555555-5555-4555-8555-555555555555' });
  let finishAutomatic: (value: FleetOperation) => void = () => undefined;
  let finishManual: (value: FleetOperation) => void = () => undefined;
  const automaticRead = new Promise<FleetOperation>(resolve => { finishAutomatic = resolve; });
  const manualRead = new Promise<FleetOperation>(resolve => { finishManual = resolve; });
  vi.spyOn(testApi, 'getFleetCapability').mockResolvedValue(FleetCapabilitySchema.parse(capability));
  vi.spyOn(testApi, 'listFleetOperations').mockResolvedValue([automatic]);
  vi.spyOn(testApi, 'getFleetOperation').mockImplementation(operationId => operationId === automatic.id ? automaticRead : manualRead);
  const reloadInventory = vi.fn();
  const { result } = renderHook(() => useAgentLifecycle(true, target, reloadInventory),
    { wrapper: ({ children }: { children: ReactNode }) => <ApiProvider api={testApi}>{children}</ApiProvider> });
  await waitFor(() => { expect(result.current.operation?.id).toBe(automatic.id); });
  let refreshAutomatic: Promise<unknown> = Promise.resolve();
  act(() => { refreshAutomatic = result.current.refresh(); });
  expect(result.current.busy).toBe(true);
  act(() => { result.current.accept(manual); });
  expect(result.current.operation?.id).toBe(manual.id);
  expect(result.current.busy).toBe(false);
  let refreshManual: Promise<unknown> = Promise.resolve();
  act(() => { refreshManual = result.current.refresh(); });
  expect(result.current.busy).toBe(true);
  await act(async () => { finishAutomatic({ ...automatic, status: 'cancelled', version: 2 }); await refreshAutomatic; });
  expect(result.current.operation?.id).toBe(manual.id);
  expect(result.current.busy).toBe(true);
  expect(reloadInventory).not.toHaveBeenCalled();
  await act(async () => { finishManual({ ...manual, status: 'succeeded', version: 2 }); await refreshManual; });
  expect(result.current.operation).toMatchObject({ id: manual.id, status: 'succeeded', version: 2 });
  expect(result.current.busy).toBe(false);
  expect(reloadInventory).toHaveBeenCalledTimes(1);
});
it('translates the primary membership refusal and jumps to its checkbox on click', async () => {
  renderPanel();
  server.use(http.post('http://localhost/v3/console/fleet/operations/preview', () =>
    HttpResponse.json({ error: 'conflict', message: 'primary membership must be enabled in the activation intent' }, { status: 409 })));
  const user = await fill();
  const checkbox = screen.getByRole('checkbox', { name: /Habilitar membresía " Sala "/ });
  await user.click(checkbox);
  expect(checkbox).not.toBeChecked();
  await user.click(screen.getByRole('button', { name: 'Previsualizar operación' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Para activar el agente su grupo principal ( Sala ) debe quedar habilitado. Marca "Habilitar membresía".');
  expect(alert).not.toHaveTextContent('primary membership must be enabled');
  const jump = within(alert).getByRole('button');
  await user.click(jump);
  expect(checkbox).toHaveFocus();
});
it('keeps an edited operational draft when the inventory re-polls', async () => {
  const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
  const withAgent = { ...snapshot, agents: [{ tenant_id: 'A', alias: 'one', harness_id: 'codex', display_name: 'Uno' }] };
  server.use(http.get('http://localhost/v3/console/access', () => HttpResponse.json({
    subject: 'A:operator', roles: ['operator'], permissions: ['config.read', 'config.write'] })),
  http.get('http://localhost/v3/console/fleet/capability', () => HttpResponse.json(capability)),
  http.get('http://localhost/v3/console/fleet/operations', () => HttpResponse.json({ operations: [] })));
  const view = (value: ConfigurationSnapshot) => <ConsoleAccessBoundary><AgentLifecyclePanel snapshot={value} target={target} initialOpen /></ConsoleAccessBoundary>;
  const { rerender } = renderWithApi(view(withAgent));
  const user = userEvent.setup();
  const name = await screen.findByRole('textbox', { name: 'Nombre visible operativo' });
  await user.clear(name);
  await user.type(name, 'Cambio pendiente');
  rerender(<ApiProvider api={testApi}>{view({ ...withAgent, revision: 5 })}</ApiProvider>);
  expect(await screen.findByText(/El borrador se conserva/)).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Nombre visible operativo' })).toHaveValue('Cambio pendiente');
});
