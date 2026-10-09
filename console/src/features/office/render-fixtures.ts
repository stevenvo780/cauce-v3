import { TILE, type Furniture, type Level } from './level';
import { rect, type Ctx } from './paint';
import { OFFICE } from './palette';
import { paintText, textWidth } from './pixel-font';

export interface FixtureState {
  /** Capsules waiting in a building's tray. */
  tray: (level: string) => number;
  /** Seconds since a building's station last rang. */
  rang: (level: string) => number;
  /** Whether somebody lies in the repair pod at this tile. */
  occupied: (x: number, y: number) => boolean;
  night: boolean;
}

export interface FixtureDrawable { sortY: number; draw: (ctx: Ctx, time: number) => void }

const shadow = (ctx: Ctx, x: number, y: number, w: number) => { rect(ctx, x + 1, y, w - 2, 2, OFFICE.shadow); };

/** A small brass capsule lying on its side. */
export function capsule(ctx: Ctx, x: number, y: number, body: string): void {
  rect(ctx, x, y, 7, 4, OFFICE.outline);
  rect(ctx, x + 1, y + 1, 5, 2, body);
  rect(ctx, x + 1, y + 1, 1, 2, OFFICE.brassLight);
  rect(ctx, x + 5, y + 1, 1, 2, OFFICE.brassDark);
  rect(ctx, x + 2, y + 1, 2, 1, OFFICE.tubeShine);
}

/** The tube terminal: a brass receiver under the glass tube, its tray, and a lamp that rings when a capsule lands. */
function station(ctx: Ctx, x: number, y: number, level: string, state: FixtureState, time: number): void {
  const left = x * TILE;
  const top = y * TILE;
  const cx = left + TILE / 2;
  const since = state.rang(level);
  const ringing = since < 2.2;
  const count = state.tray(level);
  shadow(ctx, left + 1, top + 14, 14);
  rect(ctx, cx - 4, top - 4, 8, 6, OFFICE.tubeEdge);
  rect(ctx, cx - 3, top - 4, 6, 6, OFFICE.tube);
  rect(ctx, left + 1, top + 1, 14, 13, OFFICE.outline);
  rect(ctx, left + 2, top + 2, 12, 11, OFFICE.brass);
  rect(ctx, left + 2, top + 2, 12, 2, OFFICE.brassLight);
  rect(ctx, left + 2, top + 10, 12, 3, OFFICE.brassDark);
  rect(ctx, left + 4, top + 5, 8, 4, OFFICE.outline);
  rect(ctx, left + 5, top + 6, 6, 2, count > 0 ? OFFICE.mail : OFFICE.machineDark);
  const shake = ringing ? Math.round(Math.sin(time * 40) * 1) : 0;
  rect(ctx, left + 11 + shake, top - 2, 5, 4, OFFICE.outline);
  rect(ctx, left + 12 + shake, top - 1, 3, 2, ringing && Math.floor(time * 8) % 2 === 0 ? OFFICE.alert : OFFICE.brassLight);
  for (let index = 0; index < Math.min(3, count); index += 1) capsule(ctx, left + 1 + index * 4, top + 11 - index, OFFICE.brass);
  if (count > 3) {
    rect(ctx, left + 10, top - 9, 9, 7, OFFICE.alert);
    paintText(ctx, String(Math.min(9, count)), left + 13, top - 8, 1, OFFICE.paper);
  }
  if (ringing) {
    const r = Math.floor(since * 6) % 3;
    rect(ctx, left + 18 + r, top - 3, 1, 3, OFFICE.spark);
    rect(ctx, left + 18 + r, top + 2, 3, 1, OFFICE.spark);
    rect(ctx, left - 3 - r, top - 2, 1, 3, OFFICE.spark);
  }
}

function podBase(ctx: Ctx, x: number, y: number, busy: boolean, time: number): void {
  const left = x * TILE;
  const top = y * TILE;
  shadow(ctx, left + 1, top + 15, 31);
  rect(ctx, left, top - 1, 32, 16, OFFICE.outline);
  rect(ctx, left + 1, top, 30, 13, OFFICE.podFrame);
  rect(ctx, left + 3, top + 2, 26, 8, OFFICE.metalLight);
  rect(ctx, left + 1, top + 13, 30, 1, OFFICE.metal);
  rect(ctx, left + 2, top + 14, 2, 2, OFFICE.outline);
  rect(ctx, left + 28, top + 14, 2, 2, OFFICE.outline);
  rect(ctx, left + 26, top - 10, 4, 10, OFFICE.outline);
  rect(ctx, left + 27, top - 9, 2, 9, OFFICE.metal);
  const lit = busy ? Math.floor(time * 2) % 2 === 0 : true;
  rect(ctx, left + 26, top - 13, 4, 4, OFFICE.outline);
  rect(ctx, left + 27, top - 12, 2, 2, busy ? (lit ? OFFICE.led : OFFICE.machineDark) : OFFICE.ledOk);
}

