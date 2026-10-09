import type { Avatar } from './avatar';
import { OPERATOR_ID, paintRows, rect, type Ctx, type SpriteCache } from './paint';
import { OFFICE } from './palette';
import { drawProp } from './props';
import { capsule } from './render-fixtures';
import type { Actor } from './simulation';
import {
  BLANKET_X, BLANKET_Y, BUBBLE, CHAR_H, CHAR_W, GLYPH_Z, GLYPH_Z_SMALL, ICONS, LIE_H, LIE_W, blanketRows,
  type Facing, type FrameName, type IconName,
} from './sprites';

export const SELECT = '#6c63ff';

export interface Box { x: number; y: number; w: number; h: number }

export interface ActorLook {
  /** Top-left of the sprite, in art px. */
  x: number;
  y: number;
  frame: FrameName;
  facing: Facing;
  step: number;
  ghost: boolean;
  seated: boolean;
  lying: boolean;
  /** Where the name goes: above `labelY` or hanging below it. */
  labelAbove: boolean;
  labelY: number;
  /** Clickable body, in art px. */
  hit: Box;
  /** Where the sleep trail starts. */
  head: { x: number; y: number };
}

const SEATED: ReadonlySet<string> = new Set(['sit', 'type', 'lie', 'ghost', 'read', 'eat']);
const CHAT_ICONS: readonly IconName[] = ['heart', 'idea', 'coffee', 'note'];
const BREATH = 1.6;
const PATIENT: Readonly<Record<string, string>> = { o: OFFICE.outline, w: OFFICE.sheet, b: '#9fd8e3', l: '#c7eef5', d: '#7cc0cc' };

export const blankLook = (): ActorLook => ({
  x: 0, y: 0, frame: 'stand', facing: 'down', step: 0, ghost: false, seated: false, lying: false,
  labelAbove: false, labelY: 0, hit: { x: 0, y: 0, w: 0, h: 0 }, head: { x: 0, y: 0 },
});

function setLook(out: ActorLook, x: number, y: number, hit: { w: number; h: number; dx: number; dy: number }, head: { dx: number; dy: number }): ActorLook {
  out.x = x;
  out.y = y;
  out.hit.x = x + hit.dx;
  out.hit.y = y + hit.dy;
  out.hit.w = hit.w;
  out.hit.h = hit.h;
  out.head.x = x + head.dx;
  out.head.y = y + head.dy;
  return out;
}

const LYING_HIT = { w: LIE_W, h: LIE_H, dx: 0, dy: 0 };
const LYING_HEAD = { dx: 10, dy: 1 };
const BODY_HIT = { w: 14, h: 23, dx: 1, dy: 1 };
const BODY_HEAD = { dx: 11, dy: 2 };

/**
 * `gaze` turns someone standing around towards the operator walking up to them; `lift` makes them
 * hop. Pass `out` to fill a look kept between frames instead of making a new one.
 */
export function actorLook(actor: Actor, gaze: Facing | null = null, lift = 0, out: ActorLook = blankLook()): ActorLook {
  if (actor.pose === 'lie') {
    out.frame = 'sleep';
    out.facing = 'right';
    out.step = 0;
    out.ghost = false;
    out.seated = true;
    out.lying = true;
    out.labelAbove = false;
    out.labelY = Math.round(actor.y) + 8;
    return setLook(out, Math.round(actor.x - 14), Math.round(actor.y - 12), LYING_HIT, LYING_HEAD);
  }
  const game = actor.pose === 'play' ? actor.rest.game : undefined;
  const seated = SEATED.has(actor.pose) || game === 'beanbag';
  let facing: Facing = actor.pose === 'coffee'
    ? (actor.clock % 7 < 2.2 ? 'up' : 'down')
    : actor.pose === 'stretch' ? 'down' : actor.dir;
  if (gaze && (actor.pose === 'stand' || actor.pose === 'coffee')) facing = gaze;
  let frame: FrameName = 'stand';
  if (actor.pose === 'walk') frame = 'walk';
  else if (actor.pose === 'stretch') frame = Math.floor(actor.clock * 2) % 2 === 0 ? 'stretch' : 'stand';
  let dy = 0;
  if (seated) dy = facing === 'down' ? 5 : 3;
  if (actor.pose === 'type' && facing === 'up') dy += Math.floor(actor.clock * 6) % 2;
  if (actor.pose === 'cook' || actor.pose === 'chat') dy += Math.floor(actor.clock * (actor.pose === 'cook' ? 4 : 2.5)) % 2;
  if (game === 'arcade' || game === 'foosball') dy += Math.floor(actor.clock * (game === 'arcade' ? 5 : 3)) % 2;
  let dx = 0;
  if (actor.behaviour.shake && actor.pose === 'sit') dx = Math.floor(actor.clock * 14) % 3 === 0 ? 1 : 0;
  if (game === 'pingpong') dx = Math.round(Math.sin(actor.clock * 4.4) * 1.5);
  const x = Math.round(actor.x - CHAR_W / 2 + dx);
  const y = Math.round(actor.y - CHAR_H + 1 + dy - lift);
  const labelAbove = seated && facing === 'down';
  out.frame = frame;
  out.facing = facing;
  out.step = Math.floor(actor.walked / 5);
  out.ghost = actor.pose === 'ghost' || actor.state === 'down';
  out.seated = seated;
  out.lying = false;
  out.labelAbove = labelAbove;
  out.labelY = labelAbove ? y + 1 : Math.round(actor.y) + 4;
  return setLook(out, x, y, BODY_HIT, BODY_HEAD);
}

