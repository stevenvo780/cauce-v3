import { GARDEN_CORE_H, GARDEN_CORE_W, buildGarden } from './garden-layout';

/** Tile edge, in art pixels. */
export const TILE = 16;
/** The back wall takes the first rows; the floor starts below it. */
export const WALL_ROWS = 3;
const SEATS_PER_POD = 4;
const POD_W = 4;
const POD_H = 4;
/** The kitchen and the playground share a column this wide; their fixtures are drawn for it. */
const MID_W = 10;
const KITCHEN_H = 4;
const PATIO_H = 7;
const GARDEN_W = GARDEN_CORE_W;
const GARDEN_H = GARDEN_CORE_H;
/** The side door into the garden opens on a core row that is clear at both edges. */
const GARDEN_DOOR_ROW = 3;
const SLOT_W = 3;

export interface Point { x: number; y: number }
export type Dir = 'down' | 'up' | 'left' | 'right';

export type RoomId = 'programadores' | 'cocina' | 'patio' | 'jardin' | 'dormitorio';
export interface Room { id: RoomId; x: number; y: number; w: number; h: number }
export type GameKind = 'arcade' | 'pingpong' | 'foosball' | 'beanbag';

/** A place a character can occupy: the tile it paths to, and its exact feet position in art px. */
export interface Spot {
  tile: Point;
  px: Point;
  dir: Dir;
  rest?: 'bed';
  game?: GameKind;
  station?: number;
  variant?: number;
  /** Chat spots come in pairs facing each other; `variant` says which side of the pair. */
  pair?: number;
  /** Where a tidier picks the next box up before carrying it here. */
  from?: Spot;
}

export type Activity = 'cook' | 'eat' | 'coffee' | 'play' | 'tidy' | 'sweep' | 'water' | 'read' | 'chat' | 'stroll' | 'sleep';
export type RoutineSpots = Readonly<Record<Exclude<Activity, 'sleep'>, readonly Spot[]>>;

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
  | { kind: 'bed'; x: number; y: number; variant: number }
  | { kind: 'nightstand'; x: number; y: number }
  | { kind: 'arcade'; x: number; y: number; station: number }
  | { kind: 'pingpong'; x: number; y: number }
  | { kind: 'foosball'; x: number; y: number }
  | { kind: 'table'; x: number; y: number }
  | { kind: 'plant'; x: number; y: number; big: boolean }
  | { kind: 'counter'; x: number; y: number; w: number }
  | { kind: 'coffee'; x: number; y: number }
  | { kind: 'fridge'; x: number; y: number }
  | { kind: 'cooler'; x: number; y: number }
  | { kind: 'stove' | 'shelf' | 'crates' | 'stool' | 'grill' | 'pond' | 'bench'; x: number; y: number }
  | { kind: 'tree'; x: number; y: number; variant: number }
  | { kind: 'flowers'; x: number; y: number; w: number; variant: number }
  | { kind: 'lights'; x: number; y: number; w: number };

/** `y` is the wall row the item hangs on: 0 for the back wall, or an inner partition's row. */
export interface WallItem { kind: 'window' | 'board' | 'clock' | 'door' | 'night'; x: number; w: number; y: number }
export interface Zone {
  kind: 'carpet' | 'wood' | 'tile' | 'rug' | 'rest' | 'play' | 'grass' | 'path' | 'partition' | 'pillar';
  x: number; y: number; w: number; h: number;
}

export interface OfficeLayout {
  cols: number;
  rows: number;
  walkable: boolean[];
  rooms: Room[];
  desks: DeskSlot[];
  furniture: Furniture[];
  wall: WallItem[];
  zones: Zone[];
  /** One bed per agent; bed `i` belongs to the agent at desk `i`. */
  beds: Spot[];
  play: Spot[];
  door: Spot;
  /** Standing places in front of the coffee machine. */
  coffee: Spot[];
  /** Where people without work spend their time, by activity. */
  routine: RoutineSpots;
  /** The garden cat's round, in art px. */
  pet: Point[];
}

export interface LayoutParams {
  pods: number;
  podCols: number;
  side: 'right' | 'bottom';
  /** One-tile margins and gaps: lets two pods sit side by side on a phone, or the room grow a scale step. */
  compact: boolean;
  beds: number;
  /** Bed columns in the side arrangement's dormitory; fewer makes it taller. */
  slots?: number;
}

interface Plan { cols: number; rows: number; rooms: Record<RoomId, Room>; slots: number }

