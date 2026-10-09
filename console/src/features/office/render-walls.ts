import { TILE, WALL_ROWS, type Level, type WallItem, type Zone } from './level';
import { rect, type Ctx } from './paint';
import { OFFICE } from './palette';
import { fitText, paintText, textWidth, TEXT_HEIGHT } from './pixel-font';
import { paintGround } from './render-garden';
import { paintNightWindow } from './render-rooms';
import { paintTeamRug } from './render-teams';
import { seededRandom } from './random';
import { teamTone } from './teams';

function checker(ctx: Ctx, zone: Zone, a: string, b: string, line?: string): void {
  for (let ty = 0; ty < zone.h; ty += 1) {
    for (let tx = 0; tx < zone.w; tx += 1) {
      const x = (zone.x + tx) * TILE;
      const y = (zone.y + ty) * TILE;
      rect(ctx, x, y, TILE, TILE, (tx + ty) % 2 === 0 ? a : b);
      if (line) rect(ctx, x, y + TILE - 1, TILE, 1, line);
    }
  }
}

function hedge(ctx: Ctx, zone: Zone): void {
  const x0 = zone.x * TILE;
  const y0 = zone.y * TILE;
  rect(ctx, x0, y0, zone.w * TILE, zone.h * TILE, OFFICE.hedgeDark);
  for (let ty = 0; ty < zone.h; ty += 1) {
    for (let tx = 0; tx < zone.w; tx += 1) {
      const x = x0 + tx * TILE;
      const y = y0 + ty * TILE;
      rect(ctx, x + 1, y + 1, TILE - 2, TILE - 3, OFFICE.hedge);
      rect(ctx, x + 3, y + 2, 5, 3, OFFICE.hedgeTop);
      rect(ctx, x + 9, y + 7, 4, 2, OFFICE.hedgeTop);
    }
  }
}

/** Every floor kind a map can have, painted once into the map's background. */
export function paintFloor(ctx: Ctx, zones: readonly Zone[]): void {
  for (const zone of zones) {
    const x0 = zone.x * TILE;
    const y0 = zone.y * TILE;
    const w = zone.w * TILE;
    const h = zone.h * TILE;
    switch (zone.kind) {
      case 'carpet': checker(ctx, zone, OFFICE.carpet, OFFICE.carpetAlt, OFFICE.carpetLine); break;
      case 'play': checker(ctx, zone, OFFICE.playFloor, OFFICE.playFloorAlt, OFFICE.playLine); break;
      case 'rest': checker(ctx, zone, OFFICE.rest, OFFICE.restAlt); break;
      case 'concrete': checker(ctx, zone, OFFICE.concrete, OFFICE.concreteAlt, OFFICE.concreteLine); break;
      case 'grass':
      case 'path': paintGround(ctx, zone); break;
      case 'teamrug': paintTeamRug(ctx, zone); break;
      case 'hedge': hedge(ctx, zone); break;
      case 'wood':
        rect(ctx, x0, y0, w, h, OFFICE.wood);
        for (let y = 0; y < h; y += 6) {
          const row = Math.floor((y0 + y) / 6);
          if (row % 2 === 1) rect(ctx, x0, y0 + y, w, 6, OFFICE.woodAlt);
          rect(ctx, x0, y0 + y + 5, w, 1, OFFICE.woodLine);
          for (let x = (row * 13) % 40; x < w; x += 40) rect(ctx, x0 + x, y0 + y, 1, 5, OFFICE.woodLine);
        }
        break;
      case 'tile':
        for (let y = 0; y < h; y += 8) for (let x = 0; x < w; x += 8) rect(ctx, x0 + x, y0 + y, 8, 8, ((x + y) / 8) % 2 === 0 ? OFFICE.tile : OFFICE.tileAlt);
        break;
      case 'mat':
        rect(ctx, x0 + 2, y0 + 3, w - 4, h - 5, OFFICE.mat);
        for (let x = x0 + 4; x < x0 + w - 4; x += 3) rect(ctx, x, y0 + 5, 1, h - 9, OFFICE.matLight);
        break;
      case 'rug':
        rect(ctx, x0 + 2, y0 + 3, w - 4, h - 6, OFFICE.rugBorder);
        rect(ctx, x0 + 4, y0 + 5, w - 8, h - 10, OFFICE.rug);
        for (let x = x0 + 8; x < x0 + w - 8; x += 6) {
          rect(ctx, x, y0 + 8, 3, 1, OFFICE.rugInner);
          rect(ctx, x + 3, y0 + h - 9, 3, 1, OFFICE.rugInner);
        }
        break;
      default:
        break;
    }
  }
}

