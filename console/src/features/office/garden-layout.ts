import type { Dir, Furniture, Point, Room, Spot, Zone } from './layout';
import { TILE } from './tile';

/** The fountain plaza is drawn for a block this size; wider or taller gardens get lawn, lanes and wings around it. */
export const GARDEN_CORE_W = 10;
export const GARDEN_CORE_H = 7;
/** Wing furniture repeats on this stride, in tiles. */
const STRIDE = 8;

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
 * Lays the plaza centred vertically with its left edge at column `cx`, a lane through its middle row
 * out to both room edges, a path from every door in `doors` (first of two tiles) down to the lane,
 * and trees, benches and flower beds on the lawn either side.
 */
export function buildGarden(room: Room, cx: number, doors: readonly number[], out: Builder): GardenSpots {
  const cy = room.y + Math.floor((room.h - GARDEN_CORE_H) / 2);
  const lane = cy + 3;
  const east = cx + GARDEN_CORE_W;
  const right = room.x + room.w;
  const bottom = room.y + room.h - 1;
  const at = (dx: number, dy: number): Point => ({ x: cx + dx, y: cy + dy });
  const spot = (dx: number, dy: number, dir: Dir, extra: Partial<Spot> = {}): Spot => ({
    tile: at(dx, dy), px: centerPx(at(dx, dy)), dir, ...extra,
  });
  const path = (x: number, y: number, w: number, h: number) => {
    if (w > 0 && h > 0) out.zones.push({ kind: 'path', x, y, w, h });
  };
  out.zones.push({ kind: 'grass', x: room.x, y: room.y, w: room.w, h: room.h });
  for (const [dx, dy, w, h] of [[3, 1, 5, 1], [3, 4, 5, 1], [3, 2, 1, 2], [7, 2, 1, 2], [4, 5, 2, 2], [4, 0, 2, 1]] as const) path(cx + dx, cy + dy, w, h);
  path(room.x, lane, cx - room.x, 1);
  path(east, lane, right - east, 1);

  const taken = new Set<number>();
  const solid = new Set<number>();
  const key = (x: number, y: number) => y * 4096 + x;
  const reserve = (x: number, y: number, w: number, h: number) => {
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) taken.add(key(x + dx, y + dy));
  };
  reserve(cx, cy, GARDEN_CORE_W, GARDEN_CORE_H);
  reserve(room.x, lane, room.w, 1);
  for (const door of doors) {
    const inCore = door + 1 >= cx && door < east;
    const length = inCore ? cy - room.y : lane - room.y + 1;
    path(door, room.y, 2, length);
    reserve(door, room.y, 2, Math.max(length, 0));
  }

  const put = (piece: Furniture, w = 1, h = 1) => {
    out.furniture.push(piece);
    out.block(piece.x, piece.y, w, h);
    reserve(piece.x, piece.y, w, h);
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) solid.add(key(piece.x + dx, piece.y + dy));
  };
  const place = (piece: Furniture, w = 1, h = 1): boolean => {
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) {
      const x = piece.x + dx;
      const y = piece.y + dy;
      if (x < room.x || x >= right || y < room.y || y > bottom || taken.has(key(x, y))) return false;
    }
    put(piece, w, h);
    return true;
  };
  for (const [dx, dy] of [[0, 0], [9, 0], [0, 6], [9, 6]] as const) put({ kind: 'tree', x: cx + dx, y: cy + dy, variant: dx + dy });
  for (const [dx, dy, w] of [[2, 0, 2], [6, 0, 2], [0, 4, 1], [9, 4, 1], [2, 6, 2], [6, 6, 2]] as const) {
    put({ kind: 'flowers', x: cx + dx, y: cy + dy, w, variant: dx * 3 + dy }, w);
  }
  put({ kind: 'grill', x: cx + 8, y: cy });
  put({ kind: 'pond', x: cx + 4, y: cy + 2 }, 3, 2);
  put({ kind: 'bench', x: cx, y: cy + 2 }, 2);
  put({ kind: 'bench', x: cx + 8, y: cy + 2 }, 2);
  out.furniture.push({ kind: 'lights', x: room.x, y: room.y, w: room.w });

  const seat = (x: number): Spot => ({ tile: { x, y: lane }, px: { x: x * TILE + TILE / 2, y: (lane - 1) * TILE + 11 }, dir: 'down' });
  const read = [seat(cx), seat(cx + 1), seat(cx + 8), seat(cx + 9)];
  const water = [spot(3, 1, 'up'), spot(6, 1, 'up'), spot(1, 4, 'left'), spot(8, 4, 'right'), spot(2, 5, 'down'), spot(7, 5, 'down')];
  const chat = ([[1, 1], [2, 4], [6, 4]] as const).flatMap(([dx, dy], pair) => [
    spot(dx, dy, 'right', { pair, variant: 0 }),
    spot(dx + 1, dy, 'left', { pair, variant: 1 }),
  ]);

  for (let x = room.x; x < right; x += 3) {
    place({ kind: 'tree', x, y: room.y, variant: x });
    place({ kind: 'tree', x: x + 1, y: bottom, variant: x + 1 });
  }
  for (let x = room.x + 2; x + 1 < right; x += STRIDE) {
    if (place({ kind: 'bench', x, y: lane - 1 }, 2)) read.push(seat(x), seat(x + 1));
    const wet = x + 3;
    if (place({ kind: 'flowers', x: wet, y: lane + 2, w: 2, variant: x }, 2)) water.push({ tile: { x: wet, y: lane + 1 }, px: centerPx({ x: wet, y: lane + 1 }), dir: 'down' });
    if (!taken.has(key(x, lane + 1)) && !taken.has(key(x + 1, lane + 1))) {
      const pair = chat.length / 2;
      chat.push(
        { tile: { x, y: lane + 1 }, px: centerPx({ x, y: lane + 1 }), dir: 'right', pair, variant: 0 },
        { tile: { x: x + 1, y: lane + 1 }, px: centerPx({ x: x + 1, y: lane + 1 }), dir: 'left', pair, variant: 1 },
      );
    }
  }
  for (const row of [cy - 1, cy + GARDEN_CORE_H]) {
    for (const dx of [1, 7]) place({ kind: 'flowers', x: cx + dx, y: row, w: 2, variant: dx + row }, 2);
  }

  const seen = new Set<number>([key(cx, lane)]);
  const queue: Point[] = [{ x: cx, y: lane }];
  for (const { x, y } of queue) {
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
      const next = { x: x + dx, y: y + dy };
      if (next.x < room.x || next.x >= right || next.y < room.y || next.y > bottom || solid.has(key(next.x, next.y)) || seen.has(key(next.x, next.y))) continue;
      seen.add(key(next.x, next.y));
      queue.push(next);
    }
  }
  for (let y = room.y; y <= bottom; y += 1) for (let x = room.x; x < right; x += 1) {
    if (!seen.has(key(x, y)) && !solid.has(key(x, y))) put({ kind: 'tree', x, y, variant: x + y });
  }

  const xl = cx - room.x >= 3 ? room.x + 1 : cx;
  const xr = right - east >= 3 ? right - 2 : east - 1;
  const round: readonly (readonly [number, number])[] = [
    [xl, lane], [cx + 3, lane], [cx + 3, cy + 1], [cx + 7, cy + 1], [cx + 7, lane], [xr, lane], [cx + 7, lane], [cx + 7, cy + 4], [cx + 3, cy + 4], [cx + 3, lane],
  ];
  return {
    cook: [spot(8, 1, 'up')],
    read,
    water,
    chat,
    pet: round.map(([x, y]) => centerPx({ x, y })),
  };
}
