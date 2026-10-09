import { assignSlots } from './capacity';

export const SEATS_PER_POD = 4;

interface PodPolicy { min: number; spare: number; slack: number }

/** A group gets whole pods with a spare seat. */
export const GROUP_POLICY: PodPolicy = { min: 1, spare: 1, slack: 4 };

export function podsNeeded(count: number, policy: PodPolicy): number {
  return Math.max(policy.min, Math.ceil((count + policy.spare) / SEATS_PER_POD));
}

/** Grows only when the team no longer fits and shrinks only when its pods are far too many. */
export function nextPods(count: number, previous: number | undefined, policy: PodPolicy): number {
  const need = podsNeeded(count, policy);
  if (previous === undefined || count > previous * SEATS_PER_POD) return need;
  return (previous - need) * SEATS_PER_POD <= policy.slack ? previous : need;
}

export interface Seat { team: string; seat: number }
export interface SeatedTeam { id: string; ids: readonly string[]; pods: number }

/** Each agent keeps its seat inside its own team, whatever the other teams do. */
export function assignSeats(previous: ReadonlyMap<string, Seat>, teams: readonly SeatedTeam[]): Map<string, Seat> {
  const next = new Map<string, Seat>();
  for (const team of teams) {
    const size = team.pods * SEATS_PER_POD;
    const kept = new Map<string, number>();
    for (const id of team.ids) {
      const seat = previous.get(id);
      if (seat?.team === team.id) kept.set(id, seat.seat);
    }
    for (const [id, seat] of assignSlots(kept, team.ids, size)) next.set(id, { team: team.id, seat });
  }
  return next;
}
