import { settle, shell, windows } from './interior';
import { TILE, WALL_ROWS, spotAt, type Level, type Point, type Spot } from './level';

export const SHARED_IDS = {
  cafe: 'cafeteria',
  dorm: 'residencia',
  park: 'parque',
  lobby: 'recepcion',
  shop: 'taller',
} as const;
export type SharedKind = keyof typeof SHARED_IDS;
export const SHARED_LABELS: Readonly<Record<SharedKind, string>> = {
  cafe: 'Cafetería',
  dorm: 'Residencia',
  park: 'Parque',
  lobby: 'Recepción',
  shop: 'Taller',
};

const NEUTRAL = -1;
const BED_SLOTS = 4;
const SLOT_W = 3;

/** Two-tile sweeping lanes near the middle of the floor, clear of every other spot. */
export function sweepSpots(level: Level, used: ReadonlySet<string>, count = 1): Spot[] {
  const tiles: Point[] = [];
  for (let y = WALL_ROWS; y < level.rows - 1; y += 1) for (let x = 1; x < level.cols - 2; x += 1) tiles.push({ x, y });
  const mid = { x: level.cols / 2, y: (WALL_ROWS + level.rows) / 2 };
  tiles.sort((a, b) => Math.hypot(a.x - mid.x, a.y - mid.y) - Math.hypot(b.x - mid.x, b.y - mid.y));
  const taken = new Set(used);
  const out: Spot[] = [];
  const open = (x: number, y: number) => level.walkable[y * level.cols + x] && !taken.has(`${String(x)},${String(y)}`);
  for (const tile of tiles) {
    if (out.length >= count) break;
    if (!open(tile.x, tile.y) || !open(tile.x + 1, tile.y) || (tile.y === level.door.tile.y - 1)) continue;
    taken.add(`${String(tile.x)},${String(tile.y)}`).add(`${String(tile.x + 1)},${String(tile.y)}`);
    const next = { x: tile.x + 1, y: tile.y };
    out.push(spotAt(tile, 'right', { from: spotAt(next, 'left') }));
  }
  return out;
}

export const keyOf = (spot: Spot) => `${String(spot.tile.x)},${String(spot.tile.y)}`;

/** Kitchen along the back wall, a coffee corner and tables to eat at. */
export function buildCafe(): Level {
  const cols = 16;
  const rows = 12;
  const s = shell(SHARED_IDS.cafe, 'cafe', SHARED_LABELS.cafe, NEUTRAL, cols, rows);
  const { level } = s;
  const kx = 2;
  const ky = WALL_ROWS;
  s.floor({ kind: 'tile', x: 1, y: WALL_ROWS, w: cols - 2, h: rows - WALL_ROWS - 1 });
  s.floor({ kind: 'rug', x: 3, y: 7, w: 10, h: 3 });
  s.floor({ kind: 'mat', x: s.doorX, y: rows - 2, w: 2, h: 1 });
  s.put({ kind: 'counter', x: kx, y: ky, w: 4 }, 5, 1);
  level.furniture.push({ kind: 'coffee', x: kx + 1, y: ky }, { kind: 'fridge', x: kx + 4, y: ky });
  s.put({ kind: 'stove', x: kx + 5, y: ky });
  s.put({ kind: 'shelf', x: kx + 8, y: ky });
  s.put({ kind: 'plant', x: kx + 9, y: ky, big: true });
  s.put({ kind: 'table', x: kx + 6, y: ky + 2 });
  s.put({ kind: 'cooler', x: kx + 9, y: ky + 2 });
  s.put({ kind: 'crates', x: kx + 9, y: ky + 3 });
  s.put({ kind: 'vending', x: cols - 3, y: ky });
  s.put({ kind: 'plant', x: cols - 2, y: rows - 2, big: false });
  s.put({ kind: 'plant', x: 1, y: rows - 2, big: false });
  const stools: Point[] = [{ x: kx + 5, y: ky + 2 }, { x: kx + 7, y: ky + 2 }];
  for (const tx of [4, 11]) {
    s.put({ kind: 'table', x: tx, y: 8 });
    stools.push({ x: tx - 1, y: 8 }, { x: tx + 1, y: 8 });
  }
  for (const stool of stools) level.furniture.push({ kind: 'stool', ...stool });
  s.hang({ kind: 'menu', x: 12, w: 3, y: 0 });
  s.hang({ kind: 'clock', x: 10, w: 1, y: 0 });
  windows(s, 1, 10, []);
  const eat = stools.map((tile, index) => spotAt(tile, index % 2 === 0 ? 'right' : 'left', { seated: true }));
  const coffee = [1, 2, 3, 0].map((dx) => spotAt({ x: kx + dx, y: ky + 1 }, 'up'));
  const cook = [spotAt({ x: kx + 5, y: ky + 1 }, 'up')];
  const tidy = [spotAt({ x: kx + 8, y: ky + 1 }, 'up', { from: spotAt({ x: kx + 8, y: ky + 3 }, 'right') })];
  const used = new Set([...eat, ...coffee, ...cook, ...tidy, ...tidy.flatMap((spot) => (spot.from ? [spot.from] : []))].map(keyOf));
  level.routine = { coffee, cook, eat, tidy, sweep: sweepSpots(level, used) };
  settle(level);
  return level;
}

