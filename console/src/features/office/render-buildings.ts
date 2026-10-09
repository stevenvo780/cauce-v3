import type { Site } from './campus';
import { TILE } from './level';
import { rect, type Ctx, type MakeCanvas } from './paint';
import { OFFICE } from './palette';
import { fitText, paintText, textWidth } from './pixel-font';
import { seededRandom } from './random';
import { teamTone } from './teams';

/** Px of the facade at the bottom of a footprint; the roof fills the rest. */
export const FACADE = 26;
/** Room around a footprint in a building sprite, for eaves, chimneys and the sign. */
export const SPRITE_PAD = { x: 4, top: 14, bottom: 3 };
export const BUILD_S = 6;
export const DEMOLISH_S = 5;

export interface Rect { x: number; y: number; w: number; h: number }

/** Window slots on the facade, relative to the footprint's top-left, left to right and top row first. */
export function facadeWindows(site: Pick<Site, 'w' | 'h' | 'kind' | 'door' | 'x'>): Rect[] {
  const width = site.w * TILE;
  const top = site.h * TILE - FACADE;
  const doorCx = (site.door.tile.x - site.x) * TILE + TILE / 2;
  const out: Rect[] = [];
  const size = site.kind === 'lobby' || site.kind === 'cafe' ? 8 : 6;
  const step = size + 3;
  const rows = site.kind === 'cafe' || site.kind === 'lobby' ? [top + 7] : [top + 4, top + 13];
  for (const y of rows) {
    for (let x = 5; x + size <= doorCx - 8; x += step) out.push({ x, y, w: size, h: size });
    for (let x = doorCx + 8; x + size <= width - 5; x += step) out.push({ x, y, w: size, h: size });
  }
  return out.sort((a, b) => a.y - b.y || a.x - b.x);
}

function roofColors(site: Site): { base: string; dark: string; light: string } {
  switch (site.kind) {
    case 'cafe': return { base: '#b5543f', dark: '#8e3d2d', light: '#cf7158' };
    case 'dorm': return { base: '#5a5fa8', dark: '#43478a', light: '#7479c4' };
    case 'lobby': return { base: '#7e8796', dark: '#646c7a', light: '#9aa3b1' };
    case 'shop': return { base: '#8a929e', dark: '#6b737f', light: '#a8b0ba' };
    default: return { base: teamTone(site.hue, 48, 46), dark: teamTone(site.hue, 50, 34), light: teamTone(site.hue, 55, 60) };
  }
}

function paintRoof(ctx: Ctx, site: Site, ox: number, oy: number): void {
  const width = site.w * TILE;
  const roofH = site.h * TILE - FACADE;
  const { base, dark, light } = roofColors(site);
  const flat = site.kind === 'lobby' || site.kind === 'shop';
  rect(ctx, ox - 3, oy - 2, width + 6, roofH + 4, OFFICE.roofEdge);
  rect(ctx, ox - 2, oy - 1, width + 4, roofH + 2, base);
  if (flat) {
    for (let y = oy + 3; y < oy + roofH - 2; y += 5) rect(ctx, ox, y, width, 1, dark);
    if (site.kind === 'shop') for (let x = ox + 2; x < ox + width - 2; x += 4) rect(ctx, x, oy, 1, roofH - 1, light);
    rect(ctx, ox - 2, oy - 1, width + 4, 2, light);
  } else {
    const ridge = oy + Math.floor(roofH / 2) - 2;
    for (let y = oy + 1; y < oy + roofH; y += 4) {
      const shift = Math.floor((y - oy) / 4) % 2 === 0 ? 0 : 3;
      rect(ctx, ox - 2, y + 3, width + 4, 1, dark);
      for (let x = ox - 2 + shift; x < ox + width + 2; x += 6) rect(ctx, x, y, 1, 3, dark);
    }
    rect(ctx, ox - 2, ridge, width + 4, 3, light);
    rect(ctx, ox - 2, ridge + 3, width + 4, 1, dark);
  }
  rect(ctx, ox - 3, oy + roofH, width + 6, 2, OFFICE.roofEdge);
}

