/** Tile edge, in art pixels. */
export const TILE = 16;
/** The back wall takes the first rows; the floor starts below it. */
export const WALL_ROWS = 3;
const SEATS_PER_POD = 4;
const POD_W = 4;
const POD_H = 4;
const LOUNGE_W = 9;
const LOUNGE_H = 9;

export interface Point { x: number; y: number }
export type Dir = 'down' | 'up' | 'left' | 'right';

/** A place a character can occupy: the tile it paths to, and its exact feet position in art px. */
export interface Spot { tile: Point; px: Point; dir: Dir }

export interface DeskSlot {
  index: number;
  /** Left tile of the two-tile desk. */
  x: number;
  deskY: number;
  chairY: number;
  /** Where the seated person looks: `down` faces the viewer, `up` faces the monitor. */
  facing: 'down' | 'up';
  seat: Spot;
  visit: Spot;
}

export type Furniture =
  | { kind: 'desk'; x: number; y: number; slot: number }
  | { kind: 'chair'; x: number; y: number; slot: number; facing: 'down' | 'up' }
  | { kind: 'sofa'; x: number; y: number; w: number; facing: 'down' | 'up'; alt: boolean }
  | { kind: 'beanbag'; x: number; y: number; variant: 0 | 1 }
  | { kind: 'table'; x: number; y: number }
  | { kind: 'plant'; x: number; y: number; big: boolean }
  | { kind: 'counter'; x: number; y: number; w: number }
  | { kind: 'coffee'; x: number; y: number }
  | { kind: 'fridge'; x: number; y: number }
  | { kind: 'rack'; x: number; y: number }
  | { kind: 'cooler'; x: number; y: number }
  | { kind: 'shelf'; x: number; y: number };

export interface WallItem { kind: 'window' | 'board' | 'clock'; x: number; w: number }
export interface Zone { kind: 'carpet' | 'wood' | 'tile' | 'rug' | 'partition'; x: number; y: number; w: number; h: number }

export interface OfficeLayout {
  cols: number;
  rows: number;
  walkable: boolean[];
  desks: DeskSlot[];
  furniture: Furniture[];
  wall: WallItem[];
  zones: Zone[];
  /** Sofa and beanbag places where idle people nap, best first. */
  lounge: Spot[];
  /** Standing places in front of the coffee machine. */
  coffee: Spot[];
  /** Free floor tiles worth strolling to. */
  wander: Point[];
}

export interface LayoutParams {
  pods: number;
  podCols: number;
  side: 'right' | 'bottom';
  /** One-tile margins and gaps: lets two pods sit side by side on a phone, or the room grow a scale step. */
  compact: boolean;
}

function workSize(params: LayoutParams): { w: number; h: number } {
  const podRows = Math.ceil(params.pods / params.podCols);
  const margin = params.compact ? 1 : 2;
  const gap = params.compact ? 1 : 2;
  return {
    w: margin * 2 + params.podCols * POD_W + (params.podCols - 1) * gap,
    h: margin * 2 + podRows * POD_H + (podRows - 1) * 2,
  };
}

export function layoutSize(params: LayoutParams): { cols: number; rows: number } {
  const work = workSize(params);
  if (params.side === 'right') {
    return { cols: work.w + LOUNGE_W, rows: WALL_ROWS + Math.max(work.h, LOUNGE_H) };
  }
  return { cols: Math.max(work.w, LOUNGE_W + 2), rows: WALL_ROWS + work.h + 1 + LOUNGE_H };
}

export function podsFor(count: number): number {
  return Math.max(1, Math.ceil(count / SEATS_PER_POD));
}

const centerPx = (tile: Point): Point => ({ x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 3 });

