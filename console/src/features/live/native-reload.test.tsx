import { webcrypto } from 'node:crypto';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { FleetCapability, FleetOperation, FleetOperationRequest } from '@cauce/protocol/fleet-operation';
import type { ConfigurationSnapshot } from '../../api/types';
import type { Resource } from '../../api/use-resource';
import { fleetRequestHash } from '../../api/client/fleet-operations-client';
import { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import type { NativeRead } from './native-admin/client';
import { measureNativeReload, nativeReloadBinding, reloadNativeAgent } from './native-reload';
import { useNativeReload } from './use-native-reload';

Object.defineProperty(globalThis, 'crypto', { configurable: true, value: webcrypto });
const target = { resource: 'agent' as const, tenant_id: 'A', alias: 'one' };
const row = { tenant_id: 'A', alias: 'one', enabled: true, runtime_key: 'physical-one', harness_id: 'codex',
  host_id: 'test-host', runtime_mode: 'container', container_name: 'test-physical-one', runtime_user: 'runner',
  home_directory: '/home/runner', state_directory: '/state/physical-one', primary_account_id: 'account-one' };
const capability: FleetCapability = { available: true, actions: ['stop', 'start'], placements: [{ host_id: 'test-host',
  modes: ['container'], runtime_users: ['runner'], systemd_users: [], home_roots: ['/home/runner'], state_roots: ['/state'],
  runtimes: [{ mode: 'container', harness_id: 'codex', provider: 'codex', runtime_user: 'runner',
    home_directory: '/home/runner', state_root: '/state', container_prefix: 'test-' }] }] };
function snapshot(revision = 4, running = true): ConfigurationSnapshot {
  return { revision, agents: [{ ...row, enabled: running }],
    capabilities: { actor: { tenant_id: 'A', alias: 'operator', is_hub: true, can_control: true }, resources: [] } };
}
const native: NativeRead = { tenant_id: 'A', alias: 'one', harness: 'codex', kinds: ['skill', 'mcp'], can_write: true,
  identity: { generation: 'same-generation', container_id: 'same-container', writer_instance_id: '00000000-0000-4000-8000-000000000061' },
  outcome: { type: 'inventory', kind: 'skill', items: [], truncated: false } };
const stopSteps: FleetOperation['steps'] = [{ name: 'stop', status: 'succeeded', evidence: { stopped_verified: true } }];
const startSteps: FleetOperation['steps'] = [
  { name: 'runtime', status: 'succeeded', evidence: { runtime_digest: 'a'.repeat(64) } },
  { name: 'authenticate', status: 'succeeded', evidence: { provider_verified: true } },
  { name: 'profile', status: 'succeeded', evidence: { profile_verified: true } },
  { name: 'verify', status: 'succeeded', evidence: { bootstrap_verified: true, roundtrip_verified: true } },
  { name: 'admission', status: 'succeeded', evidence: { authority_verified: true, artifact_sha256: 'a'.repeat(64) } },
];
async function receipt(request: FleetOperationRequest, status: FleetOperation['status'] = 'succeeded', version = 2): Promise<FleetOperation> {
  return { id: request.kind === 'stop' ? '00000000-0000-4000-8000-000000000062' : '00000000-0000-4000-8000-000000000063',
    status, version, target: request.target, kind: request.kind, request_sha256: await fleetRequestHash(request),
    actor: { tenant_id: 'A', alias: 'operator', actor_subject: 'person-one' }, expected_revision: request.expected_revision,
    desired_revision: request.expected_revision + 2, applied_revision: status === 'succeeded' ? request.expected_revision + 2 : null,
    steps: request.kind === 'stop' ? structuredClone(stopSteps) : structuredClone(startSteps), error: null,
    created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
}
function fixture() {
  const calls: string[] = [];
  const api = {
    getFleetCapability: vi.fn(async () => { calls.push('capability'); return capability; }),
    readNativePieces: vi.fn(async () => { calls.push('native'); return native; }),
    previewFleetOperation: vi.fn(async (request: FleetOperationRequest) => ({ request_sha256: await fleetRequestHash(request),
      expected_revision: request.expected_revision, target: request.target, kind: request.kind, steps: [], dependencies: [], can_apply: true })),
    enqueueFleetOperation: vi.fn(async (request: FleetOperationRequest) => { calls.push(request.kind); return receipt(request); }),
    getFleetOperation: vi.fn<(_id: string) => Promise<FleetOperation>>(),
    listFleetOperations: vi.fn(), cancelFleetOperation: vi.fn(), resumeFleetOperation: vi.fn(),
  };
  let reads = 0;
  const configuration: Resource<ConfigurationSnapshot> = { data: snapshot(), loading: false,
    reload: vi.fn(async () => { calls.push('snapshot'); const read = reads++;
      return { data: read === 0 ? snapshot() : read === 1 ? snapshot(6, false) : snapshot(8, true) }; }) };
  return { api, configuration, calls, signal: new AbortController().signal };
}

describe('native restart authority and physical identity', () => {
  it('uses only the selected physical runtime from an explicit host catalog', () => {
    expect(nativeReloadBinding(snapshot(), capability, target, true)).toMatchObject({ runtime_key: 'physical-one',
      placement: { host_id: 'test-host', container_name: 'test-physical-one' } });
    expect(nativeReloadBinding(snapshot(), capability, { ...target, alias: 'other' }, true)).toBeUndefined();
  });
  it.each([
    { ...capability, available: false, actions: [], placements: [] },
    { ...capability, actions: ['stop'] },
    { ...capability, placements: [{ ...capability.placements[0]!, runtimes: undefined }] },
    { ...capability, placements: [{ ...capability.placements[0]!, host_id: 'other-host' }] },
    { ...capability, placements: [{ ...capability.placements[0]!, runtime_users: ['other'] }] },
  ] satisfies FleetCapability[])('fails closed for unsupported capability %#', value => {
    expect(nativeReloadBinding(snapshot(), value, target, true)).toBeUndefined();
  });
  it.each([
    { revision: undefined }, { capabilities: undefined }, { agents: [{ ...row, runtime_key: null }] },
    { agents: [{ ...row, container_name: 'other' }] }, { agents: [{ ...row, primary_account_id: null }] },
    { agents: [row, row] }, { agents: [{ ...row, enabled: false }] }, { agents: [{ ...row, retired_at: 'retired' }] },
  ] satisfies Partial<ConfigurationSnapshot>[])('fails closed for missing or conflicting snapshot evidence %#', value => {
    expect(nativeReloadBinding({ ...snapshot(), ...value }, capability, target, true)).toBeUndefined();
  });
  it.each([{ ...native, can_write: false }, { ...native, alias: 'other' }, { ...native, harness: 'claude' }])(
    'requires measured native authority for the exact target %#', async value => {
      const { api } = fixture(); api.readNativePieces.mockResolvedValue(value);
      await expect(measureNativeReload(api, snapshot(), target)).rejects.toThrow(/identidad física/);
    });
});

describe('durable stop then fresh CAS start', () => {
  it('waits for verified stop, rereads configuration and uses its fresh revision to start', async () => {
    const { api, configuration, calls, signal } = fixture();
    await reloadNativeAgent(api, configuration, target, signal);
    expect(calls).toEqual(['snapshot', 'capability', 'native', 'stop', 'snapshot', 'capability', 'start', 'snapshot']);
    expect(api.enqueueFleetOperation.mock.calls.map(([request]) => [request.kind, request.expected_revision, request.target]))
      .toEqual([['stop', 4, target], ['start', 6, target]]);
    const requests = api.enqueueFleetOperation.mock.calls.map(([request]) => request);
    expect(requests[0]?.parameters).toEqual({}); expect(requests[1]?.parameters).toEqual({});
    expect(requests[0]?.idempotency_key).not.toBe(requests[1]?.idempotency_key);
    expect(api.cancelFleetOperation).not.toHaveBeenCalled(); expect(api.resumeFleetOperation).not.toHaveBeenCalled();
  });
  it.each(['awaiting_auth', 'failed', 'cancelled', 'cancelling'] as const)('does not start after stop status %s', async status => {
    const { api, configuration, signal } = fixture(); api.enqueueFleetOperation.mockImplementation(request => receipt(request, status));
    await expect(reloadNativeAgent(api, configuration, target, signal)).rejects.toThrow(status);
    expect(api.enqueueFleetOperation).toHaveBeenCalledTimes(1); expect(configuration.reload).toHaveBeenCalledTimes(1);
  });
  it('does not start after a successful label without stopped evidence', async () => {
    const { api, configuration, signal } = fixture(); api.enqueueFleetOperation.mockImplementation(async request => ({ ...await receipt(request), steps: [] }));
    await expect(reloadNativeAgent(api, configuration, target, signal)).rejects.toThrow(/efecto completo/);
    expect(api.enqueueFleetOperation).toHaveBeenCalledTimes(1);
  });
  it.each([
    snapshot(5, false), { ...snapshot(6, false), agents: [{ ...row, enabled: false, primary_account_id: 'other' }] },
    { ...snapshot(6, false), agents: [{ ...row, enabled: false, container_name: 'other' }] },
  ])('does not start with stale revision or changed physical/account binding %#', async value => {
    const { api, configuration, signal } = fixture(); vi.mocked(configuration.reload).mockResolvedValueOnce({ data: snapshot() }).mockResolvedValueOnce({ data: value });
    await expect(reloadNativeAgent(api, configuration, target, signal)).rejects.toThrow(/queda detenido/);
    expect(api.enqueueFleetOperation).toHaveBeenCalledTimes(1);
  });
  it('rejects an unavailable fresh configuration instead of reusing the displayed revision', async () => {
    const { api, configuration, signal } = fixture(); vi.mocked(configuration.reload).mockResolvedValue({ error: new Error('offline') });
    await expect(reloadNativeAgent(api, configuration, target, signal)).rejects.toThrow(/lectura fresca/);
    expect(api.enqueueFleetOperation).not.toHaveBeenCalled();
  });
  it('polls the receipt until success before sending start', async () => {
    const { api, configuration, signal } = fixture();
    api.enqueueFleetOperation.mockImplementation(request => receipt(request, request.kind === 'stop' ? 'queued' : 'succeeded', 1));
    api.getFleetOperation.mockImplementation(async () => receipt(api.enqueueFleetOperation.mock.calls[0]![0], 'succeeded', 2));
    await reloadNativeAgent(api, configuration, target, signal, { pollMilliseconds: 1 });
    expect(api.getFleetOperation).toHaveBeenCalledTimes(1); expect(api.enqueueFleetOperation).toHaveBeenCalledTimes(2);
  });
  it.each(['version', 'target', 'hash', 'actor', 'id', 'same-version-change'] as const)('rejects substituted or regressed poll receipt %s', async attack => {
    const { api, configuration, signal } = fixture();
    api.enqueueFleetOperation.mockImplementation(request => receipt(request, 'queued', 2));
    api.getFleetOperation.mockImplementation(async () => {
      const value = await receipt(api.enqueueFleetOperation.mock.calls[0]![0], 'succeeded', attack === 'same-version-change' ? 2 : 3);
      if (attack === 'version') value.version = 1;
      if (attack === 'target') value.target = { ...target, alias: 'other' };
      if (attack === 'hash') value.request_sha256 = 'f'.repeat(64);
      if (attack === 'actor') value.actor.alias = 'other';
      if (attack === 'id') value.id = '00000000-0000-4000-8000-000000000069';
      return value;
    });
    await expect(reloadNativeAgent(api, configuration, target, signal, { pollMilliseconds: 1 })).rejects.toThrow(/recibo/);
    expect(api.enqueueFleetOperation).toHaveBeenCalledTimes(1);
  });
  it('does not credit start without roundtrip proof', async () => {
    const { api, configuration, signal } = fixture(); api.enqueueFleetOperation.mockImplementation(async request => {
      const value = await receipt(request);
      if (request.kind === 'start') value.steps.find(step => step.name === 'verify')!.evidence!.roundtrip_verified = false;
      return value;
    });
    await expect(reloadNativeAgent(api, configuration, target, signal)).rejects.toThrow(/arranque verificado/);
  });
  it('does not credit the restarted runtime while the final snapshot still declares it stopped', async () => {
    const { api, configuration, signal } = fixture(); vi.mocked(configuration.reload)
      .mockResolvedValueOnce({ data: snapshot() }).mockResolvedValueOnce({ data: snapshot(6, false) })
      .mockResolvedValueOnce({ data: snapshot(8, false) });
    await expect(reloadNativeAgent(api, configuration, target, signal)).rejects.toThrow(/configuración actual/);
    expect(api.enqueueFleetOperation).toHaveBeenCalledTimes(2);
  });
  it('bounds unresolved polling and never starts or cancels after timeout', async () => {
    const { api, configuration, signal } = fixture(); api.enqueueFleetOperation.mockImplementation(request => receipt(request, 'queued'));
    api.getFleetOperation.mockImplementation(() => new Promise(() => undefined));
    await expect(reloadNativeAgent(api, configuration, target, signal, { timeoutMilliseconds: 25, pollMilliseconds: 1 })).rejects.toThrow(/plazo/);
    expect(api.enqueueFleetOperation).toHaveBeenCalledTimes(1); expect(api.cancelFleetOperation).not.toHaveBeenCalled();
  });
  it('aborts before mutation and does not send another phase after an abort while polling', async () => {
    const first = fixture(); const cancelled = new AbortController(); cancelled.abort();
    await expect(reloadNativeAgent(first.api, first.configuration, target, cancelled.signal)).rejects.toThrow(/interrumpió/);
    expect(first.configuration.reload).not.toHaveBeenCalled();
    const second = fixture(); const controller = new AbortController();
    second.api.enqueueFleetOperation.mockImplementation(request => receipt(request, 'queued'));
    second.api.getFleetOperation.mockImplementation(() => { controller.abort(); return new Promise(() => undefined); });
    await expect(reloadNativeAgent(second.api, second.configuration, target, controller.signal, { pollMilliseconds: 1 })).rejects.toThrow(/interrumpió/);
    expect(second.api.enqueueFleetOperation).toHaveBeenCalledTimes(1); expect(second.api.cancelFleetOperation).not.toHaveBeenCalled();
  });
});

describe('native reload hook', () => {
  it('offers no callback for baseline capability and exposes one only after measured authority', async () => {
    const { api, configuration } = fixture(); const client = new CauceApi('http://localhost');
    const capabilities = vi.spyOn(client, 'getFleetCapability').mockResolvedValue({ available: false, actions: [], placements: [] });
    const measured = vi.spyOn(client, 'readNativePieces').mockImplementation(api.readNativePieces);
    const { result, rerender, unmount } = renderHook(({ config }) => useNativeReload('A', 'one', config, 'allowed'), {
      initialProps: { config: configuration }, wrapper: ({ children }) => <ApiProvider api={client}>{children}</ApiProvider>,
    });
    await waitFor(() => { expect(capabilities).toHaveBeenCalled(); });
    expect(result.current).toBeUndefined(); expect(measured).not.toHaveBeenCalled();
    capabilities.mockResolvedValue(capability);
    rerender({ config: { ...configuration, data: snapshot() } });
    await waitFor(() => { expect(result.current).toBeTypeOf('function'); });
    const reload = result.current!; unmount();
    await expect(reload()).rejects.toThrow(/capacidad/);
  });
  it('removes the callback when the authenticated session changes', async () => {
    const { api, configuration } = fixture(); const client = new CauceApi('http://localhost');
    vi.spyOn(client, 'getFleetCapability').mockImplementation(api.getFleetCapability);
    vi.spyOn(client, 'readNativePieces').mockImplementation(api.readNativePieces);
    let changed: () => void = () => undefined;
    vi.spyOn(client, 'onAuthGenerationChange').mockImplementation(listener => { changed = listener; return () => undefined; });
    const { result } = renderHook(() => useNativeReload('A', 'one', configuration, 'allowed'), {
      wrapper: ({ children }) => <ApiProvider api={client}>{children}</ApiProvider>,
    });
    await waitFor(() => { expect(result.current).toBeTypeOf('function'); });
    act(() => { changed(); });
    expect(result.current).toBeUndefined();
  });
  it('rejects a callback captured before changing aliases even when both targets remain in the snapshot', async () => {
    const { api, configuration } = fixture(); const client = new CauceApi('http://localhost');
    vi.spyOn(client, 'getFleetCapability').mockImplementation(api.getFleetCapability);
    vi.spyOn(client, 'readNativePieces').mockImplementation(api.readNativePieces);
    const enqueue = vi.spyOn(client, 'enqueueFleetOperation');
    const config = { ...configuration, data: { ...snapshot(), agents: [row, { ...row, alias: 'two' }] } };
    const { result, rerender } = renderHook(({ alias }) => useNativeReload('A', alias, config, 'allowed'), {
      initialProps: { alias: 'one' }, wrapper: ({ children }) => <ApiProvider api={client}>{children}</ApiProvider>,
    });
    await waitFor(() => { expect(result.current).toBeTypeOf('function'); });
    const stale = result.current!; rerender({ alias: 'two' });
    await act(async () => { await expect(stale()).rejects.toThrow(/capacidad/); });
    expect(enqueue).not.toHaveBeenCalled(); expect(configuration.reload).not.toHaveBeenCalled();
  });
});
