import type { MonitorMode } from './behaviour';
import { TILE, WALL_ROWS, type DeskSlot, type Furniture, type OfficeLayout } from './layout';
import { rect, type Ctx } from './paint';
import { OFFICE, type CharPalette } from './palette';
import { seededRandom } from './simulation';

function paintFloor(ctx: Ctx, layout: OfficeLayout): void {
  for (const zone of [...layout.zones].sort((a, b) => Number(a.kind === 'partition') - Number(b.kind === 'partition'))) {
    const x0 = zone.x * TILE;
    const y0 = zone.y * TILE;
    const w = zone.w * TILE;
    const h = zone.h * TILE;
    if (zone.kind === 'carpet') {
      for (let ty = 0; ty < zone.h; ty += 1) {
        for (let tx = 0; tx < zone.w; tx += 1) {
          const x = x0 + tx * TILE;
          const y = y0 + ty * TILE;
          rect(ctx, x, y, TILE, TILE, (tx + ty) % 2 === 0 ? OFFICE.carpet : OFFICE.carpetAlt);
          rect(ctx, x, y + TILE - 1, TILE, 1, OFFICE.carpetLine);
        }
      }
    } else if (zone.kind === 'wood') {
      rect(ctx, x0, y0, w, h, OFFICE.wood);
      for (let y = 0; y < h; y += 6) {
        const row = Math.floor((y0 + y) / 6);
        if (row % 2 === 1) rect(ctx, x0, y0 + y, w, 6, OFFICE.woodAlt);
        rect(ctx, x0, y0 + y + 5, w, 1, OFFICE.woodLine);
        for (let x = (row * 13) % 40; x < w; x += 40) rect(ctx, x0 + x, y0 + y, 1, 5, OFFICE.woodLine);
      }
    } else if (zone.kind === 'rest') {
      for (let ty = 0; ty < zone.h; ty += 1) {
        for (let tx = 0; tx < zone.w; tx += 1) {
          rect(ctx, x0 + tx * TILE, y0 + ty * TILE, TILE, TILE, (tx + ty) % 2 === 0 ? OFFICE.rest : OFFICE.restAlt);
        }
      }
      rect(ctx, x0, y0, w, 1, OFFICE.restLine);
      rect(ctx, x0 + w - 1, y0, 1, h, OFFICE.restLine);
    } else if (zone.kind === 'tile') {
      for (let y = 0; y < h; y += 8) {
        for (let x = 0; x < w; x += 8) rect(ctx, x0 + x, y0 + y, 8, 8, ((x + y) / 8) % 2 === 0 ? OFFICE.tile : OFFICE.tileAlt);
      }
    } else if (zone.kind === 'partition') {
      rect(ctx, x0, y0 - 2, w, 14, OFFICE.wall);
      rect(ctx, x0, y0 - 4, w, 3, OFFICE.wallTop);
      rect(ctx, x0, y0 + 6, w, 4, OFFICE.wallShade);
      rect(ctx, x0, y0 + 10, w, 3, OFFICE.trim);
      rect(ctx, x0, y0 + 13, w, 1, OFFICE.trimDark);
      rect(ctx, x0, y0 + 14, w, 2, OFFICE.shadow);
    } else {
      rect(ctx, x0 + 2, y0 + 3, w - 4, h - 6, OFFICE.rugBorder);
      rect(ctx, x0 + 4, y0 + 5, w - 8, h - 10, OFFICE.rug);
      for (let x = x0 + 8; x < x0 + w - 8; x += 6) {
        rect(ctx, x, y0 + 8, 3, 1, OFFICE.rugInner);
        rect(ctx, x + 3, y0 + h - 9, 3, 1, OFFICE.rugInner);
      }
    }
  }
}