function podLid(ctx: Ctx, x: number, y: number, busy: boolean, time: number): void {
  const left = x * TILE;
  const top = y * TILE;
  ctx.fillStyle = OFFICE.podGlass;
  ctx.fillRect(left + 2, top - 3, 28, 12);
  rect(ctx, left + 2, top - 4, 28, 1, OFFICE.glassLine);
  rect(ctx, left + 5, top - 2, 6, 1, OFFICE.glassLine);
  if (!busy) return;
  const swing = Math.round(Math.sin(time * 2.4) * 5);
  rect(ctx, left + 16 + swing, top - 9, 2, 6, OFFICE.metal);
  rect(ctx, left + 14 + swing, top - 10, 6, 2, OFFICE.outline);
  if (Math.floor(time * 7) % 3 !== 0) {
    rect(ctx, left + 16 + swing, top - 3, 1, 1, OFFICE.spark);
    rect(ctx, left + 18 + swing, top - 2, 1, 1, OFFICE.spark);
    rect(ctx, left + 15 + swing, top - 1, 1, 1, OFFICE.paper);
  }
}

function counterBlock(ctx: Ctx, left: number, top: number, width: number, front: string, light: string): void {
  shadow(ctx, left, top + 15, width);
  rect(ctx, left, top - 4, width, 20, OFFICE.outline);
  rect(ctx, left + 1, top - 3, width - 2, 6, OFFICE.counter);
  rect(ctx, left + 1, top + 3, width - 2, 12, front);
  rect(ctx, left + 1, top + 3, width - 2, 1, light);
  for (let dx = 12; dx < width - 4; dx += 16) rect(ctx, left + dx, top + 5, 1, 9, light);
}

function reception(ctx: Ctx, x: number, y: number, w: number): void {
  const left = x * TILE;
  const top = y * TILE;
  counterBlock(ctx, left, top, w * TILE, OFFICE.deskFront, OFFICE.deskLight);
  rect(ctx, left + 6, top - 12, 14, 9, OFFICE.outline);
  rect(ctx, left + 7, top - 11, 12, 6, OFFICE.monitor);
  rect(ctx, left + 8, top - 10, 10, 4, OFFICE.screenOn);
  rect(ctx, left + w * TILE - 14, top - 7, 7, 4, OFFICE.outline);
  rect(ctx, left + w * TILE - 13, top - 8, 5, 2, OFFICE.brassLight);
  const label = 'RECEPCION';
  rect(ctx, left + Math.floor((w * TILE - textWidth(label, 1)) / 2) - 2, top + 6, textWidth(label, 1) + 4, 7, OFFICE.outline);
  paintText(ctx, label, left + Math.floor((w * TILE - textWidth(label, 1)) / 2), top + 7, 1, OFFICE.mail);
}

function helpdesk(ctx: Ctx, x: number, y: number, w: number, time: number): void {
  const left = x * TILE;
  const top = y * TILE;
  counterBlock(ctx, left, top, w * TILE, OFFICE.ink[1], '#6f9be4');
  rect(ctx, left + 4, top - 26, 2, 22, OFFICE.outline);
  const label = 'AYUDA';
  const sw = textWidth(label, 1) + 8;
  rect(ctx, left + 1, top - 33, sw, 10, OFFICE.outline);
  rect(ctx, left + 2, top - 32, sw - 2, 8, Math.floor(time * 1.5) % 2 === 0 ? OFFICE.alert : '#c23c40');
  paintText(ctx, label, left + 5, top - 30, 1, OFFICE.paper);
  rect(ctx, left + w * TILE - 12, top - 9, 8, 6, OFFICE.outline);
  rect(ctx, left + w * TILE - 11, top - 8, 6, 4, OFFICE.paper);
  rect(ctx, left + w * TILE - 10, top - 7, 4, 1, OFFICE.alert);
}

function workbench(ctx: Ctx, x: number, y: number, w: number, time: number): void {
  const left = x * TILE;
  const top = y * TILE;
  const width = w * TILE;
  shadow(ctx, left, top + 15, width);
  rect(ctx, left, top - 2, width, 10, OFFICE.outline);
  rect(ctx, left + 1, top - 1, width - 2, 7, OFFICE.deskTop);
  rect(ctx, left + 2, top + 8, 2, 7, OFFICE.outline);
  rect(ctx, left + width - 4, top + 8, 2, 7, OFFICE.outline);
  rect(ctx, left + 4, top - 5, 6, 4, OFFICE.metal);
  rect(ctx, left + 14, top - 2, 9, 2, OFFICE.metalLight);
  rect(ctx, left + 24, top - 4, 4, 4, OFFICE.alert);
  if (Math.floor(time * 3) % 5 === 0) rect(ctx, left + 8, top - 8, 1, 2, OFFICE.spark);
}

function sofa(ctx: Ctx, x: number, y: number, w: number): void {
  const left = x * TILE;
  const top = y * TILE;
  const width = w * TILE;
  shadow(ctx, left, top + 15, width);
  rect(ctx, left, top - 4, width, 19, OFFICE.outline);
  rect(ctx, left + 1, top - 3, width - 2, 8, OFFICE.beanbagDark[1]);
  rect(ctx, left + 1, top + 5, width - 2, 8, OFFICE.beanbag[1]);
  rect(ctx, left + Math.floor(width / 2), top + 5, 1, 8, OFFICE.beanbagDark[1]);
  rect(ctx, left + 1, top - 3, 4, 16, OFFICE.beanbagLight[1]);
  rect(ctx, left + width - 5, top - 3, 4, 16, OFFICE.beanbagLight[1]);
}