function paintFacade(ctx: Ctx, site: Site, ox: number, oy: number): void {
  const width = site.w * TILE;
  const top = oy + site.h * TILE - FACADE;
  const wall = site.kind === 'shop' ? OFFICE.concrete : site.kind === 'lobby' ? '#e9edf2' : OFFICE.facade;
  rect(ctx, ox - 1, top, width + 2, FACADE, OFFICE.outline);
  rect(ctx, ox, top + 1, width, FACADE - 2, wall);
  rect(ctx, ox, top + 1, width, 2, OFFICE.facadeShade);
  rect(ctx, ox, top + FACADE - 6, width, 5, site.kind === 'lobby' ? OFFICE.metalLight : OFFICE.brick);
  for (let x = ox + 2; x < ox + width; x += 6) rect(ctx, x, top + FACADE - 4, 1, 2, OFFICE.brickDark);
  for (const slot of facadeWindows(site)) {
    rect(ctx, ox + slot.x - 1, oy + slot.y - 1, slot.w + 2, slot.h + 2, OFFICE.outline);
    rect(ctx, ox + slot.x, oy + slot.y, slot.w, slot.h, OFFICE.windowOff);
    rect(ctx, ox + slot.x - 1, oy + slot.y + slot.h + 1, slot.w + 2, 1, OFFICE.facadeShade);
  }
}

function paintDoorway(ctx: Ctx, site: Site, ox: number, oy: number): void {
  const cx = ox + (site.door.tile.x - site.x) * TILE + TILE / 2;
  const bottom = oy + site.h * TILE;
  const wide = site.kind === 'shop';
  const half = wide ? 9 : 6;
  const tall = wide ? 18 : 15;
  rect(ctx, cx - half - 1, bottom - tall - 1, half * 2 + 2, tall + 1, OFFICE.outline);
  rect(ctx, cx - half, bottom - tall, half * 2, tall, wide ? OFFICE.metal : OFFICE.door);
  if (wide) {
    for (let y = bottom - tall + 2; y < bottom; y += 3) rect(ctx, cx - half, y, half * 2, 1, OFFICE.metalLight);
    rect(ctx, cx - half, bottom - tall, half * 2, 2, OFFICE.ledWarn);
  } else {
    rect(ctx, cx - half + 2, bottom - tall + 2, half * 2 - 4, 5, OFFICE.doorGlass);
    rect(ctx, cx + half - 4, bottom - 8, 2, 2, OFFICE.mail);
  }
  rect(ctx, cx - half - 2, bottom - 1, half * 2 + 4, 1, OFFICE.stoneDark);
}

function paintPlaque(ctx: Ctx, text: string, cx: number, y: number, fill: string): void {
  const fit = fitText(text, 52, 1);
  const w = textWidth(fit.text, 1) + 6;
  rect(ctx, cx - Math.ceil(w / 2) - 1, y - 1, w + 2, 9, OFFICE.outline);
  rect(ctx, cx - Math.ceil(w / 2), y, w, 7, fill);
  paintText(ctx, fit.text, cx - Math.ceil(w / 2) + 3, y + 1, 1, '#ffffff');
}