function workSize(params: LayoutParams): { w: number; h: number } {
  const podRows = Math.ceil(params.pods / params.podCols);
  const margin = params.compact ? 1 : 2;
  const gap = params.compact ? 1 : 2;
  return {
    w: margin * 2 + params.podCols * POD_W + (params.podCols - 1) * gap,
    h: margin * 2 + podRows * POD_H + (podRows - 1) * 2,
  };
}

function plan(params: LayoutParams): Plan {
  const work = workSize(params);
  const beds = Math.max(1, params.beds);
  const top = WALL_ROWS;
  if (params.side === 'right') {
    const base = Math.max(work.h, KITCHEN_H + 1 + PATIO_H, 5);
    const minSlots = Math.ceil((GARDEN_W - 1) / SLOT_W);
    const slots = Math.max(minSlots, params.slots ?? Math.ceil(Math.sqrt(beds * 1.5)));
    const dormH = 1 + 2 * Math.ceil(beds / slots);
    const h = Math.max(base, dormH + 1 + GARDEN_H);
    const mid = work.w + 1;
    const dorm = { id: 'dormitorio' as const, x: mid + MID_W + 1, y: top, w: 1 + slots * SLOT_W, h: dormH };
    const garden = { id: 'jardin' as const, x: dorm.x, y: top + dormH + 1, w: dorm.w, h: h - dormH - 1 };
    return {
      cols: dorm.x + dorm.w,
      rows: top + h,
      slots,
      rooms: {
        programadores: { id: 'programadores', x: 0, y: top, w: work.w, h },
        cocina: { id: 'cocina', x: mid, y: top, w: MID_W, h: KITCHEN_H },
        patio: { id: 'patio', x: mid, y: top + KITCHEN_H + 1, w: MID_W, h: h - KITCHEN_H - 1 },
        jardin: garden,
        dormitorio: dorm,
      },
    };
  }
  const w = Math.max(work.w, MID_W);
  const slots = Math.floor((w - 1) / SLOT_W);
  const kitchenY = top + work.h + 1;
  const patioY = kitchenY + KITCHEN_H + 1;
  const gardenY = patioY + PATIO_H + 1;
  const dormY = gardenY + GARDEN_H + 1;
  const dormH = 1 + 2 * Math.ceil(beds / slots);
  return {
    cols: w,
    rows: dormY + dormH,
    slots,
    rooms: {
      programadores: { id: 'programadores', x: 0, y: top, w, h: work.h },
      cocina: { id: 'cocina', x: 0, y: kitchenY, w, h: KITCHEN_H },
      patio: { id: 'patio', x: 0, y: patioY, w, h: PATIO_H },
      jardin: { id: 'jardin', x: 0, y: gardenY, w, h: GARDEN_H },
      dormitorio: { id: 'dormitorio', x: 0, y: dormY, w, h: dormH },
    },
  };
}

export function layoutSize(params: LayoutParams): { cols: number; rows: number } {
  const { cols, rows } = plan(params);
  return { cols, rows };
}

export function podsFor(count: number): number {
  return Math.max(1, Math.ceil(count / SEATS_PER_POD));
}

const centerPx = (tile: Point): Point => ({ x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 3 });

