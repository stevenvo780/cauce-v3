import { TILE } from './level';
import { rect, type Ctx } from './paint';
import { OFFICE } from './palette';
import { seededRandom } from './random';

const SHADOW = OFFICE.shadow;

export function paintNightWindow(ctx: Ctx, x: number, w: number, top: number, bottom: number): void {
  const h = bottom - top;
  rect(ctx, x - 1, top - 1, w + 2, h + 2, OFFICE.frame);
  rect(ctx, x, top, w, h, OFFICE.nightSky);
  rect(ctx, x, top + Math.floor(h * 0.65), w, h - Math.floor(h * 0.65), OFFICE.nightSkyLow);
  const random = seededRandom(x * 131 + top);
  for (let i = 0; i < Math.max(3, Math.floor(w / 5)); i += 1) {
    rect(ctx, x + 1 + Math.floor(random() * (w - 2)), top + 1 + Math.floor(random() * Math.max(1, h - 4)), 1, 1, OFFICE.star);
  }
  const mx = x + w - 9;
  rect(ctx, mx, top + 3, 5, 3, OFFICE.moon);
  rect(ctx, mx + 1, top + 2, 3, 5, OFFICE.moon);
  rect(ctx, mx + 2, top + 2, 3, 3, OFFICE.nightSky);
  rect(ctx, x - 3, top - 3, w + 6, 2, OFFICE.curtainDark);
  rect(ctx, x - 3, top - 1, 4, h + 3, OFFICE.curtain);
  rect(ctx, x + w - 1, top - 1, 4, h + 3, OFFICE.curtain);
  rect(ctx, x - 2, bottom + 1, w + 4, 2, OFFICE.trim);
}

export function nightstand(ctx: Ctx, x: number, y: number): void {
  const left = x * TILE + 2;
  const base = y * TILE + 14;
  ctx.fillStyle = OFFICE.lampGlow;
  ctx.fillRect(left - 5, base - 27, 22, 20);
  rect(ctx, left + 1, base + 1, 10, 2, SHADOW);
  rect(ctx, left, base - 10, 12, 11, OFFICE.outline);
  rect(ctx, left + 1, base - 9, 10, 9, OFFICE.bedFrame);
  rect(ctx, left + 1, base - 9, 10, 1, OFFICE.bedFrameLight);
  rect(ctx, left + 1, base - 5, 10, 1, OFFICE.outline);
  rect(ctx, left + 5, base - 3, 2, 1, OFFICE.mail);
  rect(ctx, left + 4, base - 13, 4, 3, OFFICE.outline);
  rect(ctx, left + 5, base - 16, 2, 3, OFFICE.outline);
  rect(ctx, left + 2, base - 22, 8, 7, OFFICE.outline);
  rect(ctx, left + 3, base - 21, 6, 5, OFFICE.lampShade);
  rect(ctx, left + 3, base - 21, 6, 1, OFFICE.paper);
}

export function arcade(ctx: Ctx, x: number, y: number, station: number, active: boolean, time: number): void {
  const left = x * TILE + 1;
  const base = y * TILE + 15;
  const top = base - 30;
  const body = OFFICE.arcade[station % OFFICE.arcade.length];
  const dark = OFFICE.arcadeDark[station % OFFICE.arcadeDark.length];
  if (active) {
    ctx.fillStyle = OFFICE.screenGlow;
    ctx.fillRect(left - 3, top + 3, 20, 16);
  }
  rect(ctx, left + 1, base, 12, 2, SHADOW);
  rect(ctx, left - 1, top - 1, 16, 32, OFFICE.outline);
  rect(ctx, left, top, 14, 30, body);
  rect(ctx, left, top, 14, 4, OFFICE.marquee);
  rect(ctx, left + 3, top + 1, 8, 2, dark);
  rect(ctx, left + 2, top + 5, 10, 10, OFFICE.outline);
  rect(ctx, left + 3, top + 6, 8, 8, OFFICE.arcadeScreen);
  if (active) {
    const random = seededRandom(station * 97 + Math.floor(time * 8));
    for (let i = 0; i < 6; i += 1) {
      rect(ctx, left + 3 + Math.floor(random() * 7), top + 6 + Math.floor(random() * 7), 2, 1, OFFICE.code[Math.floor(random() * 5)]);
    }
    rect(ctx, left + 4 + (Math.floor(time * 5) % 6), top + 12, 2, 2, OFFICE.ledOk);
  } else if (Math.floor(time * 1.2 + station) % 2 === 0) {
    rect(ctx, left + 5, top + 9, 4, 1, OFFICE.marquee);
  }
  rect(ctx, left - 1, top + 16, 16, 4, OFFICE.outline);
  rect(ctx, left, top + 17, 14, 2, dark);
  rect(ctx, left + 2, top + 14, 3, 2, OFFICE.alert);
  rect(ctx, left + 3, top + 16, 1, 1, OFFICE.outline);
  rect(ctx, left + 8, top + 17, 2, 1, OFFICE.mail);
  rect(ctx, left + 11, top + 17, 2, 1, OFFICE.ledInfo);
  rect(ctx, left, top + 20, 14, 10, dark);
  rect(ctx, left + 5, top + 23, 4, 3, OFFICE.outline);
  rect(ctx, left + 6, top + 24, 2, 1, OFFICE.led);
}

