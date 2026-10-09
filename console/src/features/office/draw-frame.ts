import type { Avatar } from './avatar';
import { originOf, type Camera, type Size } from './camera';
import type { Site } from './campus';
import type { Entry } from './draw-art';
import { drawGroupDots, type GroupDots } from './group-dots';
import { TILE } from './level';
import { drawSleepTrail, type ScreenRect } from './people';
import type { LabelTone, PixelLabels } from './pixel-label';
import { SPRITE_PAD } from './render-buildings';
import { CHAR_H } from './sprites';
import { drawSpeech, type Speech } from './speech';

export interface SiteTag { site: Site; text: string; swatch: string | null; alerts: number }

export interface ScreenInput {
  cam: Camera;
  view: Size;
  dpr: number;
  time: number;
  still: boolean;
  art: HTMLCanvasElement;
  /** The ground beyond the map's edges, so the world fills the whole frame. */
  backdrop: CanvasPattern | null;
  night: boolean;
  indoor: boolean;
  campus: boolean;
  entries: readonly Entry[];
  names: ReadonlyMap<string, string>;
  selected: string | null;
  hovered: string | null;
  nearby: string | null;
  highlight: ReadonlySet<string> | null;
  avatar: Avatar | null;
  avatarHere: boolean;
  speech?: ReadonlyMap<string, Speech>;
  groups?: ReadonlyMap<string, GroupDots>;
  labels: PixelLabels;
  sites: readonly SiteTag[];
  hoveredSite: string | null;
  /** 0 to 1 while switching maps: the share of the screen covered by the dither. */
  cover: number;
  /** The campus road and its sidewalk, in art px, carried on past the map's edges. */
  road: { y: number; walk: number } | null;
}

interface Tag { id: string | null; text: string; x: number; y: number; above: boolean; tone: LabelTone; rank: number; box: ScreenRect }

const tags: Tag[] = [];
const order: Tag[] = [];
const placed: ScreenRect[] = [];
const boxes: ScreenRect[] = [];
let used = 0;
const BAYER = [0, 8, 2, 10, 12, 4, 14, 6, 3, 11, 1, 9, 15, 7, 13, 5];

function tag(): Tag {
  const next = tags[used] ?? { id: null, text: '', x: 0, y: 0, above: true, tone: 'normal', rank: 0, box: { left: 0, top: 0, right: 0, bottom: 0 } };
  tags[used] = next;
  used += 1;
  return next;
}

const crosses = (a: ScreenRect, b: ScreenRect, gap: number) =>
  a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;

export function labelUnit(zoom: number, dpr: number): number {
  return Math.max(Math.round(2 * dpr), Math.min(Math.round(3 * dpr), Math.round(zoom * 0.7)));
}

function roadBand(ctx: CanvasRenderingContext2D, input: ScreenInput, origin: { x: number; y: number }): void {
  if (!input.road) return;
  const { cam, view } = input;
  const unit = cam.zoom;
  const walk = Math.round(origin.y + input.road.walk * unit);
  const top = Math.round(origin.y + input.road.y * unit);
  ctx.fillStyle = '#d9d4ca';
  ctx.fillRect(0, walk, view.width, top - walk);
  ctx.fillStyle = '#e6dfd0';
  ctx.fillRect(0, top - 2 * unit, view.width, 2 * unit);
  ctx.fillStyle = '#5d6270';
  ctx.fillRect(0, top, view.width, 2 * TILE * unit);
  ctx.fillStyle = '#4a4e5a';
  ctx.fillRect(0, top, view.width, 2 * unit);
  ctx.fillRect(0, top + (2 * TILE - 2) * unit, view.width, 2 * unit);
  ctx.fillStyle = '#f3d36b';
  const first = Math.floor(-origin.x / unit / 16) * 16 + 4;
  for (let x = first; origin.x + x * unit < view.width; x += 16) ctx.fillRect(Math.round(origin.x + x * unit), top + (TILE - 1) * unit, 8 * unit, 2 * unit);
}

