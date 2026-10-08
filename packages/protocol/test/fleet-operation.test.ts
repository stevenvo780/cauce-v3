import { describe, expect, it } from 'vitest';
import * as protocol from '../src/index.js';

const input = {
  kind: 'create', target: { resource: 'agent', tenant_id: 'Nuevo', alias: 'worker_1' },
  expected_revision: 1, idempotency_key: 'create-worker-1',
  parameters: {
    runtime_key: 'nuevo-worker-1', harness_id: 'codex', primary_room_id: 'nuevo-general',
    memberships: [{ room_id: 'nuevo-general', role: 'agent' }],
    placement: { host_id: 'kratos', mode: 'container', container_name: 'cauce-agents', runtime_user: 'dev',
      home_directory: '/home/dev', state_directory: '/home/dev/.cauce/nuevo-worker-1' },
  },
};

function valid(value: unknown): boolean {
  const schema = Reflect.get(protocol, 'FleetOperationRequestSchema') as { safeParse(value: unknown): { success: boolean } } | undefined;
  return schema?.safeParse(value).success ?? false;
}

describe('fleet operation request authority', () => {
  it('accepts a complete draft independent of routing admission', () => {
    expect(valid(input)).toBe(true);
  });
  it('accepts lifecycle actions without mutable configuration or credentials', () => {
    for (const kind of ['start', 'stop', 'retire', 'restore', 'purge']) {
      expect(valid({ ...input, kind, parameters: {} })).toBe(true);
    }
  });
  it('rejects arbitrary commands, provider secrets, relative paths and unsupported target actions', () => {
    for (const parameters of [
      { ...input.parameters, command: 'sudo sh' },
      { ...input.parameters, credential: 'secret-value' },
      { ...input.parameters, placement: { ...input.parameters.placement, state_directory: '/home/dev/../root' } },
      { ...input.parameters, placement: { ...input.parameters.placement, runtime_user: 'dev;root' } },
    ]) expect(valid({ ...input, parameters })).toBe(false);
    expect(valid({ ...input, kind: 'start', target: { resource: 'room', tenant_id: 'Nuevo', room_id: 'r' }, parameters: {} })).toBe(false);
  });
  it('rejects duplicated memberships and a primary room outside the memberships', () => {
    expect(valid({ ...input, parameters: { ...input.parameters, memberships: [...input.parameters.memberships, ...input.parameters.memberships] } })).toBe(false);
    expect(valid({ ...input, parameters: { ...input.parameters, primary_room_id: 'other' } })).toBe(false);
  });
});


describe('fleet effect and execution catalogue', () => {
  it('matches identical placements by the durable account provider without equating it to the harness', () => {
    const runtime = { mode: 'container' as const, harness_id: 'openclaw', provider: 'codex', runtime_user: 'dev',
      home_directory: '/home/dev', state_root: '/home/dev/.cauce', container_name: 'cauce-agents' };
    const capability: protocol.FleetCapability = { available: true, actions: ['create'], placements: [{ host_id: 'kratos',
      modes: ['container'], runtime_users: ['dev'], systemd_users: [], home_roots: ['/home/dev'],
      state_roots: ['/home/dev/.cauce'], runtimes: [runtime, { ...runtime, provider: 'gemini' }] }] };
    const request = protocol.FleetOperationRequestSchema.parse({ ...input, parameters: { ...input.parameters, harness_id: 'openclaw' } });
    expect(protocol.matchingFleetRuntime(capability, request)?.provider).toBe('codex');
    expect(protocol.matchingFleetRuntime(capability, request, 'gemini')?.provider).toBe('gemini');
    expect(protocol.matchingFleetRuntime(capability, request, 'unapproved')).toBeUndefined();
  });
  it('accepts checked stopping and revocation without process output', () => {
    expect(protocol.FleetEvidenceSchema.safeParse({ stopped_verified: true, revocation_verified: true }).success).toBe(true);
    expect(protocol.FleetEvidenceSchema.safeParse({ stdout: 'sensitive' }).success).toBe(false);
  });
  it('preserves membership intent and dynamic roles', () => {
    expect(valid({ ...input, parameters: { ...input.parameters, memberships: [{ room_id: 'nuevo-general', role: 'Custom role', enabled: false }] } })).toBe(true);
  });
});