function paintIcon(ctx: Ctx, name: IconName, x: number, y: number): void {
  paintRows(ctx, ICONS[name], x, y, { k: OFFICE.outline, w: OFFICE.paper, y: OFFICE.mail, r: OFFICE.alert, g: OFFICE.ink[1] });
}

function bubble(ctx: Ctx, icon: IconName, x: number, y: number): void {
  paintRows(ctx, BUBBLE, x, y, { o: OFFICE.outline, w: OFFICE.bubble });
  paintIcon(ctx, icon, x + 2, y + 1);
}

function blanketColors(actor: Actor): Record<string, string> {
  const variant = actor.rest.variant ?? 0;
  const pick = <T,>(list: readonly T[]): T => list[variant % list.length];
  return { o: OFFICE.outline, w: OFFICE.sheet, b: pick(OFFICE.blanket), l: pick(OFFICE.blanketLight), d: pick(OFFICE.blanketDark) };
}

function drawLying(ctx: Ctx, sprites: SpriteCache, actor: Actor, look: ActorLook): void {
  const inhale = Math.floor(actor.clock / BREATH) % 2 === 1;
  const colors = actor.rest.rest === 'pod' ? PATIENT : blanketColors(actor);
  paintRows(ctx, blanketRows(19, 7, inhale), look.x + BLANKET_X, look.y + BLANKET_Y - (inhale ? 1 : 0), colors);
  ctx.drawImage(sprites.lying(actor.id), look.x, look.y);
}

/** Props in the hands of someone playing: a swinging paddle or a handheld console. */
function drawToy(ctx: Ctx, actor: Actor, look: ActorLook, time: number): void {
  const cx = look.x + CHAR_W / 2;
  const handY = look.y + 15;
  if (actor.rest.game === 'pingpong') {
    const side = look.facing === 'left' ? -1 : 1;
    const swing = Math.round(Math.sin(time * 8.8 + (side > 0 ? 0 : Math.PI)) * 3);
    const px = cx + side * 6;
    rect(ctx, px - 2, handY - 3 + swing, 5, 5, OFFICE.outline);
    rect(ctx, px - 1, handY - 2 + swing, 3, 3, OFFICE.paddle);
    rect(ctx, px, handY + 2 + swing, 1, 2, OFFICE.outline);
  } else if (actor.rest.game === 'beanbag') {
    rect(ctx, cx - 4, handY - 1, 9, 5, OFFICE.outline);
    rect(ctx, cx - 3, handY, 7, 3, OFFICE.handheld);
    rect(ctx, cx - 1, handY, 3, 2, OFFICE.code[Math.floor(time * 6) % 4]);
  }
}

