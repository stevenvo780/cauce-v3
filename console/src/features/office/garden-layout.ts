import type { Dir, Furniture, Point, Room, Spot, Zone } from './layout';
import { TILE } from './tile';

/** The garden's fixtures are drawn for a block this size; wider or taller gardens get more lawn. */
export const GARDEN_CORE_W = 10;
export const GARDEN_CORE_H = 7;

export interface GardenSpots {
  cook: Spot[];
  read: Spot[];
  water: Spot[];
  chat: Spot[];
  pet: Point[];
}

interface Builder {
  furniture: Furniture[];
  zones: Zone[];
  block: (x: number, y: number, w?: number, h?: number) => void;
}

const centerPx = (tile: Point): Point => ({ x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 3 });

/**
 * Lays the garden core at its top left (`cx`, `cy`). Every edge keeps walkable tiles in its middle
 * and on rows 1, 3 and 5, so doors can open on any side.
 */
export function buildGarden(room: Room, cx: number, cy: number, out: Builder): GardenSpots {
  const at = (dx: number, dy: number): Point => ({ x: cx + dx, y: cy + dy });
  const spot = (dx: number, dy: number, dir: Dir, extra: Partial<Spot> = {}): Spot => ({
    tile: at(dx, dy), px: centerPx(at(dx, dy)), dir, ...extra,
  });
  out.zones.push({ kind: 'grass', x: room.x, y: room.y, w: room.w, h: room.h });
  for (const [dx, dy, w, h] of [[3, 1, 5, 1], [3, 4, 5, 1], [3, 2, 1, 2], [7, 2, 1, 2], [4, 5, 2, 2], [4, 0, 2, 1]] as const) {
    out.zones.push({ kind: 'path', x: cx + dx, y: cy + dy, w, h });
  }
  const place = (piece: Furniture, w = 1, h = 1) => {
    out.furniture.push(piece);
    out.block(piece.x, piece.y, w, h);
  };
  for (const [dx, dy] of [[0, 0], [9, 0], [0, 6], [9, 6]] as const) place({ kind: 'tree', x: cx + dx, y: cy + dy, variant: dx + dy });
  for (const [dx, dy, w] of [[2, 0, 2], [6, 0, 2], [0, 4, 1], [9, 4, 1], [2, 6, 2], [6, 6, 2]] as const) {
    place({ kind: 'flowers', x: cx + dx, y: cy + dy, w, variant: dx * 3 + dy }, w);
  }
  place({ kind: 'grill', x: cx + 8, y: cy });
  place({ kind: 'pond', x: cx + 4, y: cy + 2 }, 3, 2);
  place({ kind: 'bench', x: cx, y: cy + 2 }, 2);
  place({ kind: 'bench', x: cx + 8, y: cy + 2 }, 2);
  out.furniture.push({ kind: 'lights', x: room.x, y: room.y, w: room.w });

  const seat = (dx: number): Spot => ({ tile: at(dx, 3), px: { x: (cx + dx) * TILE + TILE / 2, y: (cy + 2) * TILE + 11 }, dir: 'down' });
  return {
    cook: [spot(8, 1, 'up')],
    read: [seat(0), seat(1), seat(8), seat(9)],
    water: [spot(3, 1, 'up'), spot(6, 1, 'up'), spot(1, 4, 'left'), spot(8, 4, 'right'), spot(2, 5, 'down'), spot(7, 5, 'down')],
    chat: ([[1, 1], [2, 4], [6, 4]] as const).flatMap(([dx, dy], pair) => [
      spot(dx, dy, 'right', { pair, variant: 0 }),
      spot(dx + 1, dy, 'left', { pair, variant: 1 }),
    ]),
    pet: [at(3, 1), at(7, 1), at(7, 4), at(3, 4)].map(centerPx),
  };
}
