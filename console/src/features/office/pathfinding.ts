import type { Point } from './layout';

const STEPS = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;

/**
 * Shortest 4-connected route over walkable tiles, start and goal included. The start may sit on a
 * blocked tile (someone getting up from a sofa); the goal must be walkable. Returns `null` when
 * the goal cannot be reached.
 */
export function findPath(walkable: readonly boolean[], cols: number, from: Point, to: Point): Point[] | null {
  const rows = walkable.length / cols;
  const inside = (p: Point) => p.x >= 0 && p.y >= 0 && p.x < cols && p.y < rows;
  if (!inside(from) || !inside(to) || !walkable[to.y * cols + to.x]) return null;
  const start = from.y * cols + from.x;
  const goal = to.y * cols + to.x;
  const previous = new Map<number, number>([[start, -1]]);
  const queue = [start];
  for (const current of queue) {
    if (current === goal) break;
    const cx = current % cols;
    const cy = Math.floor(current / cols);
    for (const [dx, dy] of STEPS) {
      const next = { x: cx + dx, y: cy + dy };
      const key = next.y * cols + next.x;
      if (!inside(next) || previous.has(key) || !walkable[key]) continue;
      previous.set(key, current);
      queue.push(key);
    }
  }
  if (!previous.has(goal)) return null;
  const path: Point[] = [];
  for (let at: number | undefined = goal; at !== undefined && at !== -1; at = previous.get(at)) {
    path.push({ x: at % cols, y: Math.floor(at / cols) });
  }
  return path.reverse();
}
