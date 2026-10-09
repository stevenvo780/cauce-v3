import { buildCampus, type Campus, type Phase, type SiteSpec } from './campus';
import { CORE, type Cell } from './campus-lots';
import { buildGroupRoom } from './interior';
import { buildPark } from './interior-park';
import { SHARED_IDS, SHARED_LABELS, buildCafe, buildDorm, buildLobby, buildShop, type SharedKind } from './interior-shared';
import { CAMPUS, type Level } from './level';
import { routinePools, type RoutinePools } from './routine';

export interface GroupPlan {
  /** Group (room) id from the topology. */
  id: string;
  label: string;
  hue: number;
  seats: number;
  cell: Cell;
  phase?: Phase;
}

export interface WorldPlan {
  groups: readonly GroupPlan[];
  beds: number;
  pods: number;
}

export interface WorldMap {
  campus: Campus;
  levels: ReadonlyMap<string, Level>;
  pools: RoutinePools;
  plan: WorldPlan;
}

export const groupLevelId = (groupId: string) => `grupo:${groupId}`;
export const SHARED_ORDER: readonly SharedKind[] = ['lobby', 'cafe', 'park', 'shop', 'dorm'];

/** Shared buildings first in the campus specs so their lots never depend on the groups. */
function sharedSpecs(): SiteSpec[] {
  return SHARED_ORDER.map((kind) => ({ id: SHARED_IDS[kind], kind, label: SHARED_LABELS[kind], hue: -1, cell: CORE[kind], seats: 0 }));
}

const sameGroup = (a: GroupPlan | undefined, b: GroupPlan) => a?.seats === b.seats && a.label === b.label && a.hue === b.hue;

/**
 * Every map of the world: the campus and one interior per building. Interiors whose shape did not
 * change are reused from `previous`, so people inside them keep walking.
 */
export function buildWorldMap(plan: WorldPlan, previous: WorldMap | null = null): WorldMap {
  const levels = new Map<string, Level>();
  const reuse = (id: string, same: boolean, build: () => Level) => {
    const old = previous?.levels.get(id);
    levels.set(id, old && same ? old : build());
  };
  const before = new Map(previous?.plan.groups.map((group) => [group.id, group]));
  reuse(SHARED_IDS.cafe, true, buildCafe);
  reuse(SHARED_IDS.park, true, buildPark);
  reuse(SHARED_IDS.lobby, true, buildLobby);
  reuse(SHARED_IDS.dorm, previous?.plan.beds === plan.beds, () => buildDorm(plan.beds));
  reuse(SHARED_IDS.shop, previous?.plan.pods === plan.pods, () => buildShop(plan.pods));
  for (const group of plan.groups) {
    const id = groupLevelId(group.id);
    reuse(id, sameGroup(before.get(group.id), group), () => buildGroupRoom({ id, label: group.label, hue: group.hue, seats: group.seats }));
  }
  const specs: SiteSpec[] = [
    ...sharedSpecs(),
    ...plan.groups.map((group): SiteSpec => ({
      id: groupLevelId(group.id), kind: 'group', label: group.label, hue: group.hue, cell: group.cell, seats: group.seats,
      ...(group.phase ? { phase: group.phase } : {}),
    })),
  ];
  const campus = buildCampus(specs);
  levels.set(CAMPUS, campus);
  const pools = previous && levels.get(SHARED_IDS.cafe) === previous.levels.get(SHARED_IDS.cafe)
    && levels.get(SHARED_IDS.park) === previous.levels.get(SHARED_IDS.park) && levels.get(SHARED_IDS.dorm) === previous.levels.get(SHARED_IDS.dorm)
    ? previous.pools
    : routinePools([SHARED_IDS.cafe, SHARED_IDS.park, SHARED_IDS.dorm].flatMap((id) => levels.get(id) ?? []));
  return { campus, levels, pools, plan };
}

export function levelOf(map: WorldMap, id: string): Level | undefined {
  return map.levels.get(id);
}
