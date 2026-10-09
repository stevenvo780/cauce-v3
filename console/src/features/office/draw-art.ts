import { faceTowards, type Avatar } from './avatar';
import { busPhase } from './bus';
import { alongRoute, type Site } from './campus';
import { CAMPUS, TILE, type Point } from './level';
import { OFFICE } from './palette';
import { orbHues } from '../../orb-hues';
import { hslHex } from './palette';
import { actorLook, blankLook, drawActor, drawActorOverlay, drawAvatar, drawTapMarker, type ActorLook, type TapMarker } from './people';
import {
  BUILD_S, DEMOLISH_S, SPRITE_PAD, facadeWindows, paintBeacon, paintConstruction, paintDemolition, paintSmoke, paintWindowLight,
  type Rect, type WindowLight,
} from './render-buildings';
import { drawBus, drawCapsule } from './render-campus';
import { drawPet, petAt } from './render-garden';
import type { CampusScene, LevelScene, Scenes } from './scene';
import type { Actor, World } from './simulation';

export interface Entry {
  sortY: number;
  actor: Actor | null;
  look: ActorLook;
  site: Site | null;
}

/** Something that is neither an agent nor a building but must be depth-sorted with them: the operator, the cat. */
export interface Extra { sortY: number; visible: boolean; draw: (ctx: CanvasRenderingContext2D, time: number) => void }

export interface ArtInput {
  world: World;
  scenes: Scenes;
  time: number;
  still: boolean;
  night: boolean;
  avatar: Avatar | null;
  selected: string | null;
  hovered: string | null;
  highlight: ReadonlySet<string> | null;
  nearby: string | null;
  marker: (TapMarker & { level: string }) | null;
  hoveredSite: string | null;
  /** Wall clock in seconds for building phases, which are stamped in wall time. */
  now: number;
}

const pool: Entry[] = [];
const active: Entry[] = [];
const windowCache = new WeakMap<Site, Rect[]>();
const capsulePoint: Point = { x: 0, y: 0 };
const stripes = new Map<string, string>();
const stripeOf = (id: string): string => {
  let color = stripes.get(id);
  if (!color) {
    color = hslHex(orbHues(id)[0], 70, 50);
    stripes.set(id, color);
  }
  return color;
};
const trailPoint: Point = { x: 0, y: 0 };
const EMOTE_HOP_S = 0.6;

function nextEntry(): Entry {
  const entry = pool[active.length] ?? { sortY: 0, actor: null, look: blankLook(), site: null };
  pool[active.length] = entry;
  active.push(entry);
  return entry;
}

/** The people on `level`, looks computed into entries kept between frames and sorted by depth. */
export function collect(world: World, level: string, avatar: Avatar | null, nearby: string | null, sites: readonly Site[] = []): Entry[] {
  active.length = 0;
  for (const actor of world.actors.values()) {
    if (actor.level !== level || actor.pose === 'hidden') continue;
    const entry = nextEntry();
    const gaze = avatar && nearby === actor.id ? faceTowards({ x: actor.x, y: actor.y }, { x: avatar.x, y: avatar.y }) : null;
    let lift = 0;
    if (actor.emote) {
      const elapsed = 3 - (actor.emote.until - world.time);
      if (elapsed >= 0 && elapsed < EMOTE_HOP_S) lift = Math.round(Math.sin((elapsed / EMOTE_HOP_S) * Math.PI) * 4);
    }
    entry.actor = actor;
    entry.site = null;
    actorLook(actor, gaze, lift, entry.look);
    entry.sortY = actor.y + (entry.look.seated ? 0.5 : 0);
  }
  for (const site of sites) {
    const entry = nextEntry();
    entry.actor = null;
    entry.site = site;
    entry.sortY = (site.y + site.h) * TILE - 1;
  }
  return active.sort((a, b) => a.sortY - b.sortY);
}

function paintNight(ctx: CanvasRenderingContext2D, width: number, height: number, glow: HTMLCanvasElement | null, lamps: readonly Point[]): void {
  ctx.fillStyle = OFFICE.nightVeil;
  ctx.fillRect(0, 0, width, height);
  if (!glow) return;
  ctx.globalCompositeOperation = 'lighter';
  for (const lamp of lamps) ctx.drawImage(glow, Math.round(lamp.x) - glow.width / 2, Math.round(lamp.y) - glow.height / 2);
  ctx.globalCompositeOperation = 'source-over';
}

function drawPerson(ctx: CanvasRenderingContext2D, input: ArtInput, entry: Entry, time: number): void {
  const actor = entry.actor;
  if (!actor) return;
  ctx.globalAlpha = input.highlight && !input.highlight.has(actor.id) ? 0.3 : 1;
  drawActor(ctx, input.scenes.sprites, actor, entry.look, time, actor.holding > input.world.time);
  ctx.globalAlpha = 1;
}

