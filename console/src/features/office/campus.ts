import { CORE, LOT_H, LOT_W, STREET, YARD_H, YARD_W, type Cell } from './campus-lots';
import { CAMPUS, TILE, emptyLevel, spotAt, type Furniture, type Level, type LevelKind, type Point, type Spot, type Zone } from './level';

export interface Phase { kind: 'build' | 'demolish'; since: number }

export interface SiteSpec {
  /** Level id of the building's interior. */
  id: string;
  kind: Exclude<LevelKind, 'campus'>;
  label: string;
  hue: number;
  cell: Cell;
  /** Desks for a group building; it sets the size of the house and its windows. */
  seats: number;
  phase?: Phase;
}

export interface Site extends SiteSpec {
  /** Footprint in tiles. */
  x: number;
  y: number;
  w: number;
  h: number;
  /** The doorway on the facade, where people step in and out. */
  door: Spot;
  /** Where the building's tube leaves its wall, in art px; only group buildings have one. */
  outlet: Point | null;
}

export interface Campus extends Level {
  sites: Site[];
  siteOf: ReadonlyMap<string, Site>;
  hub: Point;
  /** Tube from each group building's outlet to the hub, in art px. */
  tubes: ReadonlyMap<string, readonly Point[]>;
  stop: Spot;
  gateX: number;
  fenceY: number;
  roadY: number;
  vacant: Point[];
  /** Top-left tile of the plaza lot: it anchors the campus when it grows. */
  plaza: Point;
}

const EDGE = 1;
const TOP = 2;
const BAND = 5;
const GRASS_COST = 4;

/** Footprint of a building in tiles; group houses grow with their desks. */
export function footprint(kind: SiteSpec['kind'], seats: number): { w: number; h: number } {
  switch (kind) {
    case 'park': return { w: 9, h: 7 };
    case 'lobby': return { w: 9, h: 4 };
    case 'dorm': return { w: 7, h: 5 };
    case 'cafe':
    case 'shop': return { w: 7, h: 4 };
    default:
      if (seats <= 4) return { w: 5, h: 4 };
      if (seats <= 8) return { w: 7, h: 4 };
      return seats <= 12 ? { w: 7, h: 5 } : { w: 9, h: 5 };
  }
}

