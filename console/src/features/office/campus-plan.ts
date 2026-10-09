import type { LiveState } from '../live/agent-state';
import { lotCell } from './campus-lots';
import { assignSlots } from './capacity';
import { BUILD_S, DEMOLISH_S } from './render-buildings';
import { SLEEP_SHARE } from './routine';
import { GROUP_POLICY, SEATS_PER_POD, assignSeats, nextPods, type Seat } from './team-seats';
import { NO_TEAM, teamHue, type OfficeTeam } from './teams';
import { groupLevelId, type GroupPlan, type WorldPlan } from './world-map';

export interface PlanGroup { id: string; label: string; hue: number }

export interface PlanAgent { id: string; state: LiveState; team?: OfficeTeam; visitor?: boolean }

export interface CampusPlan {
  plan: WorldPlan;
  /** Level id of the building each fleet agent works in. */
  homeOf: ReadonlyMap<string, string>;
  deskOf: ReadonlyMap<string, number>;
  /** Group buildings in a stable order: the topology's, then any group only the agents name. */
  groups: readonly GroupPlan[];
}

interface Retired { group: PlanGroup; pods: number; since: number }

export interface PlanMemory {
  lots: Map<string, number>;
  pods: Map<string, number>;
  seats: ReadonlyMap<string, Seat>;
  known: Set<string>;
  born: Map<string, number>;
  retired: Map<string, Retired>;
  present: Map<string, PlanGroup>;
  populated: boolean;
  beds: number;
  repair: number;
  last: { key: string; plan: CampusPlan } | null;
}

export const createPlanMemory = (): PlanMemory => ({
  lots: new Map(), pods: new Map(), seats: new Map(), known: new Set(), born: new Map(), retired: new Map(), present: new Map(),
  populated: false, beds: 0, repair: 0, last: null,
});

function keyOf(groups: readonly GroupPlan[], seats: ReadonlyMap<string, Seat>, beds: number, repair: number): string {
  const parts = [String(beds), String(repair)];
  for (const group of groups) parts.push(`${group.id}\u0001${group.label}\u0001${String(group.hue)}\u0001${String(group.seats)}\u0001${String(group.cell.c)},${String(group.cell.r)}\u0001${group.phase ? `${group.phase.kind}@${String(group.phase.since)}` : ''}`);
  for (const [id, seat] of seats) parts.push(`${id}\u0001${seat.team}\u0001${String(seat.seat)}`);
  return parts.join('\u0002');
}

/** Grows to `need` at once and only shrinks once the spare passes `slack`. */
function hysteresis(kept: number, need: number, slack: number): number {
  return kept >= need && kept - need <= slack ? kept : need;
}

/**
 * Where everything goes on the campus. Every group keeps its lot, its pods and its people keep
 * their desks across updates; a new group's house goes up, a removed one comes down before its lot
 * is freed. `now` is wall-clock seconds. While nothing in the layout changes (a poll that only
 * moves states) it hands back the same plan object, so the map is not rebuilt.
 */
export function planCampus(memory: PlanMemory, agents: readonly PlanAgent[], directory: readonly PlanGroup[], now: number): CampusPlan {
  const fleet = agents.filter((agent) => !agent.visitor);
  const members = new Map<string, string[]>();
  const named = new Map<string, PlanGroup>();
  for (const group of directory) {
    members.set(group.id, []);
    named.set(group.id, group);
  }
  for (const agent of fleet) {
    const team = agent.team ?? NO_TEAM;
    if (!named.has(team.id)) named.set(team.id, { id: team.id, label: team.label, hue: team.hue ?? teamHue(team.id) });
    const list = members.get(team.id) ?? [];
    list.push(agent.id);
    members.set(team.id, list);
  }
  const live = [...named.values()];
  const liveIds = new Set(live.map((group) => group.id));
  const fresh = !memory.populated;
  for (const [id, group] of memory.present) {
    if (!liveIds.has(id) && !memory.retired.has(id)) memory.retired.set(id, { group, pods: memory.pods.get(id) ?? 1, since: now });
  }
  for (const [id, retired] of memory.retired) if (liveIds.has(id) || now - retired.since > DEMOLISH_S) memory.retired.delete(id);
  for (const group of live) {
    if (!memory.known.has(group.id) && !fresh) memory.born.set(group.id, now);
    memory.known.add(group.id);
  }
  for (const [id, since] of memory.born) if (now - since > BUILD_S) memory.born.delete(id);
  memory.present = new Map(live.map((group) => [group.id, group]));

  memory.lots = assignSlots(memory.lots, [...liveIds, ...memory.retired.keys()]);
  const pods = new Map<string, number>();
  for (const group of live) pods.set(group.id, nextPods(members.get(group.id)?.length ?? 0, memory.pods.get(group.id), GROUP_POLICY));
  memory.pods = pods;
  const teams = live.map((group) => ({ id: group.id, ids: [...(members.get(group.id) ?? [])].sort(), pods: pods.get(group.id) ?? 1 }));
  memory.seats = assignSeats(memory.seats, teams);

  const groups: GroupPlan[] = [
    ...live.map((group): GroupPlan => {
      const since = memory.born.get(group.id);
      return {
        ...group, seats: (pods.get(group.id) ?? 1) * SEATS_PER_POD, cell: lotCell(memory.lots.get(group.id) ?? 0),
        ...(since === undefined ? {} : { phase: { kind: 'build' as const, since } }),
      };
    }),
    ...[...memory.retired.values()].map((retired): GroupPlan => ({
      ...retired.group, seats: retired.pods * SEATS_PER_POD, cell: lotCell(memory.lots.get(retired.group.id) ?? 0),
      phase: { kind: 'demolish', since: retired.since },
    })),
  ];
  const homeOf = new Map<string, string>();
  const deskOf = new Map<string, number>();
  for (const [id, seat] of memory.seats) {
    homeOf.set(id, groupLevelId(seat.team));
    deskOf.set(id, seat.seat);
  }
  const down = fleet.filter((agent) => agent.state === 'down').length;
  memory.beds = hysteresis(memory.beds, Math.max(3, Math.ceil(fleet.length * SLEEP_SHARE) + 1), 4);
  memory.repair = hysteresis(memory.repair, Math.max(2, down + 1), 3);
  if (fleet.length > 0 || directory.length > 0) memory.populated = true;
  const key = keyOf(groups, memory.seats, memory.beds, memory.repair);
  if (memory.last?.key === key) return memory.last.plan;
  const plan: CampusPlan = { plan: { groups, beds: memory.beds, pods: memory.repair }, homeOf, deskOf, groups };
  memory.last = { key, plan };
  return plan;
}

/** Seconds until the next phase in the plan ends, or `null` when nothing is being built or demolished. */
export function nextPhaseEnd(memory: PlanMemory, now: number): number | null {
  const ends = [
    ...[...memory.retired.values()].map((retired) => retired.since + DEMOLISH_S - now),
    ...[...memory.born.values()].map((since) => since + BUILD_S - now),
  ].filter((left) => left > 0);
  return ends.length > 0 ? Math.min(...ends) : null;
}
