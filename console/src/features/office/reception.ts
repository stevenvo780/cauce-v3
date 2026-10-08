import type { Point, Room, Spot } from './layout';
import { TILE } from './tile';

const MAX_SPOTS = 8;

/** Standing places for visitors in the first open rows of their room, nearest the entry first. */
export function receptionSpots(
  walkable: readonly boolean[], cols: number, room: Room, door: Point, avoid: readonly Point[],
): Spot[] {
  const taken = new Set(avoid.map((tile) => `${String(tile.x)},${String(tile.y)}`));
  const candidates: { tile: Point; rank: number }[] = [];
  for (let y = room.y; y < Math.min(room.y + 4, room.y + room.h); y += 1) {
    for (let x = room.x; x < room.x + room.w; x += 1) {
      if (!walkable[y * cols + x] || (x === door.x && y === door.y)) continue;
      const crowded = taken.has(`${String(x)},${String(y)}`) ? 100 : 0;
      candidates.push({ tile: { x, y }, rank: crowded + (y - room.y) * 10 + Math.abs(x - door.x) });
    }
  }
  return candidates.sort((a, b) => a.rank - b.rank).slice(0, MAX_SPOTS).map(({ tile }) => ({
    tile, px: { x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 3 }, dir: 'down' as const,
  }));
}