function drawOverlays(ctx: CanvasRenderingContext2D, input: ArtInput, entries: readonly Entry[], time: number): void {
  for (const entry of entries) {
    const actor = entry.actor;
    if (!actor || (input.highlight && !input.highlight.has(actor.id))) continue;
    drawActorOverlay(ctx, actor, entry.look, time, actor.id === input.selected, actor.id === input.hovered, actor.emote?.icon ?? null);
  }
}

/** An interior in art px: floor and walls, then furniture and people by depth, night, bubbles. */
export function drawLevelArt(scene: LevelScene, input: ArtInput, entries: readonly Entry[], extras: readonly Extra[]): void {
  const ctx = scene.art.getContext('2d');
  if (!ctx) return;
  const time = input.still ? 0 : input.time;
  const { level } = scene;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scene.bg, 0, 0);
  scene.owners.length = level.desks.length;
  scene.owners.fill(undefined);
  for (const actor of input.world.actors.values()) if (actor.home === level.id && actor.desk >= 0 && actor.desk < level.desks.length) scene.owners[actor.desk] = actor;
  if (input.marker?.level === level.id) drawTapMarker(ctx, input.marker);
  const furniture = scene.furniture;
  let next = 0;
  let extra = 0;
  const flushUntil = (sortY: number) => {
    for (;;) {
      const piece = next < furniture.length ? furniture[next] : null;
      const other = extra < extras.length ? extras[extra] : null;
      if (!piece && !other) return;
      const pieceY = piece ? piece.sortY : Infinity;
      const otherY = other ? other.sortY : Infinity;
      if (Math.min(pieceY, otherY) > sortY) return;
      if (piece && pieceY <= otherY) {
        piece.draw(ctx, time);
        next += 1;
      } else if (other) {
        if (other.visible) other.draw(ctx, time);
        extra += 1;
      }
    }
  };
  for (const entry of entries) {
    flushUntil(entry.sortY);
    drawPerson(ctx, input, entry, time);
  }
  flushUntil(Infinity);
  if (scene.night) paintNight(ctx, scene.art.width, scene.art.height, input.scenes.glow, scene.lamps);
  drawOverlays(ctx, input, entries, time);
}

function windowsOf(site: Site): Rect[] {
  let slots = windowCache.get(site);
  if (!slots) {
    slots = facadeWindows(site);
    windowCache.set(site, slots);
  }
  return slots;
}

function deskLight(actor: Actor | undefined): WindowLight {
  if (!actor) return 'off';
  switch (actor.state) {
    case 'down': return 'down';
    case 'blocked': return 'alert';
    case 'receiving': return 'mail';
    case 'thinking':
    case 'delegating': return 'work';
    default: return actor.level === actor.home ? 'dim' : 'off';
  }
}

const owners: (Actor | undefined)[] = [];