function paintNightSky(ctx: Ctx, x: number, w: number, top: number, bottom: number): void {
  const random = seededRandom(x * 613);
  for (let i = 0; i < Math.max(2, Math.floor(w / 4)); i += 1) {
    rect(ctx, x + 1 + Math.floor(random() * (w - 2)), top + 2 + Math.floor(random() * (bottom - top - 5)), 1, 1, OFFICE.star);
  }
  const mx = x + w - 8;
  rect(ctx, mx, top + 3, 4, 3, OFFICE.moon);
  rect(ctx, mx + 1, top + 2, 2, 5, OFFICE.moon);
  rect(ctx, mx + 2, top + 2, 2, 3, OFFICE.nightSky);
}

function paintWindow(ctx: Ctx, x: number, w: number, night: boolean): void {
  const top = 8;
  const bottom = 31;
  rect(ctx, x - 1, top - 1, w + 2, bottom - top + 2, OFFICE.frame);
  rect(ctx, x + 1, top + 1, w - 2, 10, night ? OFFICE.nightSky : OFFICE.glassTop);
  rect(ctx, x + 1, top + 11, w - 2, bottom - top - 12, night ? OFFICE.nightSkyLow : OFFICE.glassBottom);
  if (night) paintNightSky(ctx, x, w, top, bottom);
  const random = seededRandom(x * 977);
  for (let bx = x + 1; !night && bx < x + w - 1;) {
    const bw = 3 + Math.floor(random() * 5);
    const bh = 4 + Math.floor(random() * 7);
    rect(ctx, bx, bottom - 1 - bh, Math.min(bw, x + w - 1 - bx), bh, OFFICE.skylineFar);
    bx += bw;
  }
  for (let bx = x + 2; !night && bx < x + w - 2;) {
    const bw = 4 + Math.floor(random() * 4);
    const bh = 3 + Math.floor(random() * 5);
    rect(ctx, bx, bottom - 1 - bh, Math.min(bw, x + w - 1 - bx), bh, OFFICE.skyline);
    bx += bw + 2;
  }
  if (!night) for (let i = 0; i < 5; i += 1) rect(ctx, x + 4 + i, top + 6 - i, 1, 1, OFFICE.glassShine);
  rect(ctx, x + Math.floor(w / 2), top, 1, bottom - top, OFFICE.frame);
  rect(ctx, x, top + 10, w, 1, OFFICE.frame);
  rect(ctx, x - 2, bottom + 1, w + 4, 2, OFFICE.trim);
}

function paintBoard(ctx: Ctx, x: number, w: number): void {
  rect(ctx, x - 1, 7, w + 2, 23, OFFICE.boardFrame);
  rect(ctx, x, 8, w, 21, OFFICE.board);
  [6, 10, 7, 13, 9].forEach((height, index) => { rect(ctx, x + 4 + index * 4, 25 - height, 3, height, OFFICE.ink[index % 2]); });
  rect(ctx, x + 3, 25, 20, 1, OFFICE.outline);
  for (let i = 0; i < 14; i += 1) rect(ctx, x + 27 + i, 12 + Math.round(Math.sin(i / 2) * 2), 1, 1, OFFICE.ink[2]);
  rect(ctx, x + 2, 29, w - 4, 2, OFFICE.boardFrame);
}

function paintClock(ctx: Ctx, x: number): void {
  const cx = x + 8;
  rect(ctx, cx - 4, 10, 8, 10, OFFICE.outline);
  rect(ctx, cx - 5, 11, 10, 8, OFFICE.outline);
  rect(ctx, cx - 3, 11, 6, 8, OFFICE.board);
  rect(ctx, cx - 4, 12, 8, 6, OFFICE.board);
  rect(ctx, cx, 12, 1, 3, OFFICE.outline);
  rect(ctx, cx, 15, 3, 1, OFFICE.alert);
}

