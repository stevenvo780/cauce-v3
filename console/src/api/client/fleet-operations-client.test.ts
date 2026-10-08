import { webcrypto } from 'node:crypto';
import { sha256Hex } from '@cauce/protocol';
import { describe, expect, it, vi } from 'vitest';
import type { FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { fleetOperationsClient, fleetRequestHash } from './fleet-operations-client';
import type { RequestFn } from './system-client';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const input: FleetOperationRequest = { kind: 'stop', target: { resource: 'agent', tenant_id: 'A', alias: 'worker' },
  expected_revision: 4, idempotency_key: 'request_key', parameters: {} };
const id = '11111111-1111-4111-8111-111111111111';
async function operation() {
  return { id, request_sha256: await fleetRequestHash(input), kind: input.kind, target: input.target,
    status: 'queued', version: 0, actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4,
    desired_revision: null, applied_revision: null, steps: [], error: null,
    created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
}
function client(value: unknown) {
  const request = vi.fn(async () => value) as unknown as RequestFn;
  return { api: fleetOperationsClient(request), request };
}
describe('fleet receipts', () => {
  it('hashes reordered keys with the exact server canonical encoding', async () => {
    expect(await fleetRequestHash(input)).toBe(await fleetRequestHash({ parameters: {}, idempotency_key: 'request_key',
      expected_revision: 4, target: { alias: 'worker', tenant_id: 'A', resource: 'agent' }, kind: 'stop' }));
    expect(await fleetRequestHash(input)).toBe(sha256Hex(input));
  });
  it('accepts only a preview for the exact request and keeps room identity spaces', async () => {
    const room: FleetOperationRequest = { ...input, kind: 'retire', target: { resource: 'room', tenant_id: 'A', room_id: ' Sala ' } };
    const receipt = { request_sha256: await fleetRequestHash(room), target: room.target, kind: room.kind,
      expected_revision: 4, steps: ['prepare'], dependencies: [], can_apply: true };
    const { api, request } = client(receipt);
    expect(await api.previewFleetOperation(room)).toEqual(receipt);
    expect(vi.mocked(request).mock.calls[0]?.[0]).toBe('/v3/console/fleet/operations/preview');
    expect(vi.mocked(request).mock.calls[0]?.[1]?.method).toBe('POST');
    expect(JSON.parse(vi.mocked(request).mock.calls[0]?.[1]?.body as string)).toEqual(room);
    await expect(client({ ...receipt, target: { ...room.target, room_id: 'Sala' } }).api.previewFleetOperation(room)).rejects.toThrow(/recibo/);
    await expect(client({ ...receipt, request_sha256: 'a'.repeat(64) }).api.previewFleetOperation(room)).rejects.toThrow(/recibo/);
  });
  it('verifies enqueue envelope and sends cancel/resume with CAS', async () => {
    const receipt = await operation();
    const { api, request } = client({ operation_id: id, status: 'queued', operation: receipt });
    expect(await api.enqueueFleetOperation(input)).toEqual(receipt);
    await expect(client({ operation_id: id, status: 'running', operation: receipt }).api.enqueueFleetOperation(input)).rejects.toThrow(/recibo/);
    const controls = client({ ...receipt, version: 3, status: 'cancelled' });
    await controls.api.cancelFleetOperation(id, 2);
    expect(controls.request).toHaveBeenCalledWith(`/v3/console/fleet/operations/${id}/cancel`,
      { method: 'POST', body: '{"expected_version":2}' });
    await controls.api.resumeFleetOperation(id, 2);
    expect(controls.request).toHaveBeenLastCalledWith(`/v3/console/fleet/operations/${id}/resume`,
      { method: 'POST', body: '{"expected_version":2}' });
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects wrong operation IDs, regressed versions and unsafe evidence', async () => {
    const receipt = await operation();
    await expect(client({ ...receipt, id: '22222222-2222-4222-8222-222222222222' }).api.getFleetOperation(id)).rejects.toThrow(/recibo/);
    await expect(client(receipt).api.cancelFleetOperation(id, 3)).rejects.toThrow(/recibo/);
    await expect(client({ ...receipt, steps: [{ name: 'credentials', status: 'succeeded', evidence: { token: 'secret' } }] }).api.getFleetOperation(id)).rejects.toThrow(/recibo/);
  });
});
it('validates explicit capability and exact target history', async () => {
  await expect(client({}).api.getFleetCapability()).rejects.toThrow();
  const receipt = await operation();
  await expect(client({ operations: [receipt] }).api.listFleetOperations({ resource: 'agent', tenant_id: 'A', alias: 'other' })).rejects.toThrow(/recibo/);
  const { api, request } = client({ operations: [receipt] });
  expect(await api.listFleetOperations(input.target)).toEqual([receipt]);
  expect(request).toHaveBeenCalledWith('/v3/console/fleet/operations?resource=agent&tenant_id=A&alias=worker', { cache: 'no-store' });
});
