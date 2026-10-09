import type { MonitorMode } from './behaviour';
import { TILE, type DeskSlot, type Furniture, type GameKind, type Level } from './level';
import { rect, type Ctx } from './paint';
import { OFFICE } from './palette';
import { gardenDrawable } from './render-garden';
import { fixtureDrawable, type FixtureState } from './render-fixtures';
import { arcade, foosball, nightstand, pingpong } from './render-rooms';
import { seededRandom } from './random';

/** Pixel icon on a desk screen: a six px square in the top right corner. */
const SCREEN_MARK = 6;

export interface DeskState {
  monitor: MonitorMode;
  /** Owner seated and typing: hands move over the keyboard. */
  typing: boolean;
  hands?: string;
  offline: boolean;
  /** The owner's pixel icon for the screen; drawn while the screen shows code or rests. */
  mark?: HTMLCanvasElement | null;
  /** Night: the lamp on the desk is lit. */
  lit?: boolean;
}

export interface Drawable { sortY: number; draw: (ctx: Ctx, time: number) => void }

function shadow(ctx: Ctx, x: number, y: number, w: number): void {
  rect(ctx, x + 1, y, w - 2, 2, OFFICE.shadow);
}

function screen(ctx: Ctx, x: number, y: number, mode: MonitorMode, time: number, seed: number, mark: HTMLCanvasElement | null): void {
  const w = 12;
  const h = 8;
  if (mode === 'off') {
    rect(ctx, x, y, w, h, OFFICE.screenOff);
    rect(ctx, x + 1, y + 1, 3, 1, OFFICE.monitorLight);
    return;
  }
  if (mode === 'error') {
    rect(ctx, x, y, w, h, OFFICE.screenError);
    for (let i = 0; i < 4; i += 1) {
      rect(ctx, x + 4 + i, y + 2 + i, 1, 1, OFFICE.paper);
      rect(ctx, x + 7 - i, y + 2 + i, 1, 1, OFFICE.paper);
    }
    return;
  }
  if (mode === 'alert') {
    const blink = Math.floor(time * 2) % 2 === 0;
    rect(ctx, x, y, w, h, blink ? OFFICE.screenAlert : OFFICE.screenAlertDark);
    rect(ctx, x + 5, y + 1, 2, 4, OFFICE.outline);
    rect(ctx, x + 5, y + 6, 2, 1, OFFICE.outline);
    return;
  }
  if (mode === 'dim') {
    rect(ctx, x, y, w, h, OFFICE.screenDim);
    rect(ctx, x + 1, y + 1, w - 2, 1, OFFICE.screenDimLine);
    if (mark) {
      ctx.globalAlpha = 0.45;
      ctx.drawImage(mark, x + w - SCREEN_MARK, y + 1);
      ctx.globalAlpha = 1;
    }
    return;
  }
  rect(ctx, x, y, w, h, '#1f2a3d');
  const scroll = Math.floor(time * 3 + seed);
  const limit = mark ? w - SCREEN_MARK - 3 : w - 2;
  for (let line = 0; line < 4; line += 1) {
    const random = seededRandom(seed * 31 + scroll + line);
    const indent = Math.floor(random() * 3);
    const len = 3 + Math.floor(random() * 6);
    rect(ctx, x + 1 + indent, y + 1 + line * 2, Math.min(len, limit - indent), 1, OFFICE.code[Math.floor(random() * 4)]);
  }
  if (Math.floor(time * 2) % 2 === 0) rect(ctx, x + 2, y + 7, 2, 1, OFFICE.code[4]);
  if (mark) ctx.drawImage(mark, x + w - SCREEN_MARK, y + 1);
}

const GLOW: Partial<Record<MonitorMode, string>> = {
  code: OFFICE.screenGlow,
  error: 'rgba(255, 110, 110, 0.22)',
  alert: 'rgba(255, 190, 80, 0.24)',
};

