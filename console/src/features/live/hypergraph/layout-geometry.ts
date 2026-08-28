export interface Point {
  x: number;
  y: number;
}

/**
 * How much space a node ACTUALLY occupies on screen, measured from its center.
 *
 * A node is not a point: it is the avatar **plus** its name below **plus** the queue bubble on
 * the top right. Spacing them by circular `nodeSpacing` against the avatar's radius is exactly
 * the mistake that made `zeus` overlap `argos`: the avatars never touched, but their names and
 * bubbles did. The box is asymmetric because the drawing is (the name only hangs downward).
 */
export interface NodeFootprint {
  /** Half-width: half of the longest expected name, not the avatar's radius. */
  halfWidth: number;
  /** Offset of the top edge from the center (negative). */
  top: number;
  /** Offset of the bottom edge from the center (positive). */
  bottom: number;
}

/** Hypergraph node: 9-px dot with its alias below. */
export const NODE_FOOTPRINT: NodeFootprint = { halfWidth: 32, top: -20, bottom: 36 };

/**
 * Do two nodes placed at `a` and `b` overlap?
 *
 * Exported because it is the condition the tests assert: two axis-aligned boxes overlap iff
 * they overlap on both axes at once. Checking it with Euclidean distance against a radius is
 * simpler and wrong — it lets through exactly the cases that look ugly (two nodes nearly at
 * the same height, separated just enough that the circles do not touch but the names do).
 */
export function footprintsOverlap(a: Point, b: Point, box: NodeFootprint = NODE_FOOTPRINT): boolean {
  const width = box.halfWidth * 2;
  const height = box.bottom - box.top;
  return Math.abs(b.x - a.x) < width && Math.abs(b.y - a.y) < height;
}

/**
 * Deterministic hash (32-bit FNV-1a) over a string.
 *
 * Used to break ties on initial positions without resorting to a random generator: the same
 * string always produces the same offset, so the drawing is reproducible across refreshes,
 * sessions and machines.
 */
export function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** Deterministic pseudo-random in [0, 1) derived from a string and a channel. */
export function jitter(seed: string, channel: number): number {
  return (hashString(`${seed}::${String(channel)}`) % 10_000) / 10_000;
}

/** Convex hull (Andrew's monotone chain). Returns the vertices in clockwise order. */
export function convexHull(points: Point[]): Point[] {
  if (points.length <= 2) return points.slice();
  const sorted = points
    .slice()
    .sort((a, b) => (a.x === b.x ? a.y - b.y : a.x - b.x));

  const cross = (o: Point, a: Point, b: Point): number =>
    (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);

  const lower: Point[] = [];
  for (const point of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], point) <= 0) lower.pop();
    lower.push(point);
  }
  const upper: Point[] = [];
  for (let index = sorted.length - 1; index >= 0; index -= 1) {
    const point = sorted[index];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], point) <= 0) upper.pop();
    upper.push(point);
  }
  lower.pop();
  upper.pop();
  const hull = lower.concat(upper);
  return hull.length >= 3 ? hull : sorted;
}

export function normalize(vector: Point): Point {
  const length = Math.hypot(vector.x, vector.y);
  if (length < 1e-9) return { x: 0, y: 0 };
  return { x: vector.x / length, y: vector.y / length };
}

/**
 * Inflates a convex polygon by pushing each vertex along its exterior bisector.
 *
 * For a convex polygon, `(v - previous) + (v - next)` points outward, so it serves as the
 * inflation direction without computing per-edge normals. Preferred over pushing from the
 * centroid because on elongated hulls (two or three nodes nearly aligned) the radial push
 * leaves the ends with no padding and the outline ends up cutting the nodes it should contain.
 */