function paintPark(ctx: Ctx, site: Site, ox: number, oy: number): void {
  const width = site.w * TILE;
  const height = site.h * TILE;
  rect(ctx, ox, oy, width, height, OFFICE.grass);
  const random = seededRandom(91);
  for (let i = 0; i < 70; i += 1) rect(ctx, ox + Math.floor(random() * width), oy + Math.floor(random() * height), 1, 2, OFFICE.grassBlade);
  rect(ctx, ox + 38, oy + 30, 34, 22, OFFICE.outline);
  rect(ctx, ox + 39, oy + 31, 32, 20, OFFICE.stone);
  rect(ctx, ox + 42, oy + 34, 26, 14, OFFICE.water);
  rect(ctx, ox + 46, oy + 37, 8, 1, OFFICE.waterLight);
  rect(ctx, ox + 12, oy + 60, 30, 20, OFFICE.playFloor);
  rect(ctx, ox + 16, oy + 63, 3, 12, OFFICE.alert);
  rect(ctx, ox + 19, oy + 63, 14, 3, OFFICE.alert);
  rect(ctx, ox + 30, oy + 66, 8, 2, OFFICE.mail);
  rect(ctx, ox + 90, oy + 62, 30, 12, OFFICE.pingpong);
  rect(ctx, ox + 104, oy + 62, 2, 12, OFFICE.net);
  for (const [tx, ty, variant] of [[14, 14, 0], [104, 18, 1], [70, 78, 2], [124, 44, 0]] as const) {
    rect(ctx, ox + tx - 1, oy + ty + 8, 4, 8, OFFICE.bark);
    rect(ctx, ox + tx - 9, oy + ty - 6, 20, 15, OFFICE.outline);
    rect(ctx, ox + tx - 8, oy + ty - 5, 18, 13, OFFICE.canopy[variant]);
    rect(ctx, ox + tx - 5, oy + ty - 3, 6, 3, OFFICE.leafLight);
  }
  const doorCx = ox + (site.door.tile.x - site.x) * TILE + TILE / 2;
  for (const [x, y, w, h] of [[ox - 2, oy - 2, width + 4, 5], [ox - 2, oy, 5, height], [ox + width - 3, oy, 5, height]] as const) {
    rect(ctx, x, y, w, h, OFFICE.hedgeDark);
    rect(ctx, x + 1, y + 1, w - 2, h - 3, OFFICE.hedge);
  }
  for (const [x, w] of [[ox - 2, doorCx - 10 - ox + 2], [doorCx + 10, ox + width + 2 - doorCx - 10]] as const) {
    rect(ctx, x, oy + height - 5, w, 6, OFFICE.hedgeDark);
    rect(ctx, x + 1, oy + height - 4, w - 2, 3, OFFICE.hedge);
  }
  rect(ctx, doorCx - 11, oy + height - 22, 3, 22, OFFICE.outline);
  rect(ctx, doorCx + 8, oy + height - 22, 3, 22, OFFICE.outline);
  rect(ctx, doorCx - 12, oy + height - 26, 24, 5, OFFICE.outline);
  rect(ctx, doorCx - 11, oy + height - 25, 22, 3, OFFICE.fence);
  paintPlaque(ctx, site.label, doorCx, oy + height - 35, '#3f8a44');
}

function paintExtras(ctx: Ctx, site: Site, ox: number, oy: number): void {
  const width = site.w * TILE;
  const roofH = site.h * TILE - FACADE;
  const doorCx = ox + (site.door.tile.x - site.x) * TILE + TILE / 2;
  const top = oy + roofH;
  switch (site.kind) {
    case 'cafe':
      rect(ctx, ox + width - 22, oy - 12, 9, 14, OFFICE.outline);
      rect(ctx, ox + width - 21, oy - 11, 7, 12, OFFICE.brickDark);
      for (let x = ox - 2; x < ox + width + 2; x += 8) {
        rect(ctx, x, top + 1, 8, 6, OFFICE.awning[Math.floor((x - ox) / 8) % 2 === 0 ? 0 : 1]);
        rect(ctx, x, top + 7, 8, 1, OFFICE.outline);
      }
      paintPlaque(ctx, 'CAFE', doorCx, oy + roofH - 10, '#8e3d2d');
      break;
    case 'dorm':
      rect(ctx, ox + 10, oy - 8, 8, 9, OFFICE.outline);
      rect(ctx, ox + 11, oy - 7, 6, 8, OFFICE.brick);
      paintPlaque(ctx, 'ZZZ', doorCx, oy + roofH - 10, '#43478a');
      break;
    case 'lobby':
      rect(ctx, ox + width - 10, oy - 22, 2, 24, OFFICE.outline);
      rect(ctx, ox + width - 8, oy - 21, 10, 6, OFFICE.exit);
      rect(ctx, ox + width - 8, oy - 18, 10, 1, OFFICE.paper);
      paintPlaque(ctx, 'RECEPCION', doorCx, oy + roofH - 10, '#3b6fd1');
      break;
    case 'shop':
      rect(ctx, ox + 6, oy - 6, 6, 6, OFFICE.outline);
      rect(ctx, ox + 7, oy - 5, 4, 5, OFFICE.metal);
      paintPlaque(ctx, 'TALLER', doorCx, oy + roofH - 10, '#a3324a');
      break;
    default:
      rect(ctx, ox + width - 14, oy - 9, 2, 10, OFFICE.outline);
      rect(ctx, ox + width - 18, oy - 10, 10, 2, OFFICE.outline);
      paintPlaque(ctx, site.label, doorCx, oy + roofH - 10, teamTone(site.hue, 55, 30));
  }
}