function monitorFront(ctx: Ctx, cx: number, base: number, mode: MonitorMode, time: number, seed: number, mark: HTMLCanvasElement | null): void {
  const glow = GLOW[mode];
  if (glow) {
    ctx.fillStyle = glow;
    ctx.fillRect(cx - 10, base - 13, 20, 16);
  }
  rect(ctx, cx - 8, base - 12, 16, 11, OFFICE.outline);
  rect(ctx, cx - 7, base - 11, 14, 9, OFFICE.monitor);
  screen(ctx, cx - 6, base - 11, mode, time, seed, mark);
  rect(ctx, cx - 1, base - 1, 2, 2, OFFICE.monitor);
  rect(ctx, cx - 3, base + 1, 6, 1, OFFICE.outline);
}

/** The back of a monitor faces the viewer when its owner sits on the near side; the icon is stuck on there. */
function monitorBack(ctx: Ctx, cx: number, base: number, mode: MonitorMode, mark: HTMLCanvasElement | null): void {
  rect(ctx, cx - 8, base - 12, 16, 11, OFFICE.outline);
  rect(ctx, cx - 7, base - 11, 14, 9, OFFICE.monitorLight);
  rect(ctx, cx - 7, base - 3, 14, 1, OFFICE.monitor);
  rect(ctx, cx - 1, base - 8, 2, 2, mode === 'off' ? OFFICE.monitor : OFFICE.ledOk);
  if (mark && (mode === 'code' || mode === 'dim')) ctx.drawImage(mark, cx - 3, base - 10);
  rect(ctx, cx - 1, base - 1, 2, 2, OFFICE.monitor);
  rect(ctx, cx - 3, base + 1, 6, 1, OFFICE.outline);
}

/** A desk lamp on a bent arm; lit at night, its glow is painted over the room by the scene. */
function deskLamp(ctx: Ctx, x: number, y: number, lit: boolean): void {
  rect(ctx, x + 1, y - 8, 4, 3, OFFICE.outline);
  rect(ctx, x + 2, y - 7, 2, 1, lit ? OFFICE.lampShade : OFFICE.paper);
  rect(ctx, x + 3, y - 5, 1, 5, OFFICE.outline);
  rect(ctx, x + 2, y, 3, 1, OFFICE.outline);
}

function deskDrawables(desk: DeskSlot, state: () => DeskState): Drawable[] {
  const x = desk.x * TILE;
  const y = desk.deskY * TILE;
  const seed = desk.index * 7 + 3;
  if (desk.facing === 'down') {
    return [{
      sortY: y + TILE,
      draw: (ctx, time) => {
        const s = state();
        rect(ctx, x, y - 1, 32, 17, OFFICE.outline);
        rect(ctx, x + 1, y, 30, 16, OFFICE.deskTop);
        rect(ctx, x + 1, y, 30, 1, OFFICE.deskLight);
        rect(ctx, x + 8, y + 2, 16, 3, OFFICE.keyboard);
        rect(ctx, x + 8, y + 4, 16, 1, '#c9c2b6');
        if (s.typing && s.hands) {
          const left = Math.floor(time * 7) % 2;
          rect(ctx, x + 9 + left, y + 1 + left, 3, 2, s.hands);
          rect(ctx, x + 20 - left, y + 2 - left, 3, 2, s.hands);
        }
        rect(ctx, x + 26, y + 3, 3, 3, OFFICE.mug);
        if (s.offline) {
          rect(ctx, x + 2, y + 2, 5, 4, OFFICE.paper);
          rect(ctx, x + 3, y + 3, 3, 2, OFFICE.offSign);
        }
        monitorBack(ctx, x + 10, y + 14, s.monitor, s.mark ?? null);
        deskLamp(ctx, x + 3, y, s.lit === true);
      },
    }];
  }
  return [{
    sortY: y + TILE - 1,
    draw: (ctx, time) => {
      const s = state();
      rect(ctx, x, y, 32, 16, OFFICE.outline);
      rect(ctx, x + 1, y, 30, 10, OFFICE.deskTop);
      rect(ctx, x + 1, y + 10, 30, 5, OFFICE.deskFront);
      rect(ctx, x + 1, y + 14, 30, 1, OFFICE.deskDark);
      rect(ctx, x + 2, y + 16, 2, 2, OFFICE.deskDark);
      rect(ctx, x + 28, y + 16, 2, 2, OFFICE.deskDark);
      rect(ctx, x, y - 1, 32, 2, OFFICE.divider);
      rect(ctx, x, y - 2, 32, 1, OFFICE.dividerLight);
      rect(ctx, x + 4, y + 6, 4, 3, OFFICE.paper);
      if (s.offline) {
        rect(ctx, x + 3, y + 5, 5, 4, OFFICE.paper);
        rect(ctx, x + 4, y + 6, 3, 2, OFFICE.offSign);
      }
      monitorFront(ctx, x + 20, y + 3, s.monitor, time, seed, s.mark ?? null);
      deskLamp(ctx, x + 3, y, s.lit === true);
    },
  }];
}

