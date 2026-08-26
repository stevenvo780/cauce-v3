import {
  AGENT_PRIORITY_CEILING, HUMAN_CHAT_PRIORITY, clampAgentPriority
} from '@cauce/protocol';
import type { Principal } from './auth.js';

export type PublishPriorityReason = 'unchanged' | 'agent_ceiling' | 'human_entry_floor';

export interface PublishPriorityDecision {
  readonly applied: number;
  readonly reason: PublishPriorityReason;
}

export interface PublishPriorityContext {
  /** True only for the interactive compose surface, never for batch or adapter ingress. */
  readonly interactiveHumanEntry: boolean;
}

/**
 * An operator role grants control operations; it does not prove that a person originated a
 * message.  Human-band authority additionally requires server-authenticated attribution.
 * Password and OIDC browser sessions set `operator_id`; machine mTLS/JWT principals do not unless
 * their trusted identity mapping explicitly says so.
 */
export function isAttributedHuman(principal: Principal): boolean {
  return principal.roles.includes('operator')
    && typeof principal.operator_id === 'string'
    && principal.operator_id.length > 0;
}

/** Pure policy used by both HTTP publish surfaces. */
export function publishPriorityDecision(
  principal: Principal,
  requested: number,
  context: PublishPriorityContext
): PublishPriorityDecision {
  if (!isAttributedHuman(principal) || !context.interactiveHumanEntry) {
    const applied = clampAgentPriority(requested);
    return { applied, reason: applied === requested ? 'unchanged' : 'agent_ceiling' };
  }

  if (requested < HUMAN_CHAT_PRIORITY) {
    return { applied: HUMAN_CHAT_PRIORITY, reason: 'human_entry_floor' };
  }
  return { applied: requested, reason: 'unchanged' };
}

export { AGENT_PRIORITY_CEILING, HUMAN_CHAT_PRIORITY };