export function buildLayout(params: LayoutParams): OfficeLayout {
  const { cols, rows } = layoutSize(params);
  const work = workSize(params);
  const margin = params.compact ? 1 : 2;
  const gap = params.compact ? 1 : 2;
  const workX = params.side === 'bottom' ? Math.floor((cols - work.w) / 2) : 0;
  const top = WALL_ROWS;
  const blocked = new Array<boolean>(cols * rows).fill(false);
  const block = (x: number, y: number, w = 1, h = 1) => {
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) blocked[(y + dy) * cols + x + dx] = true;
  };
  for (let y = 0; y < WALL_ROWS; y += 1) block(0, y, cols, 1);

  const furniture: Furniture[] = [];
  const desks: DeskSlot[] = [];
  const zones: Zone[] = [{ kind: 'carpet', x: workX, y: top, w: work.w, h: rows - top }];

  for (let pod = 0; pod < params.pods; pod += 1) {
    const px = workX + margin + (pod % params.podCols) * (POD_W + gap);
    const py = top + margin + Math.floor(pod / params.podCols) * (POD_H + 2);
    for (let seat = 0; seat < SEATS_PER_POD; seat += 1) {
      const x = px + (seat % 2) * 2;
      const facing = seat < 2 ? 'down' : 'up';
      const chairY = facing === 'down' ? py : py + 3;
      const deskY = facing === 'down' ? py + 1 : py + 2;
      const index = desks.length;
      const seatTile = { x, y: chairY };
      const visitTile = { x, y: facing === 'down' ? py - 1 : py + 4 };
      desks.push({
        index, x, deskY, chairY, facing,
        seat: { tile: seatTile, px: { x: (x + 1) * TILE, y: chairY * TILE + TILE - 3 }, dir: facing },
        visit: { tile: visitTile, px: { x: (x + 1) * TILE, y: visitTile.y * TILE + TILE - 3 }, dir: facing },
      });
      furniture.push({ kind: 'desk', x, y: deskY, slot: index });
      furniture.push({ kind: 'chair', x, y: chairY, slot: index, facing });
      block(x, deskY, 2, 1);
      block(x, chairY);
    }
  }

  const plant = (x: number, y: number, big: boolean) => {
    furniture.push({ kind: 'plant', x, y, big });
    block(x, y);
  };
  plant(workX, top, true);
  plant(workX + work.w - 1, rows - 1, false);
  if (params.side === 'right') plant(workX, rows - 1, false);

  const lx = params.side === 'right' ? work.w : Math.floor((cols - LOUNGE_W) / 2);
  const ly = params.side === 'right' ? top : top + work.h + 1;
  if (params.side === 'bottom') {
    const door = lx + 6;
    zones.push({ kind: 'partition', x: 0, y: ly - 1, w: door, h: 1 });
    zones.push({ kind: 'partition', x: door + 2, y: ly - 1, w: cols - door - 2, h: 1 });
    block(0, ly - 1, door, 1);
    block(door + 2, ly - 1, cols - door - 2, 1);
  }
  zones.push({ kind: 'wood', x: params.side === 'right' ? lx : 0, y: params.side === 'right' ? ly : ly - 1, w: params.side === 'right' ? LOUNGE_W : cols, h: rows - ly + (params.side === 'right' ? 0 : 1) });
  zones.push({ kind: 'tile', x: lx, y: ly, w: 6, h: 3 });
  zones.push({ kind: 'rug', x: lx + 1, y: ly + 3, w: 7, h: 3 });

  furniture.push({ kind: 'counter', x: lx, y: ly, w: 4 });
  furniture.push({ kind: 'coffee', x: lx + 1, y: ly });
  furniture.push({ kind: 'fridge', x: lx + 4, y: ly });
  block(lx, ly, 5, 1);
  plant(lx + 8, ly, true);

  furniture.push({ kind: 'sofa', x: lx + 2, y: ly + 3, w: 3, facing: 'down', alt: false });
  furniture.push({ kind: 'table', x: lx + 3, y: ly + 4 });
  furniture.push({ kind: 'sofa', x: lx + 2, y: ly + 5, w: 3, facing: 'up', alt: true });
  furniture.push({ kind: 'beanbag', x: lx + 6, y: ly + 3, variant: 0 });
  furniture.push({ kind: 'beanbag', x: lx + 6, y: ly + 5, variant: 1 });
  block(lx + 2, ly + 3, 3, 1);
  block(lx + 3, ly + 4);
  block(lx + 2, ly + 5, 3, 1);
  block(lx + 6, ly + 3);
  block(lx + 6, ly + 5);
  plant(lx, ly + 4, false);
  furniture.push({ kind: 'rack', x: lx + 7, y: ly + 7 });
  furniture.push({ kind: 'rack', x: lx + 8, y: ly + 7 });
  block(lx + 7, ly + 7, 2, 1);
  furniture.push({ kind: 'cooler', x: lx, y: ly + 7 });
  block(lx, ly + 7);
  furniture.push({ kind: 'shelf', x: lx + 3, y: ly + 7 });
  block(lx + 3, ly + 7, 2, 1);
  plant(lx + 5, ly + 7, false);

  const walkable = blocked.map((value) => !value);
  const nearestFree = (tile: Point): Point => {
    const seen = new Set<number>([tile.y * cols + tile.x]);
    const queue: Point[] = [tile];
    for (const current of queue) {
      if (walkable[current.y * cols + current.x]) return current;
      for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
        const next = { x: current.x + dx, y: current.y + dy };
        const key = next.y * cols + next.x;
        if (next.x < 0 || next.y < 0 || next.x >= cols || next.y >= rows || seen.has(key)) continue;
        seen.add(key);
        queue.push(next);
      }
    }
    return tile;
  };

  for (const desk of desks) {
    desk.seat.tile = nearestFree(desk.seat.tile);
    desk.visit.tile = nearestFree(desk.visit.tile);
  }

  const seatSpot = (x: number, y: number, dir: Dir, dx = 0): Spot => ({
    tile: nearestFree({ x, y }),
    px: { x: x * TILE + TILE / 2 + dx, y: y * TILE + TILE - 3 },
    dir,
  });
  const lounge: Spot[] = [
    seatSpot(lx + 3, ly + 3, 'down'),
    seatSpot(lx + 3, ly + 5, 'up'),
    seatSpot(lx + 6, ly + 3, 'down'),
    seatSpot(lx + 6, ly + 5, 'down'),
    seatSpot(lx + 2, ly + 3, 'down', 2),
    seatSpot(lx + 4, ly + 5, 'up', -2),
    seatSpot(lx + 4, ly + 3, 'down', -2),
    seatSpot(lx + 2, ly + 5, 'up', 2),
  ];
  const coffee: Spot[] = [1, 2, 3, 0].map((dx) => ({
    tile: { x: lx + dx, y: ly + 1 }, px: centerPx({ x: lx + dx, y: ly + 1 }), dir: 'up' as const,
  }));

  const wander: Point[] = [];
  for (let y = top; y < rows; y += 1) {
    for (let x = 0; x < cols; x += 1) {
      if (walkable[y * cols + x] && (x + y * 3) % 5 === 0) wander.push({ x, y });
    }
  }

  const wall: WallItem[] = [];
  const workWallEnd = params.side === 'right' ? work.w : cols;
  for (let x = workX + 1, n = 0; x + 3 <= workWallEnd - 1; x += 5, n += 1) {
    wall.push({ kind: n === 1 ? 'board' : 'window', x, w: 3 });
  }
  if (params.side === 'right') {
    wall.push({ kind: 'clock', x: lx + 2, w: 1 });
    wall.push({ kind: 'window', x: lx + 5, w: 3 });
  }

  return { cols, rows, walkable, desks, furniture, wall, zones, lounge, coffee, wander };
}

