import { describe, expect, it } from 'vitest';
import { ConfigChangeRequestSchema, ConfigMutationSchema } from '../src/schemas/configuration.js';

describe('configuration administration contract', () => {
  it.each([
    { resource: 'tenant', id: 'nuevo' },
    { resource: 'room', tenant_id: 'nuevo', id: 'nuevo-general' },
    { resource: 'membership', tenant_id: 'nuevo', room_id: 'nuevo-general', alias: 'agent_1' },
  ])('accepts retire and restore for $resource', (identity) => {
    for (const action of ['retire', 'restore']) {
      expect(ConfigMutationSchema.safeParse({ ...identity, action }).success).toBe(true);
    }
  });
  it('allows an atomic inverse restoring a ceiling and its bindings', () => {
    expect(ConfigMutationSchema.safeParse({ resource: 'batch', action: 'apply', mutations: [
      { resource: 'alias_routing_ceiling', action: 'create', tenant_id: 'nuevo', alias: 'worker', account_id: 'paid' },
      { resource: 'agent_account_binding', action: 'create', tenant_id: 'nuevo', agent_alias: 'worker', account_id: 'paid', value: { priority: 2, enabled: true } },
    ] }).success).toBe(true);
  });
  it('rejects nested or empty batches and retirement of runtime agents', () => {
    for (const mutation of [
      { resource: 'batch', action: 'apply', mutations: [] },
      { resource: 'batch', action: 'apply', mutations: [{ resource: 'batch', action: 'apply', mutations: [] }] },
      { resource: 'agent', action: 'retire', tenant_id: 'nuevo', alias: 'worker' },
    ]) expect(ConfigMutationSchema.safeParse(mutation).success).toBe(false);
  });
  it('accepts a 200-leaf durable inverse while keeping incoming requests capped at 100 leaves', () => {
    const mutations = Array.from({ length: 200 }, (_, i) => ({ resource: 'room', action: 'delete', tenant_id: 'Nuevo', id: `room-${String(i)}` }));
    const inverse = { resource: 'batch', action: 'apply', mutations };
    expect(ConfigMutationSchema.safeParse(inverse).success).toBe(true);
    expect(ConfigMutationSchema.safeParse({ ...inverse, mutations: [...mutations, mutations[0]] }).success).toBe(false);
    expect(ConfigChangeRequestSchema.safeParse({ mutation: inverse }).success).toBe(false);
    expect(ConfigChangeRequestSchema.safeParse({ mutation: { ...inverse, mutations: mutations.slice(0, 100) } }).success).toBe(true);
  });
});
