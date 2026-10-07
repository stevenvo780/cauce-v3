import type { Avatar } from './avatar';
import { OPERATOR_ID, paintRows, rect, type Ctx, type SpriteCache } from './paint';
import { OFFICE } from './palette';
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

const SEATED: ReadonlySet<string> = new Set(['sit', 'type', 'sleep', 'lie', 'nap', 'ghost']);
const BREATH = 1.6;

/** `gaze` turns someone standing around towards the operator walking up to them. */
export function actorLook(actor: Actor, gaze: Facing | null = null): ActorLook {
  if (actor.pose === 'lie') {
    const x = Math.round(actor.x - 14);
    const y = Math.round(actor.y - 12);
    return {
      x, y, frame: 'sleep', facing: 'right', step: 0, ghost: false, seated: true, lying: true,
      labelAbove: false, labelY: Math.round(actor.y) + 8,
      hit: { x, y, w: LIE_W, h: LIE_H },
      head: { x: x + 10, y: y + 1 },
    };
  }
  const seated = SEATED.has(actor.pose);
  let facing: Facing = actor.pose === 'coffee'
    ? (actor.clock % 7 < 2.2 ? 'up' : 'down')
    : actor.pose === 'stretch' ? 'down' : actor.dir;
  if (gaze && (actor.pose === 'stand' || actor.pose === 'coffee')) facing = gaze;
  let frame: FrameName = 'stand';
  if (actor.pose === 'walk') frame = 'walk';
  else if (actor.pose === 'stretch') frame = Math.floor(actor.clock * 2) % 2 === 0 ? 'stretch' : 'stand';
  else if (actor.pose === 'sleep') frame = 'sleep';
  else if (actor.pose === 'nap') frame = facing === 'down' ? 'napDown' : 'napUp';
  let dy = 0;
  if (seated) dy = facing === 'down' ? 5 : 3;
  if (actor.pose === 'sleep') dy = 3 + (Math.floor(actor.clock / BREATH) % 2);
  if (actor.pose === 'type' && facing === 'up') dy += Math.floor(actor.clock * 6) % 2;
  let dx = 0;
  if (actor.behaviour.shake && actor.pose === 'sit') dx = Math.floor(actor.clock * 14) % 3 === 0 ? 1 : 0;
  if (frame === 'napDown') dx = 5;
  const x = Math.round(actor.x - CHAR_W / 2 + dx);
  const y = Math.round(actor.y - CHAR_H + 1 + dy);
  const labelAbove = seated && facing === 'down';
  const feet = Math.round(actor.y);
  let labelY = labelAbove ? y + 1 : feet + 4;
  let head = { x: x + 11, y: y + 2 };
  if (frame === 'napDown') {
    labelY = feet - 4;
    head = { x: Math.round(actor.x) + 10, y: feet - 5 };
  } else if (frame === 'napUp') {
    head = { x: x + 11, y: y + 6 };
  } else if (frame === 'sleep') {
    head = { x: x + 12, y: y + 3 };
  }
  const top = frame === 'napDown' ? y + 14 : y + 1;
  return {
    x, y, frame, facing, step: Math.floor(actor.walked / 5), ghost: actor.pose === 'ghost', seated, lying: false,
    labelAbove, labelY, hit: { x: x + 1, y: top, w: 14, h: y + 24 - top }, head,
  };
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

/** Bed blankets match the bed's own cover; the sofa one runs to the far armrest so no feet stick out. */
function drawLying(ctx: Ctx, sprites: SpriteCache, actor: Actor, look: ActorLook): void {
  const sofa = actor.rest.rest === 'sofa';
  if (sofa) {
    rect(ctx, look.x + 1, look.y + 3, 11, 9, OFFICE.outline);
    rect(ctx, look.x + 2, look.y + 4, 9, 7, OFFICE.pillow);
    rect(ctx, look.x + 2, look.y + 10, 9, 1, OFFICE.pillowShade);
  }
  const inhale = Math.floor(actor.clock / BREATH) % 2 === 1;
  const rows = sofa ? blanketRows(29, 6, inhale) : blanketRows(19, 7, inhale);
  paintRows(ctx, rows, look.x + BLANKET_X, look.y + BLANKET_Y - (inhale ? 1 : 0), blanketColors(actor));
  ctx.drawImage(sprites.lying(actor.id), look.x, look.y);
}

export function drawActor(ctx: Ctx, sprites: SpriteCache, actor: Actor, look: ActorLook, time: number): void {
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
  if (actor.pose === 'sleep') {
    const inhale = Math.floor(actor.clock / BREATH) % 2 === 1;
    paintRows(ctx, blanketRows(12, 3, inhale), look.x + 2, look.y + 13 - (inhale ? 1 : 0), blanketColors(actor));
  }
  const cx = look.x + CHAR_W / 2;
  const handY = look.y + 16;
  if ((actor.carrying || actor.pose === 'handover') && look.facing !== 'up') {
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
export function drawActorOverlay(ctx: Ctx, actor: Actor, look: ActorLook, time: number, selected: boolean, hovered: boolean): void {
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
  const icon: IconName | null = actor.bubble === 'mail' ? 'mail'
    : actor.bubble === 'alert' ? 'alert'
      : actor.bubble === 'paper' ? 'paper' : null;
  if (icon) {
    const bob = Math.floor(time * 2.5) % 2;
    const bx = look.labelAbove ? cx + 6 : cx + 2;
    const by = look.labelAbove ? look.y - 2 - bob : look.y - 9 - bob;
    bubble(ctx, icon, bx, by);
  }
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

export type LabelTone = 'normal' | 'selected' | 'dim' | 'operator';

/** Measures a name tag in device px without drawing it, so trails and prompts can avoid it. */
export function labelRect(ctx: Ctx, text: string, x: number, y: number, above: boolean, fontPx: number): ScreenRect {
  ctx.font = `600 ${String(fontPx)}px "Inter Variable", Inter, system-ui, sans-serif`;
  const width = Math.ceil(ctx.measureText(text).width) + fontPx;
  const height = Math.round(fontPx * 1.5);
  const left = Math.round(x - width / 2);
  const top = Math.round(above ? y - height : y);
  return { left, top, right: left + width, bottom: top + height };
}

/** Device-pixel name tag: drawn after the art is scaled so the text stays sharp. */
export function drawLabel(ctx: Ctx, text: string, box: ScreenRect, fontPx: number, tone: LabelTone): void {
  ctx.font = `600 ${String(fontPx)}px "Inter Variable", Inter, system-ui, sans-serif`;
  ctx.globalAlpha = tone === 'dim' ? 0.4 : 1;
  ctx.fillStyle = tone === 'selected' ? SELECT : tone === 'operator' ? OFFICE.operatorMarkDark : 'rgba(37, 28, 24, 0.78)';
  const height = box.bottom - box.top;
  ctx.beginPath();
  ctx.roundRect(box.left, box.top, box.right - box.left, height, height / 2);
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  ctx.fillText(text, Math.round((box.left + box.right) / 2), box.top + height / 2 + 0.5);
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
