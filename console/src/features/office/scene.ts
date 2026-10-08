import { faceTowards, type Avatar } from './avatar';
import { originOf, type Camera, type Size } from './camera';
import { TILE, type GameKind, type OfficeLayout, type Point } from './layout';
import { SpriteCache, type MakeCanvas } from './paint';
import { CHAR_H } from './sprites';
import { deskMonitor } from './monitor';
import { OFFICE } from './palette';
import {
  actorLook, drawActor, drawActorOverlay, drawAvatar, drawLabel, drawSleepTrail, drawTapMarker, labelRect,
  type ActorLook, type LabelTone, type ScreenRect, type TapMarker,
} from './people';
import { furnitureDrawables, paintRoom, type DeskState, type Drawable } from './render';
import { drawPet, petAt } from './render-garden';
import type { Actor, World } from './simulation';
import { drawSpeech, type Speech } from './speech';

export interface Scene {
  sprites: SpriteCache;
  room: HTMLCanvasElement;
  art: HTMLCanvasElement;
  furniture: Drawable[];
  /** Night darkens the art and lights the desk lamps. */
  night: boolean;
  lamps: readonly Point[];
  glow: HTMLCanvasElement | null;
}

const GLOW_PX = 24;

/** A soft warm disc, drawn once and added over each lit lamp. */
function lampGlow(make: MakeCanvas): HTMLCanvasElement | null {
  const glow = make(GLOW_PX, GLOW_PX);
  const ctx = glow.getContext('2d');
  if (!ctx || typeof ctx.createRadialGradient !== 'function') return null;
  const mid = GLOW_PX / 2;
  const gradient = ctx.createRadialGradient(mid, mid, 0, mid, mid, mid);
  gradient.addColorStop(0, 'rgba(255, 214, 120, 0.7)');
  gradient.addColorStop(1, 'rgba(255, 214, 120, 0)');
  ctx.fillStyle = gradient;
  ctx.fillRect(0, 0, GLOW_PX, GLOW_PX);
  return glow;
}

export function createScene(layout: OfficeLayout, world: World, make: MakeCanvas, night = false): Scene | null {
  const sprites = new SpriteCache(make);
  const width = layout.cols * TILE;
  const height = layout.rows * TILE;
  const room = make(width, height);
  const art = make(width, height);
  const roomCtx = room.getContext('2d');
  if (!roomCtx || typeof roomCtx.drawImage !== 'function') return null;
  paintRoom(roomCtx, layout, night);
  const deskState = (slot: number): DeskState => {
    const owner = [...world.actors.values()].find((actor) => actor.desk === slot);
    if (!owner) return { monitor: 'off', typing: false, offline: false, lit: night };
    const desk = layout.desks[slot];
    const atDesk = Math.abs(owner.x - desk.seat.px.x) < 1 && Math.abs(owner.y - desk.seat.px.y) < 1;
    return {
      monitor: deskMonitor(owner.state, owner.pose === 'lie'),
      typing: atDesk && owner.pose === 'type',
      hands: sprites.palette(owner.id, false).s,
      offline: owner.state === 'down',
      mark: sprites.screenMark(owner.id),
      lit: night,
    };
  };
  const playing = (game: GameKind, station: number) => [...world.actors.values()].some((actor) => actor.pose === 'play'
    && actor.rest.game === game && actor.rest.station === station);
  const cooking = (x: number, y: number) => [...world.actors.values()].some((actor) => actor.pose === 'cook'
    && actor.rest.tile.x === x && actor.rest.tile.y === y + 1);
  const lamps = layout.desks.map((desk) => ({ x: desk.x * TILE + 4, y: desk.deskY * TILE - 4 }));
  return {
    sprites, room, art, furniture: furnitureDrawables(layout, deskState, playing, cooking), night, lamps,
    glow: night ? lampGlow(make) : null,
  };
}

/** The look of an agent, turned towards the operator when the operator is the one standing next to them. */
export function lookOf(actor: Actor, avatar: Avatar | null, nearby: string | null): ActorLook {
  const gaze = avatar && nearby === actor.id ? faceTowards({ x: actor.x, y: actor.y }, { x: avatar.x, y: avatar.y }) : null;
  return actorLook(actor, gaze);
}

export interface FrameInput {
  world: World;
  scene: Scene;
  avatar: Avatar | null;
  cam: Camera;
  view: Size;
  dpr: number;
  time: number;
  still: boolean;
  selected: string | null;
  hovered: string | null;
  highlight: ReadonlySet<string> | null;
  nearby: string | null;
  names: ReadonlyMap<string, string>;
  marker?: TapMarker | null;
  speech?: ReadonlyMap<string, Speech>;
}

interface Tag { id?: string; text: string; x: number; y: number; above: boolean; tone: LabelTone; rank: number; box?: ScreenRect }

const crosses = (a: ScreenRect, b: ScreenRect, gap: number) =>
  a.left < b.right + gap && b.left < a.right + gap && a.top < b.bottom + gap && b.top < a.bottom + gap;

/** Keeps every tag that matters and drops ordinary ones that would overlap a tag already placed. */
function placeTags(ctx: CanvasRenderingContext2D, tags: Tag[], fontPx: number, gap: number): Tag[] {
  const placed: ScreenRect[] = [];
  const kept = new Set<Tag>();
  for (const tag of [...tags].sort((a, b) => a.rank - b.rank)) {
    const box = labelRect(ctx, tag.text, tag.x, tag.y, tag.above, fontPx);
    if (tag.rank > 2 && placed.some((other) => crosses(other, box, gap))) continue;
    tag.box = box;
    placed.push(box);
    kept.add(tag);
  }
  return tags.filter((tag) => kept.has(tag));
}

