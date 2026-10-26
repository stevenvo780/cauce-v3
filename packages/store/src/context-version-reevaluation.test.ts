import { describe, expect, it } from 'vitest';
import { CONTEXT_ADOPTION_CAPABILITY, HarnessConsumptionEvidenceSchema, VERSIONED_CONTEXT_CAPABILITY } from '@cauce/protocol';
import { supportsVersionedContextApplication } from './context-version-reevaluation.js';

describe('versioned context readiness', () => {
  it.each(HarnessConsumptionEvidenceSchema.shape.harness_id.options)('accepts the consumption witness from %s when the adapter accredits adoption', harness => {
    expect(supportsVersionedContextApplication([VERSIONED_CONTEXT_CAPABILITY, CONTEXT_ADOPTION_CAPABILITY, `harness.${harness}`])).toBe(true);
  });
  it.each(['claude', 'codex'])('still trusts an adapter that predates the adoption capability for %s', harness => {
    expect(supportsVersionedContextApplication([VERSIONED_CONTEXT_CAPABILITY, `harness.${harness}`])).toBe(true);
  });
  it.each(['grok', 'muse', 'openclaw'])('refuses %s without the adoption capability: its runner or release may not witness turns', harness => {
    expect(supportsVersionedContextApplication([VERSIONED_CONTEXT_CAPABILITY, `harness.${harness}`])).toBe(false);
  });
  it.each([undefined, null, {}, VERSIONED_CONTEXT_CAPABILITY, [], [VERSIONED_CONTEXT_CAPABILITY], ['harness.codex'],
    [CONTEXT_ADOPTION_CAPABILITY, 'harness.codex'], [VERSIONED_CONTEXT_CAPABILITY, CONTEXT_ADOPTION_CAPABILITY],
    [VERSIONED_CONTEXT_CAPABILITY, 'harness.hermes'], [VERSIONED_CONTEXT_CAPABILITY, CONTEXT_ADOPTION_CAPABILITY, 'harness.hermes'],
    [VERSIONED_CONTEXT_CAPABILITY, { harness: 'codex' }]])(
    'requires both the context capability and a supported witness: %j', capabilities => {
      expect(supportsVersionedContextApplication(capabilities)).toBe(false);
    });
});