/** The building as a still sprite; windows, door and lights are added on top every frame. */
export function paintSiteSprite(make: MakeCanvas, site: Site): HTMLCanvasElement {
  const width = site.w * TILE + SPRITE_PAD.x * 2;
  const height = site.h * TILE + SPRITE_PAD.top + SPRITE_PAD.bottom;
  const sprite = make(width, height);
  const ctx = sprite.getContext('2d');
  if (!ctx || typeof ctx.fillRect !== 'function') return sprite;
  const ox = SPRITE_PAD.x;
  const oy = SPRITE_PAD.top;
  rect(ctx, ox + 3, oy + site.h * TILE - 2, site.w * TILE, 4, OFFICE.shadow);
  if (site.kind === 'park') {
    paintPark(ctx, site, ox, oy);
    return sprite;
  }
  paintRoof(ctx, site, ox, oy);
  paintFacade(ctx, site, ox, oy);
  paintDoorway(ctx, site, ox, oy);
  paintExtras(ctx, site, ox, oy);
  return sprite;
}

export type WindowLight = 'off' | 'dim' | 'work' | 'mail' | 'alert' | 'down';

const LIGHT: Readonly<Record<Exclude<WindowLight, 'off'>, string>> = {
  dim: OFFICE.windowDim,
  work: OFFICE.windowLit,
  mail: OFFICE.windowWarm,
  alert: OFFICE.windowAlert,
  down: OFFICE.windowDown,
};

/** One window: its light tells what the person at that desk is doing; the down get a red cross. */
export function paintWindowLight(ctx: Ctx, slot: Rect, x: number, y: number, light: WindowLight, time: number, seed: number): void {
  if (light === 'off') return;
  const left = x + slot.x;
  const top = y + slot.y;
  if (light === 'alert' && Math.floor(time * 2 + seed) % 2 === 1) {
    rect(ctx, left, top, slot.w, slot.h, OFFICE.windowOff);
    return;
  }
  rect(ctx, left, top, slot.w, slot.h, LIGHT[light]);
  if (light === 'work') {
    rect(ctx, left + 1, top + slot.h - 3, slot.w - 2, 2, Math.floor(time * 3 + seed) % 3 === 0 ? '#7fd8ff' : '#5fb3e6');
  } else if (light === 'down') {
    for (let i = 1; i < slot.w - 1; i += 1) {
      rect(ctx, left + i, top + i * (slot.h / slot.w), 1, 1, OFFICE.led);
      rect(ctx, left + slot.w - 1 - i, top + i * (slot.h / slot.w), 1, 1, OFFICE.led);
    }
  } else if (light === 'mail') {
    rect(ctx, left + 1, top + 1, slot.w - 2, 1, OFFICE.paper);
  }
}

