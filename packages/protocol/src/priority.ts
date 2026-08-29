/**
 * Delivery queue priority policy.
 *
 * Priority bands:
 *   -100 .. 50   Agent band: automated traffic (self-assigned or inherited).
 *     51 .. 59   Reserved gap.
 *     60 .. 100  Human band: interactive human messages and operator escalations.
 */

/** Highest priority any agent-caused message may carry, self-assigned or inherited. */
export const AGENT_PRIORITY_CEILING = 50;

/** Minimum priority value for messages in the reserved human band. */
export const HUMAN_PRIORITY_FLOOR = 60;

/** Priority of an inbound chat message from an allowlisted human. */
export const HUMAN_CHAT_PRIORITY = 70;

/**
 * Clamps agent-originated priority to the allowed agent ceiling.
 */
export function clampAgentPriority(priority: number): number {
  if (!Number.isFinite(priority)) return 0;
  return Math.min(Math.trunc(priority), AGENT_PRIORITY_CEILING);
}