/** Three tiles wide with the net across the middle; the ball only flies while someone plays. */
export function pingpong(ctx: Ctx, x: number, y: number, active: boolean, time: number): void {
  const left = x * TILE + 1;
  const w = 3 * TILE - 2;
  const top = y * TILE + 1;
  rect(ctx, left + 2, top + 16, w - 4, 2, SHADOW);
  rect(ctx, left + 2, top + 12, 2, 5, OFFICE.outline);
  rect(ctx, left + w - 4, top + 12, 2, 5, OFFICE.outline);
  rect(ctx, left - 1, top - 1, w + 2, 15, OFFICE.outline);
  rect(ctx, left, top, w, 10, OFFICE.pingpong);
  rect(ctx, left, top + 10, w, 3, OFFICE.pingpongDark);
  rect(ctx, left, top, w, 1, OFFICE.net);
  rect(ctx, left, top + 9, w, 1, OFFICE.net);
  rect(ctx, left, top, 1, 10, OFFICE.net);
  rect(ctx, left + w - 1, top, 1, 10, OFFICE.net);
  rect(ctx, left + 1, top + 5, w - 2, 1, 'rgba(255, 255, 255, 0.45)');
  const mid = left + Math.floor(w / 2);
  rect(ctx, mid - 1, top - 4, 3, 15, OFFICE.outline);
  rect(ctx, mid, top - 3, 1, 13, OFFICE.net);
  if (!active) return;
  const phase = (time * 0.75) % 1;
  const rightwards = phase < 0.5;
  const u = (phase % 0.5) * 2;
  const hop = u < 0.7 ? Math.sin((Math.PI * u) / 0.7) * 9 : Math.sin((Math.PI * (u - 0.7)) / 0.3) * 5;
  const bx = Math.round(rightwards ? left + 2 + u * (w - 6) : left + w - 4 - u * (w - 6));
  rect(ctx, bx, top + 5, 2, 1, 'rgba(0, 0, 0, 0.25)');
  rect(ctx, bx, Math.round(top + 3 - hop), 2, 2, OFFICE.paper);
}

/** Two tiles wide, rods running front to back; the little players twitch while a match is on. */
export function foosball(ctx: Ctx, x: number, y: number, active: boolean, time: number): void {
  const left = x * TILE + 1;
  const w = 2 * TILE - 2;
  const top = y * TILE;
  rect(ctx, left + 2, top + 17, w - 4, 2, SHADOW);
  rect(ctx, left + 2, top + 14, 2, 4, OFFICE.outline);
  rect(ctx, left + w - 4, top + 14, 2, 4, OFFICE.outline);
  rect(ctx, left - 1, top - 1, w + 2, 16, OFFICE.outline);
  rect(ctx, left, top, w, 15, OFFICE.foosFrame);
  rect(ctx, left + 2, top + 2, w - 4, 9, OFFICE.foosField);
  rect(ctx, left + Math.floor(w / 2), top + 2, 1, 9, 'rgba(255, 255, 255, 0.55)');
  rect(ctx, left + 2, top + 5, 1, 3, OFFICE.paper);
  rect(ctx, left + w - 3, top + 5, 1, 3, OFFICE.paper);
  rect(ctx, left, top + 11, w, 4, OFFICE.deskDark);
  [6, 11, 17, 22].forEach((dx, index) => {
    const rx = left + dx;
    const shift = active ? Math.round(Math.sin(time * 7 + index * 1.7) * 1.5) : 0;
    rect(ctx, rx, top - 3, 1, 17, OFFICE.rod);
    rect(ctx, rx - 1, index % 2 === 0 ? top - 4 : top + 13, 3, 2, OFFICE.outline);
    const color = index % 2 === 0 ? OFFICE.foosRed : OFFICE.foosBlue;
    rect(ctx, rx - 1, top + 3 + shift, 3, 2, color);
    rect(ctx, rx - 1, top + 7 + shift, 3, 2, color);
  });
  if (active) rect(ctx, left + 3 + Math.floor((Math.sin(time * 2.3) + 1) * 0.5 * (w - 8)), top + 6, 2, 2, OFFICE.paper);
}
