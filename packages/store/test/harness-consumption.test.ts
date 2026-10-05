import { describe, expect, it } from 'vitest';
import { withValidatedHarnessConsumption } from '../src/repository/deliveries/harness-consumption.js';

const evidence = {
  version: 1, harness_id: 'codex', native_session_id: 'session-a', native_turn_id: 'turn-a',
  input_sha256: 'a'.repeat(64), evidence_kind: 'canonical_final_response',
} as const;

describe('harness consumption authority', () => {
  it('retains a matching terminal witness without changing the reply', () => {
    const result = { output: { reply: 'answer' }, harness_consumption_v1: evidence };
    expect(withValidatedHarnessConsumption(result, 'codex', 'done')).toEqual(result);
  });

  it.each(['accepted', 'started', 'failed'])('does not treat %s as canonical final response', (status) => {
    expect(withValidatedHarnessConsumption({ harness_consumption_v1: evidence }, 'codex', status)).toBeUndefined();
  });

  it.each([
    { ...evidence, harness_id: 'claude' },
    { ...evidence, input_sha256: 'wrong' },
    { ...evidence, native_session_id: '/private/session.json' },
    { ...evidence, prompt: 'private input' },
    { ...evidence, evidence_kind: 'turn_started' },
    { ...evidence, native_turn_id: '' },
  ])('drops invalid authority while preserving the response: %j', (invalid) => {
    const output = { reply: 'answer' };
    expect(withValidatedHarnessConsumption({ output, harness_consumption_v1: invalid }, 'codex', 'done'))
      .toEqual({ output });
  });
});
