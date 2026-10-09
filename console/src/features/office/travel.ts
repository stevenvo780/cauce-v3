import { CAMPUS, TILE, type Level, type Point, type Spot } from './level';
import { findCheapestPath, findPath } from './pathfinding';
import type { Place } from './routine';
import type { WorldMap } from './world-map';

/** One walk inside a single map, optionally followed by stepping through a door onto another map. */
export interface Leg {
  level: string;
  to: Spot;
  hop: { level: string; at: Spot } | null;
}

/** Walks from map `from` to `place`: out through the door, across the campus and in through the other door. */
export function legsTo(map: WorldMap, from: string, place: Place): Leg[] | null {
  if (from === place.level) return [{ level: from, to: place.spot, hop: null }];
  const { campus } = map;
  const legs: Leg[] = [];
  if (from !== CAMPUS) {
    const level = map.levels.get(from);
    const site = campus.siteOf.get(from);
    if (!level || !site) return null;
    legs.push({ level: from, to: level.door, hop: { level: CAMPUS, at: site.door } });
  }
  if (place.level === CAMPUS) {
    legs.push({ level: CAMPUS, to: place.spot, hop: null });
    return legs;
  }
  const target = map.levels.get(place.level);
  const site = campus.siteOf.get(place.level);
  if (!target || !site) return null;
  legs.push({ level: CAMPUS, to: site.door, hop: { level: place.level, at: target.door } }, { level: place.level, to: place.spot, hop: null });
  return legs;
}

export const tileOf = (x: number, y: number): Point => ({ x: Math.floor(x / TILE), y: Math.floor((y - 1) / TILE) });

/**
 * Waypoints in art px from `(x, y)` to `spot` on `level`. Everyone walks a lane of their own, a few
 * px off the tile centres, so two people on one corridor do not merge into one.
 */
export function waypointsTo(level: Level, x: number, y: number, spot: Spot, lane: number): Point[] | null {
  const here = tileOf(x, y);
  const start = { x: Math.min(level.cols - 1, Math.max(0, here.x)), y: Math.min(level.rows - 1, Math.max(0, here.y)) };
  const route = level.cost
    ? findCheapestPath(level.walkable, level.cost, level.cols, start, spot.tile)
    : findPath(level.walkable, level.cols, start, spot.tile);
  if (!route) return null;
  const points: Point[] = [];
  for (let index = 1; index < route.length - 1; index += 1) {
    points.push({ x: route[index].x * TILE + TILE / 2 + lane, y: route[index].y * TILE + TILE - 3 + lane });
  }
  if (route.length > 1) {
    const last = route[route.length - 1];
    points.push({ x: last.x * TILE + TILE / 2, y: last.y * TILE + TILE - 3 });
  }
  points.push({ x: spot.px.x, y: spot.px.y });
  return points;
}
