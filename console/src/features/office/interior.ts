import { SEATS_PER_POD } from './team-seats';
import {
  TILE, WALL_ROWS, emptyLevel, grid, nearestOpen, spotAt,
  type DeskSlot, type Furniture, type Level, type LevelKind, type Spot, type WallItem, type Zone,
} from './level';

const POD = 4;
const POD_GAP = 2;
const MIN_COLS = 14;

export interface Shell {
  level: Level;
  block: (x: number, y: number, w?: number, h?: number) => void;
  free: (x: number, y: number) => boolean;
  put: (piece: Furniture, w?: number, h?: number) => void;
  hang: (item: WallItem) => void;
  floor: (zone: Zone) => void;
  doorX: number;
}

/**
 * A room seen from above: back wall on the first rows, a wall column on each side and a front wall
 * on the last row with a two-tile doorway in the middle, which is where people come and go.
 */
export function shell(id: string, kind: LevelKind, label: string, hue: number, cols: number, rows: number): Shell {
  const doorX = Math.floor(cols / 2) - 1;
  const door: Spot = { tile: { x: doorX, y: rows - 1 }, px: { x: (doorX + 1) * TILE, y: (rows - 1) * TILE + TILE - 4 }, dir: 'up' };
  const level = emptyLevel(id, kind, label, hue, cols, rows, door);
  const cells = grid(cols, rows);
  level.walkable = cells.walkable;
  cells.block(0, 0, cols, WALL_ROWS);
  cells.block(0, 0, 1, rows);
  cells.block(cols - 1, 0, 1, rows);
  cells.block(0, rows - 1, cols, 1);
  cells.open(doorX, rows - 1);
  cells.open(doorX + 1, rows - 1);
  return {
    level,
    block: cells.block,
    free: cells.free,
    put: (piece, w = 1, h = 1) => {
      level.furniture.push(piece);
      cells.block(piece.x, piece.y, w, h);
    },
    hang: (item) => { level.wall.push(item); },
    floor: (zone) => { level.zones.push(zone); },
    doorX,
  };
}

/** Moves every spot's path tile onto open floor once the furniture is in place. */
export function settle(level: Level): void {
  const fix = (spot: Spot) => {
    spot.tile = nearestOpen(level.walkable, level.cols, level.rows, spot.tile);
    if (spot.from) fix(spot.from);
  };
  for (const desk of level.desks) {
    fix(desk.seat);
    fix(desk.visit);
  }
  for (const list of Object.values(level.routine)) for (const spot of list) fix(spot);
  for (const spot of [...level.beds, ...level.waiting, ...level.repair, ...level.help]) fix(spot);
  if (level.station) fix(level.station);
}

/** Back-wall windows between `from` and `to`, skipping the columns already taken. */
export function windows(s: Shell, from: number, to: number, taken: readonly { x: number; w: number }[], kind: 'window' | 'night' = 'window'): void {
  for (let x = from; x + 3 <= to;) {
    if (taken.some((item) => x < item.x + item.w + 1 && item.x < x + 4)) {
      x += 1;
      continue;
    }
    s.hang({ kind, x, w: 3, y: 0 });
    x += 5;
  }
}

export interface GroupRoomSpec { id: string; label: string; hue: number; seats: number }

export function podColumns(pods: number): number {
  if (pods <= 2) return Math.max(1, pods);
  return pods <= 4 ? 2 : 3;
}

/** The office of one group: desks in pods of four on the group's rug, the tube terminal and the door. */
export function buildGroupRoom(spec: GroupRoomSpec): Level {
  const pods = Math.max(1, Math.ceil(spec.seats / SEATS_PER_POD));
  const podCols = podColumns(pods);
  const podRows = Math.ceil(pods / podCols);
  const podsW = podCols * POD + (podCols - 1) * POD_GAP;
  const podsH = podRows * POD + (podRows - 1) * POD_GAP;
  const cols = Math.max(MIN_COLS, podsW + 8);
  const rows = WALL_ROWS + 2 + podsH + 3;
  const s = shell(spec.id, 'group', spec.label, spec.hue, cols, rows);
  const { level } = s;
  const x0 = 3 + Math.floor((cols - 8 - podsW) / 2);
  const y0 = WALL_ROWS + 2;
  s.floor({ kind: 'carpet', x: 1, y: WALL_ROWS, w: cols - 2, h: rows - WALL_ROWS - 1 });
  s.floor({ kind: 'teamrug', x: x0 - 1, y: y0 - 1, w: podsW + 2, h: podsH + 2, hue: spec.hue });
  s.floor({ kind: 'mat', x: s.doorX, y: rows - 2, w: 2, h: 1 });

  for (let pod = 0; pod < pods; pod += 1) {
    const px = x0 + (pod % podCols) * (POD + POD_GAP);
    const py = y0 + Math.floor(pod / podCols) * (POD + POD_GAP);
    for (let seat = 0; seat < SEATS_PER_POD; seat += 1) {
      const x = px + (seat % 2) * 2;
      const facing = seat < 2 ? 'down' : 'up';
      const chairY = facing === 'down' ? py : py + 3;
      const deskY = facing === 'down' ? py + 1 : py + 2;
      const index = level.desks.length;
      const visitY = facing === 'down' ? py - 1 : py + 4;
      const desk: DeskSlot = {
        index, x, deskY, chairY, facing,
        seat: { tile: { x, y: chairY }, px: { x: (x + 1) * TILE, y: chairY * TILE + TILE - 3 }, dir: facing, seated: true },
        visit: { tile: { x, y: visitY }, px: { x: (x + 1) * TILE, y: visitY * TILE + TILE - 3 }, dir: facing },
      };
      level.desks.push(desk);
      s.put({ kind: 'desk', x, y: deskY, slot: index }, 2, 1);
      s.put({ kind: 'chair', x, y: chairY, slot: index, facing });
    }
  }

  const stationX = cols - 3;
  s.put({ kind: 'station', x: stationX, y: WALL_ROWS });
  level.station = spotAt({ x: stationX, y: WALL_ROWS + 1 }, 'up');
  s.hang({ kind: 'pipe', x: stationX, w: 1, y: 0 });
  const signW = Math.min(6, cols - 8);
  const signX = Math.floor((cols - signW) / 2);
  s.hang({ kind: 'sign', x: signX, w: signW, y: 0, label: spec.label, hue: spec.hue });
  s.hang({ kind: 'clock', x: Math.max(signX + signW, stationX - 2), w: 1, y: 0 });
  windows(s, 1, stationX - 2, [{ x: signX, w: signW }]);
  s.put({ kind: 'plant', x: 1, y: WALL_ROWS, big: true });
  s.put({ kind: 'plant', x: 1, y: rows - 2, big: false });
  s.put({ kind: 'cooler', x: cols - 2, y: rows - 2 });
  if (rows - WALL_ROWS > 9) s.put({ kind: 'bookcase', x: 1, y: Math.floor((WALL_ROWS + rows) / 2), w: 1 });
  settle(level);
  return level;
}