function chairDrawables(x: number, y: number, facing: 'down' | 'up'): Drawable[] {
  const cx = x * TILE + TILE;
  const top = y * TILE;
  const wheels = (ctx: Ctx, base: number) => {
    rect(ctx, cx - 1, base - 3, 2, 3, OFFICE.outline);
    rect(ctx, cx - 6, base, 12, 1, OFFICE.outline);
    rect(ctx, cx - 6, base + 1, 2, 1, OFFICE.outline);
    rect(ctx, cx + 4, base + 1, 2, 1, OFFICE.outline);
  };
  if (facing === 'down') {
    return [{
      sortY: top + 2,
      draw: (ctx) => {
        shadow(ctx, cx - 7, top + 15, 14);
        wheels(ctx, top + 13);
        rect(ctx, cx - 7, top + 7, 14, 5, OFFICE.outline);
        rect(ctx, cx - 6, top + 8, 12, 3, OFFICE.chairDark);
        rect(ctx, cx - 5, top - 4, 10, 12, OFFICE.outline);
        rect(ctx, cx - 6, top - 3, 12, 10, OFFICE.outline);
        rect(ctx, cx - 5, top - 3, 10, 10, OFFICE.chair);
        rect(ctx, cx - 4, top - 3, 8, 2, OFFICE.chairLight);
        rect(ctx, cx - 8, top + 4, 3, 5, OFFICE.outline);
        rect(ctx, cx + 5, top + 4, 3, 5, OFFICE.outline);
        rect(ctx, cx - 7, top + 5, 2, 3, OFFICE.chairLight);
        rect(ctx, cx + 5, top + 5, 2, 3, OFFICE.chairLight);
      },
    }];
  }
  return [
    {
      sortY: top + 1,
      draw: (ctx) => {
        rect(ctx, cx - 7, top + 2, 14, 7, OFFICE.outline);
        rect(ctx, cx - 6, top + 3, 12, 5, OFFICE.chairDark);
      },
    },
    {
      sortY: top + TILE - 1,
      draw: (ctx) => {
        shadow(ctx, cx - 7, top + 16, 14);
        wheels(ctx, top + 15);
        rect(ctx, cx - 5, top + 5, 10, 10, OFFICE.outline);
        rect(ctx, cx - 6, top + 6, 12, 8, OFFICE.outline);
        rect(ctx, cx - 5, top + 6, 10, 8, OFFICE.chair);
        rect(ctx, cx - 4, top + 6, 8, 2, OFFICE.chairLight);
        rect(ctx, cx - 4, top + 12, 8, 1, OFFICE.chairDark);
      },
    },
  ];
}