/** Lit windows say who is doing what inside: one window per desk for a group, how full it is for the rest. */
function drawWindows(ctx: CanvasRenderingContext2D, input: ArtInput, site: Site, x: number, y: number, time: number, glow: boolean): void {
  const slots = windowsOf(site);
  const { world } = input;
  owners.length = slots.length;
  owners.fill(undefined);
  let inside = 0;
  let repairing = false;
  for (const actor of world.actors.values()) {
    if (site.kind === 'group' && actor.home === site.id && actor.desk >= 0) owners[actor.desk % Math.max(1, slots.length)] = actor;
    if (actor.level === site.id && actor.pose !== 'hidden') {
      inside += 1;
      if (actor.state === 'down') repairing = true;
    }
  }
  for (let index = 0; index < slots.length; index += 1) {
    const light: WindowLight = site.kind === 'group' ? deskLight(owners[index])
      : index < inside ? (site.kind === 'shop' && repairing ? 'alert' : site.kind === 'dorm' ? 'mail' : 'work') : 'off';
    paintWindowLight(ctx, slots[index], x, y, light, time, index);
    if (glow && light !== 'off' && light !== 'dim' && input.scenes.glow) {
      ctx.globalCompositeOperation = 'lighter';
      ctx.drawImage(input.scenes.glow, x + slots[index].x + slots[index].w / 2 - 12, y + slots[index].y + slots[index].h / 2 - 12);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  if (site.kind === 'shop') paintBeacon(ctx, x + site.w * TILE - 10, y - 2, repairing, time);
  if (site.kind === 'cafe' && inside > 0) paintSmoke(ctx, x + site.w * TILE - 19, y - 14, time);
}

function doorOpen(world: World, site: Site): boolean {
  for (const actor of world.actors.values()) {
    if (actor.level === CAMPUS && Math.abs(actor.x - site.door.px.x) < 10 && Math.abs(actor.y - site.door.px.y) < 14) return true;
  }
  return false;
}

function drawSite(ctx: CanvasRenderingContext2D, input: ArtInput, scene: CampusScene, site: Site, time: number): void {
  const sprite = input.scenes.site(scene, site);
  const x = site.x * TILE - SPRITE_PAD.x;
  const y = site.y * TILE - SPRITE_PAD.top;
  const phase = site.phase;
  if (phase?.kind === 'build' && input.now - phase.since < BUILD_S) {
    paintConstruction(ctx, sprite, x, y, (input.now - phase.since) / BUILD_S, time);
    return;
  }
  if (phase?.kind === 'demolish') {
    paintDemolition(ctx, sprite, x, y, (input.now - phase.since) / DEMOLISH_S, time);
    return;
  }
  ctx.drawImage(sprite, x, y);
  const fx = site.x * TILE;
  const fy = site.y * TILE;
  if (input.hoveredSite === site.id) {
    ctx.fillStyle = 'rgba(255, 255, 255, 0.16)';
    ctx.fillRect(fx - 3, fy - 2, site.w * TILE + 6, site.h * TILE + 2);
  }
  if (site.kind === 'park') return;
  drawWindows(ctx, input, site, fx, fy, time, false);
  if (doorOpen(input.world, site)) {
    const cx = (site.door.tile.x) * TILE + TILE / 2;
    const bottom = fy + site.h * TILE;
    ctx.fillStyle = OFFICE.slate;
    ctx.fillRect(cx - 5, bottom - 14, 10, 13);
  }
  if (input.world.line.dings.has(site.id) && input.world.time - (input.world.line.dings.get(site.id) ?? 0) < 1.6 && site.outlet) {
    ctx.fillStyle = Math.floor(time * 10) % 2 === 0 ? OFFICE.spark : OFFICE.paper;
    ctx.fillRect(Math.round(site.outlet.x) - 2, Math.round(site.outlet.y) - 9, 4, 4);
  }
}

/** The campus in art px: ground, houses and walkers by depth, the bus, the tubes above them and the capsules in them. */
export function drawCampusArt(scene: CampusScene, input: ArtInput, entries: readonly Entry[], extras: readonly Extra[]): void {
  const ctx = scene.art.getContext('2d');
  if (!ctx) return;
  const time = input.still ? 0 : input.time;
  const { campus } = scene;
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(scene.bg, 0, 0);
  if (input.marker?.level === CAMPUS) drawTapMarker(ctx, input.marker);
  let extra = 0;
  for (const entry of entries) {
    while (extra < extras.length && extras[extra].sortY <= entry.sortY) {
      if (extras[extra].visible) extras[extra].draw(ctx, time);
      extra += 1;
    }
    if (entry.site) drawSite(ctx, input, scene, entry.site, time);
    else drawPerson(ctx, input, entry, time);
  }
  for (; extra < extras.length; extra += 1) if (extras[extra].visible) extras[extra].draw(ctx, time);
  const bus = busPhase(input.world.bus, input.world.time);
  if (bus !== null) drawBus(ctx, campus, bus, time);
  ctx.drawImage(scene.over, 0, 0);
  for (const capsule of input.world.line.capsules) {
    if (capsule.phase !== 'flying' || capsule.at < 0 || capsule.route.length === 0) continue;
    alongRoute(capsule.route, capsule.at, capsulePoint);
    alongRoute(capsule.route, capsule.at - 8, trailPoint);
    drawCapsule(ctx, capsulePoint, trailPoint, stripeOf(capsule.from));
  }
  if (scene.night) {
    paintNight(ctx, scene.art.width, scene.art.height, null, []);
    for (const entry of entries) if (entry.site && entry.site.kind !== 'park') drawWindows(ctx, input, entry.site, entry.site.x * TILE, entry.site.y * TILE, time, true);
    if (input.scenes.glow) {
      ctx.globalCompositeOperation = 'lighter';
      for (const piece of campus.furniture) if (piece.kind === 'lamp') ctx.drawImage(input.scenes.glow, piece.x * TILE - 4, piece.y * TILE - 28);
      ctx.globalCompositeOperation = 'source-over';
    }
  }
  drawOverlays(ctx, input, entries, time);
}

export interface Extras { avatar: Extra; pet: Extra; list: Extra[]; placePet: (level: string, time: number) => void }

/** The operator and the park cat as depth-sorted extras; their closures are made once per canvas. */
export function makeExtras(world: World, scenes: Scenes, avatar: Avatar): Extras {
  const cat = { x: 0, y: 0, left: false, sitting: false };
  const pet: Extra = { sortY: 0, visible: false, draw: (ctx, time) => { drawPet(ctx, cat, time); } };
  const operator: Extra = { sortY: 0, visible: false, draw: (ctx) => { drawAvatar(ctx, scenes.sprites, avatar); } };
  return {
    avatar: operator,
    pet,
    list: [operator, pet],
    placePet: (level, time) => {
      const round = world.map.levels.get(level)?.pet ?? [];
      pet.visible = round.length > 0;
      if (pet.visible) Object.assign(cat, petAt(round, time));
      pet.sortY = cat.y;
    },
  };
}

/** Refreshes who of the extras shows on `level` and keeps them in depth order. */
export function updateExtras(extras: Extras, avatar: Avatar | null, avatarLevel: string, level: string, time: number): Extra[] {
  extras.avatar.visible = avatar !== null && avatarLevel === level;
  extras.avatar.sortY = avatar ? avatar.y + 0.25 : 0;
  extras.placePet(level, time);
  return extras.list.sort((a, b) => a.sortY - b.sortY);
}