export function buildLayout(params: LayoutParams): OfficeLayout {
  const { cols, rows, rooms, slots } = plan(params);
  const work = workSize(params);
  const margin = params.compact ? 1 : 2;
  const gap = params.compact ? 1 : 2;
  const workRoom = rooms.programadores;
  const workX = workRoom.x + Math.floor((workRoom.w - work.w) / 2);
  const top = WALL_ROWS;
  const blocked = new Array<boolean>(cols * rows).fill(false);
  const block = (x: number, y: number, w = 1, h = 1) => {
    for (let dy = 0; dy < h; dy += 1) for (let dx = 0; dx < w; dx += 1) blocked[(y + dy) * cols + x + dx] = true;
  };
  for (let y = 0; y < WALL_ROWS; y += 1) block(0, y, cols, 1);

  const furniture: Furniture[] = [];
  const desks: DeskSlot[] = [];
  const zones: Zone[] = [
    { kind: 'carpet', ...pick(workRoom) },
    { kind: 'tile', ...pick(rooms.cocina) },
    { kind: 'play', ...pick(rooms.patio) },
    { kind: 'rest', ...pick(rooms.dormitorio) },
  ];
  const wall: WallItem[] = [];

  for (let pod = 0; pod < params.pods; pod += 1) {
    const px = workX + margin + (pod % params.podCols) * (POD_W + gap);
    const py = top + margin + Math.floor(pod / params.podCols) * (POD_H + 2);
    for (let seat = 0; seat < SEATS_PER_POD; seat += 1) {
      const x = px + (seat % 2) * 2;
      const facing = seat < 2 ? 'down' : 'up';
      const chairY = facing === 'down' ? py : py + 3;
      const deskY = facing === 'down' ? py + 1 : py + 2;
      const index = desks.length;
      const visitTile = { x, y: facing === 'down' ? py - 1 : py + 4 };
      desks.push({
        index, x, deskY, chairY, facing,
        seat: { tile: { x, y: chairY }, px: { x: (x + 1) * TILE, y: chairY * TILE + TILE - 3 }, dir: facing },
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
  plant(workRoom.x, top, true);
  plant(workRoom.x + workRoom.w - 1, workRoom.y + workRoom.h - 1, false);

  /** A wall run with gaps: `gaps` lists the first tile of each two-tile doorway. */
  const wallRun = (kind: 'partition' | 'pillar', x: number, y: number, length: number, gaps: number[]) => {
    let start = 0;
    for (const gapAt of [...gaps.sort((a, b) => a - b), length]) {
      const run = gapAt - start;
      if (run > 0) {
        const zone = kind === 'partition' ? { x: x + start, y, w: run, h: 1 } : { x, y: y + start, w: 1, h: run };
        zones.push({ kind, ...zone });
        block(zone.x, zone.y, zone.w, zone.h);
      }
      start = gapAt + 2;
    }
  };

  const kitchen = rooms.cocina;
  const patio = rooms.patio;
  const dorm = rooms.dormitorio;
  const garden = rooms.jardin;
  const coreX = garden.x + Math.floor((garden.w - GARDEN_CORE_W) / 2);
  const kx = kitchen.x + Math.floor((kitchen.w - MID_W) / 2);
  const gx = patio.x + Math.floor((patio.w - MID_W) / 2);
  if (params.side === 'right') {
    wallRun('pillar', workRoom.w, top, workRoom.h, [1, KITCHEN_H + 4]);
    wallRun('partition', kitchen.x, kitchen.y + KITCHEN_H, MID_W, [7]);
    wallRun('pillar', dorm.x - 1, top, rows - top, [garden.y - top + GARDEN_DOOR_ROW]);
    wallRun('partition', garden.x, garden.y - 1, garden.w, [coreX - garden.x + 4]);
  } else {
    wallRun('partition', 0, kitchen.y - 1, cols, [kx + 6]);
    wallRun('partition', 0, patio.y - 1, cols, [gx + 7]);
    wallRun('partition', 0, garden.y - 1, cols, [gx + 4]);
    wallRun('partition', 0, dorm.y - 1, cols, [gx + 4]);
  }

  furniture.push({ kind: 'counter', x: kx, y: kitchen.y, w: 4 });
  furniture.push({ kind: 'coffee', x: kx + 1, y: kitchen.y });
  furniture.push({ kind: 'fridge', x: kx + 4, y: kitchen.y });
  block(kx, kitchen.y, 5, 1);
  plant(kx + 9, kitchen.y, true);
  furniture.push({ kind: 'table', x: kx + 6, y: kitchen.y + 2 });
  block(kx + 6, kitchen.y + 2);
  furniture.push({ kind: 'cooler', x: kx + 9, y: kitchen.y + 2 });
  block(kx + 9, kitchen.y + 2);
  for (const [kind, dx, dy] of [['stove', 5, 0], ['shelf', 8, 0], ['crates', 9, 3]] as const) {
    furniture.push({ kind, x: kx + dx, y: kitchen.y + dy });
    block(kx + dx, kitchen.y + dy);
  }
  furniture.push({ kind: 'stool', x: kx + 5, y: kitchen.y + 2 }, { kind: 'stool', x: kx + 7, y: kitchen.y + 2 });

  const play: Spot[] = [];
  const stand = (x: number, y: number, dir: Dir, game: GameKind, station: number): Spot => ({
    tile: { x, y }, px: centerPx({ x, y }), dir, game, station,
  });
  const arcades = [0, 1, 2].map((station) => {
    furniture.push({ kind: 'arcade', x: gx + 1 + station, y: patio.y, station });
    block(gx + 1 + station, patio.y);
    return stand(gx + 1 + station, patio.y + 1, 'up', 'arcade', station);
  });
  furniture.push({ kind: 'pingpong', x: gx + 5, y: patio.y + 2 });
  block(gx + 5, patio.y + 2, 3, 1);
  furniture.push({ kind: 'foosball', x: gx + 2, y: patio.y + 4 });
  block(gx + 2, patio.y + 4, 2, 1);
  zones.push({ kind: 'rug', x: gx + 5, y: patio.y + 4, w: 5, h: 2 });
  const beanbags = ([[6, 0], [8, 1]] as const).map(([dx, variant], station) => {
    furniture.push({ kind: 'beanbag', x: gx + dx, y: patio.y + 4, variant, station });
    block(gx + dx, patio.y + 4);
    return { tile: { x: gx + dx, y: patio.y + 5 }, px: { x: (gx + dx) * TILE + TILE / 2, y: (patio.y + 4) * TILE + TILE - 3 }, dir: 'down' as const, game: 'beanbag' as const, station };
  });
  play.push(
    stand(gx + 4, patio.y + 2, 'right', 'pingpong', 0),
    stand(gx + 8, patio.y + 2, 'left', 'pingpong', 0),
    arcades[0],
    stand(gx + 3, patio.y + 5, 'up', 'foosball', 0),
    stand(gx + 2, patio.y + 3, 'down', 'foosball', 0),
    arcades[1],
    beanbags[0],
    arcades[2],
    beanbags[1],
  );
  plant(gx + 9, patio.y, false);
  plant(gx, patio.y + PATIO_H - 1, false);
  const outside = buildGarden(garden, coreX, garden.y, { furniture, zones, block });
  if (params.side === 'right') zones.push({ kind: 'path', x: garden.x, y: garden.y + GARDEN_DOOR_ROW, w: coreX - garden.x + 3, h: 1 });

  const sx0 = dorm.x + 1 + Math.floor((dorm.w - 1 - slots * SLOT_W) / 2);
  const bedCount = Math.max(1, params.beds);
  const bedTiles: Point[] = [];
  for (let index = 0; index < bedCount; index += 1) {
    const x = sx0 + (index % slots) * SLOT_W;
    const y = dorm.y + 1 + 2 * Math.floor(index / slots);
    furniture.push({ kind: 'nightstand', x, y });
    furniture.push({ kind: 'bed', x: x + 1, y, variant: index });
    block(x, y, SLOT_W, 1);
    bedTiles.push({ x: x + 1, y });
  }
  zones.push({ kind: 'rug', x: sx0, y: dorm.y, w: Math.min(slots, bedCount) * SLOT_W, h: 1 });

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
  for (const spot of play) spot.tile = nearestFree(spot.tile);
  const beds: Spot[] = bedTiles.map((tile, variant) => ({
    tile: nearestFree(tile), px: { x: tile.x * TILE + 16, y: tile.y * TILE + 9 }, dir: 'right', rest: 'bed', variant,
  }));
  const coffee: Spot[] = [1, 2, 3, 0].map((dx) => ({
    tile: { x: kx + dx, y: kitchen.y + 1 }, px: centerPx({ x: kx + dx, y: kitchen.y + 1 }), dir: 'up' as const,
  }));

  const kitchenSpot = (dx: number, dy: number, dir: Dir, extra: Partial<Spot> = {}): Spot => ({
    tile: { x: kx + dx, y: kitchen.y + dy }, px: centerPx({ x: kx + dx, y: kitchen.y + dy }), dir, ...extra,
  });
  const fixed = {
    cook: [kitchenSpot(5, 1, 'up'), ...outside.cook],
    eat: [kitchenSpot(5, 2, 'right'), kitchenSpot(7, 2, 'left')],
    tidy: [kitchenSpot(8, 1, 'up', { from: kitchenSpot(8, 3, 'right') })],
    read: outside.read,
    chat: outside.chat,
  };
  const used = new Set([...Object.values(fixed).flat(), ...outside.water, ...play, ...coffee].map((spot) => `${String(spot.tile.x)},${String(spot.tile.y)}`));
  const inside = (room: Room, tile: Point) => tile.x >= room.x && tile.x < room.x + room.w && tile.y >= room.y && tile.y < room.y + room.h;
  const claim = (room: Room, tile: Point): boolean => {
    const key = `${String(tile.x)},${String(tile.y)}`;
    if (!inside(room, tile) || !walkable[tile.y * cols + tile.x] || used.has(key)) return false;
    used.add(key);
    return true;
  };
  const roomList = Object.values(rooms);
  const water = [...outside.water, ...furniture.flatMap((piece) => {
    if (piece.kind !== 'plant') return [];
    const room = roomList.find((candidate) => inside(candidate, piece));
    const sides = [[0, 1, 'up'], [-1, 0, 'right'], [1, 0, 'left'], [0, -1, 'down']] as const;
    const side = room && sides.find(([dx, dy]) => claim(room, { x: piece.x + dx, y: piece.y + dy }));
    if (!side) return [];
    const tile = { x: piece.x + side[0], y: piece.y + side[1] };
    return [{ tile, px: centerPx(tile), dir: side[2] }];
  })];
  const sweep = [workRoom, kitchen, patio, garden].flatMap((room) => {
    const centre = { x: room.x + room.w / 2, y: room.y + room.h / 2 };
    const tiles: Point[] = [];
    for (let y = room.y; y < room.y + room.h; y += 1) for (let x = room.x; x < room.x + room.w; x += 1) tiles.push({ x, y });
    tiles.sort((a, b) => Math.hypot(a.x - centre.x, a.y - centre.y) - Math.hypot(b.x - centre.x, b.y - centre.y));
    const tile = tiles.find((candidate) => claim(room, candidate) && claim(room, { x: candidate.x + 1, y: candidate.y }));
    if (!tile) return [];
    const next = { x: tile.x + 1, y: tile.y };
    return [{ tile, px: centerPx(tile), dir: 'right' as const, from: { tile: next, px: centerPx(next), dir: 'left' as const } }];
  });
  const stroll: Spot[] = [];
  for (let y = garden.y; y < garden.y + garden.h; y += 1) {
    for (let x = garden.x; x < garden.x + garden.w; x += 1) {
      if (walkable[y * cols + x]) stroll.push({ tile: { x, y }, px: centerPx({ x, y }), dir: 'down' });
    }
  }

  const workWallEnd = workRoom.x + workRoom.w;
  const doorX = workX + margin + POD_W;
  for (let x = workRoom.x + 1; x + 3 <= workWallEnd - 1;) {
    if (x + 3 > doorX - 1 && x < doorX + 3) {
      x = doorX + 3;
      continue;
    }
    wall.push({ kind: wall.length === 1 ? 'board' : 'window', x, w: 3, y: 0 });
    x += 5;
  }
  wall.push({ kind: 'door', x: doorX, w: 2, y: 0 });
  if (params.side === 'right') {
    wall.push({ kind: 'clock', x: kitchen.x + 6, w: 1, y: 0 });
    wall.push({ kind: 'window', x: kitchen.x + 7, w: 3, y: 0 });
    wall.push({ kind: 'night', x: dorm.x + 1, w: 3, y: 0 });
    if (dorm.w >= 10) wall.push({ kind: 'night', x: dorm.x + dorm.w - 4, w: 3, y: 0 });
  } else {
    wall.push({ kind: 'night', x: gx + 1, w: 2, y: dorm.y - 1 });
    wall.push({ kind: 'night', x: gx + 7, w: 2, y: dorm.y - 1 });
  }
  const door: Spot = { tile: { x: doorX, y: top }, px: { x: doorX * TILE + TILE / 2 + (gap > 1 ? TILE / 2 : 0), y: top * TILE + TILE - 3 }, dir: 'down' };

  return {
    cols, rows, walkable, rooms: [rooms.programadores, rooms.cocina, rooms.patio, garden, rooms.dormitorio],
    desks, furniture, wall, zones, beds, play, door, coffee, pet: outside.pet,
    routine: { ...fixed, coffee, play, water, sweep, stroll },
  };
}

function pick(room: Room): { x: number; y: number; w: number; h: number } {
  return { x: room.x, y: room.y, w: room.w, h: room.h };
}

export interface LayoutChoice { params: LayoutParams; scale: number }

/** Largest crisp integer `scale` (device px per art px); on phones the height is let go and the page scrolls. */
export function chooseLayout(count: number, box: { width: number; height: number; dpr: number }): LayoutChoice {
  const pods = podsFor(count);
  const beds = Math.max(1, count);
  const minScale = Math.ceil(1.6 * box.dpr);
  const maxScale = Math.floor(5 * box.dpr);
  const candidates: { params: LayoutParams; kw: number; kh: number; empty: number }[] = [];
  const slotChoices = [...new Set([3, 4, 5, 6, 8, 10, 13].map((slots) => Math.min(slots, Math.max(3, beds))))];
  for (const compact of box.width < 700 ? [true] : [false, true]) for (const side of ['right', 'bottom'] as const) {
    for (let podCols = 1; podCols <= Math.min(pods, 8); podCols += 1) for (const slots of side === 'right' ? slotChoices : [undefined]) {
      const params = { pods, podCols, side, compact, beds, slots };
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