function backdrop(ctx: CanvasRenderingContext2D, input: ScreenInput, origin: { x: number; y: number }): void {
  const { cam, view } = input;
  if (input.backdrop) {
    ctx.setTransform(cam.zoom, 0, 0, cam.zoom, origin.x, origin.y);
    ctx.fillStyle = input.backdrop;
    ctx.fillRect(-origin.x / cam.zoom - 1, -origin.y / cam.zoom - 1, view.width / cam.zoom + 2, view.height / cam.zoom + 2);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
  } else {
    ctx.fillStyle = '#8fcf72';
    ctx.fillRect(0, 0, view.width, view.height);
  }
  roadBand(ctx, input, origin);
  if (input.night) {
    ctx.fillStyle = 'rgba(22, 27, 66, 0.38)';
    ctx.fillRect(0, 0, view.width, view.height);
  }
}

function placeTags(ctx: CanvasRenderingContext2D, input: ScreenInput, unit: number, origin: { x: number; y: number }): void {
  const { cam, labels } = input;
  used = 0;
  for (const entry of input.entries) {
    const actor = entry.actor;
    if (!actor) continue;
    const special = actor.id === input.selected || actor.id === input.hovered;
    if ((actor.pose === 'walk' || actor.pose === 'handover') && !special) continue;
    if (input.campus && !special && actor.id !== input.nearby) continue;
    const dim = Boolean(input.highlight && !input.highlight.has(actor.id));
    const item = tag();
    item.id = actor.id;
    item.text = input.names.get(actor.id) ?? actor.id;
    item.x = origin.x + (entry.look.hit.x + entry.look.hit.w / 2) * cam.zoom;
    item.y = origin.y + entry.look.labelY * cam.zoom - (entry.look.labelAbove ? 2 * input.dpr : 0);
    item.above = entry.look.labelAbove;
    item.tone = actor.id === input.selected ? 'selected' : dim ? 'dim' : actor.state === 'down' || actor.state === 'blocked' ? 'alert' : 'normal';
    item.rank = actor.id === input.selected ? 0 : actor.id === input.hovered ? 2 : dim ? 4 : 3;
  }
  if (input.avatar && input.avatarHere) {
    const item = tag();
    item.id = null;
    item.text = 'Vos';
    item.x = origin.x + input.avatar.x * cam.zoom;
    item.y = origin.y + (Math.round(input.avatar.y) - CHAR_H + 2) * cam.zoom - 2 * input.dpr;
    item.above = true;
    item.tone = 'operator';
    item.rank = 1;
  }
  order.length = 0;
  for (let index = 0; index < used; index += 1) order.push(tags[index]);
  order.sort((a, b) => a.rank - b.rank);
  boxes.length = 0;
  for (const item of order) {
    const sprite = labels.get(item.text, item.tone, unit);
    const left = Math.round(item.x - sprite.width / 2);
    const top = Math.round(item.above ? item.y - sprite.height : item.y);
    item.box.left = left;
    item.box.top = top;
    item.box.right = left + sprite.width;
    item.box.bottom = top + sprite.height;
    if (item.rank > 2 && placed.some((other) => crosses(other, item.box, input.dpr))) continue;
    placed.push(item.box);
    ctx.drawImage(sprite.canvas, left, top);
    const dots = item.id ? input.groups?.get(item.id) : undefined;
    if (dots) drawGroupDots(ctx, item.box, dots, unit * 5, item.tone === 'dim');
  }
  boxes.push(...placed);
}

const siteOrder: SiteTag[] = [];

