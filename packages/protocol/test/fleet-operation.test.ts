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
  const schema = Reflect.get(protocol, 'FleetOperationSubmissionSchema') as { safeParse(value: unknown): { success: boolean } } | undefined;
  return schema?.safeParse(value).success ?? false;
}

describe('fleet operation request authority', () => {
  it('accepts a complete draft independent of routing admission', () => {
    expect(valid(input)).toBe(true);
  });
  it('accepts lifecycle actions without mutable configuration or credentials', () => {
    for (const kind of ['start', 'stop', 'retire', 'restore', 'purge']) {
      expect(valid({ ...input, kind, parameters: kind === 'purge' ? { confirm_alias: 'worker_1' } : {} })).toBe(true);
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
  it('projects only reasoning efforts supported by the exact harness and runtime', () => {
    const base = { mode: 'container' as const, provider: 'muse', runtime_user: 'dev', home_directory: '/home/dev',
      state_root: '/home/dev/.cauce', container_name: 'cauce-agents' };
    const efforts = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    for (const reasoning_effort of efforts) {
      for (const kind of ['create', 'update']) expect(valid({ ...input, kind,
        parameters: { ...input.parameters, harness_id: 'muse', reasoning_effort } })).toBe(true);
    }
    expect(protocol.FleetRuntimeCapabilitySchema.safeParse({ ...base, harness_id: 'muse', reasoning_efforts: efforts }).success).toBe(true);
    expect(protocol.FleetRuntimeCapabilitySchema.safeParse({ ...base, harness_id: 'grok', reasoning_efforts: [] }).success).toBe(true);
    expect(valid({ ...input, parameters: { ...input.parameters, harness_id: 'grok', reasoning_effort: 'high' } })).toBe(false);
    expect(protocol.FleetRuntimeCapabilitySchema.safeParse({ ...base, harness_id: 'grok', reasoning_efforts: ['high'] }).success).toBe(false);
    for (const harness_id of ['codex', 'claude', 'openclaw']) {
      for (const reasoning_effort of ['none', 'ultra']) {
        expect(valid({ ...input, parameters: { ...input.parameters, harness_id, reasoning_effort } })).toBe(false);
        expect(protocol.FleetRuntimeCapabilitySchema.safeParse({ ...base, harness_id, reasoning_efforts: [reasoning_effort] }).success).toBe(false);
      }
    }
  });
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
  it('lists only the resources a purge actually removed', () => {
    expect(protocol.FleetEvidenceSchema.safeParse({
      stopped_verified: true, revocation_verified: true, native_decommissioned: true,
      removed: [{ type: 'container', name: 'ws-w' }, { type: 'volume', name: 'ws-w-state' }, { type: 'network', name: 'n' },
        { type: 'unit', name: 'cauce-v3-alias-w.service' }, { type: 'file', name: '/home/dev/.config/systemd/user/cauce-v3-alias-w.service' }],
    }).success).toBe(true);
    expect(protocol.FleetEvidenceSchema.safeParse({ removed: [] }).success).toBe(true);
    expect(protocol.FleetEvidenceSchema.safeParse({ removed: Array.from({ length: 600 }, (_, index) => ({ type: 'unit', name: `cauce-v3-alias-w${String(index)}.service` })) }).success).toBe(true);
    expect(protocol.FleetEvidenceSchema.safeParse({ removed: [{ type: 'secret', name: 'n' }] }).success).toBe(false);
    expect(protocol.FleetEvidenceSchema.safeParse({ removed: [{ type: 'volume', name: 'v', action: 'delete' }] }).success).toBe(false);
  });
  it('preserves membership intent and dynamic roles', () => {
    expect(valid({ ...input, parameters: { ...input.parameters, memberships: [{ room_id: 'nuevo-general', role: 'Custom role', enabled: false }] } })).toBe(true);
  });
});

describe('fleet purge preview resources', () => {
  const preview = {
    request_sha256: 'a'.repeat(64), expected_revision: 1, target: { resource: 'agent', tenant_id: 'Nuevo', alias: 'worker_1' },
    kind: 'purge', steps: ['fence'], dependencies: [], can_apply: true,
  };
  const parse = (value: unknown) => (Reflect.get(protocol, 'FleetOperationPreviewSchema') as { safeParse(value: unknown): { success: boolean; data?: { resources: unknown[] } } }).safeParse(value);
  it('lists the planned physical resources with action and reason, and defaults to none', () => {
    const resources = [{ type: 'container', name: 'cauce-x', action: 'delete', reason: 'propio' },
      { type: 'volume', name: 'cauce-x-state', action: 'keep', reason: 'otro dueño' }, { type: 'network', name: 'n', action: 'delete', reason: 'propia' }];
    expect(parse({ ...preview, resources }).data?.resources).toEqual(resources);
    expect(parse(preview).data?.resources).toEqual([]);
  });
  it('rejects unknown resource types, actions and extra fields', () => {
    for (const resource of [{ type: 'secret', name: 'n', action: 'delete', reason: 'r' }, { type: 'volume', name: 'v', action: 'drop', reason: 'r' },
      { type: 'volume', name: 'v', action: 'delete', reason: 'r', extra: 1 }]) expect(parse({ ...preview, resources: [resource] }).success).toBe(false);
  });
});