/** The group's name on a plaque in its colour, set in the pixel font. */
function paintSign(ctx: Ctx, x: number, w: number, label: string, hue: number): void {
  rect(ctx, x, 9, w, 22, OFFICE.outline);
  rect(ctx, x + 1, 10, w - 2, 20, teamTone(hue, 52, 34));
  rect(ctx, x + 1, 10, w - 2, 2, teamTone(hue, 55, 48));
  rect(ctx, x + 3, 27, w - 6, 1, teamTone(hue, 50, 26));
  const fit = fitText(label, w - 8, 2);
  paintText(ctx, fit.text, x + Math.floor((w - textWidth(fit.text, fit.scale)) / 2), 12 + Math.floor((14 - TEXT_HEIGHT(fit.scale)) / 2), fit.scale, '#ffffff');
  rect(ctx, x + 4, 31, 2, 3, OFFICE.outline);
  rect(ctx, x + w - 6, 31, 2, 3, OFFICE.outline);
}

/** The glass tube that drops from the ceiling into the station below it. */
function paintPipe(ctx: Ctx, x: number): void {
  const cx = x + TILE / 2;
  rect(ctx, cx - 4, 0, 8, WALL_ROWS * TILE, OFFICE.tubeEdge);
  rect(ctx, cx - 3, 0, 6, WALL_ROWS * TILE, OFFICE.tube);
  rect(ctx, cx - 2, 0, 1, WALL_ROWS * TILE, OFFICE.tubeShine);
  for (let y = 6; y < WALL_ROWS * TILE; y += 12) {
    rect(ctx, cx - 5, y, 10, 3, OFFICE.brassDark);
    rect(ctx, cx - 5, y, 10, 1, OFFICE.brassLight);
  }
}

function paintMailboxes(ctx: Ctx, x: number, w: number): void {
  rect(ctx, x, 6, w, 28, OFFICE.outline);
  rect(ctx, x + 1, 7, w - 2, 26, OFFICE.deskFront);
  const random = seededRandom(x * 41);
  for (let row = 0; row < 3; row += 1) {
    for (let col = 0; col * 9 + 9 < w; col += 1) {
      const bx = x + 3 + col * 9;
      const by = 9 + row * 8;
      rect(ctx, bx, by, 7, 6, OFFICE.deskDark);
      if (random() < 0.45) rect(ctx, bx + 1, by + 1, 5, 3, random() < 0.5 ? OFFICE.paper : OFFICE.mail);
    }
  }
}

function paintTools(ctx: Ctx, x: number, w: number): void {
  rect(ctx, x, 7, w, 25, OFFICE.outline);
  rect(ctx, x + 1, 8, w - 2, 23, OFFICE.box);
  for (let y = 11; y < 30; y += 4) for (let dx = 3; dx < w - 2; dx += 4) rect(ctx, x + dx, y, 1, 1, OFFICE.boxDark);
  rect(ctx, x + 5, 11, 2, 14, OFFICE.metal);
  rect(ctx, x + 3, 10, 6, 3, OFFICE.metal);
  rect(ctx, x + 14, 12, 10, 3, OFFICE.metalLight);
  rect(ctx, x + 22, 12, 3, 10, OFFICE.bark);
  rect(ctx, x + 32, 10, 3, 14, OFFICE.alert);
  rect(ctx, x + 31, 22, 5, 5, OFFICE.metal);
  rect(ctx, x + 44, 11, 8, 2, OFFICE.metal);
  rect(ctx, x + 47, 13, 2, 12, OFFICE.bark);
}

function paintMenu(ctx: Ctx, x: number, w: number): void {
  rect(ctx, x, 7, w, 24, OFFICE.bark);
  rect(ctx, x + 2, 9, w - 4, 20, OFFICE.slate);
  paintText(ctx, 'MENU', x + Math.floor((w - textWidth('MENU', 1)) / 2), 11, 1, OFFICE.mail);
  for (let row = 0; row < 3; row += 1) {
    rect(ctx, x + 5, 19 + row * 3, w - 18, 1, OFFICE.chalk);
    rect(ctx, x + w - 10, 19 + row * 3, 4, 1, OFFICE.ledOk);
  }
}