export function inflateHull(hull: Point[], padding: number): Point[] {
  const count = hull.length;
  if (count === 0) return [];
  if (count === 1) {
    // Single member: a circle. Approximated with 8 points so the smoothing closes it round.
    const [center] = hull;
    return Array.from({ length: 8 }, (_, index) => {
      const angle = (index / 8) * Math.PI * 2;
      return { x: center.x + Math.cos(angle) * padding, y: center.y + Math.sin(angle) * padding };
    });
  }
  if (count === 2) {
    // Two members: a capsule. Extends `padding` along the axis and `padding` perpendicular to it.
    const [a, b] = hull;
    const axis = normalize({ x: b.x - a.x, y: b.y - a.y });
    const perpendicular = { x: -axis.y, y: axis.x };
    const extend = (point: Point, sign: number): Point => ({
      x: point.x + axis.x * padding * sign,
      y: point.y + axis.y * padding * sign,
    });
    const shift = (point: Point, sign: number): Point => ({
      x: point.x + perpendicular.x * padding * sign,
      y: point.y + perpendicular.y * padding * sign,
    });
    const tailA = extend(a, -1);
    const tailB = extend(b, 1);
    return [shift(tailA, 1), shift(tailB, 1), shift(tailB, -1), shift(tailA, -1)];
  }

  return hull.map((vertex, index) => {
    const previous = hull[(index - 1 + count) % count];
    const next = hull[(index + 1) % count];
    const outward = normalize({
      x: normalize({ x: vertex.x - previous.x, y: vertex.y - previous.y }).x
        + normalize({ x: vertex.x - next.x, y: vertex.y - next.y }).x,
      y: normalize({ x: vertex.x - previous.x, y: vertex.y - previous.y }).y
        + normalize({ x: vertex.x - next.x, y: vertex.y - next.y }).y,
    });
    return { x: vertex.x + outward.x * padding, y: vertex.y + outward.y * padding };
  });
}

/**
 * Converts a closed polygon into a smooth `path` (Catmull-Rom to cubic Bezier).
 *
 * The smoothing is what makes a hyperedge read as "a region that contains things" rather than a
 * technical polygon. It is purely visual: it does not move nodes nor change who is inside.
 */
export function closedSmoothPath(points: Point[]): string {
  const count = points.length;
  if (count === 0) return '';
  if (count === 1) return `M ${String(round(points[0].x))} ${String(round(points[0].y))}`;

  const segments: string[] = [`M ${String(round(points[0].x))} ${String(round(points[0].y))}`];
  for (let index = 0; index < count; index += 1) {
    const p0 = points[(index - 1 + count) % count];
    const p1 = points[index];
    const p2 = points[(index + 1) % count];
    const p3 = points[(index + 2) % count];
    const c1 = { x: p1.x + (p2.x - p0.x) / 6, y: p1.y + (p2.y - p0.y) / 6 };
    const c2 = { x: p2.x - (p3.x - p1.x) / 6, y: p2.y - (p3.y - p1.y) / 6 };
    segments.push(`C ${String(round(c1.x))} ${String(round(c1.y))}, ${String(round(c2.x))} ${String(round(c2.y))}, ${String(round(p2.x))} ${String(round(p2.y))}`);
  }
  segments.push('Z');
  return segments.join(' ');
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}

export function centroidOf(points: Point[]): Point {
  if (points.length === 0) return { x: 0, y: 0 };
  const sum = points.reduce((acc, point) => ({ x: acc.x + point.x, y: acc.y + point.y }), { x: 0, y: 0 });
  return { x: sum.x / points.length, y: sum.y / points.length };
}

/** Point-in-polygon (ray casting). Used by the tests: the outline must contain its members. */
export function pointInPolygon(point: Point, polygon: Point[]): boolean {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i, i += 1) {
    const a = polygon[i];
    const b = polygon[j];
    const intersects = (a.y > point.y) !== (b.y > point.y)
      && point.x < ((b.x - a.x) * (point.y - a.y)) / (b.y - a.y) + a.x;
    if (intersects) inside = !inside;
  }
  return inside;
}
