import { useState } from 'react';
import { sameSlots } from './capacity';
import type { TeamSpec } from './team-layout';
import { GROUP_POLICY, PLAIN_POLICY, SEATS_PER_POD, assignSeats, deskIndexes, nextPods, sameSeats, type Seat } from './team-seats';
import { NO_TEAM, hasGroups, sameTeams, summarizeTeams, type OfficeTeam, type TeamSummary } from './teams';

interface PlanAgent { id: string; team?: OfficeTeam; visitor?: boolean }

export interface TeamPlan {
  teams: readonly TeamSummary[];
  /** Real groups exist: the work room gets one rug and sign per team. */
  zoned: boolean;
  specs: readonly TeamSpec[];
  seats: number;
  deskOf: ReadonlyMap<string, number>;
}

function useStable<T>(value: T, same: (a: T, b: T) => boolean): T {
  const [kept, setKept] = useState(value);
  if (same(kept, value)) return kept;
  setKept(value);
  return value;
}

const samePods = (a: ReadonlyMap<string, number>, b: ReadonlyMap<string, number>): boolean => sameSlots(a, b);
const sameSpecs = (a: readonly TeamSpec[], b: readonly TeamSpec[]): boolean => a.length === b.length
  && a.every((spec, index) => spec.id === b[index].id && spec.label === b[index].label && spec.hue === b[index].hue && spec.pods === b[index].pods);

/**
 * Pods and desks per team: a team grows by whole pods only when it no longer fits and every agent
 * keeps its seat inside its own team, so one team changing never moves another team's people.
 */
export function useTeamPlan(agents: readonly PlanAgent[]): TeamPlan {
  const summary = summarizeTeams(agents);
  const teams = useStable(summary.length > 0 ? summary : [{ ...NO_TEAM, hue: -1, ids: [] }], sameTeams);
  const zoned = hasGroups(teams);
  const policy = zoned ? GROUP_POLICY : PLAIN_POLICY;

  const [keptPods, setKeptPods] = useState<ReadonlyMap<string, number>>(() => new Map());
  const wanted = new Map(teams.map((team) => [team.id, nextPods(team.ids.length, keptPods.get(team.id), policy)]));
  const pods = samePods(keptPods, wanted) ? keptPods : wanted;
  if (pods !== keptPods) setKeptPods(pods);

  const seated = teams.map((team) => ({ id: team.id, ids: team.ids, pods: pods.get(team.id) ?? 1 }));
  const [keptSeats, setKeptSeats] = useState<ReadonlyMap<string, Seat>>(() => new Map());
  const assigned = assignSeats(keptSeats, seated);
  const seats = sameSeats(keptSeats, assigned) ? keptSeats : assigned;
  if (seats !== keptSeats) setKeptSeats(seats);

  const deskOf = useStable<ReadonlyMap<string, number>>(deskIndexes(seated, seats), sameSlots);
  const specs = useStable<readonly TeamSpec[]>(
    teams.map((team, index) => ({ id: team.id, label: team.label, hue: team.hue, pods: seated[index].pods })),
    sameSpecs,
  );
  return { teams, zoned, specs, seats: specs.reduce((sum, spec) => sum + spec.pods, 0) * SEATS_PER_POD, deskOf };
}
