import { describe, expect, it } from 'vitest';
import { HarnessConsumptionEvidenceSchema, VERSIONED_CONTEXT_CAPABILITY } from '@cauce/protocol';
import { supportsVersionedContextApplication } from './context-version-reevaluation.js';

describe('versioned context readiness', () => {
  it.each(HarnessConsumptionEvidenceSchema.shape.harness_id.options)('accepts the consumption witness from %s', harness => {
    expect(supportsVersionedContextApplication([VERSIONED_CONTEXT_CAPABILITY, `harness.${harness}`])).toBe(true);
  });
  it.each([undefined, null, {}, VERSIONED_CONTEXT_CAPABILITY, [], [VERSIONED_CONTEXT_CAPABILITY], ['harness.codex'],
    [VERSIONED_CONTEXT_CAPABILITY, 'harness.hermes'], [VERSIONED_CONTEXT_CAPABILITY, { harness: 'codex' }]])(
    'requires both the context capability and a supported witness: %j', capabilities => {
      expect(supportsVersionedContextApplication(capabilities)).toBe(false);
    });
});
