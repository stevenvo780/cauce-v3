import { GARDEN_CORE_H, GARDEN_CORE_W, buildGarden } from './garden-layout';
import { settle } from './interior';
import { SHARED_IDS, SHARED_LABELS, keyOf, sweepSpots } from './interior-shared';
import { TILE, emptyLevel, grid, spotAt, type Dir, type Furniture, type GameKind, type Level, type Spot } from './level';

const COLS = 24;
const ROWS = 15;
const GAMES_W = 10;

/** Outdoors behind a hedge: the fountain garden on top, the games underneath, the gate at the bottom. */
export function buildPark(): Level {
  const doorX = Math.floor(COLS / 2) - 1;
  const door: Spot = { tile: { x: doorX, y: ROWS - 1 }, px: { x: (doorX + 1) * TILE, y: (ROWS - 1) * TILE + TILE - 4 }, dir: 'up' };
  const level = emptyLevel(SHARED_IDS.park, 'park', SHARED_LABELS.park, -1, COLS, ROWS, door);
  level.outdoor = true;
  const cells = grid(COLS, ROWS);
  level.walkable = cells.walkable;
  const put = (piece: Furniture, w = 1, h = 1) => {
    level.furniture.push(piece);
    cells.block(piece.x, piece.y, w, h);
  };
  level.zones.push({ kind: 'grass', x: 0, y: 0, w: COLS, h: ROWS });
  level.zones.push(
    { kind: 'hedge', x: 0, y: 0, w: COLS, h: 1 }, { kind: 'hedge', x: 0, y: 1, w: 1, h: ROWS - 1 },
    { kind: 'hedge', x: COLS - 1, y: 1, w: 1, h: ROWS - 1 },
    { kind: 'hedge', x: 1, y: ROWS - 1, w: doorX - 1, h: 1 }, { kind: 'hedge', x: doorX + 2, y: ROWS - 1, w: COLS - doorX - 3, h: 1 },
  );
  cells.block(0, 0, COLS, 1);
  cells.block(0, 0, 1, ROWS);
  cells.block(COLS - 1, 0, 1, ROWS);
  cells.block(0, ROWS - 1, COLS, 1);
  cells.open(doorX, ROWS - 1);
  cells.open(doorX + 1, ROWS - 1);

  const garden = { x: 1, y: 1, w: COLS - 2, h: GARDEN_CORE_H };
  const cx = garden.x + Math.floor((garden.w - GARDEN_CORE_W) / 2);
  const outside = buildGarden(garden, cx, [], { furniture: level.furniture, zones: level.zones, block: cells.block });

  const gx = cx;
  const py = garden.y + garden.h;
  level.zones.push({ kind: 'play', x: gx, y: py, w: GAMES_W, h: ROWS - 1 - py });
  level.zones.push({ kind: 'rug', x: gx + 6, y: py + 4, w: 4, h: 2 });
  level.zones.push({ kind: 'path', x: doorX, y: py + 5, w: 2, h: ROWS - py - 5 });
  const stand = (x: number, y: number, dir: Dir, game: GameKind, station: number): Spot => spotAt({ x, y }, dir, { game, station });
  const arcades = [0, 1, 2].map((station) => {
    put({ kind: 'arcade', x: gx + 1 + station, y: py, station });
    return stand(gx + 1 + station, py + 1, 'up', 'arcade', station);
  });
  put({ kind: 'pingpong', x: gx + 5, y: py + 2 }, 3, 1);
  put({ kind: 'foosball', x: gx + 2, y: py + 4 }, 2, 1);
  const beanbags = ([[6, 0], [8, 1]] as const).map(([dx, variant], station) => {
    put({ kind: 'beanbag', x: gx + dx, y: py + 4, variant, station });
    return { tile: { x: gx + dx, y: py + 5 }, px: { x: (gx + dx) * TILE + TILE / 2, y: (py + 4) * TILE + TILE - 3 }, dir: 'down' as const, game: 'beanbag' as const, station };
  });
  put({ kind: 'plant', x: gx + 9, y: py, big: false });
  put({ kind: 'plant', x: gx, y: ROWS - 2, big: false });
  for (const [x, y, variant] of [[2, py + 1, 1], [5, py + 4, 2], [COLS - 6, py + 4, 0], [COLS - 3, py + 1, 2]] as const) put({ kind: 'tree', x, y, variant });
  put({ kind: 'bench', x: COLS - 5, y: py + 1 }, 2, 1);
  put({ kind: 'bench', x: 3, y: py + 2 }, 2, 1);
  put({ kind: 'flowers', x: 2, y: ROWS - 2, w: 2, variant: 7 }, 2, 1);
  put({ kind: 'flowers', x: COLS - 4, y: ROWS - 2, w: 2, variant: 3 }, 2, 1);

  const play = [
    stand(gx + 4, py + 2, 'right', 'pingpong', 0),
    stand(gx + 8, py + 2, 'left', 'pingpong', 0),
    arcades[0],
    stand(gx + 3, py + 5, 'up', 'foosball', 0),
    stand(gx + 2, py + 3, 'down', 'foosball', 0),
    arcades[1],
    beanbags[0],
    arcades[2],
    beanbags[1],
  ];
  const benchSeat = (x: number, y: number): Spot => ({ tile: { x, y: y + 1 }, px: { x: x * TILE + TILE / 2, y: y * TILE + 11 }, dir: 'down' });
  const read = [...outside.read, benchSeat(COLS - 5, py + 1), benchSeat(COLS - 4, py + 1), benchSeat(3, py + 2), benchSeat(4, py + 2)];
  const stroll: Spot[] = [];
  for (let y = garden.y; y < garden.y + garden.h; y += 1) {
    for (let x = garden.x; x < garden.x + garden.w; x += 1) if (level.walkable[y * COLS + x]) stroll.push(spotAt({ x, y }, 'down'));
  }
  const used = new Set([...play, ...read, ...outside.water, ...outside.chat, ...outside.cook].map(keyOf));
  level.routine = { play, read, water: outside.water, chat: outside.chat, cook: outside.cook, stroll, sweep: sweepSpots(level, used) };
  level.pet = outside.pet;
  settle(level);
  return level;
}
