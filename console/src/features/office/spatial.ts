import type { Dir } from './level';

export interface Placed { id: string; x: number; y: number }

const AXIS: Readonly<Record<Dir, { x: number; y: number }>> = {
  up: { x: 0, y: -1 }, down: { x: 0, y: 1 }, left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
};

/** Reading order: top row first, left to right inside a row of roughly the same height. */
export function readingOrder(points: readonly Placed[], rowTolerance = 8): Placed[] {
  return [...points].sort((a, b) => (Math.abs(a.y - b.y) > rowTolerance ? a.y - b.y : a.x - b.x));
}

/**
 * The neighbour an arrow key should move to: the closest point ahead in that direction, where
 * drifting sideways costs more than going straight. Without a current point it starts at the top
 * left; with nothing ahead it stays put.
 */
export function spatialNext(points: readonly Placed[], fromId: string | null, dir: Dir): string | null {
  const from = fromId === null ? undefined : points.find((point) => point.id === fromId);
  if (!from) return readingOrder(points).at(0)?.id ?? null;
  const axis = AXIS[dir];
  let best: { id: string; score: number } | null = null;
  for (const point of points) {
    if (point.id === from.id) continue;
    const dx = point.x - from.x;
    const dy = point.y - from.y;
    const ahead = dx * axis.x + dy * axis.y;
    if (ahead <= 2) continue;
    const aside = Math.abs(dx * axis.y + dy * axis.x);
    const score = ahead + aside * 2.5;
    if (!best || score < best.score) best = { id: point.id, score };
  }
  return best?.id ?? from.id;
}
