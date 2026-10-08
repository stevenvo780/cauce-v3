import { describe, expect, it, vi } from 'vitest';
import { assertFleetPlacement, assertFleetProviderAccount, configuredFleetCapability } from './fleet-capability.js';
import type { DatabasePool } from '@cauce/store';
import type { FleetCapability, FleetOperationRequest } from '@cauce/protocol';
const capability: FleetCapability = { available: true, actions: ['create', 'update', 'start', 'stop', 'retire', 'restore', 'purge'],
  placements: [{ host_id: 'isolated', modes: ['container'], runtime_users: ['dev'], systemd_users: [],
    home_roots: ['/home/dev'], state_roots: ['/home/dev/.cauce'] }] };
const request: FleetOperationRequest = { kind: 'create', target: { resource: 'agent', tenant_id: 'Nuevo', alias: 'new_agent' },
  expected_revision: 0, idempotency_key: 'create-new-agent', parameters: { runtime_key: 'new-agent', harness_id: 'codex',
    primary_room_id: 'room', memberships: [{ room_id: 'room', role: 'agent' }],
    placement: { host_id: 'isolated', mode: 'container', runtime_user: 'dev', container_name: 'isolated-runtime',
      home_directory: '/home/dev', state_directory: '/home/dev/.cauce/new-agent' } } };
describe('fleet execution capability', () => {
  it('resolves the account provider before selecting among identical approved placements', async () => {
    if (request.kind !== 'create') throw new Error('fixture');
    const runtime = { mode: 'container' as const, harness_id: 'openclaw', provider: 'codex', runtime_user: 'dev',
      home_directory: '/home/dev', state_root: '/home/dev/.cauce', container_name: 'isolated-runtime' };
    const catalog = { ...capability, placements: capability.placements.map(host => ({ ...host,
      runtimes: [runtime, { ...runtime, provider: 'gemini' }] })) };
    const approved = { ...request, parameters: { ...request.parameters, harness_id: 'openclaw', primary_account_id: 'gemini-account' } };
    const query = vi.fn().mockResolvedValue({ rows: [{ provider: 'gemini' }] });
    const pool = { query } as unknown as DatabasePool;
    await expect(assertFleetProviderAccount(pool, catalog, approved)).resolves.toBeUndefined();
    expect(query).toHaveBeenCalledWith(expect.stringMatching(/enabled AND \(payer_tenant_id=\$2 OR shared_with_pool\)/), ['gemini-account', 'Nuevo']);
    for (const rows of [[], [{ provider: 'unapproved' }], [{ provider: 'gemini' }, { provider: 'codex' }]]) {
      query.mockResolvedValueOnce({ rows });
      await expect(assertFleetProviderAccount(pool, catalog, approved)).rejects.toThrow('provider account');
    }
  });
  it('preflights approved templates and provider identity before allowing a durable operation', async () => {
    const catalog: FleetCapability = { ...capability, placements: capability.placements.map(host => ({ ...host, runtimes: [{
      mode: 'container', harness_id: 'codex', provider: 'codex', runtime_user: 'dev', home_directory: '/home/dev',
      state_root: '/home/dev/.cauce', container_prefix: 'isolated-', reasoning_efforts: ['low', 'high'],
    }] })) };
    if (request.kind !== 'create') throw new Error('fixture');
    const approved = { ...request, parameters: { ...request.parameters, primary_account_id: 'account',
      placement: { ...request.parameters.placement, container_name: 'isolated-new-agent' } } };
    expect(() => { assertFleetPlacement(catalog, approved); }).not.toThrow();
    for (const parameters of [{ ...approved.parameters, harness_id: 'unapproved' },
      { ...approved.parameters, reasoning_effort: 'max' as const },
      { ...approved.parameters, placement: { ...approved.parameters.placement, container_name: 'unapproved' } }]) {
      expect(() => { assertFleetPlacement(catalog, { ...approved, parameters }); }).toThrow('approved host templates');
    }
    const pool = (provider: string) => ({ query: async () => ({ rows: [{ provider }] }) }) as unknown as DatabasePool;
    await expect(assertFleetProviderAccount(pool('codex'), catalog, approved)).resolves.toBeUndefined();
    await expect(assertFleetProviderAccount(pool('claude'), catalog, approved)).rejects.toThrow('provider account');
    await expect(assertFleetProviderAccount(pool('codex'), catalog, { ...approved, parameters: {
      ...approved.parameters, primary_account_id: null } })).rejects.toThrow('explicit provider account');
  });
  it('disables execution until explicitly configured', () => {
    expect(configuredFleetCapability({})).toEqual({ available: false, actions: [], placements: [], reason: 'executor_unconfigured' });
    expect(() => configuredFleetCapability({ CAUCE_FLEET_OPERATIONS_ENABLED: 'yes' })).toThrow();
  });
  it('binds actor-selected placement to host users and one physical state directory', () => {
    expect(() => { assertFleetPlacement(capability, request); }).not.toThrow();
    if (request.kind !== 'create') throw new Error('invalid fixture');
    for (const patch of [{ host_id: 'other' }, { runtime_user: 'root' }, { systemd_user: 'root' },
      { home_directory: '/home/dev/other' }, { state_directory: '/home/dev/.cauce/other-agent' }]) {
      expect(() => { assertFleetPlacement(capability, { ...request, parameters: { ...request.parameters,
        placement: { ...request.parameters.placement, ...patch } } }); }).toThrow();
    }
  });
  it('fails closed when advertised actions are unavailable', () => {
    expect(() => { assertFleetPlacement({ available: false, actions: [], placements: [] }, request); }).toThrow();
  });
});