function beanbagDrawables(x: number, y: number, variant: 0 | 1): Drawable[] {
  const cx = x * TILE + 8;
  const top = y * TILE;
  const base = OFFICE.beanbag[variant];
  const dark = OFFICE.beanbagDark[variant];
  const light = OFFICE.beanbagLight[variant];
  return [
    {
      sortY: top + 1,
      draw: (ctx) => {
        rect(ctx, cx - 7, top + 1, 14, 12, OFFICE.outline);
        rect(ctx, cx - 8, top + 3, 16, 9, OFFICE.outline);
        rect(ctx, cx - 6, top + 2, 12, 10, base);
        rect(ctx, cx - 7, top + 4, 14, 7, base);
        rect(ctx, cx - 5, top + 3, 5, 2, light);
      },
    },
    {
      sortY: top + TILE - 1,
      draw: (ctx) => {
        shadow(ctx, cx - 8, top + 15, 16);
        rect(ctx, cx - 8, top + 9, 16, 6, OFFICE.outline);
        rect(ctx, cx - 7, top + 10, 14, 4, dark);
        rect(ctx, cx - 7, top + 10, 14, 1, base);
      },
    },
  ];
}

/** Two tiles wide, headboard on the left; the sleeper and their blanket are drawn by the person. */
function bed(ctx: Ctx, x: number, y: number, variant: number): void {
  const left = x * TILE;
  const top = y * TILE;
  const blanket = OFFICE.blanket[variant % OFFICE.blanket.length];
  const dark = OFFICE.blanketDark[variant % OFFICE.blanketDark.length];
  const light = OFFICE.blanketLight[variant % OFFICE.blanketLight.length];
  shadow(ctx, left + 1, top + 15, 31);
  rect(ctx, left, top - 1, 32, 16, OFFICE.outline);
  rect(ctx, left + 1, top, 30, 11, OFFICE.mattress);
  rect(ctx, left + 1, top + 11, 30, 3, OFFICE.bedFrame);
  rect(ctx, left + 1, top + 11, 30, 1, OFFICE.bedFrameLight);
  rect(ctx, left + 2, top + 14, 2, 2, OFFICE.outline);
  rect(ctx, left + 28, top + 14, 2, 2, OFFICE.outline);
  rect(ctx, left + 3, top + 2, 8, 7, OFFICE.pillowShade);
  rect(ctx, left + 3, top + 2, 8, 6, OFFICE.pillow);
  rect(ctx, left + 4, top + 3, 3, 1, OFFICE.sheet);
  rect(ctx, left + 13, top, 18, 11, dark);
  rect(ctx, left + 13, top, 18, 10, blanket);
  rect(ctx, left + 13, top, 18, 1, light);
  rect(ctx, left + 12, top, 2, 11, OFFICE.sheet);
  rect(ctx, left + 18, top + 4, 9, 1, light);
  rect(ctx, left - 1, top - 7, 4, 22, OFFICE.outline);
  rect(ctx, left, top - 6, 2, 20, OFFICE.bedFrame);
  rect(ctx, left, top - 6, 2, 1, OFFICE.bedFrameLight);
  rect(ctx, left + 30, top + 3, 3, 12, OFFICE.outline);
  rect(ctx, left + 31, top + 4, 1, 10, OFFICE.bedFrame);
}

function plant(ctx: Ctx, x: number, y: number, big: boolean): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 15;
  shadow(ctx, cx - 6, base, 12);
  const pw = big ? 10 : 8;
  rect(ctx, cx - pw / 2 - 1, base - 8, pw + 2, 8, OFFICE.outline);
  rect(ctx, cx - pw / 2, base - 7, pw, 6, OFFICE.pot);
  rect(ctx, cx - pw / 2, base - 3, pw, 2, OFFICE.potDark);
  rect(ctx, cx - pw / 2 - 1, base - 8, pw + 2, 2, OFFICE.potDark);
  const leaves = big
    ? [[-6, -22, 5, 9], [1, -26, 5, 11], [-2, -18, 5, 10], [3, -17, 5, 8], [-8, -14, 5, 6], [5, -21, 4, 7]]
    : [[-5, -16, 4, 7], [0, -18, 4, 9], [3, -14, 4, 6], [-3, -13, 4, 5]];
  for (const [dx, dy, w, h] of leaves) rect(ctx, cx + dx - 1, base + dy - 1, w + 2, h + 2, OFFICE.outline);
  leaves.forEach(([dx, dy, w, h], index) => {
    rect(ctx, cx + dx, base + dy, w, h, index % 2 === 0 ? OFFICE.leaf : OFFICE.leafDark);
    rect(ctx, cx + dx + 1, base + dy + 1, 1, h - 2, OFFICE.leafLight);
  });
}