/** Dusk over the whole office; the desk lamps are added back on top as warm pools of light. */
function paintNight(ctx: CanvasRenderingContext2D, scene: Scene): void {
  ctx.fillStyle = OFFICE.nightVeil;
  ctx.fillRect(0, 0, scene.art.width, scene.art.height);
  if (!scene.glow) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const lamp of scene.lamps) ctx.drawImage(scene.glow, Math.round(lamp.x) - GLOW_PX / 2, Math.round(lamp.y) - GLOW_PX / 2);
  ctx.globalCompositeOperation = 'source-over';
}

export function drawFrame(ctx: CanvasRenderingContext2D, input: FrameInput): void {
  const { world, scene, avatar, cam, view, dpr, selected, hovered, highlight: only } = input;
  /** Reduced motion freezes the ambient animation on the frame it was asked for. */
  const time = input.still ? 0 : input.time;
  const artCtx = scene.art.getContext('2d');
  if (!artCtx) return;
  artCtx.imageSmoothingEnabled = false;
  artCtx.drawImage(scene.room, 0, 0);
  if (input.marker) drawTapMarker(artCtx, input.marker);
  const actors = [...world.actors.values()].map((actor) => ({ actor, look: lookOf(actor, avatar, input.nearby) }));
  const drawables: (Drawable & { alpha?: number })[] = [...scene.furniture];
  for (const { actor, look } of actors) {
    drawables.push({
      sortY: actor.y + (look.seated ? 0.5 : 0),
      alpha: only && !only.has(actor.id) ? 0.3 : 1,
      draw: (c, t) => { drawActor(c, scene.sprites, actor, look, t); },
    });
  }
  if (avatar) drawables.push({ sortY: avatar.y + 0.25, draw: (c) => { drawAvatar(c, scene.sprites, avatar); } });
  if (world.layout.pet.length > 0) {
    const pet = petAt(world.layout.pet, input.still ? 0 : time);
    drawables.push({ sortY: pet.y, draw: (c, t) => { drawPet(c, pet, input.still ? 0 : t); } });
  }
  drawables.sort((a, b) => a.sortY - b.sortY);
  for (const item of drawables) {
    artCtx.globalAlpha = item.alpha ?? 1;
    item.draw(artCtx, time);
  }
  artCtx.globalAlpha = 1;
  if (scene.night) paintNight(artCtx, scene);
  for (const { actor, look } of actors) {
    if (only && !only.has(actor.id)) continue;
    drawActorOverlay(artCtx, actor, look, time, actor.id === selected, actor.id === hovered);
  }

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, view.width, view.height);
  ctx.imageSmoothingEnabled = false;
  const origin = originOf(cam, view);
  ctx.drawImage(scene.art, origin.x, origin.y, scene.art.width * cam.zoom, scene.art.height * cam.zoom);

  const fontPx = Math.max(Math.round(10 * dpr), Math.min(Math.round(15 * dpr), Math.round(cam.zoom * 3.4)));
  const sx = (x: number) => origin.x + x * cam.zoom;
  const tags: Tag[] = [];
  const byDepth = [...actors].sort((a, b) => Number(a.actor.id === selected) - Number(b.actor.id === selected) || a.actor.y - b.actor.y);
  for (const { actor, look } of byDepth) {
    if ((actor.pose === 'walk' || actor.pose === 'handover') && actor.id !== selected && actor.id !== hovered) continue;
    const dim = Boolean(only && !only.has(actor.id));
    tags.push({
      id: actor.id,
      text: input.names.get(actor.id) ?? actor.id,
      x: sx(look.hit.x + look.hit.w / 2),
      y: origin.y + look.labelY * cam.zoom - (look.labelAbove ? 2 * dpr : 0),
      above: look.labelAbove,
      tone: actor.id === selected ? 'selected' : dim ? 'dim' : 'normal',
      rank: actor.id === selected ? 0 : actor.id === hovered ? 2 : dim ? 4 : 3,
    });
  }
  if (avatar) tags.push({ text: 'Vos', x: sx(avatar.x), y: origin.y + (Math.round(avatar.y) - CHAR_H + 2) * cam.zoom - 2 * dpr, above: true, tone: 'operator', rank: 1 });
  const shown = placeTags(ctx, tags, fontPx, dpr);
  const boxes = shown.flatMap((tag) => (tag.box ? [tag.box] : []));
  for (const { actor, look } of actors) {
    if (actor.bubble !== 'zzz' || actor.pose !== 'lie') continue;
    if (only && !only.has(actor.id)) continue;
    drawSleepTrail(ctx, { x: sx(look.head.x), y: origin.y + look.head.y * cam.zoom }, time, cam.zoom, boxes, input.still);
  }
  for (const tag of shown) if (tag.box) drawLabel(ctx, tag.text, tag.box, fontPx, tag.tone);
  for (const { actor, look } of actors) {
    const speech = input.speech?.get(actor.id);
    if (!speech) continue;
    const tag = shown.find((item) => item.id === actor.id && item.above);
    const head = origin.y + look.hit.y * cam.zoom;
    drawSpeech(ctx, speech, { x: sx(look.hit.x + look.hit.w / 2), y: Math.min(head, tag?.box?.top ?? head) }, fontPx, dpr, time, view.width);
  }
}

/** Screen box of an agent in device px, for hit tests and tooltips. */
export function screenBox(look: ActorLook, cam: Camera, view: Size): ScreenRect {
  const origin = originOf(cam, view);
  return {
    left: origin.x + look.hit.x * cam.zoom,
    top: origin.y + look.hit.y * cam.zoom,
    right: origin.x + (look.hit.x + look.hit.w) * cam.zoom,
    bottom: origin.y + (look.hit.y + look.hit.h) * cam.zoom,
  };
}
