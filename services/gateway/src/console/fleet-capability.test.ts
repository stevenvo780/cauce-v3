import { describe, expect, it } from 'vitest';
import { assertFleetPlacement, configuredFleetCapability } from './fleet-capability.js';
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
  it('disables execution until explicitly configured', () => {
    expect(configuredFleetCapability({})).toEqual({ available: false, actions: [], placements: [], reason: 'executor_unconfigured' });
    expect(() => configuredFleetCapability({ CAUCE_FLEET_OPERATIONS_ENABLED: 'yes' })).toThrow();
  });
  it('binds actor-selected placement to host users and one physical state directory', () => {
    expect(() => assertFleetPlacement(capability, request)).not.toThrow();
    if (request.kind !== 'create') throw new Error('invalid fixture');
    for (const patch of [{ host_id: 'other' }, { runtime_user: 'root' }, { systemd_user: 'root' },
      { home_directory: '/home/dev/other' }, { state_directory: '/home/dev/.cauce/other-agent' }]) {
      expect(() => assertFleetPlacement(capability, { ...request, parameters: { ...request.parameters,
        placement: { ...request.parameters.placement, ...patch } } })).toThrow();
    }
  });
  it('fails closed when advertised actions are unavailable', () => {
    expect(() => assertFleetPlacement({ available: false, actions: [], placements: [] }, request)).toThrow();
  });
});
