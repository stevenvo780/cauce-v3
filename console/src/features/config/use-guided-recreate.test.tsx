import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FleetOperation, FleetOperationPreview, FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import { useGuidedRecreate, type GuidedBuildResult, type GuidedRecreateClient } from './use-guided-recreate';

const driftId = '11111111-1111-4111-8111-111111111111';
const newId = '22222222-2222-4222-8222-222222222222';
const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'zz-canary-worker' };
const request: FleetOperationRequest = {
  kind: 'update', target, expected_revision: 4, idempotency_key: 'fleet_guided_test',
  parameters: {
    runtime_key: 'zz-canary-worker', harness_id: 'codex', display_name: null, primary_room_id: 'grp.test',
    memberships: [{ room_id: 'grp.test', role: 'agent', enabled: true }],
    placement: { host_id: 'test-host', mode: 'container', container_name: 'zz-canary-worker', runtime_user: 'runner', home_directory: '/home/runner', state_directory: '/state/zz-canary-worker' },
    primary_account_id: 'main', model_id: null,
  },
};
function operation(id: string, status: FleetOperation['status'], version: number, error: FleetOperation['error'] = null): FleetOperation {
  return {
    id, kind: 'update', target, status, version, request_sha256: 'a'.repeat(64),
    actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4, desired_revision: 5,
    applied_revision: null, steps: [{ name: 'authenticate', status: 'waiting' }], error,
    created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z',
  };
}
const drift = operation(driftId, 'awaiting_auth', 2, { code: 'RUNTIME_DRIFT', step: 'authenticate', retryable: false });
const preview: FleetOperationPreview = {
  request_sha256: 'a'.repeat(64), expected_revision: 4, target, kind: 'update', steps: ['prepare', 'verify'], dependencies: [], can_apply: true, resources: [],
};

function harness(client: Partial<GuidedRecreateClient>, buildRequest: () => GuidedBuildResult = () => ({ request })) {
  const calls: string[] = [];
  const full: GuidedRecreateClient = {
    cancelFleetOperation: vi.fn(async (id: string) => { calls.push('cancel'); return operation(id, 'cancelled', 3); }),
    previewFleetOperation: vi.fn(async () => { calls.push('preview'); return preview; }),
    enqueueFleetOperation: vi.fn(async () => { calls.push('enqueue'); return operation(newId, 'awaiting_auth', 1); }),
    getFleetOperation: vi.fn(async (id: string) => { calls.push(`get:${id === driftId ? 'drift' : 'new'}`); return id === driftId ? drift : operation(newId, 'awaiting_auth', 1); }),
    resumeFleetOperation: vi.fn(async (id: string) => operation(id, 'running', 5)),
    ...client,
  };
  const accepted: FleetOperation[] = [];
  const view = renderHook(() => useGuidedRecreate({
    client: full, operation: drift, buildRequest, accept: (value) => { accepted.push(value); }, pollMs: 0,
    translateError: (message) => `traducido: ${message}`,
  }));
  return { ...view, client: full, calls, accepted };
}

describe('useGuidedRecreate', () => {
  it('chains cancel, preview, enqueue and follow into awaiting_auth', async () => {
    const { result, client, accepted } = harness({});
    act(() => { result.current.start(); });
    await waitFor(() => { expect(result.current.state.status).toBe('awaiting_auth'); });
    expect(vi.mocked(client.cancelFleetOperation).mock.calls).toEqual([[driftId, 2]]);
    expect(client.previewFleetOperation).toHaveBeenCalledWith(request);
    expect(client.enqueueFleetOperation).toHaveBeenCalledWith(request);
    expect(result.current.state.operation?.id).toBe(newId);
    expect(accepted.map((value) => value.status)).toContain('cancelled');
    expect(accepted.map((value) => value.id)).toContain(newId);
  });

  it('polls a cancelling drift and a queued recreation until awaiting_auth', async () => {
    let driftReads = 0;
    let newReads = 0;
    const { result } = harness({
      cancelFleetOperation: vi.fn(async (id: string) => operation(id, 'cancelling', 3)),
      enqueueFleetOperation: vi.fn(async () => operation(newId, 'queued', 1)),
      getFleetOperation: vi.fn(async (id: string) => {
        if (id === driftId) { driftReads += 1; return driftReads === 1 ? drift : operation(driftId, 'cancelled', 4); }
        newReads += 1; return operation(newId, 'awaiting_auth', 2);
      }),
    });
    act(() => { result.current.start(); });
    await waitFor(() => { expect(result.current.state.status).toBe('awaiting_auth'); });
    expect(newReads).toBe(1);
  });

  it('stops at preview when it cannot apply and retries only from preview', async () => {
    let previews = 0;
    const { result, client } = harness({
      previewFleetOperation: vi.fn(async () => { previews += 1; return previews === 1 ? { ...preview, can_apply: false } : preview; }),
    });
    act(() => { result.current.start(); });
    await waitFor(() => { expect(result.current.state).toMatchObject({ status: 'failed', failedStep: 'preview' }); });
    expect(result.current.state.message).toContain('todavía no se puede encolar');
    expect(client.enqueueFleetOperation).not.toHaveBeenCalled();
    act(() => { result.current.retry(); });
    await waitFor(() => { expect(result.current.state.status).toBe('awaiting_auth'); });
    expect(previews).toBe(2);
    expect(client.cancelFleetOperation).toHaveBeenCalledTimes(1);
  });

  it('retries an enqueue failure with the same request without previewing again', async () => {
    let enqueues = 0;
    const { result, client } = harness({
      enqueueFleetOperation: vi.fn(async () => {
        enqueues += 1;
        if (enqueues === 1) throw new Error('fleet operation refused');
        return operation(newId, 'awaiting_auth', 1);
      }),
    });
    act(() => { result.current.start(); });
    await waitFor(() => { expect(result.current.state).toMatchObject({ status: 'failed', failedStep: 'enqueue' }); });
    expect(result.current.state.message).toContain('traducido: fleet operation refused');
    act(() => { result.current.retry(); });
    await waitFor(() => { expect(result.current.state.status).toBe('awaiting_auth'); });
    expect(client.previewFleetOperation).toHaveBeenCalledTimes(1);
    expect(enqueues).toBe(2);
    const first = vi.mocked(client.enqueueFleetOperation).mock.calls[0]?.[0];
    const second = vi.mocked(client.enqueueFleetOperation).mock.calls[1]?.[0];
    expect(second).toEqual(first);
    expect(second.idempotency_key).toBe(request.idempotency_key);
  });

  it('fails at preview without calling the server when the current intent is invalid', async () => {
    const { result, client } = harness({}, () => ({ error: 'Falta el grupo primario. No se enviaron cambios.' }));
    act(() => { result.current.start(); });
    await waitFor(() => { expect(result.current.state).toMatchObject({ status: 'failed', failedStep: 'preview' }); });
    expect(result.current.state.message).toContain('grupo primario');
    expect(client.previewFleetOperation).not.toHaveBeenCalled();
  });
});
