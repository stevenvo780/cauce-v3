import { describe, expect, it, vi } from 'vitest';
import { worldToScreen } from './camera';
import { lotCell } from './campus-lots';
import { OfficeEngine, type EngineEvents } from './engine';
import { makeCanvas } from './frame';
import { CAMPUS } from './level';
import { buildWorldMap, groupLevelId } from './world-map';

const map = buildWorldMap({
  groups: [{ id: 'grp.a', label: 'a', hue: 30, seats: 4, cell: lotCell(0) }, { id: 'grp.b', label: 'b', hue: 220, seats: 8, cell: lotCell(1) }],
  beds: 4,
  pods: 2,
});
const A = groupLevelId('grp.a');
const view = { width: 1200, height: 800 };

function engine(reduced: boolean) {
  const events: EngineEvents = { level: vi.fn(), nearby: vi.fn(), edges: vi.fn(), occupancy: vi.fn(), tube: vi.fn() };
  const created = new OfficeEngine(map, reduced, makeCanvas, events, new Set());
  created.resize(view, 1, { top: 60, bottom: 70, right: 0 });
  return { engine: created, events };
}

const ticks = (target: OfficeEngine, seconds: number, each?: () => void) => {
  const start = performance.now();
  for (let ms = 16; ms <= seconds * 1000; ms += 16) {
    target.tick(start + ms, 0.016);
    each?.();
  }
};

describe('switching maps', () => {
  it('enters a building fitted to the screen and comes back out next to its door', () => {
    const { engine: game, events } = engine(true);
    expect(game.level).toBe(CAMPUS);
    game.go(A);
    expect(game.level).toBe(A);
    expect(events.level).toHaveBeenLastCalledWith(A);
    const room = map.levels.get(A);
    expect([game.avatarLevel, game.avatar.x, game.avatar.y]).toEqual([A, room?.door.px.x, room?.door.px.y]);
    expect(game.limits.min).toBeGreaterThanOrEqual(3);
    expect(game.target.zoom).toBe(game.limits.min);
    game.go(CAMPUS);
    const site = map.campus.siteOf.get(A);
    expect([game.level, game.avatar.x, game.avatar.y]).toEqual([CAMPUS, site?.door.px.x, site?.door.px.y]);
  });

  it('switches behind a short dither when motion is allowed, and a click on a house goes in', () => {
    const { engine: game } = engine(false);
    const site = map.campus.siteOf.get(A);
    if (!site) throw new Error('no site');
    const screen = worldToScreen(game.cam, game.view, { x: (site.x + site.w / 2) * 16, y: (site.y + 1) * 16 });
    expect(game.siteAt(screen)?.id).toBe(A);
    game.go(A);
    let covered = 0;
    ticks(game, 0.6, () => { covered = Math.max(covered, game.cover); });
    expect(covered).toBe(1);
    expect(game.level).toBe(A);
    expect(game.cover).toBe(0);
    expect(game.siteAt(screen)).toBeNull();
  });

  it('walks out through the doorway in walk mode, and in through the door of a house on the campus', () => {
    const { engine: game } = engine(false);
    game.go(A);
    ticks(game, 0.6);
    game.setPaseo(true);
    game.keys.add('w');
    ticks(game, 0.8);
    game.keys.clear();
    game.keys.add('s');
    ticks(game, 3);
    game.keys.clear();
    ticks(game, 0.6);
    expect(game.level).toBe(CAMPUS);
    game.keys.add('s');
    ticks(game, 0.5);
    game.keys.clear();
    game.keys.add('w');
    ticks(game, 1.5);
    game.keys.clear();
    ticks(game, 0.6);
    expect(game.level).toBe(A);
  });

  it('follows an agent across buildings', () => {
    const { engine: game } = engine(true);
    game.sync([{ id: 't/a', state: 'thinking', home: A, desk: 0 }]);
    game.follow = 't/a';
    ticks(game, 0.1);
    expect(game.level).toBe(A);
  });
});