/** House names over the roofs; where two would overlap, the one with people in trouble or under the pointer wins. */
function siteTags(ctx: CanvasRenderingContext2D, input: ScreenInput, origin: { x: number; y: number }): void {
  const { cam, labels, dpr } = input;
  const unit = Math.min(2 * dpr, Math.max(Math.round(1.6 * dpr), Math.round(cam.zoom * 0.75)));
  siteOrder.length = 0;
  siteOrder.push(...input.sites);
  const rank = (item: SiteTag) => (item.site.id === input.hoveredSite ? 0 : item.alerts > 0 ? 1 : item.site.kind === 'group' ? 2 : 3);
  siteOrder.sort((a, b) => rank(a) - rank(b));
  for (const item of siteOrder) {
    const { site } = item;
    const tone: LabelTone = input.hoveredSite === site.id ? 'selected' : 'normal';
    const sprite = labels.get(item.text, tone, unit, item.swatch);
    const badge = item.alerts > 0 ? labels.get(`!${String(item.alerts)}`, 'alert', unit) : null;
    const width = sprite.width + (badge ? badge.width + unit : 0);
    const cx = origin.x + (site.x + site.w / 2) * TILE * cam.zoom;
    const top = Math.round(origin.y + (site.y * TILE - SPRITE_PAD.top) * cam.zoom - sprite.height - 2 * dpr);
    const left = Math.round(cx - width / 2);
    const box = { left, top, right: left + width, bottom: top + sprite.height };
    if (placed.some((other) => crosses(other, box, 2 * dpr))) continue;
    placed.push(box);
    ctx.drawImage(sprite.canvas, left, top);
    if (badge) ctx.drawImage(badge.canvas, left + sprite.width + unit, top);
  }
}

function dither(ctx: CanvasRenderingContext2D, view: Size, cover: number, dpr: number): void {
  if (cover <= 0) return;
  const cell = Math.max(6, Math.round(14 * dpr));
  ctx.fillStyle = '#0e0f17';
  for (let y = 0, row = 0; y < view.height; y += cell, row += 1) {
    for (let x = 0, col = 0; x < view.width; x += cell, col += 1) {
      if ((BAYER[(row % 4) * 4 + (col % 4)] + 0.5) / 16 < cover) ctx.fillRect(x, y, cell, cell);
    }
  }
}

/** The frame on screen: the ground beyond the map, the map art scaled up, then crisp tags, bubbles and the switch dither. */
export function drawScreen(ctx: CanvasRenderingContext2D, input: ScreenInput): void {
  const { cam, view, dpr } = input;
  const time = input.still ? 0 : input.time;
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.imageSmoothingEnabled = false;
  const origin = originOf(cam, view);
  backdrop(ctx, input, origin);
  const width = input.art.width * cam.zoom;
  const height = input.art.height * cam.zoom;
  if (input.indoor) {
    ctx.fillStyle = 'rgba(30, 35, 30, 0.28)';
    ctx.fillRect(origin.x + 4 * cam.zoom, origin.y + 5 * cam.zoom, width, height);
  }
  ctx.drawImage(input.art, origin.x, origin.y, width, height);
  placed.length = 0;
  if (input.campus) siteTags(ctx, input, origin);
  const unit = labelUnit(cam.zoom, dpr);
  placeTags(ctx, input, unit, origin);
  for (const entry of input.entries) {
    const actor = entry.actor;
    if (actor?.bubble !== 'zzz' || actor.pose !== 'lie' || (input.highlight && !input.highlight.has(actor.id))) continue;
    drawSleepTrail(ctx, { x: origin.x + entry.look.head.x * cam.zoom, y: origin.y + entry.look.head.y * cam.zoom }, time, cam.zoom, boxes, input.still);
  }
  if (input.speech && input.speech.size > 0) {
    const fontPx = Math.max(Math.round(11 * dpr), Math.min(Math.round(15 * dpr), Math.round(cam.zoom * 3.4)));
    for (const entry of input.entries) {
      const speech = entry.actor ? input.speech.get(entry.actor.id) : undefined;
      if (!speech) continue;
      const head = origin.y + entry.look.hit.y * cam.zoom;
      drawSpeech(ctx, speech, { x: origin.x + (entry.look.hit.x + entry.look.hit.w / 2) * cam.zoom, y: head - unit * 9 }, fontPx, dpr, time, view.width);
    }
  }
  dither(ctx, view, input.cover, dpr);
}
