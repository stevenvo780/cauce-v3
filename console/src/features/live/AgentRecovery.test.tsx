import { webcrypto } from 'node:crypto';
import { act, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { beforeEach, expect, it, vi } from 'vitest';
import type { FleetOperation, FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import type { FleetRecoveryReason } from '@cauce/protocol/fleet-recovery';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import { server } from '../../mocks/server';
import { renderWithApi, testApi } from '../../test/render';
import { AgentRecovery } from './AgentRecovery';
import { executeFleetRecovery } from './fleet-agent-recovery';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const path = '*/v3/console/tenants/A/agents/one/recovery';
const identity = { generation: 'a'.repeat(64), container_id: 'b'.repeat(64), writer_instance_id: '00000000-0000-4000-8000-000000000061' };
const fingerprint = 'c'.repeat(64);
const session = { type: 'session' as const, state: 'present' as const, resumable: true, fingerprint, reason: 'Conversación verificada.' };
const recovery = { identity, session, strategy: 'shared_tui' as const, preserves_conversation: true as const, recreates_container: false as const };
const base = { tenant_id: 'A', alias: 'one', transport: 'fleet', expected_revision: 4, in_flight: 0 };
const ready = { ...base, status: 'ready', recovery };
const drift = { ...base, status: 'update_required', reason_code: 'runtime_mounts_differ', reason: 'Actualizar ejecución.', next_action: 'update' };
beforeEach(() => {
  window.history.replaceState({}, '', '/office');
  vi.spyOn(testApi, 'listFleetOperations').mockResolvedValue([]);
});

async function open(value: Record<string, unknown>) {
  const read = vi.fn();
  server.use(http.get(path, () => { read(); return HttpResponse.json(value); }));
  const enqueue = vi.spyOn(testApi, 'enqueueFleetOperation');
  const plan = vi.spyOn(testApi, 'previewFleetOperation');
  renderWithApi(<AgentRecovery tenantId="A" alias="one" permission="allowed" />);
  const user = userEvent.setup();
  await user.click(screen.getByRole('button', { name: 'Reiniciar agente' }));
  return { user, enqueue, plan, read };
}

it('ofrece actualizar desde una consulta de solo lectura sin crear recover', async () => {
  const { user, enqueue, plan } = await open(drift);
  expect(await screen.findByRole('alert')).toHaveTextContent('El contenedor usa archivos de una versión anterior');
  expect(enqueue).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Confirmar reinicio y reanudar' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Actualizar ejecución' }));
  expect(window.location.pathname).toBe('/config');
  expect(new URLSearchParams(window.location.search).get('agente')).toBe('A/one');
  expect(new URLSearchParams(window.location.search).get('ficha')).toBe('operacion');
});

it.each(['stop', 'start'] as const)('ofrece la operación %s existente si no hay TUI', async action => {
  const { user, enqueue } = await open({ ...base, status: 'unsupported', reason_code: 'shared_tui_disabled',
    reason: 'fleet action is unavailable', next_action: 'stop_start' });
  expect(await screen.findByRole('alert')).toHaveTextContent('La política de este equipo no permite una TUI compartida');
  expect(screen.queryByText(/fleet action is unavailable/u)).toBeNull();
  await user.click(screen.getByRole('button', { name: action === 'stop' ? 'Detener' : 'Arrancar' }));
  expect(new URLSearchParams(window.location.search).get('accion')).toBe(action);
  expect(enqueue).not.toHaveBeenCalled();
});

