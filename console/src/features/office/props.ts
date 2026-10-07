import { rect, type Ctx } from './paint';
import { OFFICE } from './palette';
import type { Actor } from './simulation';
import { CHAR_W, type Facing } from './sprites';

interface Held { x: number; y: number; facing: Facing }

function box(ctx: Ctx, x: number, y: number): void {
  rect(ctx, x - 1, y - 1, 9, 8, OFFICE.outline);
  rect(ctx, x, y, 7, 6, OFFICE.box);
  rect(ctx, x, y + 2, 7, 1, OFFICE.boxDark);
}

function broom(ctx: Ctx, at: Held, feet: number, time: number): void {
  const swing = Math.round(Math.sin(time * 5) * 3);
  const side = at.facing === 'left' ? -1 : 1;
  const hx = at.x + side * 4;
  for (let i = 0; i < 9; i += 1) rect(ctx, hx + Math.round((swing * i) / 9), at.y - 2 + i, 1, 1, OFFICE.broom);
  rect(ctx, hx + swing - 3, feet - 3, 7, 3, OFFICE.outline);
  rect(ctx, hx + swing - 2, feet - 3, 5, 2, OFFICE.straw);
  if (Math.floor(time * 4) % 3 === 0) rect(ctx, hx + swing + side * 5, feet - 2, 1, 1, OFFICE.stoneDark);
}

function wateringCan(ctx: Ctx, at: Held, time: number): void {
  const side = at.facing === 'left' ? -1 : 1;
  const cx = at.facing === 'up' || at.facing === 'down' ? at.x + 4 : at.x + side * 5;
  rect(ctx, cx - 3, at.y - 2, 7, 6, OFFICE.outline);
  rect(ctx, cx - 2, at.y - 1, 5, 4, OFFICE.can);
  const spout = at.facing === 'left' ? cx - 6 : cx + 4;
  rect(ctx, spout, at.y - 1, 3, 1, OFFICE.outline);
  if (at.facing === 'up') return;
  for (let i = 0; i < 3; i += 1) {
    const fall = (time * 2 + i / 3) % 1;
    rect(ctx, spout + (at.facing === 'left' ? 0 : 2) + (i - 1), Math.round(at.y + fall * 9), 1, 2, OFFICE.sweat);
  }
}

function book(ctx: Ctx, at: Held, actor: Actor, time: number): void {
  const color = OFFICE.book[(actor.rest.tile.x + actor.rest.tile.y) % OFFICE.book.length];
  rect(ctx, at.x - 5, at.y - 2, 11, 7, OFFICE.outline);
  rect(ctx, at.x - 4, at.y - 1, 9, 5, color);
  rect(ctx, at.x - 3, at.y - 1, 3, 4, OFFICE.paper);
  rect(ctx, at.x + 1, at.y - 1, 3, 4, OFFICE.paper);
  if (Math.floor(time / 4) % 3 === 0) rect(ctx, at.x, at.y - 2, 1, 5, OFFICE.counterLine);
}

function meal(ctx: Ctx, at: Held, time: number): void {
  const side = at.facing === 'left' ? -1 : 1;
  const px = at.x + side * 8 - 3;
  rect(ctx, px - 1, at.y + 1, 8, 3, OFFICE.outline);
  rect(ctx, px, at.y + 1, 6, 2, OFFICE.mug);
  rect(ctx, px + 1, at.y, 4, 1, OFFICE.food);
  const lift = Math.floor(time * 1.2) % 2 === 0 ? 0 : 5;
  rect(ctx, at.x + side * 3, at.y - lift, 1, 4, OFFICE.metalLight);
}

/** Hand props for the routine of the free: a box, a broom, a watering can, a book, a meal. */
export function drawProp(ctx: Ctx, actor: Actor, look: { x: number; y: number; facing: Facing }, time: number): void {
  const at: Held = { x: look.x + CHAR_W / 2, y: look.y + 15, facing: look.facing };
  if (actor.carry === 'box' && look.facing !== 'up') box(ctx, at.x - 3, at.y - 4);
  if (actor.pose === 'tidy') box(ctx, at.x - 3, look.y - 4 - (Math.floor(time * 2) % 2));
  else if (actor.pose === 'sweep') broom(ctx, at, Math.round(actor.y), time);
  else if (actor.pose === 'water') wateringCan(ctx, at, time);
  else if (actor.pose === 'read') book(ctx, at, actor, time);
  else if (actor.pose === 'eat') meal(ctx, at, time);
}