/** Rows of beds with a nightstand each; only the long idle come here to nap. */
export function buildDorm(beds: number): Level {
  const count = Math.max(2, beds);
  const bedRows = Math.ceil(count / BED_SLOTS);
  const cols = 2 + 1 + BED_SLOTS * SLOT_W + 1;
  const rows = WALL_ROWS + 1 + bedRows * 2 + 2 + 1;
  const s = shell(SHARED_IDS.dorm, 'dorm', SHARED_LABELS.dorm, NEUTRAL, cols, rows);
  const { level } = s;
  s.floor({ kind: 'rest', x: 1, y: WALL_ROWS, w: cols - 2, h: rows - WALL_ROWS - 1 });
  s.floor({ kind: 'mat', x: s.doorX, y: rows - 2, w: 2, h: 1 });
  for (let index = 0; index < count; index += 1) {
    const x = 2 + (index % BED_SLOTS) * SLOT_W;
    const y = WALL_ROWS + 1 + 2 * Math.floor(index / BED_SLOTS);
    s.put({ kind: 'nightstand', x, y });
    s.put({ kind: 'bed', x: x + 1, y, variant: index }, 2, 1);
    level.beds.push({ tile: { x: x + 1, y: y + 1 }, px: { x: (x + 1) * TILE + 16, y: y * TILE + 9 }, dir: 'right', rest: 'bed', variant: index });
  }
  for (let row = 0; row < bedRows; row += 1) s.floor({ kind: 'rug', x: 2, y: WALL_ROWS + 1 + row * 2, w: BED_SLOTS * SLOT_W, h: 1 });
  s.put({ kind: 'plant', x: cols - 2, y: rows - 2, big: true });
  s.put({ kind: 'plant', x: 1, y: rows - 2, big: false });
  windows(s, 2, cols - 1, [], 'night');
  settle(level);
  return level;
}

/** Where MCP visitors wait: a front desk with the mailboxes behind it, sofas and standing room. */
export function buildLobby(): Level {
  const cols = 16;
  const rows = 11;
  const s = shell(SHARED_IDS.lobby, 'lobby', SHARED_LABELS.lobby, NEUTRAL, cols, rows);
  const { level } = s;
  s.floor({ kind: 'wood', x: 1, y: WALL_ROWS, w: cols - 2, h: rows - WALL_ROWS - 1 });
  s.floor({ kind: 'rug', x: 2, y: 4, w: 4, h: 5 });
  s.floor({ kind: 'mat', x: s.doorX, y: rows - 2, w: 2, h: 1 });
  s.put({ kind: 'reception', x: 7, y: 5, w: 4 }, 4, 1);
  s.hang({ kind: 'mailboxes', x: 7, w: 4, y: 0 });
  s.hang({ kind: 'poster', x: 12, w: 2, y: 0 });
  windows(s, 1, 6, []);
  s.put({ kind: 'sofa', x: 2, y: 4, w: 2 }, 2, 1);
  s.put({ kind: 'sofa', x: 2, y: 7, w: 2 }, 2, 1);
  s.put({ kind: 'plant', x: 1, y: WALL_ROWS, big: true });
  s.put({ kind: 'plant', x: cols - 2, y: WALL_ROWS, big: true });
  s.put({ kind: 'cooler', x: cols - 2, y: rows - 2 });
  s.put({ kind: 'lamp', x: 5, y: 4 });
  const sofa = (x: number, y: number): Spot => ({ tile: { x, y: y + 1 }, px: { x: x * TILE + TILE / 2, y: y * TILE + TILE - 6 }, dir: 'down', seated: true });
  level.waiting = [
    sofa(2, 4), sofa(3, 4), sofa(2, 7), sofa(3, 7),
    spotAt({ x: 8, y: 6 }, 'up'), spotAt({ x: 9, y: 6 }, 'up'), spotAt({ x: 12, y: 7 }, 'left'), spotAt({ x: 12, y: 8 }, 'left'),
  ];
  settle(level);
  return level;
}

/** Repair pods for the agents that are down and a help desk where the blocked queue. */
export function buildShop(pods: number): Level {
  const count = Math.max(2, pods);
  const perColumn = 3;
  const podCols = Math.ceil(count / perColumn);
  const cols = Math.max(16, 9 + podCols * 3);
  const rows = WALL_ROWS + Math.max(8, Math.min(count, perColumn) * 2 + 2) + 1;
  const s = shell(SHARED_IDS.shop, 'shop', SHARED_LABELS.shop, NEUTRAL, cols, rows);
  const { level } = s;
  s.floor({ kind: 'concrete', x: 1, y: WALL_ROWS, w: cols - 2, h: rows - WALL_ROWS - 1 });
  s.floor({ kind: 'mat', x: s.doorX, y: rows - 2, w: 2, h: 1 });
  for (let index = 0; index < count; index += 1) {
    const x = 2 + Math.floor(index / perColumn) * 3;
    const y = WALL_ROWS + 1 + (index % perColumn) * 2;
    s.put({ kind: 'pod', x, y, variant: index }, 2, 1);
    level.repair.push({ tile: { x, y: y + 1 }, px: { x: x * TILE + 16, y: y * TILE + 9 }, dir: 'right', rest: 'pod', variant: index });
  }
  const desk = cols - 6;
  s.put({ kind: 'helpdesk', x: desk, y: WALL_ROWS + 1, w: 3 }, 3, 1);
  level.help = [0, 1, 2].map((dx) => spotAt({ x: desk + dx, y: WALL_ROWS + 2 }, 'up'));
  level.help.push(spotAt({ x: desk + 1, y: WALL_ROWS + 4 }, 'up'));
  s.put({ kind: 'workbench', x: desk, y: rows - 4, w: 2 }, 2, 1);
  s.put({ kind: 'drum', x: cols - 2, y: rows - 2 });
  s.put({ kind: 'crates', x: cols - 2, y: rows - 3 });
  s.put({ kind: 'plant', x: 1, y: rows - 2, big: false });
  s.hang({ kind: 'tools', x: 2, w: 4, y: 0 });
  s.hang({ kind: 'poster', x: desk, w: 2, y: 0 });
  windows(s, 7, desk - 1, []);
  settle(level);
  return level;
}

