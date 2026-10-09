import { TILE, type Dir, type Point, type Spot } from './level';
import { findCheapestPath, findPath } from './pathfinding';

/** The part of a map the operator walks on. */
export interface Grid { cols: number; rows: number; walkable: readonly boolean[]; cost?: Uint8Array }

/** Art px per second: a little brisker than the agents, it is the operator in a hurry. */
export const AVATAR_SPEED = 62;
const FOOT_HALF_W = 4;
const FOOT_H = 4;
/** Feet never go lower than where a tile centre puts them, so the shadow stays inside the art. */
const FEET_FLOOR = 3;

export interface Avatar {
  /** Feet position in art px. */
  x: number;
  y: number;
  dir: Dir;
  moving: boolean;
  walked: number;
  /** Remaining waypoints in art px when walking to a tapped tile. */
  route: Point[];
}

export function createAvatar(door: Spot): Avatar {
  return { x: door.px.x, y: door.px.y, dir: door.dir, moving: false, walked: 0, route: [] };
}

/** Puts the operator on a door of another map, as if they had just stepped through it. */
export function teleport(avatar: Avatar, spot: Spot): void {
  avatar.x = spot.px.x;
  avatar.y = spot.px.y;
  avatar.dir = spot.dir;
  avatar.route = [];
  avatar.moving = false;
}

export const tileAt = (x: number, y: number): Point => ({ x: Math.floor(x / TILE), y: Math.floor((y - 1) / TILE) });
const tileFeet = (tile: Point): Point => ({ x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 3 });

export function walkableAt(layout: Grid, tile: Point): boolean {
  return tile.x >= 0 && tile.y >= 0 && tile.x < layout.cols && tile.y < layout.rows
    && (layout.walkable[tile.y * layout.cols + tile.x] ?? false);
}

/** The feet are a small box; every corner must stand on floor. */
export function feetFree(layout: Grid, x: number, y: number): boolean {
  const corners = [
    [x - FOOT_HALF_W, y - FOOT_H], [x + FOOT_HALF_W - 1, y - FOOT_H],
    [x - FOOT_HALF_W, y - 1], [x + FOOT_HALF_W - 1, y - 1],
  ] as const;
  if (y > layout.rows * TILE - FEET_FLOOR) return false;
  return corners.every(([cx, cy]) => walkableAt(layout, { x: Math.floor(cx / TILE), y: Math.floor(cy / TILE) }));
}

export function dirOf(dx: number, dy: number, fallback: Dir): Dir {
  if (dx === 0 && dy === 0) return fallback;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : (dy > 0 ? 'down' : 'up');
}

/** Moves each axis on its own so walking into a desk at an angle slides along it. */
export function moveBy(avatar: Avatar, layout: Grid, dx: number, dy: number): boolean {
  const startX = avatar.x;
  const startY = avatar.y;
  if (dx !== 0 && feetFree(layout, avatar.x + dx, avatar.y)) avatar.x += dx;
  if (dy !== 0 && feetFree(layout, avatar.x, avatar.y + dy)) avatar.y += dy;
  avatar.dir = dirOf(dx, dy, avatar.dir);
  const moved = Math.hypot(avatar.x - startX, avatar.y - startY);
  avatar.walked += moved;
  return moved > 0;
}

