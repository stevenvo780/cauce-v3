import { describe, expect, it } from 'vitest';
import { alongRoute, buildCampus, capsuleRoute, footprint, routeLength, type Campus, type SiteSpec } from './campus';
import { CORE, lotCell, sameCell } from './campus-lots';
import { createPlanMemory, nextPhaseEnd, planCampus, type PlanAgent, type PlanGroup } from './campus-plan';
import { TILE } from './level';
import { findCheapestPath } from './pathfinding';
import { buildWorldMap, groupLevelId } from './world-map';

const group = (id: string, hue = 100): PlanGroup => ({ id, label: id, hue });
const member = (id: string, team: string, state: PlanAgent['state'] = 'thinking'): PlanAgent => ({ id, state, team: { id: team, label: team } });
const siteOf = (campus: Campus, id: string) => {
  const site = campus.siteOf.get(id);
  if (!site) throw new Error(`no site ${id}`);
  return site;
};

describe('campus lots', () => {
  it('hand out every lot once, never the core around the plaza, nearest rings first', () => {
    const cells = Array.from({ length: 40 }, (_, index) => lotCell(index));
    expect(new Set(cells.map((cell) => `${String(cell.c)},${String(cell.r)}`)).size).toBe(40);
    for (const cell of cells) {
      expect(Object.values(CORE).some((core) => sameCell(core, cell))).toBe(false);
      expect(cell.r).toBeGreaterThanOrEqual(0);
    }
    expect(lotCell(0)).toEqual({ c: 0, r: 2 });
    const ring = (index: number) => Math.max(Math.abs(lotCell(index).c) - 1, lotCell(index).r - 1);
    for (let index = 1; index < 40; index += 1) expect(ring(index)).toBeGreaterThanOrEqual(ring(index - 1));
    expect(lotCell(7)).toEqual(lotCell(7));
  });
});

describe('the campus map', () => {
  const specs = (count: number): SiteSpec[] => Array.from({ length: count }, (_, index) => ({
    id: `grupo:g${String(index)}`, kind: 'group' as const, label: `g${String(index)}`, hue: index * 40, cell: lotCell(index), seats: 4 + index,
  }));

  it('opens every door onto the streets: from the gate a walker reaches every house', () => {
    for (const count of [1, 5, 20]) {
      const campus = buildWorldMap({ groups: specs(count).map((spec) => ({ ...spec, id: spec.label })), beds: 4, pods: 2 }).campus;
      expect(campus.sites).toHaveLength(count + 5);
      for (const site of campus.sites) {
        expect(findCheapestPath(campus.walkable, campus.cost ?? new Uint8Array(), campus.cols, campus.door.tile, site.door.tile), `${site.id} of ${String(count)}`).not.toBeNull();
      }
      expect(findCheapestPath(campus.walkable, campus.cost ?? new Uint8Array(), campus.cols, campus.door.tile, campus.stop.tile)).not.toBeNull();
    }
  });

  it('keeps houses where they were when a group is added further out: only the whole campus slides', () => {
    const before = buildCampus(specs(4));
    const after = buildCampus(specs(12));
    for (const site of before.sites) {
      const moved = siteOf(after, site.id);
      expect(moved.x - after.plaza.x).toBe(site.x - before.plaza.x);
      expect(moved.y - after.plaza.y).toBe(site.y - before.plaza.y);
    }
    expect(after.cols).toBeGreaterThan(before.cols);
  });

  it('runs a tube from every group house to the hub, along the streets in straight lines', () => {
    const campus = buildCampus(specs(6));
    for (const site of campus.sites.filter((item) => item.kind === 'group')) {
      const tube = campus.tubes.get(site.id);
      expect(tube?.[0]).toEqual(site.outlet);
      for (let index = 1; index < (tube?.length ?? 0); index += 1) {
        const a = tube?.[index - 1];
        const b = tube?.[index];
        expect(a?.x === b?.x || a?.y === b?.y).toBe(true);
      }
    }
    expect(campus.tubes.size).toBe(6);
    const route = capsuleRoute(campus, 'grupo:g0', 'grupo:g3');
    expect(route?.[0]).toEqual(siteOf(campus, 'grupo:g0').outlet);
    expect(route?.at(-1)).toEqual(siteOf(campus, 'grupo:g3').outlet);
    expect(route).toContainEqual(campus.hub);
    const length = routeLength(route ?? []);
    const point = alongRoute(route ?? [], length / 2, { x: 0, y: 0 });
    expect(Number.isFinite(point.x)).toBe(true);
    expect(alongRoute(route ?? [], length + 50, { x: 0, y: 0 })).toEqual(route?.at(-1));
  });

  it('builds houses to the size of their group', () => {
    expect(footprint('group', 4).w).toBeLessThan(footprint('group', 16).w);
    const campus = buildCampus([{ id: 'grupo:a', kind: 'group', label: 'a', hue: 0, cell: lotCell(0), seats: 16 }]);
    const site = siteOf(campus, 'grupo:a');
    expect(site.w * TILE).toBeGreaterThanOrEqual(144);
    expect(campus.walkable[site.door.tile.y * campus.cols + site.door.tile.x]).toBe(true);
    expect(campus.walkable[site.y * campus.cols + site.x]).toBe(false);
  });
});

