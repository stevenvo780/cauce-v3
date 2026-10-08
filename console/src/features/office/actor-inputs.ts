import type { OfficeAgent } from './OfficeCanvas';
import type { ActorInput } from './simulation';

/** The simulation's view of the fleet: fleet agents sit at their kept desk, visitors wait at reception. */
export function actorInputs(
  agents: readonly OfficeAgent[], deskOf: ReadonlyMap<string, number>, waitOf: ReadonlyMap<string, number>,
): ActorInput[] {
  return agents.map((agent) => {
    const base = { id: agent.id, state: agent.state, sleepy: agent.state === 'idle' && agent.awake !== true };
    if (agent.visitor) return { ...base, desk: -1, visitor: true, wait: waitOf.get(agent.id) ?? 0 };
    return {
      ...base,
      desk: deskOf.get(agent.id) ?? 0,
      delegateDesk: agent.state === 'delegating'
        ? agent.delegatesTo.map((target) => deskOf.get(target)).find((desk) => desk !== undefined) ?? null
        : null,
    };
  });
}