export interface LayoutChoice { params: LayoutParams; scale: number }

/**
 * Picks the pod arrangement that shows the office largest inside the box. `scale` is in device
 * pixels per art pixel and always an integer, so pixels stay square and crisp. When nothing fits
 * the height at the minimum readable scale (phones), the height is let go and the page scrolls.
 */
export function chooseLayout(count: number, box: { width: number; height: number; dpr: number }): LayoutChoice {
  const pods = podsFor(count);
  const minScale = Math.ceil(1.6 * box.dpr);
  const maxScale = Math.floor(5 * box.dpr);
  const candidates: { params: LayoutParams; kw: number; kh: number; empty: number }[] = [];
  for (const compact of box.width < 700 ? [true] : [false, true]) for (const side of ['right', 'bottom'] as const) {
    for (let podCols = 1; podCols <= Math.min(pods, 8); podCols += 1) {
      const params = { pods, podCols, side, compact };
      const { cols, rows } = layoutSize(params);
      candidates.push({
        params,
        kw: Math.floor((box.width * box.dpr) / (cols * TILE)),
        kh: Math.floor((box.height * box.dpr) / (rows * TILE)),
        empty: Math.ceil(pods / podCols) * podCols - pods,
      });
    }
  }
  interface Entry { params: LayoutParams; k: number; empty: number }
  const area = (entry: Entry) => {
    const size = layoutSize(entry.params);
    return size.cols * size.rows * (entry.params.side === 'bottom' ? 1.25 : 1);
  };
  const better = (a: Entry, b: Entry) => (a.k !== b.k ? a.k > b.k
    : a.empty !== b.empty ? a.empty < b.empty
      : area(a) < area(b));

  let best: Entry | undefined;
  for (const candidate of candidates) {
    const k = Math.min(candidate.kw, candidate.kh, maxScale);
    if (k < minScale) continue;
    const entry = { params: candidate.params, k, empty: candidate.empty };
    if (!best || better(entry, best)) best = entry;
  }
  if (!best) {
    const fitting = candidates.filter((candidate) => candidate.kw >= minScale);
    const widest = fitting.sort((a, b) => b.params.podCols - a.params.podCols || (a.params.side === 'bottom' ? -1 : 1)).at(0);
    if (widest) return { params: widest.params, scale: Math.min(widest.kw, maxScale) };
    const narrow = candidates.find((candidate) => candidate.params.podCols === 1 && candidate.params.side === 'bottom');
    if (!narrow) throw new Error('chooseLayout: the single-column bottom candidate is always generated');
    return { params: narrow.params, scale: Math.max(1, narrow.kw) };
  }
  return { params: best.params, scale: best.k };
}
