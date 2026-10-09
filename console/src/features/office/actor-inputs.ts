import { SHARED_IDS } from './interior-shared';
import type { OfficeAgent } from './office-agent';
import type { ActorInput } from './simulation';

/** The simulation's view of the fleet: agents sit at their kept desk in their group's house, visitors wait at reception. */
export function actorInputs(
  agents: readonly OfficeAgent[], homeOf: ReadonlyMap<string, string>, deskOf: ReadonlyMap<string, number>, waitOf: ReadonlyMap<string, number>,
): ActorInput[] {
  return agents.map((agent) => {
    const base = { id: agent.id, state: agent.state, sleepy: agent.state === 'idle' && agent.awake !== true };
    if (agent.visitor) return { ...base, home: SHARED_IDS.lobby, desk: -1, visitor: true, wait: waitOf.get(agent.id) ?? 0 };
    return {
      ...base,
      home: homeOf.get(agent.id) ?? SHARED_IDS.lobby,
      desk: deskOf.get(agent.id) ?? 0,
      sends: agent.sends ?? agent.delegatesTo.map((to) => ({ to, id: `${agent.id}>${to}` })),
    };
  });
}