/** `holding` draws the capsule just collected from the station in the person's hands. */
export function drawActor(ctx: Ctx, sprites: SpriteCache, actor: Actor, look: ActorLook, time: number, holding = false): void {
  if (actor.pose === 'hidden') return;
  if (look.lying) {
    drawLying(ctx, sprites, actor, look);
    return;
  }
  if (!look.seated && actor.pose !== 'ghost') {
    ctx.fillStyle = OFFICE.shadow;
    ctx.fillRect(look.x + 3, Math.round(actor.y) - 1, 10, 3);
  }
  const sprite = sprites.character(actor.id, look.ghost, look.frame, look.facing, look.step);
  if (look.ghost) ctx.globalAlpha *= 0.55;
  ctx.drawImage(sprite, look.x, look.y);
  if (look.ghost) ctx.globalAlpha /= 0.55;
  if (actor.pose === 'play') drawToy(ctx, actor, look, time);
  drawProp(ctx, actor, look, time);
  if (!look.seated && actor.pose !== 'ghost') {
    const badge = sprites.badge(actor.id);
    if (badge) ctx.drawImage(badge, look.x + CHAR_W - 4, look.y - 3);
  }
  const cx = look.x + CHAR_W / 2;
  const handY = look.y + 16;
  if ((actor.carry === 'capsule' || holding) && look.facing !== 'up') capsule(ctx, look.facing === 'left' ? cx - 9 : cx + 1, handY - 3, OFFICE.brass);
  else if ((actor.carry === 'paper' || actor.pose === 'handover') && look.facing !== 'up') {
    const px = look.facing === 'left' ? cx - 9 : look.facing === 'right' ? cx + 3 : cx - 3;
    rect(ctx, px - 1, handY - 4, 7, 8, OFFICE.outline);
    rect(ctx, px, handY - 3, 5, 6, OFFICE.paper);
    rect(ctx, px + 1, handY - 1, 3, 1, OFFICE.ink[1]);
  }
  if (actor.pose === 'coffee' && look.facing === 'down') {
    rect(ctx, cx + 3, handY - 2, 5, 5, OFFICE.outline);
    rect(ctx, cx + 4, handY - 1, 3, 3, OFFICE.mug);
    if (Math.floor(time * 3) % 2 === 0) rect(ctx, cx + 5, handY - 5, 1, 2, 'rgba(255,255,255,0.8)');
  }
  if (actor.behaviour.shake && actor.pose === 'sit') {
    const drop = Math.floor(time * 2) % 3;
    rect(ctx, look.x + 13, look.y + 4 + drop, 2, 3, OFFICE.sweat);
  }
}

/** Overlays that must sit above every piece of furniture: bubbles and the selection marks. */
export function drawActorOverlay(ctx: Ctx, actor: Actor, look: ActorLook, time: number, selected: boolean, hovered: boolean, emote: IconName | null = null): void {
  if (actor.pose === 'hidden') return;
  const cx = look.lying ? look.x + LIE_W / 2 : look.x + CHAR_W / 2;
  if (selected || hovered) {
    const y = look.lying ? look.y + LIE_H + 1 : Math.round(actor.y) + (look.seated ? 2 : 0);
    const half = look.lying ? 12 : 6;
    const color = selected ? SELECT : 'rgba(255,255,255,0.85)';
    rect(ctx, cx - half, y, half * 2, 1, color);
    rect(ctx, cx - half - 2, y - 1, 2, 1, color);
    rect(ctx, cx + half, y - 1, 2, 1, color);
    rect(ctx, cx - half, y - 2, half * 2, 1, color);
    if (selected) {
      const bob = Math.floor(time * 3) % 2;
      const top = (look.lying ? look.y - 7 : look.y + (look.labelAbove ? -15 : -6)) - bob;
      const ax = look.lying ? look.head.x - 3 : cx;
      rect(ctx, ax - 3, top, 7, 1, SELECT);
      rect(ctx, ax - 2, top + 1, 5, 1, SELECT);
      rect(ctx, ax - 1, top + 2, 3, 1, SELECT);
      rect(ctx, ax, top + 3, 1, 1, SELECT);
    }
  }
  const icon: IconName | null = emote ?? (actor.bubble === 'mail' ? 'mail'
    : actor.bubble === 'alert' ? 'alert'
      : actor.bubble === 'paper' ? 'paper' : chatIcon(actor, time));
  if (icon) {
    const bob = Math.floor(time * 2.5) % 2;
    const bx = look.labelAbove ? cx + 6 : cx + 2;
    const by = look.labelAbove ? look.y - 2 - bob : look.y - 9 - bob;
    bubble(ctx, icon, bx, by);
  }
}