function paintWindow(ctx: Ctx, x: number, w: number): void {
  const top = 8;
  const bottom = 31;
  rect(ctx, x - 1, top - 1, w + 2, bottom - top + 2, OFFICE.frame);
  rect(ctx, x + 1, top + 1, w - 2, 10, OFFICE.glassTop);
  rect(ctx, x + 1, top + 11, w - 2, bottom - top - 12, OFFICE.glassBottom);
  const random = seededRandom(x * 977);
  for (let bx = x + 1; bx < x + w - 1;) {
    const bw = 3 + Math.floor(random() * 5);
    const bh = 4 + Math.floor(random() * 7);
    rect(ctx, bx, bottom - 1 - bh, Math.min(bw, x + w - 1 - bx), bh, OFFICE.skylineFar);
    bx += bw;
  }
  for (let bx = x + 2; bx < x + w - 2;) {
    const bw = 4 + Math.floor(random() * 4);
    const bh = 3 + Math.floor(random() * 5);
    rect(ctx, bx, bottom - 1 - bh, Math.min(bw, x + w - 1 - bx), bh, OFFICE.skyline);
    bx += bw + 2;
  }
  for (let i = 0; i < 5; i += 1) rect(ctx, x + 4 + i, top + 6 - i, 1, 1, OFFICE.glassShine);
  rect(ctx, x + Math.floor(w / 2), top, 1, bottom - top, OFFICE.frame);
  rect(ctx, x, top + 10, w, 1, OFFICE.frame);
  rect(ctx, x - 2, bottom + 1, w + 4, 2, OFFICE.trim);
}