function bookcase(ctx: Ctx, x: number, y: number): void {
  const left = x * TILE + 1;
  const top = y * TILE - 14;
  shadow(ctx, left, top + 29, 14);
  rect(ctx, left - 1, top - 1, 16, 30, OFFICE.outline);
  rect(ctx, left, top, 14, 28, OFFICE.deskFront);
  for (const [row, offset] of [[top + 2, 0], [top + 11, 1], [top + 20, 2]] as const) {
    for (let index = 0; index < 4; index += 1) rect(ctx, left + 1 + index * 3, row + (index % 2), 2, 7 - (index % 2), OFFICE.book[(index + offset) % OFFICE.book.length]);
    rect(ctx, left, row + 7, 14, 1, OFFICE.deskDark);
  }
}

function vending(ctx: Ctx, x: number, y: number, time: number): void {
  const left = x * TILE + 1;
  const top = y * TILE - 18;
  rect(ctx, left - 1, top - 1, 16, 35, OFFICE.outline);
  rect(ctx, left, top, 14, 33, OFFICE.ink[0]);
  rect(ctx, left + 2, top + 3, 8, 20, OFFICE.slate);
  for (let row = 0; row < 4; row += 1) for (let col = 0; col < 2; col += 1) rect(ctx, left + 3 + col * 4, top + 5 + row * 5, 3, 3, OFFICE.book[(row + col) % OFFICE.book.length]);
  rect(ctx, left + 11, top + 6, 2, 2, Math.floor(time * 2) % 2 === 0 ? OFFICE.ledOk : OFFICE.led);
  rect(ctx, left + 2, top + 26, 10, 4, OFFICE.outline);
}

function drum(ctx: Ctx, x: number, y: number): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 15;
  shadow(ctx, cx - 6, base, 12);
  rect(ctx, cx - 6, base - 14, 12, 14, OFFICE.outline);
  rect(ctx, cx - 5, base - 13, 10, 12, OFFICE.ink[1]);
  rect(ctx, cx - 5, base - 9, 10, 1, OFFICE.outline);
  rect(ctx, cx - 5, base - 5, 10, 1, OFFICE.outline);
  rect(ctx, cx - 4, base - 13, 2, 12, '#6f9be4');
}

/** A floor lamp that glows at night. */
export function lamp(ctx: Ctx, x: number, y: number, night: boolean): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 15;
  if (night) {
    ctx.fillStyle = OFFICE.lampGlow;
    ctx.fillRect(cx - 10, base - 34, 20, 18);
  }
  shadow(ctx, cx - 4, base, 8);
  rect(ctx, cx - 3, base - 2, 6, 2, OFFICE.outline);
  rect(ctx, cx - 1, base - 26, 2, 24, OFFICE.outline);
  rect(ctx, cx - 5, base - 32, 10, 7, OFFICE.outline);
  rect(ctx, cx - 4, base - 31, 8, 5, night ? OFFICE.lampShade : OFFICE.paper);
}

export function fixtureDrawable(piece: Furniture, level: Level, state: FixtureState): FixtureDrawable[] {
  const base = piece.y * TILE;
  switch (piece.kind) {
    case 'station': return [{ sortY: base + 14, draw: (ctx, time) => { station(ctx, piece.x, piece.y, level.id, state, time); } }];
    case 'pod': return [
      { sortY: base + 1, draw: (ctx, time) => { podBase(ctx, piece.x, piece.y, state.occupied(piece.x, piece.y), time); } },
      { sortY: base + 11, draw: (ctx, time) => { podLid(ctx, piece.x, piece.y, state.occupied(piece.x, piece.y), time); } },
    ];
    case 'reception': return [{ sortY: base + 14, draw: (ctx) => { reception(ctx, piece.x, piece.y, piece.w); } }];
    case 'helpdesk': return [{ sortY: base + 14, draw: (ctx, time) => { helpdesk(ctx, piece.x, piece.y, piece.w, time); } }];
    case 'workbench': return [{ sortY: base + 14, draw: (ctx, time) => { workbench(ctx, piece.x, piece.y, piece.w, time); } }];
    case 'sofa': return [{ sortY: base + 1, draw: (ctx) => { sofa(ctx, piece.x, piece.y, piece.w); } }];
    case 'bookcase': return [{ sortY: base + 15, draw: (ctx) => { bookcase(ctx, piece.x, piece.y); } }];
    case 'vending': return [{ sortY: base + 15, draw: (ctx, time) => { vending(ctx, piece.x, piece.y, time); } }];
    case 'drum': return [{ sortY: base + 15, draw: (ctx) => { drum(ctx, piece.x, piece.y); } }];
    case 'lamp': return [{ sortY: base + 15, draw: (ctx) => { lamp(ctx, piece.x, piece.y, state.night); } }];
    default: return [];
  }
}
