import { describe, expect, it } from 'vitest';
import { AGENT_PRIORITY_CEILING, HUMAN_CHAT_PRIORITY, HUMAN_PRIORITY_FLOOR } from '@cauce/protocol';
import type { Principal } from './auth.js';
import { isAttributedHuman, publishPriorityDecision } from './publish-priority-policy.js';

function principal(overrides: Partial<Principal> = {}): Principal {
  return {
    tenant_id: 'Steven', alias: 'kant', session_id: 'session', channel: 'console',
    roles: ['operator'], permissions: ['route'],
    ...overrides
  };
}

describe('publish priority authority', () => {
  it('does not confuse an operator role with authenticated human attribution', () => {
    const machineOperator = principal();
    expect(isAttributedHuman(machineOperator)).toBe(false);
    expect(publishPriorityDecision(machineOperator, 100, { interactiveHumanEntry: true }))
      .toEqual({ applied: AGENT_PRIORITY_CEILING, reason: 'agent_ceiling' });
  });

  it('raises an attributed console message into the human band even when the UI asks for 10', () => {
    const human = principal({ operator_id: 'opaque-authenticated-subject' });
    const decision = publishPriorityDecision(human, 10, { interactiveHumanEntry: true });
    expect(decision).toEqual({ applied: HUMAN_CHAT_PRIORITY, reason: 'human_entry_floor' });
    expect(decision.applied).toBeGreaterThanOrEqual(HUMAN_PRIORITY_FLOOR);
  });

  it('does not promote attributed batch/tooling publishes outside the interactive console', () => {
    const human = principal({ operator_id: 'opaque-authenticated-subject' });
    expect(publishPriorityDecision(human, 10, { interactiveHumanEntry: false }))
      .toEqual({ applied: 10, reason: 'unchanged' });
    expect(publishPriorityDecision(human, 100, { interactiveHumanEntry: false }))
      .toEqual({ applied: AGENT_PRIORITY_CEILING, reason: 'agent_ceiling' });
    expect(publishPriorityDecision(human, 100, { interactiveHumanEntry: true }))
      .toEqual({ applied: 100, reason: 'unchanged' });
  });

  it('keeps every non-attributed principal below the human floor on either surface', () => {
    for (const roles of [['agent'], ['adapter'], ['operator']] as const) {
      const actor = principal({ roles });
      for (const interactiveHumanEntry of [false, true]) {
        const decision = publishPriorityDecision(actor, 100, { interactiveHumanEntry });
        expect(decision.applied).toBeLessThan(HUMAN_PRIORITY_FLOOR);
      }
    }
  });
});