describe('planning the campus over time', () => {
  it('keeps every group on its lot and every agent at its desk when groups come and go', () => {
    const memory = createPlanMemory();
    const agents = [member('t/a', 'grp.a'), member('t/b', 'grp.b'), member('t/c', 'grp.a')];
    const first = planCampus(memory, agents, [group('grp.a'), group('grp.b')], 1_000);
    const lot = (plan: typeof first, id: string) => plan.groups.find((item) => item.id === id)?.cell;
    expect(first.groups.every((item) => item.phase === undefined)).toBe(true);
    expect(first.homeOf.get('t/a')).toBe(groupLevelId('grp.a'));
    const desks = new Map(first.deskOf);

    const grown = planCampus(memory, [...agents, member('t/d', 'grp.c')], [group('grp.a'), group('grp.b'), group('grp.c')], 1_010);
    expect(lot(grown, 'grp.a')).toEqual(lot(first, 'grp.a'));
    expect(lot(grown, 'grp.b')).toEqual(lot(first, 'grp.b'));
    expect(grown.groups.find((item) => item.id === 'grp.c')?.phase).toEqual({ kind: 'build', since: 1_010 });
    for (const [id, desk] of desks) expect(grown.deskOf.get(id)).toBe(desk);

    const shrunk = planCampus(memory, agents.filter((agent) => agent.team?.id === 'grp.a'), [group('grp.a'), group('grp.c')], 1_020);
    expect(shrunk.groups.find((item) => item.id === 'grp.b')?.phase).toEqual({ kind: 'demolish', since: 1_020 });
    expect(lot(shrunk, 'grp.b')).toEqual(lot(first, 'grp.b'));
    expect(nextPhaseEnd(memory, 1_020)).toBeGreaterThan(0);
    const later = planCampus(memory, agents.filter((agent) => agent.team?.id === 'grp.a'), [group('grp.a'), group('grp.c'), group('grp.d')], 1_040);
    expect(later.groups.some((item) => item.id === 'grp.b')).toBe(false);
    expect(lot(later, 'grp.d')).toEqual(lot(first, 'grp.b'));
    expect(lot(later, 'grp.a')).toEqual(lot(first, 'grp.a'));
  });

  it('gives a group whole pods with headroom, grows them only when full and puts the groupless in their own house', () => {
    const memory = createPlanMemory();
    const crew = (count: number) => Array.from({ length: count }, (_, index) => member(`t/m${String(index)}`, 'grp.a'));
    const seatsOf = (plan: ReturnType<typeof planCampus>) => plan.groups.find((item) => item.id === 'grp.a')?.seats;
    expect(seatsOf(planCampus(memory, crew(3), [group('grp.a')], 0))).toBe(4);
    expect(seatsOf(planCampus(memory, crew(4), [group('grp.a')], 1))).toBe(4);
    expect(seatsOf(planCampus(memory, crew(5), [group('grp.a')], 1))).toBe(8);
    expect(seatsOf(planCampus(memory, crew(3), [group('grp.a')], 2))).toBe(8);
    const loose = planCampus(memory, [...crew(3), { id: 't/solo', state: 'idle' }], [group('grp.a')], 3);
    expect(loose.homeOf.get('t/solo')).toBe(groupLevelId('~sin-grupo'));
  });

  it('sizes the residence and the workshop to the fleet without rebuilding them on every change', () => {
    const memory = createPlanMemory();
    const crew = (count: number, down: number) => Array.from({ length: count }, (_, index) => member(`t/m${String(index)}`, 'grp.a', index < down ? 'down' : 'idle'));
    const first = planCampus(memory, crew(12, 1), [group('grp.a')], 0).plan;
    expect(first.beds).toBeGreaterThanOrEqual(4);
    expect(first.pods).toBe(2);
    const again = planCampus(memory, crew(11, 0), [group('grp.a')], 1).plan;
    expect(again.beds).toBe(first.beds);
    expect(again.pods).toBe(first.pods);
    expect(planCampus(memory, crew(11, 5), [group('grp.a')], 2).plan.pods).toBe(6);
  });

  it('hands back the same plan when a poll only moves states, and a new one when the layout changes', () => {
    const memory = createPlanMemory();
    const crew = [member('t/a', 'grp.a'), member('t/b', 'grp.a')];
    const first = planCampus(memory, crew, [group('grp.a')], 0);
    const polled = planCampus(memory, [member('t/a', 'grp.a', 'idle'), member('t/b', 'grp.a', 'blocked')], [group('grp.a')], 1);
    expect(polled).toBe(first);
    const joined = planCampus(memory, [...crew, member('t/c', 'grp.a')], [group('grp.a')], 2);
    expect(joined).not.toBe(first);
    expect(joined.homeOf.get('t/c')).toBe(groupLevelId('grp.a'));
    const renamed = planCampus(memory, [...crew, member('t/c', 'grp.a')], [{ id: 'grp.a', label: 'Equipo A', hue: 100 }], 3);
    expect(renamed).not.toBe(joined);
    expect(renamed.groups[0].label).toBe('Equipo A');
  });
});