function chatIcon(actor: Actor, time: number): IconName | null {
  if (actor.bubble !== 'chat') return null;
  const pair = actor.rest.pair ?? 0;
  const turn = Math.floor(time / 2.6 + pair * 0.37);
  if (turn % 2 !== (actor.rest.variant ?? 0)) return null;
  return CHAT_ICONS[(turn + pair) % CHAT_ICONS.length];
}

export interface TapMarker { x: number; y: number; ok: boolean; age: number }

/** Where a tap landed, in art px: a ring that settles at the walk goal, or fades out in red when nothing can be reached. */
export function drawTapMarker(ctx: Ctx, marker: TapMarker): void {
  const grow = Math.min(2, Math.floor(marker.age * 10));
  const alpha = marker.ok ? 1 : Math.max(0, 1 - marker.age / 0.7);
  if (alpha <= 0) return;
  const color = marker.ok ? 'rgba(34, 197, 94, 0.9)' : 'rgba(220, 60, 60, 0.9)';
  const x = Math.round(marker.x);
  const y = Math.round(marker.y);
  const w = 3 + grow * 2;
  const h = 1 + grow;
  ctx.globalAlpha = alpha;
  rect(ctx, x - w, y - h - 1, w * 2, 1, color);
  rect(ctx, x - w, y + h, w * 2, 1, color);
  rect(ctx, x - w - 1, y - h, 1, h * 2, color);
  rect(ctx, x + w, y - h, 1, h * 2, color);
  ctx.globalAlpha = 1;
}

export interface ScreenRect { left: number; top: number; right: number; bottom: number }

const overlaps = (a: ScreenRect, b: ScreenRect) => a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;

/**
 * The sleep trail in screen space: a small `z` leaves the head, grows into a `Z` while it drifts up
 * and fades. Letters that would cross any name tag are skipped so tags stay readable.
 */
export function drawSleepTrail(
  ctx: Ctx, head: { x: number; y: number }, time: number, unit: number, avoid: readonly ScreenRect[], still: boolean,
): void {
  const px = Math.max(1, Math.round(unit));
  for (let i = 0; i < 2; i += 1) {
    const phase = still ? 0.15 + i * 0.5 : (time * 0.36 + i / 2) % 1;
    const glyph = phase < 0.45 ? GLYPH_Z_SMALL : GLYPH_Z;
    const ax = head.x + (phase * 6 + Math.sin(phase * 7 + i)) * unit;
    const ay = head.y - phase * 9 * unit;
    const size = glyph[0].length * px;
    const box = { left: ax - px, top: ay - size - px, right: ax + size + px, bottom: ay + px };
    if (avoid.some((other) => overlaps(other, box))) continue;
    ctx.globalAlpha = still ? 1 : Math.min(1, phase * 8, (1 - phase) * 4);
    const left = Math.round(ax);
    const top = Math.round(ay - size);
    glyph.forEach((row, gy) => {
      Array.from(row).forEach((key, gx) => {
        if (key === 'k') rect(ctx, left + (gx + 1) * px, top + (gy + 1) * px, px, px, OFFICE.zzzHalo);
      });
    });
    glyph.forEach((row, gy) => {
      Array.from(row).forEach((key, gx) => {
        if (key === 'k') rect(ctx, left + gx * px, top + gy * px, px, px, OFFICE.zzz);
      });
    });
  }
  ctx.globalAlpha = 1;
}

export function avatarLook(avatar: Avatar): { x: number; y: number; frame: FrameName; step: number } {
  return {
    x: Math.round(avatar.x - CHAR_W / 2),
    y: Math.round(avatar.y - CHAR_H + 1),
    frame: avatar.moving ? 'walk' : 'stand',
    step: avatar.moving ? Math.floor(avatar.walked / 5) : 0,
  };
}

export function drawAvatar(ctx: Ctx, sprites: SpriteCache, avatar: Avatar): void {
  const look = avatarLook(avatar);
  ctx.fillStyle = OFFICE.shadow;
  ctx.fillRect(look.x + 3, Math.round(avatar.y) - 1, 10, 3);
  rect(ctx, look.x + 2, Math.round(avatar.y) - 1, 12, 1, 'rgba(34, 197, 94, 0.45)');
  ctx.drawImage(sprites.character(OPERATOR_ID, false, look.frame, avatar.dir, look.step), look.x, look.y);
}
