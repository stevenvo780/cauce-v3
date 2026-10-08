import { describe, expect, it } from 'vitest';
import { ConfigChangeRequestSchema } from '@cauce/protocol/configuration';
import type { ConfigLeafMutation, ConfigMutation, ConfigurationChangeResult } from '../../api/types';
import { exactConfigurationReceipt } from './config-receipt';

function ceiling(index: number, action: 'create' | 'delete'): ConfigLeafMutation {
  return { resource: 'alias_routing_ceiling', action, tenant_id: 'Steven', alias: 'jarvis', account_id: `account-${String(index)}` };
}

function batch(mutations: ConfigLeafMutation[]): ConfigMutation {
  return { resource: 'batch', action: 'apply', mutations };
}

const requested = batch(Array.from({ length: 100 }, (_, index) => ceiling(index, 'delete')));
const inverseLeaves = Array.from({ length: 100 }, (_, index): ConfigLeafMutation[] => [
  ceiling(index, 'create'),
  { resource: 'agent_account_binding', action: 'create', tenant_id: 'Steven', agent_alias: 'jarvis', account_id: `account-${String(index)}`,
    value: { priority: index, enabled: true } },
]).flat();
const inverse = batch(inverseLeaves);
const receipt: ConfigurationChangeResult = {
  applied: true, dry_run: false, revision: 8, rolled_back_revision_id: null,
  summary: 'delete ceilings and preserve bindings in the inverse', mutation: requested, inverse_mutation: inverse,
};

describe('expanded configuration batch receipts', () => {
  it('accepts 200 inverse leaves after a legitimate 100-leaf request', () => {
    expect(ConfigChangeRequestSchema.safeParse({ mutation: requested, dry_run: false, expected_revision: 7 }).success).toBe(true);
    expect(exactConfigurationReceipt(receipt, false, requested)).toBe(true);
  });

  it('accepts a rollback receipt whose applied mutation contains 200 inverse leaves', () => {
    expect(exactConfigurationReceipt({ ...receipt, rolled_back_revision_id: 7, mutation: inverse, inverse_mutation: requested }, false, undefined, 7)).toBe(true);
  });

  it('rejects any receipt batch exceeding 200 leaves', () => {
    const tooLarge = batch([...inverseLeaves, ceiling(101, 'create')]);
    expect(exactConfigurationReceipt({ ...receipt, inverse_mutation: tooLarge }, false, requested)).toBe(false);
    expect(exactConfigurationReceipt({ ...receipt, mutation: tooLarge }, false, tooLarge)).toBe(false);
  });

  it('keeps new configuration requests limited to 100 leaves', () => {
    expect(ConfigChangeRequestSchema.safeParse({ mutation: batch([...inverseLeaves.slice(0, 100), ceiling(101, 'create')]) }).success).toBe(false);
    expect(ConfigChangeRequestSchema.safeParse({ mutation: inverse }).success).toBe(false);
  });

  it.each([
    { resource: 'room', action: 'delete', tenant_id: 'Steven' },
    { resource: 'room', action: 'delete', tenant_id: 'Steven', id: 'group-a', command: 'unexpected' },
    { resource: 'provider_account', action: 'retire', id: 'account-a' },
    { resource: 'agent_account_binding', action: 'create', tenant_id: 'Steven', agent_alias: 'jarvis', account_id: 'account-a', value: { priority: -1 } },
    { resource: 'batch', action: 'apply', mutations: inverseLeaves },
  ])('does not credit malformed leaves or nested batches as a durable inverse', (invalid) => {
    const malformed = { resource: 'batch', action: 'apply', mutations: [invalid] } as ConfigMutation;
    expect(exactConfigurationReceipt({ ...receipt, inverse_mutation: malformed }, false, requested)).toBe(false);
  });
});