function paintBoard(ctx: Ctx, x: number, w: number): void {
  rect(ctx, x - 1, 7, w + 2, 23, OFFICE.boardFrame);
  rect(ctx, x, 8, w, 21, OFFICE.board);
  const bars = [6, 10, 7, 13, 9];
  bars.forEach((height, index) => { rect(ctx, x + 4 + index * 4, 25 - height, 3, height, OFFICE.ink[index % 2]); });
  rect(ctx, x + 3, 25, 20, 1, OFFICE.outline);
  for (let i = 0; i < 14; i += 1) rect(ctx, x + 27 + i, 12 + Math.round(Math.sin(i / 2) * 2), 1, 1, OFFICE.ink[2]);
  rect(ctx, x + 27, 18, 12, 1, OFFICE.ink[1]);
  rect(ctx, x + 27, 21, 8, 1, OFFICE.ink[0]);
  rect(ctx, x + 2, 29, w - 4, 2, OFFICE.boardFrame);
  rect(ctx, x + 6, 28, 4, 1, OFFICE.ink[0]);
  rect(ctx, x + 11, 28, 4, 1, OFFICE.ink[1]);
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

function paintDoor(ctx: Ctx, x: number, w: number): void {
  const top = 13;
  const bottom = WALL_ROWS * TILE;
  rect(ctx, x - 2, top - 2, w + 4, bottom - top + 2, OFFICE.trimDark);
  rect(ctx, x, top, w, bottom - top, OFFICE.door);
  rect(ctx, x, top, w, 1, OFFICE.doorLight);
  const leaf = Math.floor(w / 2);
  rect(ctx, x + leaf, top, 1, bottom - top, OFFICE.doorDark);
  for (const left of [x + 3, x + leaf + 3]) {
    rect(ctx, left - 1, top + 4, leaf - 4, 10, OFFICE.doorDark);
    rect(ctx, left, top + 5, leaf - 6, 8, OFFICE.doorGlass);
    rect(ctx, left, top + 5, 2, 2, OFFICE.glassShine);
    rect(ctx, left - 1, top + 18, leaf - 4, 12, OFFICE.doorDark);
    rect(ctx, left, top + 19, leaf - 6, 10, OFFICE.doorLight);
  }
  rect(ctx, x + leaf - 3, top + 17, 2, 2, OFFICE.mail);
  rect(ctx, x + leaf + 2, top + 17, 2, 2, OFFICE.mail);
  rect(ctx, x + leaf - 5, top - 9, 10, 5, OFFICE.outline);
  rect(ctx, x + leaf - 4, top - 8, 8, 3, OFFICE.exit);
  rect(ctx, x + leaf - 2, top - 7, 4, 1, OFFICE.paper);
  rect(ctx, x - 2, bottom, w + 4, 3, OFFICE.rugBorder);
  rect(ctx, x, bottom + 1, w, 1, OFFICE.rug);
}

export function paintRoom(ctx: Ctx, layout: OfficeLayout): void {
  const width = layout.cols * TILE;
  const height = layout.rows * TILE;
  rect(ctx, 0, 0, width, height, OFFICE.carpet);
  paintFloor(ctx, layout);
  const wallH = WALL_ROWS * TILE;
  rect(ctx, 0, 0, width, wallH, OFFICE.wall);
  rect(ctx, 0, 0, width, 4, OFFICE.wallTop);
  rect(ctx, 0, 4, width, 1, OFFICE.wallShade);
  rect(ctx, 0, 35, width, wallH - 35, OFFICE.wallShade);
  rect(ctx, 0, 35, width, 1, OFFICE.trim);
  rect(ctx, 0, wallH - 5, width, 3, OFFICE.trim);
  rect(ctx, 0, wallH - 2, width, 2, OFFICE.trimDark);
  for (const item of layout.wall) {
    const x = item.x * TILE;
    if (item.kind === 'window') paintWindow(ctx, x + 2, item.w * TILE - 4);
    else if (item.kind === 'board') paintBoard(ctx, x + 2, item.w * TILE - 4);
    else if (item.kind === 'door') paintDoor(ctx, x + 2, item.w * TILE - 4);
    else paintClock(ctx, x);
  }
  rect(ctx, 0, wallH, width, 2, OFFICE.shadow);
  rect(ctx, 0, wallH, width, 1, OFFICE.shadow);
}

export interface DeskState {
  monitor: MonitorMode;
  /** Owner seated and typing: hands move over the keyboard. */
  typing: boolean;
  hands?: string;
  offline: boolean;
  /** Owner asleep with the head on folded arms; only drawn on desks that face the viewer. */
  napper?: CharPalette;
}

/** Folded arms and a bowed head on the desk top, right of the monitor so the face-down head shows. */
function napOnDesk(ctx: Ctx, x: number, y: number, look: CharPalette): void {
  rect(ctx, x + 12, y, 19, 7, OFFICE.outline);
  rect(ctx, x + 13, y + 1, 17, 5, look.t);
  rect(ctx, x + 13, y + 5, 17, 1, look.T);
  rect(ctx, x + 13, y + 1, 3, 3, look.s);
  rect(ctx, x + 27, y + 1, 3, 3, look.s);
  rect(ctx, x + 17, y - 6, 11, 9, OFFICE.outline);
  rect(ctx, x + 16, y - 5, 13, 7, OFFICE.outline);
  rect(ctx, x + 18, y - 5, 9, 8, look.h);
  rect(ctx, x + 17, y - 4, 11, 6, look.h);
  rect(ctx, x + 19, y - 5, 4, 1, look.H);
  rect(ctx, x + 17, y + 1, 11, 1, look.H);
  rect(ctx, x + 21, y + 2, 3, 1, look.S);
}

export interface Drawable { sortY: number; draw: (ctx: Ctx, time: number) => void }

function shadow(ctx: Ctx, x: number, y: number, w: number): void {
  rect(ctx, x + 1, y, w - 2, 2, OFFICE.shadow);
}

function screen(ctx: Ctx, x: number, y: number, mode: MonitorMode, time: number, seed: number): void {
  const w = 12;
  const h = 8;
  if (mode === 'off') {
    rect(ctx, x, y, w, h, OFFICE.screenOff);
    rect(ctx, x + 1, y + 1, 3, 1, OFFICE.monitorLight);
    return;
  }
  if (mode === 'error') {
    const on = Math.floor(time * 2.5) % 2 === 0;
    rect(ctx, x, y, w, h, on ? OFFICE.screenError : '#c94a4a');
    rect(ctx, x + 5, y + 1, 2, 4, OFFICE.paper);
    rect(ctx, x + 5, y + 6, 2, 1, OFFICE.paper);
    return;
  }
  if (mode === 'idle') {
    rect(ctx, x, y, w, h, OFFICE.screenSleep);
    const t = time * 0.6 + seed;
    rect(ctx, x + 1 + Math.floor((Math.sin(t) + 1) * 4.5), y + 1 + Math.floor((Math.cos(t * 1.3) + 1) * 2.5), 1, 1, OFFICE.screenOn);
    return;
  }
  rect(ctx, x, y, w, h, '#1f2a3d');
  const scroll = Math.floor(time * 3 + seed);
  for (let line = 0; line < 4; line += 1) {
    const random = seededRandom(seed * 31 + scroll + line);
    const indent = Math.floor(random() * 3);
    const len = 3 + Math.floor(random() * 6);
    rect(ctx, x + 1 + indent, y + 1 + line * 2, Math.min(len, w - 2 - indent), 1, OFFICE.code[Math.floor(random() * 4)]);
  }
  if (Math.floor(time * 2) % 2 === 0) rect(ctx, x + 2, y + 7, 2, 1, OFFICE.code[4]);
}

function monitorFront(ctx: Ctx, cx: number, base: number, mode: MonitorMode, time: number, seed: number): void {
  if (mode === 'code' || mode === 'error') {
    ctx.fillStyle = mode === 'error' ? 'rgba(255, 110, 110, 0.22)' : OFFICE.screenGlow;
    ctx.fillRect(cx - 10, base - 13, 20, 16);
  }
  rect(ctx, cx - 8, base - 12, 16, 11, OFFICE.outline);
  rect(ctx, cx - 7, base - 11, 14, 9, OFFICE.monitor);
  screen(ctx, cx - 6, base - 11, mode, time, seed);
  rect(ctx, cx - 1, base - 1, 2, 2, OFFICE.monitor);
  rect(ctx, cx - 3, base + 1, 6, 1, OFFICE.outline);
}

function monitorBack(ctx: Ctx, cx: number, base: number, mode: MonitorMode): void {
  rect(ctx, cx - 8, base - 12, 16, 11, OFFICE.outline);
  rect(ctx, cx - 7, base - 11, 14, 9, OFFICE.monitorLight);
  rect(ctx, cx - 7, base - 3, 14, 1, OFFICE.monitor);
  rect(ctx, cx - 1, base - 8, 2, 2, mode === 'off' ? OFFICE.monitor : OFFICE.ledOk);
  rect(ctx, cx - 1, base - 1, 2, 2, OFFICE.monitor);
  rect(ctx, cx - 3, base + 1, 6, 1, OFFICE.outline);
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
        if (s.napper) napOnDesk(ctx, x, y, s.napper);
        else rect(ctx, x + 26, y + 3, 3, 3, OFFICE.mug);
        if (s.offline) {
          rect(ctx, x + 2, y + 2, 5, 4, OFFICE.paper);
          rect(ctx, x + 3, y + 3, 3, 2, OFFICE.offSign);
        }
        monitorBack(ctx, x + 10, y + 14, s.monitor);
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
      monitorFront(ctx, x + 20, y + 3, s.monitor, time, seed);
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

function sofaDrawables(x: number, y: number, w: number, facing: 'down' | 'up', alt: boolean): Drawable[] {
  const left = x * TILE;
  const top = y * TILE;
  const width = w * TILE;
  const base = alt ? OFFICE.sofaAlt : OFFICE.sofa;
  const dark = alt ? OFFICE.sofaAltDark : OFFICE.sofaDark;
  const light = alt ? OFFICE.sofaAltLight : OFFICE.sofaLight;
  const cushions = (ctx: Ctx, cy: number) => {
    for (let i = 0; i < w; i += 1) {
      rect(ctx, left + 4 + i * ((width - 8) / w), cy, (width - 8) / w - 1, 6, light);
      rect(ctx, left + 4 + i * ((width - 8) / w), cy + 5, (width - 8) / w - 1, 1, base);
    }
  };
  if (facing === 'down') {
    return [
      {
        sortY: top + 1,
        draw: (ctx) => {
          rect(ctx, left, top - 6, width, 18, OFFICE.outline);
          rect(ctx, left + 1, top - 5, width - 2, 10, dark);
          rect(ctx, left + 1, top - 5, width - 2, 2, base);
          cushions(ctx, top + 4);
        },
      },
      {
        sortY: top + TILE - 1,
        draw: (ctx) => {
          shadow(ctx, left, top + 15, width);
          rect(ctx, left, top + 10, width, 6, OFFICE.outline);
          rect(ctx, left + 1, top + 10, width - 2, 5, dark);
          rect(ctx, left, top - 2, 5, 18, OFFICE.outline);
          rect(ctx, left + width - 5, top - 2, 5, 18, OFFICE.outline);
          rect(ctx, left + 1, top - 1, 3, 16, base);
          rect(ctx, left + width - 4, top - 1, 3, 16, base);
          rect(ctx, left + 1, top - 1, 3, 1, light);
          rect(ctx, left + width - 4, top - 1, 3, 1, light);
        },
      },
    ];
  }
  return [
    {
      sortY: top + 1,
      draw: (ctx) => {
        rect(ctx, left, top - 2, width, 12, OFFICE.outline);
        rect(ctx, left + 1, top - 1, width - 2, 10, dark);
        cushions(ctx, top);
      },
    },
    {
      sortY: top + TILE - 1,
      draw: (ctx) => {
        shadow(ctx, left, top + 16, width);
        rect(ctx, left, top + 5, width, 12, OFFICE.outline);
        rect(ctx, left + 1, top + 6, width - 2, 10, base);
        rect(ctx, left + 1, top + 6, width - 2, 2, light);
        rect(ctx, left + 1, top + 14, width - 2, 2, dark);
        rect(ctx, left, top - 2, 5, 14, OFFICE.outline);
        rect(ctx, left + width - 5, top - 2, 5, 14, OFFICE.outline);
        rect(ctx, left + 1, top - 1, 3, 12, base);
        rect(ctx, left + width - 4, top - 1, 3, 12, base);
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

function lamp(ctx: Ctx, x: number, y: number): void {
  const cx = x * TILE + 8;
  const base = y * TILE + 14;
  ctx.fillStyle = OFFICE.lampGlow;
  ctx.fillRect(cx - 9, base - 22, 18, 16);
  shadow(ctx, cx - 6, base, 12);
  rect(ctx, cx - 6, base - 9, 12, 10, OFFICE.outline);
  rect(ctx, cx - 5, base - 8, 10, 8, OFFICE.bedFrame);
  rect(ctx, cx - 5, base - 8, 10, 1, OFFICE.bedFrameLight);
  rect(ctx, cx - 4, base - 5, 8, 1, OFFICE.outline);
  rect(ctx, cx - 1, base - 14, 2, 5, OFFICE.outline);
  rect(ctx, cx - 5, base - 20, 10, 7, OFFICE.outline);
  rect(ctx, cx - 4, base - 19, 8, 5, OFFICE.lampShade);
  rect(ctx, cx - 4, base - 19, 8, 1, OFFICE.paper);
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

function rack(ctx: Ctx, x: number, y: number, time: number): void {
  const left = x * TILE + 1;
  const top = y * TILE - 14;
  shadow(ctx, left, top + 30, 14);
  rect(ctx, left - 1, top - 1, 16, 31, OFFICE.outline);
  rect(ctx, left, top, 14, 29, OFFICE.rack);
  for (let row = 0; row < 6; row += 1) {
    const ry = top + 2 + row * 4.5;
    rect(ctx, left + 1, ry, 12, 3, OFFICE.rackDark);
    const random = seededRandom(x * 100 + row * 7 + Math.floor(time * 3 + row));
    const colors = [OFFICE.ledOk, OFFICE.ledOk, OFFICE.ledInfo, OFFICE.ledWarn];
    for (let led = 0; led < 3; led += 1) {
      if (random() > 0.3) rect(ctx, left + 8 + led * 2, ry + 1, 1, 1, colors[Math.floor(random() * colors.length)]);
    }
    rect(ctx, left + 2, ry + 1, 4, 1, '#3a404d');
  }
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

function shelf(ctx: Ctx, x: number, y: number): void {
  const left = x * TILE + 1;
  const top = y * TILE - 14;
  shadow(ctx, left, top + 30, 30);
  rect(ctx, left - 1, top - 1, 32, 31, OFFICE.outline);
  rect(ctx, left, top, 30, 29, OFFICE.deskFront);
  const colors = [OFFICE.ink[0], OFFICE.ink[1], OFFICE.ink[2], OFFICE.mail, OFFICE.sofaAlt, OFFICE.beanbag[1], OFFICE.paper];
  for (let row = 0; row < 3; row += 1) {
    const sy = top + 2 + row * 9;
    rect(ctx, left + 1, sy, 28, 7, OFFICE.deskDark);
    const random = seededRandom(x * 31 + row * 5);
    for (let bx = left + 2; bx < left + 27;) {
      const w = 2 + Math.floor(random() * 2);
      const h = 4 + Math.floor(random() * 3);
      rect(ctx, bx, sy + 7 - h, w, h, colors[Math.floor(random() * colors.length)]);
      bx += w + (random() > 0.75 ? 2 : 0);
    }
    rect(ctx, left, sy + 7, 30, 1, OFFICE.deskLight);
  }
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

export function furnitureDrawables(layout: OfficeLayout, deskState: (slot: number) => DeskState): Drawable[] {
  const list: Drawable[] = [];
  const at = (_piece: Furniture, sortY: number, draw: (ctx: Ctx, time: number) => void) => {
    list.push({ sortY, draw });
  };
  for (const piece of layout.furniture) {
    switch (piece.kind) {
      case 'desk':
        list.push(...deskDrawables(layout.desks[piece.slot], () => deskState(piece.slot)));
        break;
      case 'chair':
        list.push(...chairDrawables(piece.x, piece.y, piece.facing));
        break;
      case 'sofa':
        list.push(...sofaDrawables(piece.x, piece.y, piece.w, piece.facing, piece.alt));
        break;
      case 'beanbag':
        list.push(...beanbagDrawables(piece.x, piece.y, piece.variant));
        break;
      case 'plant':
        at(piece, piece.y * TILE + 15, (ctx) => { plant(ctx, piece.x, piece.y, piece.big); });
        break;
      case 'counter':
        at(piece, piece.y * TILE + 14, (ctx) => { counter(ctx, piece.x, piece.y, piece.w); });
        break;
      case 'coffee':
        at(piece, piece.y * TILE + 14.5, (ctx, time) => { coffeeMachine(ctx, piece.x, piece.y, time); });
        break;
      case 'fridge':
        at(piece, piece.y * TILE + 15, (ctx) => { fridge(ctx, piece.x, piece.y); });
        break;
      case 'rack':
        at(piece, piece.y * TILE + 15, (ctx, time) => { rack(ctx, piece.x, piece.y, time); });
        break;
      case 'cooler':
        at(piece, piece.y * TILE + 15, (ctx) => { cooler(ctx, piece.x, piece.y); });
        break;
      case 'shelf':
        at(piece, piece.y * TILE + 15, (ctx) => { shelf(ctx, piece.x, piece.y); });
        break;
      case 'bed':
        at(piece, piece.y * TILE + 1, (ctx) => { bed(ctx, piece.x, piece.y, piece.variant); });
        break;
      case 'lamp':
        at(piece, piece.y * TILE + 14, (ctx) => { lamp(ctx, piece.x, piece.y); });
        break;
      case 'table':
        at(piece, piece.y * TILE + 13, (ctx) => { table(ctx, piece.x, piece.y); });
        break;
    }
  }
  return list;
}