export function buildCampus(specs: readonly SiteSpec[], label = 'Campus'): Campus {
  const cells = [...Object.values(CORE), ...specs.map((spec) => spec.cell)];
  const cMin = Math.min(...cells.map((cell) => cell.c));
  const cMax = Math.max(...cells.map((cell) => cell.c));
  const rMax = Math.max(...cells.map((cell) => cell.r));
  const ox = (c: number) => EDGE + (c - cMin) * LOT_W;
  const oy = (r: number) => TOP + (rMax - r) * LOT_H;
  const cols = EDGE + (cMax - cMin + 1) * LOT_W + STREET + EDGE;
  const fenceY = TOP + (rMax + 1) * LOT_H;
  const rows = fenceY + BAND;
  const plaza = { x: ox(CORE.plaza.c) + STREET, y: oy(CORE.plaza.r) };
  const gateX = plaza.x + 4;
  const gate: Spot = { tile: { x: gateX, y: fenceY }, px: { x: (gateX + 1) * TILE, y: fenceY * TILE + TILE - 3 }, dir: 'up' };
  const level = emptyLevel(CAMPUS, 'campus', label, -1, cols, rows, gate);
  level.outdoor = true;
  const walkable = new Array<boolean>(cols * rows).fill(false);
  const cost = new Uint8Array(cols * rows).fill(GRASS_COST);
  const zones: Zone[] = [{ kind: 'grass', x: 0, y: 0, w: cols, h: rows }];
  const furniture: Furniture[] = [];
  const set = (x: number, y: number, w: number, h: number, open: boolean, price?: number) => {
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx < 0 || ty < 0 || tx >= cols || ty >= rows) continue;
        walkable[ty * cols + tx] = open;
        if (price !== undefined) cost[ty * cols + tx] = price;
      }
    }
  };
  const put = (piece: Furniture, w = 1, h = 1) => {
    furniture.push(piece);
    set(piece.x, piece.y, w, h, false);
  };

  for (let c = cMin; c <= cMax + 1; c += 1) {
    zones.push({ kind: 'street', x: ox(c), y: TOP, w: STREET, h: fenceY - TOP });
    set(ox(c), TOP, STREET, fenceY - TOP, true, 1);
  }
  for (let r = 0; r <= rMax; r += 1) {
    zones.push({ kind: 'street', x: EDGE, y: oy(r) + YARD_H, w: cols - 2 * EDGE, h: STREET });
    set(EDGE, oy(r) + YARD_H, cols - 2 * EDGE, STREET, true, 1);
  }
  zones.push(
    { kind: 'hedge', x: 0, y: TOP, w: 1, h: fenceY - TOP }, { kind: 'hedge', x: cols - 1, y: TOP, w: 1, h: fenceY - TOP },
    { kind: 'sidewalk', x: 0, y: fenceY + 1, w: cols, h: 1 }, { kind: 'road', x: 0, y: fenceY + 2, w: cols, h: 2 },
  );
  set(EDGE, fenceY + 1, cols - 2 * EDGE, 1, true, 1);
  set(gateX, fenceY, 2, 1, true, 1);
  for (let x = 1; x < cols - 1; x += 2) furniture.push({ kind: 'tree', x, y: 1, variant: x });
  const stopX = gateX + 3;
  const stop = spotAt({ x: stopX, y: fenceY + 1 }, 'left');
  set(stopX + 1, fenceY + 1, 2, 1, false);

  const taken = new Map(specs.map((spec) => [`${String(spec.cell.c)},${String(spec.cell.r)}`, spec]));
  const vacant: Point[] = [];
  for (let r = 0; r <= rMax; r += 1) {
    for (let c = cMin; c <= cMax; c += 1) {
      const x0 = ox(c) + STREET;
      const y0 = oy(r);
      set(x0, y0, YARD_W, YARD_H, true, GRASS_COST);
      if (c === CORE.plaza.c && r === CORE.plaza.r) continue;
      if (!taken.has(`${String(c)},${String(r)}`)) {
        vacant.push({ x: x0 + 4, y: y0 + 4 });
        put({ kind: 'tree', x: x0 + 1, y: y0 + 1, variant: c * 7 + r });
        put({ kind: 'tree', x: x0 + YARD_W - 2, y: y0 + 2, variant: c + r * 3 });
        put({ kind: 'flowers', x: x0 + 2, y: y0 + YARD_H - 2, w: 2, variant: c * 3 + r });
      }
    }
  }

  const hub = { x: (plaza.x + 5) * TILE, y: (plaza.y + 3) * TILE };
  zones.push({ kind: 'plaza', x: plaza.x, y: plaza.y, w: YARD_W, h: YARD_H });
  set(plaza.x, plaza.y, YARD_W, YARD_H, true, 1);
  set(plaza.x + 4, plaza.y + 2, 2, 2, false);
  put({ kind: 'bench', x: plaza.x + 1, y: plaza.y + 5 }, 2, 1);
  put({ kind: 'bench', x: plaza.x + 7, y: plaza.y + 5 }, 2, 1);
  put({ kind: 'flowers', x: plaza.x + 1, y: plaza.y + 1, w: 2, variant: 4 }, 2, 1);
  put({ kind: 'flowers', x: plaza.x + 7, y: plaza.y + 1, w: 2, variant: 9 }, 2, 1);
  put({ kind: 'lamp', x: plaza.x, y: plaza.y + YARD_H - 1 });
  put({ kind: 'lamp', x: plaza.x + YARD_W - 1, y: plaza.y + YARD_H - 1 });

  const lane = { left: ox(0) * TILE + 26, right: ox(1) * TILE + 6 };
  const sites: Site[] = [];
  const tubes = new Map<string, Point[]>();
  for (const spec of specs) {
    const { w, h } = footprint(spec.kind, spec.seats);
    const x0 = ox(spec.cell.c) + STREET;
    const y0 = oy(spec.cell.r);
    const bx = x0 + Math.floor((YARD_W - w) / 2);
    const by = y0 + YARD_H - 1 - h;
    const doorX = bx + Math.floor(w / 2);
    set(bx, by, w, h, false);
    set(doorX, by + h - 1, 1, 1, true, 1);
    set(doorX, by + h, 1, y0 + YARD_H - by - h, true, 1);
    zones.push({ kind: 'path', x: doorX, y: by + h, w: 1, h: y0 + YARD_H - by - h });
    if (h <= 5) {
      put({ kind: 'tree', x: x0, y: y0 + 1, variant: spec.cell.c * 5 + spec.cell.r });
      put({ kind: 'tree', x: x0 + YARD_W - 1, y: y0 + 1, variant: spec.cell.c + spec.cell.r });
    }
    if (w >= 7 && by + h < y0 + YARD_H) {
      put({ kind: 'flowers', x: bx, y: by + h, w: 2, variant: spec.cell.c * 11 + spec.cell.r }, 2, 1);
      put({ kind: 'flowers', x: bx + w - 2, y: by + h, w: 2, variant: spec.cell.c + spec.cell.r * 13 }, 2, 1);
    }
    const door: Spot = { tile: { x: doorX, y: by + h - 1 }, px: { x: doorX * TILE + TILE / 2, y: (by + h - 1) * TILE + TILE - 3 }, dir: 'down' };
    const outlet = spec.kind === 'group' ? { x: (bx + w) * TILE + 4, y: (by + h) * TILE - 10 } : null;
    sites.push({ ...spec, x: bx, y: by, w, h, door, outlet });
    if (outlet) {
      const street = (y0 + YARD_H) * TILE + 5;
      const trunk = spec.cell.c < 0 ? lane.left : lane.right;
      const side = spec.cell.c < 0 ? hub.x - 18 : hub.x + 18;
      tubes.set(spec.id, [outlet, { x: outlet.x, y: street }, { x: trunk, y: street }, { x: trunk, y: hub.y }, { x: side, y: hub.y }]);
    }
  }

  return {
    ...level,
    walkable, cost, zones, furniture,
    sites, siteOf: new Map(sites.map((site) => [site.id, site])),
    hub, tubes, stop, gateX, fenceY, roadY: fenceY + 2, vacant, plaza,
  };
}

/** The route a capsule flies: out of the sender's wall, through the hub, into the receiver's wall. */
export function capsuleRoute(campus: Campus, from: string, to: string): Point[] | null {
  const out = campus.tubes.get(from);
  const back = campus.tubes.get(to);
  if (!out || !back) return null;
  return [...out, campus.hub, ...[...back].reverse()];
}

export function routeLength(route: readonly Point[]): number {
  let total = 0;
  for (let index = 1; index < route.length; index += 1) total += Math.hypot(route[index].x - route[index - 1].x, route[index].y - route[index - 1].y);
  return total;
}

/** Position along a route `distance` px from its start. */
export function alongRoute(route: readonly Point[], distance: number, out: Point): Point {
  let left = Math.max(0, distance);
  for (let index = 1; index < route.length; index += 1) {
    const a = route[index - 1];
    const b = route[index];
    const length = Math.hypot(b.x - a.x, b.y - a.y);
    if (left <= length && length > 0) {
      out.x = a.x + ((b.x - a.x) * left) / length;
      out.y = a.y + ((b.y - a.y) * left) / length;
      return out;
    }
    left -= length;
  }
  const last = route.at(-1) ?? { x: 0, y: 0 };
  out.x = last.x;
  out.y = last.y;
  return out;
}