function paintPoster(ctx: Ctx, x: number, w: number): void {
  rect(ctx, x + 2, 8, w - 4, 22, OFFICE.outline);
  rect(ctx, x + 3, 9, w - 6, 20, OFFICE.sky);
  rect(ctx, x + 3, 21, w - 6, 8, OFFICE.grass);
  rect(ctx, x + 8, 12, 6, 6, OFFICE.mail);
  rect(ctx, x + w - 12, 16, 5, 6, OFFICE.alert);
}

export function paintWallItem(ctx: Ctx, item: WallItem, night: boolean): void {
  const x = item.x * TILE;
  const w = item.w * TILE;
  switch (item.kind) {
    case 'night': paintNightWindow(ctx, x + 3, w - 6, 8, 31); break;
    case 'window': paintWindow(ctx, x + 2, w - 4, night); break;
    case 'board': paintBoard(ctx, x + 2, w - 4); break;
    case 'clock': paintClock(ctx, x); break;
    case 'sign': paintSign(ctx, x, w, item.label ?? '', item.hue ?? -1); break;
    case 'pipe': paintPipe(ctx, x); break;
    case 'mailboxes': paintMailboxes(ctx, x, w); break;
    case 'tools': paintTools(ctx, x, w); break;
    case 'menu': paintMenu(ctx, x, w); break;
    case 'poster': paintPoster(ctx, x, w); break;
  }
}

/** Side walls seen from above, and the front wall with its doorway and the way out marked. */
function paintShell(ctx: Ctx, level: Level): void {
  const width = level.cols * TILE;
  const height = level.rows * TILE;
  for (const left of [0, width - TILE]) {
    rect(ctx, left, 0, TILE, height, OFFICE.wallTop);
    rect(ctx, left, 0, 1, height, OFFICE.outline);
    rect(ctx, left + TILE - 1, 0, 1, height, OFFICE.outline);
    rect(ctx, left + (left === 0 ? TILE - 3 : 1), WALL_ROWS * TILE, 2, height - WALL_ROWS * TILE - TILE, OFFICE.trimDark);
  }
  const front = height - TILE;
  const gapX = level.door.tile.x * TILE;
  rect(ctx, 0, front, width, TILE, OFFICE.wallTop);
  rect(ctx, 0, front, width, 1, OFFICE.outline);
  rect(ctx, 0, front + 10, width, 6, OFFICE.wallShade);
  rect(ctx, 0, front + 10, width, 1, OFFICE.trimDark);
  rect(ctx, 0, height - 1, width, 1, OFFICE.outline);
  rect(ctx, gapX, front, 2 * TILE, TILE, OFFICE.path);
  rect(ctx, gapX, front, 2 * TILE, 2, OFFICE.shadow);
  rect(ctx, gapX - 2, front, 2, TILE, OFFICE.trimDark);
  rect(ctx, gapX + 2 * TILE, front, 2, TILE, OFFICE.trimDark);
  rect(ctx, gapX + 9, front + 5, 14, 7, OFFICE.outline);
  rect(ctx, gapX + 10, front + 6, 12, 5, OFFICE.exit);
  rect(ctx, gapX + 13, front + 8, 6, 1, OFFICE.paper);
  rect(ctx, gapX + 15, front + 7, 1, 3, OFFICE.paper);
}

/** The static part of an interior: floor, back wall with its fittings, side and front walls. */
export function paintInterior(ctx: Ctx, level: Level, night: boolean): void {
  const width = level.cols * TILE;
  const height = level.rows * TILE;
  rect(ctx, 0, 0, width, height, OFFICE.carpet);
  paintFloor(ctx, level.zones);
  if (level.outdoor) return;
  const wallH = WALL_ROWS * TILE;
  rect(ctx, 0, 0, width, wallH, OFFICE.wall);
  rect(ctx, 0, 0, width, 4, OFFICE.wallTop);
  rect(ctx, 0, 4, width, 1, OFFICE.wallShade);
  rect(ctx, 0, 35, width, wallH - 35, OFFICE.wallShade);
  rect(ctx, 0, 35, width, 1, OFFICE.trim);
  rect(ctx, 0, wallH - 5, width, 3, OFFICE.trim);
  rect(ctx, 0, wallH - 2, width, 2, OFFICE.trimDark);
  for (const item of level.wall) paintWallItem(ctx, item, night);
  rect(ctx, 0, wallH, width, 2, OFFICE.shadow);
  paintShell(ctx, level);
}