/** Nearest walkable floor tile to `tile`, searching outwards; `null` when the room has none. */
export function nearestFloor(layout: Grid, tile: Point): Point | null {
  const start = {
    x: Math.min(layout.cols - 1, Math.max(0, tile.x)),
    y: Math.min(layout.rows - 1, Math.max(0, tile.y)),
  };
  const seen = new Set<number>([start.y * layout.cols + start.x]);
  const queue: Point[] = [start];
  for (const current of queue) {
    if (walkableAt(layout, current)) return current;
    for (const [dx, dy] of [[0, 1], [1, 0], [-1, 0], [0, -1]] as const) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = next.y * layout.cols + next.x;
      if (next.x < 0 || next.y < 0 || next.x >= layout.cols || next.y >= layout.rows || seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return null;
}

/** Plans a walk to the floor tile nearest `tile`. Returns false when there is nowhere to go. */
export function walkTo(avatar: Avatar, layout: Grid, tile: Point): boolean {
  const goal = nearestFloor(layout, tile);
  if (!goal) return false;
  const from = nearestFloor(layout, tileAt(avatar.x, avatar.y)) ?? goal;
  const path = layout.cost ? findCheapestPath(layout.walkable, layout.cost, layout.cols, from, goal) : findPath(layout.walkable, layout.cols, from, goal);
  if (!path) return false;
  avatar.route = path.map(tileFeet);
  return true;
}

/** Jumps straight to the end of the planned walk, for reduced motion. */
export function arrive(avatar: Avatar): void {
  const last = avatar.route.at(-1);
  if (!last) return;
  const before = avatar.route.at(-2) ?? { x: avatar.x, y: avatar.y };
  avatar.dir = dirOf(last.x - before.x, last.y - before.y, avatar.dir);
  avatar.x = last.x;
  avatar.y = last.y;
  avatar.route = [];
  avatar.moving = false;
}

/** One whole tile in a direction, for reduced motion and single key taps. */
export function stepTile(avatar: Avatar, layout: Grid, dir: Dir): boolean {
  const here = tileAt(avatar.x, avatar.y);
  const delta = { up: [0, -1], down: [0, 1], left: [-1, 0], right: [1, 0] }[dir];
  const next = { x: here.x + delta[0], y: here.y + delta[1] };
  avatar.dir = dir;
  avatar.route = [];
  if (!walkableAt(layout, next)) return false;
  const feet = tileFeet(next);
  avatar.x = feet.x;
  avatar.y = feet.y;
  return true;
}

/**
 * Advances the avatar by `dt` seconds. A held direction wins over a planned walk and cancels it, so
 * the keyboard and the D-pad always feel in control.
 */
export function stepAvatar(avatar: Avatar, layout: Grid, input: Point, dt: number, speed = AVATAR_SPEED): void {
  const delta = Math.min(dt, 0.1);
  if (input.x !== 0 || input.y !== 0) {
    avatar.route = [];
    const length = Math.hypot(input.x, input.y);
    const moved = moveBy(avatar, layout, (input.x / length) * speed * delta, (input.y / length) * speed * delta);
    avatar.moving = moved;
    if (!moved) avatar.dir = dirOf(input.x, input.y, avatar.dir);
    return;
  }
  let budget = speed * delta;
  while (budget > 0 && avatar.route.length > 0) {
    const next = avatar.route[0];
    const dx = next.x - avatar.x;
    const dy = next.y - avatar.y;
    const distance = Math.hypot(dx, dy);
    if (distance > 0.01) avatar.dir = dirOf(dx, dy, avatar.dir);
    if (distance <= budget) {
      avatar.x = next.x;
      avatar.y = next.y;
      avatar.walked += distance;
      budget -= distance;
      avatar.route.shift();
    } else {
      avatar.x += (dx / distance) * budget;
      avatar.y += (dy / distance) * budget;
      avatar.walked += budget;
      budget = 0;
    }
  }
  avatar.moving = avatar.route.length > 0;
}

export interface Neighbour { id: string; x: number; y: number }

/** Who the operator is standing next to, closest first; desks put a tile between them, hence the reach. */
export function nearbyAgent(avatar: Pick<Avatar, 'x' | 'y'>, people: readonly Neighbour[], reach = 34): string | null {
  let best: { id: string; distance: number } | null = null;
  for (const person of people) {
    const distance = Math.hypot(person.x - avatar.x, person.y - avatar.y);
    if (distance <= reach && (!best || distance < best.distance)) best = { id: person.id, distance };
  }
  return best?.id ?? null;
}

export function faceTowards(from: Point, to: Point): Dir {
  return dirOf(to.x - from.x, to.y - from.y, 'down');
}