/** Scaffolding, a crane and dust while a building goes up, `progress` from 0 to 1. */
export function paintConstruction(ctx: Ctx, sprite: HTMLCanvasElement, x: number, y: number, progress: number, time: number): void {
  const p = Math.min(1, Math.max(0, progress));
  const visible = Math.round(sprite.height * p);
  if (visible > 0) ctx.drawImage(sprite, 0, sprite.height - visible, sprite.width, visible, x, y + sprite.height - visible, sprite.width, visible);
  const bottom = y + sprite.height - SPRITE_PAD.bottom;
  rect(ctx, x + 2, bottom - 3, sprite.width - 4, 4, OFFICE.stoneDark);
  const top = Math.min(bottom - 10, y + sprite.height - visible);
  for (let px = x + 4; px < x + sprite.width - 4; px += 12) rect(ctx, px, top, 2, bottom - top, OFFICE.scaffold);
  for (let py = bottom - 8; py > top; py -= 9) rect(ctx, x + 3, py, sprite.width - 6, 2, OFFICE.scaffold);
  const mast = x + sprite.width + 4;
  rect(ctx, mast, y - 18, 3, sprite.height + 14, OFFICE.bus);
  rect(ctx, mast - 30, y - 20, 40, 3, OFFICE.bus);
  const hook = mast - 22 + Math.round(Math.sin(time * 1.3) * 6);
  rect(ctx, hook, y - 17, 1, 14 + Math.round(p * 10), OFFICE.outline);
  rect(ctx, hook - 3, y - 3 + Math.round(p * 10), 7, 4, OFFICE.box);
  for (let i = 0; i < 3; i += 1) {
    const phase = (time * 0.8 + i / 3) % 1;
    ctx.fillStyle = OFFICE.dust;
    ctx.fillRect(Math.round(x + 6 + i * (sprite.width / 3) + phase * 6), Math.round(bottom - 4 - phase * 10), 5, 4);
  }
}

/** The building comes down from the top in a cloud of dust. */
export function paintDemolition(ctx: Ctx, sprite: HTMLCanvasElement, x: number, y: number, progress: number, time: number): void {
  const p = Math.min(1, Math.max(0, progress));
  const left = Math.round(sprite.height * (1 - p));
  if (left > 0) {
    ctx.globalAlpha *= 1 - p * 0.4;
    ctx.drawImage(sprite, 0, sprite.height - left, sprite.width, left, x, y + sprite.height - left, sprite.width, left);
    ctx.globalAlpha = 1;
  }
  const bottom = y + sprite.height - SPRITE_PAD.bottom;
  rect(ctx, x + 4, bottom - 4, sprite.width - 8, 5, OFFICE.stoneDark);
  for (let i = 0; i < 6; i += 1) {
    const phase = (time * 0.9 + i / 6) % 1;
    ctx.fillStyle = OFFICE.dust;
    const size = 6 + Math.round(phase * 6);
    ctx.fillRect(Math.round(x + 4 + ((i * 37) % Math.max(8, sprite.width - 12))), Math.round(bottom - 8 - phase * 22 - (1 - p) * 10), size, size);
  }
}

/** A puff of smoke from the café chimney. */
export function paintSmoke(ctx: Ctx, x: number, y: number, time: number): void {
  for (let i = 0; i < 3; i += 1) {
    const phase = (time * 0.35 + i / 3) % 1;
    ctx.fillStyle = `rgba(235, 235, 235, ${String(0.75 - phase * 0.7)})`;
    const size = 3 + Math.round(phase * 5);
    ctx.fillRect(Math.round(x + Math.sin(phase * 5 + i) * 3), Math.round(y - phase * 22), size, size);
  }
}

/** The workshop beacon turns while somebody is under repair. */
export function paintBeacon(ctx: Ctx, x: number, y: number, on: boolean, time: number): void {
  rect(ctx, x - 3, y - 4, 6, 5, OFFICE.outline);
  rect(ctx, x - 2, y - 3, 4, 3, on && Math.floor(time * 6) % 2 === 0 ? OFFICE.windowAlert : '#9a6a1e');
  if (!on) return;
  const sweep = Math.floor(time * 6) % 4;
  ctx.fillStyle = 'rgba(255, 190, 60, 0.35)';
  if (sweep === 0) ctx.fillRect(x - 12, y - 3, 9, 2);
  if (sweep === 2) ctx.fillRect(x + 3, y - 3, 9, 2);
}
