import { describe, expect, it } from 'vitest';
import { buildGroupRoom } from './interior';
import { buildPark } from './interior-park';
import { buildCafe, buildDorm, buildLobby, buildShop } from './interior-shared';
import { TILE, WALL_ROWS, type Level, type Spot } from './level';
import { findPath } from './pathfinding';

const reachable = (level: Level, spot: Spot) => findPath(level.walkable, level.cols, level.door.tile, spot.tile) !== null;
const everySpot = (level: Level): Spot[] => [
  ...level.desks.flatMap((desk) => [desk.seat, desk.visit]),
  ...Object.values(level.routine).flat().flatMap((spot) => [spot, ...(spot.from ? [spot.from] : [])]),
  ...level.beds, ...level.waiting, ...level.repair, ...level.help, ...(level.station ? [level.station] : []),
];

describe('group building', () => {
  it('has a desk per seat in whole pods, a tube station and a doorway in the front wall', () => {
    for (const seats of [4, 8, 12, 16, 24]) {
      const room = buildGroupRoom({ id: 'grupo:x', label: 'grp.x', hue: 120, seats });
      expect(room.desks).toHaveLength(seats);
      expect(new Set(room.desks.map((desk) => `${String(desk.seat.px.x)},${String(desk.seat.px.y)}`)).size).toBe(seats);
      expect(room.station).not.toBeNull();
      expect(room.door.tile.y).toBe(room.rows - 1);
      expect(room.walkable[room.door.tile.y * room.cols + room.door.tile.x]).toBe(true);
      expect(room.wall.find((item) => item.kind === 'sign')?.label).toBe('grp.x');
      const hung = [...room.wall].sort((a, b) => a.x - b.x);
      for (let index = 1; index < hung.length; index += 1) expect(hung[index].x, `${String(seats)} seats`).toBeGreaterThanOrEqual(hung[index - 1].x + hung[index - 1].w);
      for (const spot of everySpot(room)) expect(reachable(room, spot), `${String(seats)} seats`).toBe(true);
    }
  });

  it('grows with its people instead of crowding them: more seats, a larger floor', () => {
    const small = buildGroupRoom({ id: 'grupo:a', label: 'a', hue: 0, seats: 4 });
    const large = buildGroupRoom({ id: 'grupo:a', label: 'a', hue: 0, seats: 16 });
    expect(large.cols * large.rows).toBeGreaterThan(small.cols * small.rows);
    const floor = (room: Level) => (room.cols - 2) * (room.rows - WALL_ROWS - 1);
    expect(floor(small) / small.desks.length).toBeGreaterThan(20);
    expect(floor(large) / large.desks.length).toBeGreaterThan(10);
  });
});

describe('shared buildings', () => {
  it('reach every spot from their door, and keep each activity in its own building', () => {
    const cafe = buildCafe();
    const park = buildPark();
    const dorm = buildDorm(9);
    const lobby = buildLobby();
    const shop = buildShop(5);
    for (const level of [cafe, park, dorm, lobby, shop]) {
      for (const spot of everySpot(level)) expect(reachable(level, spot), `${level.id} ${String(spot.tile.x)},${String(spot.tile.y)}`).toBe(true);
    }
    expect(Object.keys(cafe.routine).sort()).toEqual(['coffee', 'cook', 'eat', 'sweep', 'tidy']);
    expect(park.routine.play?.length).toBe(9);
    expect(park.routine.stroll?.length).toBeGreaterThan(20);
    expect(park.outdoor).toBe(true);
    expect(park.pet.length).toBeGreaterThan(3);
    expect(dorm.beds).toHaveLength(9);
    for (const bed of dorm.beds) expect(bed.px.y % TILE).toBe(9);
    expect(lobby.waiting.length).toBeGreaterThanOrEqual(6);
    expect(shop.repair).toHaveLength(5);
    expect(shop.help.length).toBeGreaterThanOrEqual(3);
  });

  it('keeps furniture off the walls', () => {
    for (const level of [buildCafe(), buildDorm(4), buildLobby(), buildShop(2), buildGroupRoom({ id: 'g', label: 'g', hue: 1, seats: 8 })]) {
      for (const piece of level.furniture) {
        expect(piece.x).toBeGreaterThanOrEqual(1);
        expect(piece.x).toBeLessThan(level.cols - 1);
        expect(piece.y).toBeGreaterThanOrEqual(WALL_ROWS);
        expect(piece.y).toBeLessThan(level.rows - 1);
      }
    }
  });
});