function counter(ctx: Ctx, x: number, y: number, w: number): void {
  const left = x * TILE;
  const top = y * TILE;
  const width = w * TILE;
  rect(ctx, left, top - 12, width, 4, OFFICE.wallShade);
  rect(ctx, left, top - 5, width, 21, OFFICE.outline);
  rect(ctx, left + 1, top - 4, width - 2, 6, OFFICE.counter);
  rect(ctx, left + 1, top + 2, width - 2, 13, OFFICE.counterFront);
  for (let dx = 0; dx < width; dx += 16) {
    rect(ctx, left + dx, top + 2, 1, 13, OFFICE.counterLine);
    rect(ctx, left + dx + 7, top + 6, 2, 1, OFFICE.counterLine);
  }
  rect(ctx, left + 1, top + 2, width - 2, 1, OFFICE.counterLine);
  rect(ctx, left + 40, top - 6, 6, 4, OFFICE.mug);
  rect(ctx, left + 42, top - 8, 2, 2, OFFICE.leaf);
  rect(ctx, left + 50, top - 7, 4, 5, OFFICE.ink[1]);
  rect(ctx, left + 55, top - 7, 4, 5, OFFICE.ink[0]);
}

function coffeeMachine(ctx: Ctx, x: number, y: number, time: number): void {
  const left = x * TILE + 2;
  const top = y * TILE - 20;
  rect(ctx, left - 1, top - 1, 14, 18, OFFICE.outline);
  rect(ctx, left, top, 12, 16, OFFICE.machine);
  rect(ctx, left, top, 12, 3, OFFICE.machineLight);
  rect(ctx, left + 2, top + 5, 8, 7, OFFICE.machineDark);
  rect(ctx, left + 5, top + 5, 2, 2, OFFICE.machineLight);
  rect(ctx, left + 4, top + 9, 4, 3, OFFICE.mug);
  rect(ctx, left + 9, top + 1, 2, 1, Math.floor(time * 1.5) % 2 === 0 ? OFFICE.led : OFFICE.ledOk);
  if (Math.floor(time * 2) % 3 !== 0) {
    rect(ctx, left + 5, top + 2 - (Math.floor(time * 4) % 3), 1, 2, 'rgba(255,255,255,0.7)');
  }
}

function fridge(ctx: Ctx, x: number, y: number): void {
  const left = x * TILE + 1;
  const top = y * TILE - 18;
  rect(ctx, left - 1, top - 1, 16, 35, OFFICE.outline);
  rect(ctx, left, top, 14, 33, OFFICE.fridge);
  rect(ctx, left, top + 11, 14, 1, OFFICE.fridgeShade);
  rect(ctx, left + 11, top + 3, 1, 6, OFFICE.fridgeShade);
  rect(ctx, left + 11, top + 15, 1, 9, OFFICE.fridgeShade);
  rect(ctx, left + 3, top + 4, 2, 2, OFFICE.ink[0]);
  rect(ctx, left + 6, top + 6, 2, 2, OFFICE.mail);
  rect(ctx, left + 3, top + 16, 4, 5, OFFICE.paper);
}

function cooler(ctx: Ctx, x: number, y: number): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 15;
  shadow(ctx, cx - 5, base, 10);
  rect(ctx, cx - 5, base - 14, 10, 14, OFFICE.outline);
  rect(ctx, cx - 4, base - 13, 8, 12, OFFICE.fridge);
  rect(ctx, cx - 1, base - 9, 2, 2, OFFICE.ledInfo);
  rect(ctx, cx - 4, base - 24, 8, 10, OFFICE.outline);
  rect(ctx, cx - 3, base - 23, 6, 9, '#8fd0f5');
  rect(ctx, cx - 2, base - 22, 1, 6, '#d6f1ff');
}