it('bloquea entregas en vuelo sin lanzar operaciones y permite cancelar la consulta', async () => {
  const { user, enqueue } = await open({ ...ready, in_flight: 1 });
  expect(await screen.findByRole('alert')).toHaveTextContent('Hay 1 entrega en vuelo');
  expect(screen.getByRole('button', { name: 'Confirmar reinicio y reanudar' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Cancelar' }));
  expect(screen.queryByRole('button', { name: 'Confirmar reinicio y reanudar' })).toBeNull();
  expect(enqueue).not.toHaveBeenCalled();
});

it('rechaza una consulta de otro agente', async () => {
  const { enqueue } = await open({ ...drift, alias: 'other' });
  expect(await screen.findByRole('alert')).toHaveTextContent('La consulta no acreditó el agente');
  expect(screen.queryByRole('button', { name: 'Actualizar ejecución' })).toBeNull();
  expect(enqueue).not.toHaveBeenCalled();
});

it('descarta una consulta atrasada tras cambiar la autenticación', async () => {
  let reply: (() => void) | undefined;
  server.use(http.get(path, async () => { await new Promise<void>(resolve => { reply = resolve; }); return HttpResponse.json(drift); }));
  renderWithApi(<AgentRecovery tenantId="A" alias="one" permission="allowed" />);
  await userEvent.click(screen.getByRole('button', { name: 'Reiniciar agente' }));
  await waitFor(() => { expect(reply).toBeDefined(); });
  await act(async () => { await testApi.logout(); reply?.(); });
  expect(screen.queryByRole('button', { name: 'Actualizar ejecución' })).toBeNull();
});

async function operation(input: FleetOperationRequest, status: FleetOperation['status'], reason?: FleetRecoveryReason): Promise<FleetOperation> {
  const resumed = { ...recovery, session: { ...session, state: 'resumed' as const } };
  const evidence = { runtime_digest: 'd'.repeat(64), recovery: resumed };
  return { id: '00000000-0000-4000-8000-000000000062', status, version: 2, kind: input.kind, target: input.target,
    request_sha256: await fleetRequestHash(input), actor: { tenant_id: 'A', alias: 'operator' },
    expected_revision: 4, desired_revision: 4, applied_revision: status === 'succeeded' ? 4 : null,
    steps: status === 'succeeded' ? [{ name: 'runtime', status: 'succeeded', evidence }, { name: 'verify', status: 'succeeded', evidence }]
      : [{ name: 'runtime', status: 'failed' }],
    error: status === 'failed' ? { code: 'STEP_FAILED', step: 'runtime', retryable: false, ...(reason ? { reason } : {}) } : null,
    created_at: '2026-10-25T12:00:00Z', updated_at: '2026-10-25T12:00:00Z' };
}
function mockOperation(status: FleetOperation['status'], reason?: FleetRecoveryReason) {
  vi.spyOn(testApi, 'previewFleetOperation').mockImplementation(async input => ({ kind: input.kind, target: input.target,
    request_sha256: await fleetRequestHash(input), expected_revision: input.expected_revision,
    steps: [], dependencies: [], resources: [], can_apply: true }));
  vi.spyOn(testApi, 'enqueueFleetOperation').mockImplementation(input => operation(input, status, reason));
}

it('muestra causa terminal en castellano y ofrece actualizar sin fingir operación pendiente', async () => {
  mockOperation('failed', 'runtime_mounts_differ');
  const { user } = await open(ready);
  await user.click(await screen.findByRole('button', { name: 'Confirmar reinicio y reanudar' }));
  await screen.findByRole('button', { name: 'Actualizar ejecución' });
  expect(screen.getAllByRole('alert').map(node => node.textContent).join(' ')).toContain('El reinicio falló. El contenedor usa archivos de una versión anterior');
  expect(screen.queryByText(/sigue registrada/u)).toBeNull();
});

it.each(['failed', 'cancelled', 'awaiting_auth'] as const)('distingue el resultado %s de uno sin confirmar', async status => {
  mockOperation(status);
  await expect(executeFleetRecovery(testApi, { tenant_id: 'A', alias: 'one' }, 4,
    { action: 'apply', identity, expected_fingerprint: fingerprint, force: true }, new AbortController().signal))
    .rejects.toThrow(status === 'failed' ? /El reinicio falló/u : status === 'cancelled' ? /se canceló/u : /autenticación/u);
});

it('confirma la reanudación exacta y rechaza un recibo de otra conversación', async () => {
  mockOperation('succeeded');
  const apply = { action: 'apply' as const, identity, expected_fingerprint: fingerprint, force: true };
  await expect(executeFleetRecovery(testApi, { tenant_id: 'A', alias: 'one' }, 4, apply, new AbortController().signal))
    .resolves.toMatchObject({ identity, session: { state: 'resumed', fingerprint } });
  await expect(executeFleetRecovery(testApi, { tenant_id: 'A', alias: 'one' }, 4,
    { ...apply, expected_fingerprint: 'e'.repeat(64) }, new AbortController().signal)).rejects.toThrow(/No se ha confirmado/u);
});

it('identifica la operación fallida anterior y abre Ejecución sin consultar ni crear otro reinicio', async () => {
  const previous = await operation({ kind: 'recover', target: { resource: 'agent', tenant_id: 'A', alias: 'one' },
    expected_revision: 4, idempotency_key: 'previous-recovery', parameters: { action: 'probe' } }, 'failed');
  vi.spyOn(testApi, 'listFleetOperations').mockResolvedValue([previous]);
  const { user, enqueue, read } = await open(ready);
  const link = await screen.findByRole('button', { name: 'Ver operación' });
  expect(screen.getByRole('alert')).toHaveTextContent(previous.id);
  expect(screen.getByRole('alert')).toHaveTextContent('Estado: Fallida · Paso: Entorno');
  expect(read).not.toHaveBeenCalled(); expect(enqueue).not.toHaveBeenCalled();
  expect(screen.queryByText(/target already has/u)).toBeNull();
  await user.click(link);
  expect(window.location.pathname).toBe('/config');
  expect(new URLSearchParams(window.location.search).get('ficha')).toBe('operacion');
});
