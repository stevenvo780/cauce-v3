import type { Point } from './level';

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
  return previous.has(goal) ? unwind(previous, goal, cols) : null;
}

function unwind(previous: ReadonlyMap<number, number>, goal: number, cols: number): Point[] {
  const path: Point[] = [];
  for (let at: number | undefined = goal; at !== undefined && at !== -1; at = previous.get(at)) path.push({ x: at % cols, y: Math.floor(at / cols) });
  return path.reverse();
}

/** Cheapest route when tiles have a walking cost: people keep to the roads and cut across lawns only when it pays. */
export function findCheapestPath(walkable: readonly boolean[], cost: Uint8Array, cols: number, from: Point, to: Point): Point[] | null {
  const rows = walkable.length / cols;
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows;
  if (!inside(from.x, from.y) || !inside(to.x, to.y) || !walkable[to.y * cols + to.x]) return null;
  const start = from.y * cols + from.x;
  const goal = to.y * cols + to.x;
  const best = new Float64Array(walkable.length).fill(Infinity);
  const previous = new Map<number, number>([[start, -1]]);
  const heap: number[] = [];
  const priority: number[] = [];
  const push = (node: number, value: number) => {
    heap.push(node);
    priority.push(value);
    for (let index = heap.length - 1; index > 0;) {
      const parent = (index - 1) >> 1;
      if (priority[parent] <= priority[index]) break;
      [heap[parent], heap[index]] = [heap[index], heap[parent]];
      [priority[parent], priority[index]] = [priority[index], priority[parent]];
      index = parent;
    }
  };
  const pop = (): number => {
    const top = heap[0];
    const lastNode = heap.pop() ?? top;
    const lastValue = priority.pop() ?? 0;
    if (heap.length > 0) {
      heap[0] = lastNode;
      priority[0] = lastValue;
      for (let index = 0; ;) {
        const left = index * 2 + 1;
        const right = left + 1;
        let smallest = index;
        if (left < heap.length && priority[left] < priority[smallest]) smallest = left;
        if (right < heap.length && priority[right] < priority[smallest]) smallest = right;
        if (smallest === index) break;
        [heap[smallest], heap[index]] = [heap[index], heap[smallest]];
        [priority[smallest], priority[index]] = [priority[index], priority[smallest]];
        index = smallest;
      }
    }
    return top;
  };
  best[start] = 0;
  push(start, 0);
  while (heap.length > 0) {
    const current = pop();
    if (current === goal) break;
    const cx = current % cols;
    const cy = Math.floor(current / cols);
    for (const [dx, dy] of STEPS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (!inside(nx, ny)) continue;
      const key = ny * cols + nx;
      if (!walkable[key]) continue;
      const value = best[current] + cost[key];
      if (value >= best[key]) continue;
      best[key] = value;
      previous.set(key, current);
      push(key, value + Math.abs(nx - to.x) + Math.abs(ny - to.y));
    }
  }
  return previous.has(goal) ? unwind(previous, goal, cols) : null;
}