function table(ctx: Ctx, x: number, y: number): void {
  const left = x * TILE;
  const top = y * TILE;
  shadow(ctx, left + 1, top + 13, 14);
  rect(ctx, left + 1, top + 3, 14, 10, OFFICE.outline);
  rect(ctx, left + 2, top + 4, 12, 6, OFFICE.tableLight);
  rect(ctx, left + 2, top + 10, 12, 2, OFFICE.table);
  rect(ctx, left + 4, top + 5, 3, 3, OFFICE.mug);
  rect(ctx, left + 9, top + 5, 4, 3, OFFICE.ink[1]);
}

export interface FurnitureState {
  desk: (slot: number) => DeskState;
  /** Whether someone is at a given game right now, so idle machines rest. */
  playing: (game: GameKind, station: number) => boolean;
  cooking: (x: number, y: number) => boolean;
  fixtures: FixtureState;
}

/** One drawable per piece of furniture, sorted by the row its base sits on. */
export function furnitureDrawables(level: Level, state: FurnitureState): Drawable[] {
  const { desk: deskState, playing, cooking } = state;
  const list: Drawable[] = [];
  const at = (sortY: number, draw: (ctx: Ctx, time: number) => void) => {
    list.push({ sortY, draw });
  };
  for (const piece of level.furniture) {
    switch (piece.kind) {
      case 'desk':
        list.push(...deskDrawables(level.desks[piece.slot], () => deskState(piece.slot)));
        break;
      case 'chair':
        list.push(...chairDrawables(piece.x, piece.y, piece.facing));
        break;
      case 'beanbag':
        list.push(...beanbagDrawables(piece.x, piece.y, piece.variant));
        break;
      case 'plant':
        at(piece.y * TILE + 15, (ctx) => { plant(ctx, piece.x, piece.y, piece.big); });
        break;
      case 'counter':
        at(piece.y * TILE + 14, (ctx) => { counter(ctx, piece.x, piece.y, piece.w); });
        break;
      case 'coffee':
        at(piece.y * TILE + 14.5, (ctx, time) => { coffeeMachine(ctx, piece.x, piece.y, time); });
        break;
      case 'fridge':
        at(piece.y * TILE + 15, (ctx) => { fridge(ctx, piece.x, piece.y); });
        break;
      case 'cooler':
        at(piece.y * TILE + 15, (ctx) => { cooler(ctx, piece.x, piece.y); });
        break;
      case 'bed':
        at(piece.y * TILE + 1, (ctx) => { bed(ctx, piece.x, piece.y, piece.variant); });
        break;
      case 'station':
      case 'pod':
      case 'reception':
      case 'helpdesk':
      case 'workbench':
      case 'sofa':
      case 'bookcase':
      case 'vending':
      case 'drum':
      case 'lamp':
        list.push(...fixtureDrawable(piece, level, state.fixtures));
        break;
      case 'nightstand':
        at(piece.y * TILE + 14, (ctx) => { nightstand(ctx, piece.x, piece.y); });
        break;
      case 'arcade':
        at(piece.y * TILE + 15, (ctx, time) => { arcade(ctx, piece.x, piece.y, piece.station, playing('arcade', piece.station), time); });
        break;
      case 'pingpong':
        at(piece.y * TILE + 14, (ctx, time) => { pingpong(ctx, piece.x, piece.y, playing('pingpong', 0), time); });
        break;
      case 'foosball':
        at(piece.y * TILE + 15, (ctx, time) => { foosball(ctx, piece.x, piece.y, playing('foosball', 0), time); });
        break;
      case 'table':
        at(piece.y * TILE + 13, (ctx) => { table(ctx, piece.x, piece.y); });
        break;
      default:
        list.push(gardenDrawable(piece, () => cooking(piece.x, piece.y)));
    }
  }
  return list.sort((a, b) => a.sortY - b.sortY);
}

export type { Furniture };
