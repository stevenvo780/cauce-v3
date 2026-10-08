import { describe, expect, it } from 'vitest';
import { TILE, buildLayout, chooseLayout, type LayoutParams } from './layout';
import { findPath } from './pathfinding';
import { teamArea, type TeamSpec } from './team-layout';
import { GROUP_POLICY, SEATS_PER_POD, assignSeats, deskIndexes, nextPods, podsNeeded, type SeatedTeam } from './team-seats';

const spec = (id: string, pods: number): TeamSpec => ({ id, label: id, hue: 120, pods });
const params = (teams: TeamSpec[], overrides: Partial<LayoutParams> = {}): LayoutParams => {
  const pods = teams.reduce((sum, team) => sum + team.pods, 0);
  return { pods, podCols: 2, side: 'right', compact: false, beds: pods * SEATS_PER_POD, teams, ...overrides };
};

describe('team zones', () => {
  it('clusters each team desks inside its own rug, under its sign', () => {
    for (const compact of [false, true]) for (const side of ['right', 'bottom'] as const) {
      const teams = [spec('grp.a', 1), spec('grp.b', 3), spec('grp.c', 2)];
      const layout = buildLayout(params(teams, { compact, side }));
      expect(layout.desks).toHaveLength(6 * SEATS_PER_POD);
      expect(layout.teams.map((team) => team.id)).toEqual(['grp.a', 'grp.b', 'grp.c']);
      for (const team of layout.teams) {
        expect(team.sign.y + 1).toBe(team.rug.y);
        expect(team.sign.x).toBeGreaterThanOrEqual(team.rug.x);
        for (const desk of layout.desks.slice(team.firstDesk, team.firstDesk + team.desks)) {
          expect(desk.x).toBeGreaterThanOrEqual(team.rug.x);
          expect(desk.x + 2).toBeLessThanOrEqual(team.rug.x + team.rug.w);
          expect(desk.chairY).toBeGreaterThan(team.rug.y);
          expect(desk.chairY).toBeLessThan(team.rug.y + team.rug.h);
        }
      }
      const [a, b] = layout.teams;
      const overlap = a.rug.x < b.rug.x + b.rug.w && b.rug.x < a.rug.x + a.rug.w && a.rug.y < b.rug.y + b.rug.h && b.rug.y < a.rug.y + a.rug.h;
      expect(overlap).toBe(false);
    }
  });

  it('keeps every seat and visiting spot reachable from the door', () => {
    const layout = buildLayout(params([spec('grp.a', 2), spec('grp.b', 1), spec('grp.c', 1), spec('~sin-grupo', 1)], { compact: true }));
    for (const desk of layout.desks) {
      expect(findPath(layout.walkable, layout.cols, layout.door.tile, desk.seat.tile)).not.toBeNull();
      expect(findPath(layout.walkable, layout.cols, layout.door.tile, desk.visit.tile)).not.toBeNull();
    }
    for (const spot of Object.values(layout.routine).flat()) {
      expect(findPath(layout.walkable, layout.cols, layout.door.tile, spot.tile)).not.toBeNull();
    }
  });

  it('draws one rug and one sign zone per team and none for the plain office', () => {
    const layout = buildLayout(params([spec('grp.a', 1), spec('grp.b', 1)]));
    expect(layout.zones.filter((zone) => zone.kind === 'teamrug')).toHaveLength(2);
    expect(layout.zones.filter((zone) => zone.kind === 'sign').map((zone) => zone.label)).toEqual(['grp.a', 'grp.b']);
    const plain = buildLayout({ pods: 2, podCols: 2, side: 'right', compact: false, beds: 8 });
    expect(plain.teams).toEqual([]);
    expect(plain.zones.some((zone) => zone.kind === 'teamrug' || zone.kind === 'sign')).toBe(false);
  });

  it('chooses a layout that holds every team and frames a team as a room-sized area', () => {
    const teams = [spec('grp.a', 1), spec('grp.b', 2), spec('grp.c', 1), spec('grp.d', 3)];
    const { params: chosen } = chooseLayout(32, { width: 1100, height: 760, dpr: 1 }, teams);
    const layout = buildLayout(chosen);
    expect(layout.desks).toHaveLength(7 * SEATS_PER_POD);
    for (const team of layout.teams) {
      const area = teamArea(team);
      expect(area.x * TILE).toBeGreaterThanOrEqual(0);
      expect((area.y + area.h) * TILE).toBeLessThanOrEqual(layout.rows * TILE);
      expect(area).toMatchObject({ w: team.rug.w, y: team.sign.y });
    }
  });
});

describe('team seats', () => {
  const seated = (counts: Record<string, number>, pods: Record<string, number>): SeatedTeam[] => Object.entries(counts).map(([id, count]) => ({
    id, ids: Array.from({ length: count }, (_, index) => `${id}/${String(index).padStart(2, '0')}`), pods: pods[id],
  }));

  it('gives a team headroom: one more agent fits without growing, the one past the seats grows', () => {
    expect(podsNeeded(3, GROUP_POLICY)).toBe(1);
    expect(nextPods(4, 1, GROUP_POLICY)).toBe(1);
    expect(nextPods(5, 1, GROUP_POLICY)).toBe(2);
    expect(nextPods(5, 2, GROUP_POLICY)).toBe(2);
    expect(nextPods(1, 2, GROUP_POLICY)).toBe(2);
    expect(nextPods(1, 4, GROUP_POLICY)).toBe(1);
  });

  it('numbers desks team after team and keeps teams in consecutive pods', () => {
    const teams = seated({ a: 3, b: 5 }, { a: 1, b: 2 });
    const desks = deskIndexes(teams, assignSeats(new Map(), teams));
    const of = (team: string) => [...desks].filter(([id]) => id.startsWith(team)).map(([, desk]) => desk).sort((x, y) => x - y);
    expect(of('a').every((desk) => desk < 4)).toBe(true);
    expect(of('b').every((desk) => desk >= 4 && desk < 12)).toBe(true);
  });

  it('leaves the other teams seats alone when one team changes', () => {
    const before = seated({ a: 2, b: 3 }, { a: 1, b: 1 });
    const first = assignSeats(new Map(), before);
    const after = seated({ a: 6, b: 3 }, { a: 2, b: 1 });
    const second = assignSeats(first, after);
    for (const id of before[1].ids) expect(second.get(id)).toEqual(first.get(id));
    for (const id of before[0].ids) expect(second.get(id)).toEqual(first.get(id));
    const gone = assignSeats(second, seated({ a: 1, b: 3 }, { a: 2, b: 1 }));
    for (const id of before[1].ids) expect(gone.get(id)).toEqual(first.get(id));
  });

  it('moves an agent that changes team to a free seat of the new team', () => {
    const first = assignSeats(new Map(), [{ id: 'a', ids: ['x', 'y'], pods: 1 }, { id: 'b', ids: ['z'], pods: 1 }]);
    const second = assignSeats(first, [{ id: 'a', ids: ['y'], pods: 1 }, { id: 'b', ids: ['x', 'z'], pods: 1 }]);
    expect(second.get('x')?.team).toBe('b');
    expect(second.get('z')).toEqual(first.get('z'));
    expect(second.get('x')?.seat).not.toBe(second.get('z')?.seat);
  });
});
