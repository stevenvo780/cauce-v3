import { TILE } from './tile';

export { TILE } from './tile';
/** Interiors keep a back wall on their first rows; the floor starts below it. */
export const WALL_ROWS = 3;
export const CAMPUS = 'campus';

export interface Point { x: number; y: number }
export type Dir = 'down' | 'up' | 'left' | 'right';
export type GameKind = 'arcade' | 'pingpong' | 'foosball' | 'beanbag';

/** A place a character can occupy: the tile it paths to, and its exact feet position in art px. */
export interface Spot {
  tile: Point;
  px: Point;
  dir: Dir;
  rest?: 'bed' | 'pod';
  game?: GameKind;
  station?: number;
  variant?: number;
  /** Chat spots come in pairs facing each other; `variant` says which side of the pair. */
  pair?: number;
  /** Where a tidier picks the next box up before carrying it here. */
  from?: Spot;
  seated?: boolean;
}

export type Activity = 'cook' | 'eat' | 'coffee' | 'play' | 'tidy' | 'sweep' | 'water' | 'read' | 'chat' | 'stroll' | 'sleep';
export type RoutineActivity = Exclude<Activity, 'sleep'>;

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
  | { kind: 'beanbag'; x: number; y: number; variant: 0 | 1; station: number }
  | { kind: 'bed' | 'pod'; x: number; y: number; variant: number }
  | { kind: 'arcade'; x: number; y: number; station: number }
  | { kind: 'plant'; x: number; y: number; big: boolean }
  | { kind: 'counter' | 'reception' | 'helpdesk' | 'workbench' | 'sofa' | 'bookcase'; x: number; y: number; w: number }
  | { kind: 'station' | 'nightstand' | 'pingpong' | 'foosball' | 'table' | 'coffee' | 'fridge' | 'cooler' | 'vending' | 'drum' | 'lamp'; x: number; y: number }
  | { kind: 'stove' | 'shelf' | 'crates' | 'stool' | 'grill' | 'pond' | 'bench'; x: number; y: number }
  | { kind: 'tree'; x: number; y: number; variant: number }
  | { kind: 'flowers'; x: number; y: number; w: number; variant: number }
  | { kind: 'lights'; x: number; y: number; w: number };

/** `y` is the wall row the item hangs on: 0 for the back wall. */
export interface WallItem {
  kind: 'window' | 'board' | 'clock' | 'night' | 'sign' | 'pipe' | 'mailboxes' | 'tools' | 'menu' | 'poster';
  x: number;
  w: number;
  y: number;
  label?: string;
  hue?: number;
}

export interface Zone {
  kind:
    | 'carpet' | 'wood' | 'tile' | 'rug' | 'rest' | 'play' | 'grass' | 'path' | 'teamrug' | 'concrete' | 'mat' | 'hedge'
    | 'street' | 'plaza' | 'road' | 'sidewalk';
  x: number; y: number; w: number; h: number;
  hue?: number;
}

export type LevelKind = 'campus' | 'group' | 'cafe' | 'dorm' | 'park' | 'lobby' | 'shop';

export interface Level {
  id: string;
  kind: LevelKind;
  label: string;
  /** Group hue, or a negative value for the neutral shared buildings. */
  hue: number;
  cols: number;
  rows: number;
  walkable: boolean[];
  /** Per-tile walking cost; tiles absent here cost 1. Paths stay on roads where roads exist. */
  cost?: Uint8Array;
  furniture: Furniture[];
  wall: WallItem[];
  zones: Zone[];
  desks: DeskSlot[];
  /** Where people appear when they come in and where they leave from. */
  door: Spot;
  /** Where someone stands to post or collect a tube capsule. */
  station: Spot | null;
  routine: Partial<Record<RoutineActivity, Spot[]>>;
  beds: Spot[];
  waiting: Spot[];
  repair: Spot[];
  help: Spot[];
  pet: Point[];
  outdoor: boolean;
}

export const centerPx = (tile: Point): Point => ({ x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 3 });

export const spotAt = (tile: Point, dir: Dir, extra: Partial<Spot> = {}): Spot => ({ tile, px: centerPx(tile), dir, ...extra });

/** A blank grid with every tile walkable, plus the helpers the builders share. */
export function grid(cols: number, rows: number) {
  const walkable = new Array<boolean>(cols * rows).fill(true);
  const block = (x: number, y: number, w = 1, h = 1) => {
    for (let dy = 0; dy < h; dy += 1) {
      for (let dx = 0; dx < w; dx += 1) {
        const tx = x + dx;
        const ty = y + dy;
        if (tx >= 0 && ty >= 0 && tx < cols && ty < rows) walkable[ty * cols + tx] = false;
      }
    }
  };
  const open = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < cols && y < rows) walkable[y * cols + x] = true;
  };
  const free = (x: number, y: number) => x >= 0 && y >= 0 && x < cols && y < rows && walkable[y * cols + x];
  return { walkable, block, open, free };
}

/** Closest walkable tile to `tile`, breadth first; returns `tile` itself when nothing is open. */
export function nearestOpen(walkable: readonly boolean[], cols: number, rows: number, tile: Point): Point {
  const seen = new Set<number>([tile.y * cols + tile.x]);
  const queue: Point[] = [tile];
  for (const current of queue) {
    if (current.x >= 0 && current.y >= 0 && current.x < cols && current.y < rows && walkable[current.y * cols + current.x]) return current;
    for (const [dx, dy] of [[0, 1], [0, -1], [1, 0], [-1, 0]] as const) {
      const next = { x: current.x + dx, y: current.y + dy };
      const key = next.y * cols + next.x;
      if (next.x < 0 || next.y < 0 || next.x >= cols || next.y >= rows || seen.has(key)) continue;
      seen.add(key);
      queue.push(next);
    }
  }
  return tile;
}

export const emptyLevel = (id: string, kind: LevelKind, label: string, hue: number, cols: number, rows: number, door: Spot): Level => ({
  id, kind, label, hue, cols, rows, walkable: new Array<boolean>(cols * rows).fill(true), furniture: [], wall: [], zones: [], desks: [],
  door, station: null, routine: {}, beds: [], waiting: [], repair: [], help: [], pet: [], outdoor: false,
});
