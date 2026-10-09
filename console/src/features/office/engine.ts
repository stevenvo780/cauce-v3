import { createAvatar, nearbyAgent, stepAvatar, teleport, tileAt, type Avatar } from './avatar';
import {
  NO_INSET, centerOn, clampCamera, ease, fitCamera, follow, panBy, reveal, screenToWorld, worldToScreen, zoomAt,
  type Camera, type Inset, type Size, type Vec, type ZoomLimits,
} from './camera';
import type { Site } from './campus';
import { PAD_VECTOR, VECTORS } from './canvas-input';
import { collect, drawCampusArt, drawLevelArt, makeExtras, updateExtras, type ArtInput, type Entry, type Extras } from './draw-art';
import { drawScreen, type ScreenInput, type SiteTag } from './draw-frame';
import type { GroupDots } from './group-dots';
import { CAMPUS, TILE, type Dir, type Level } from './level';
import type { MakeCanvas } from './paint';
import { actorLook, type ScreenRect, type TapMarker } from './people';
import { PixelLabels } from './pixel-label';
import { SPRITE_PAD } from './render-buildings';
import { Scenes } from './scene';
import { createWorld, emote, setMap, stepWorld, syncWorld, type ActorInput, type World } from './simulation';
import type { IconName } from './sprites';
import type { Speech } from './speech';
import { teamTone } from './teams';
import type { TubeEvent } from './tubes';
import type { WorldMap } from './world-map';

const PAN_SPEED = 620;
const CLOSE_S = 0.16;
const OPEN_S = 0.24;

export interface Press { start: Vec; at: number; type: string; dragging: boolean; last: Vec }

export interface EngineEvents {
  level: (id: string) => void;
  nearby: (id: string | null) => void;
  edges: (atMin: boolean, atMax: boolean) => void;
  occupancy: (counts: ReadonlyMap<string, number>) => void;
  tube: (event: TubeEvent) => void;
}

/** What the page tells the canvas every render; the loop reads it on the next frame. */
export interface EngineProps {
  selected: string | null;
  hovered: string | null;
  highlight: ReadonlySet<string> | null;
  names: ReadonlyMap<string, string>;
  speech?: ReadonlyMap<string, Speech>;
  groups?: ReadonlyMap<string, GroupDots>;
  /** Members and agents in trouble per building, for the labels over the houses. */
  stats: ReadonlyMap<string, { members: number; alerts: number }>;
  talkId: string | null;
}

const screenOf = (look: { hit: { x: number; y: number; w: number; h: number } }, cam: Camera, view: Size): ScreenRect => {
  const origin = worldToScreen(cam, view, { x: 0, y: 0 });
  return {
    left: origin.x + look.hit.x * cam.zoom, top: origin.y + look.hit.y * cam.zoom,
    right: origin.x + (look.hit.x + look.hit.w) * cam.zoom, bottom: origin.y + (look.hit.y + look.hit.h) * cam.zoom,
  };
};

/**
 * The campus game without React: the world, the scenes, the camera of each map and the switch
 * between maps. The page drives it through the methods below and listens through `events`.
 */
export class OfficeEngine {
  readonly world: World;
  readonly scenes: Scenes;
  readonly labels: PixelLabels;
  readonly avatar: Avatar;
  readonly extras: Extras;
  level = CAMPUS;
  avatarLevel = CAMPUS;
  cam: Camera = { x: 0, y: 0, zoom: 1 };
  target: Camera = { x: 0, y: 0, zoom: 1 };
  view: Size = { width: 1, height: 1 };
  dpr = 1;
  inset: Inset = NO_INSET;
  limits: ZoomLimits = { min: 1, max: 8 };
  readonly cams = new Map<string, Camera>();
  readonly keys = new Set<string>();
  readonly pad = new Set<Dir>();
  readonly presses = new Map<number, Press>();
  pinch: { start: { distance: number; mid: Vec }; zoom: number; cam: Camera } | null = null;
  lastTap: { at: number; x: number; y: number } | null = null;
  settleAt = 0;
  pendingWalk = 0;
  following = false;
  flying = false;
  follow: string | null = null;
  /** The camera still shows the fitted frame, so a resize may fit it again. */
  untouched = true;
  paseo = false;
  marker: (TapMarker & { level: string; at: number }) | null = null;
  switching: { to: string; start: number; focus: string | null; entered: boolean } | null = null;
  cover = 0;
  nearby: string | null = null;
  hoveredSite: string | null = null;
  night = false;
  entries: readonly Entry[] = [];
  props: EngineProps = { selected: null, hovered: null, highlight: null, names: new Map(), stats: new Map(), talkId: null };
  private pattern: CanvasPattern | null = null;
  private patternCtx: CanvasRenderingContext2D | null = null;
  private avatarTile = { x: -1, y: -1 };
  private readonly held = { x: 0, y: 0 };
  private readonly neighbours: { id: string; x: number; y: number }[] = [];
  private occupancyAt = 0;
  private occupancy = new Map<string, number>();
  private edges = { atMin: true, atMax: false };
  private readonly art: ArtInput;
  private readonly screen: ScreenInput;
  private readonly tagMemo = new Map<string, { key: string; tag: SiteTag }>();
  private readonly siteTags: SiteTag[] = [];
  private readonly road = { y: 0, walk: 0 };

  constructor(map: WorldMap, reducedMotion: boolean, make: MakeCanvas, readonly events: EngineEvents, seen?: Set<string>) {
    this.world = createWorld(map, reducedMotion, Date.now() / 1000, seen);
    this.world.line.listener = (event) => { this.events.tube(event); };
    this.scenes = new Scenes(make, this.world);
    this.labels = new PixelLabels(make);
    this.avatar = createAvatar(map.campus.door);
    this.extras = makeExtras(this.world, this.scenes, this.avatar);
    this.art = {
      world: this.world, scenes: this.scenes, time: 0, still: reducedMotion, night: false, avatar: this.avatar, selected: null, hovered: null,
      highlight: null, nearby: null, marker: null, hoveredSite: null, now: 0,
    };
    this.screen = {
      cam: this.cam, view: this.view, dpr: 1, time: 0, still: reducedMotion, art: this.scenes.backdrop, backdrop: null, night: false,
      indoor: false, campus: true, entries: [], names: new Map(), selected: null, hovered: null, nearby: null, highlight: null,
      avatar: this.avatar, avatarHere: false, labels: this.labels, sites: this.siteTags, hoveredSite: null, cover: 0, road: null,
    };
  }

  get reducedMotion(): boolean { return this.world.reducedMotion; }

  setReducedMotion(reduced: boolean): void {
    if (this.world.reducedMotion === reduced) return;
    this.world.reducedMotion = reduced;
    syncWorld(this.world, this.world.inputs);
  }

  setMap(map: WorldMap): void {
    const before = this.world.map.campus.plaza;
    setMap(this.world, map);
    const dx = (map.campus.plaza.x - before.x) * TILE;
    const dy = (map.campus.plaza.y - before.y) * TILE;
    if (dx !== 0 || dy !== 0) {
      const shift = (cam: Camera): Camera => ({ ...cam, x: cam.x + dx, y: cam.y + dy });
      const campusCam = this.cams.get(CAMPUS);
      if (campusCam) this.cams.set(CAMPUS, shift(campusCam));
      if (this.level === CAMPUS) {
        this.cam = shift(this.cam);
        this.target = shift(this.target);
      }
      if (this.avatarLevel === CAMPUS) {
        this.avatar.x += dx;
        this.avatar.y += dy;
        this.avatar.route = [];
      }
    }
    if (!map.levels.has(this.level)) this.enter(CAMPUS, null);
    if (!map.levels.has(this.avatarLevel)) this.placeAvatar(CAMPUS, null);
    this.tagMemo.clear();
    this.limits = this.limitsFor(this.level);
    this.target = this.clamp(this.target);
  }

  sync(inputs: readonly ActorInput[]): void {
    syncWorld(this.world, inputs);
  }

  levelOf(id: string): Level | undefined {
    return this.world.map.levels.get(id);
  }

  sizeOf(id: string): Size {
    const level = this.levelOf(id);
    return level ? { width: level.cols * TILE, height: level.rows * TILE } : { width: 1, height: 1 };
  }

  limitsFor(id: string): ZoomLimits {
    const size = this.sizeOf(id);
    const free = { width: this.view.width - (this.inset.left ?? 0) - this.inset.right, height: this.view.height - (this.inset.top ?? 0) - this.inset.bottom };
    const fit = Math.max(1, Math.floor(Math.min(free.width / size.width, free.height / size.height)));
    return { min: fit, max: Math.max(fit * 2, Math.round(8 * this.dpr)) };
  }

  clamp(cam: Camera): Camera {
    return clampCamera(cam, this.view, this.sizeOf(this.level), this.limits, this.inset);
  }

  /**
   * The camera that shows the whole of map `id` as large as a whole zoom step allows. A campus too
   * big for the screen opens on its plaza at a size where the houses still read, and pans from there.
   */
  fitTarget(id: string): Camera {
    const size = this.sizeOf(id);
    const limits = this.limitsFor(id);
    const fitted = fitCamera({ x: 0, y: 0, w: size.width, h: size.height }, this.view, limits, this.inset);
    const readable = Math.max(1, Math.round(0.75 * this.dpr));
    if (id === CAMPUS && fitted.zoom < readable) {
      const { hub } = this.world.map.campus;
      return clampCamera(centerOn({ ...fitted, zoom: readable }, { x: hub.x, y: hub.y - 2 * TILE }, this.inset), this.view, size, limits, this.inset);
    }
    return clampCamera(fitted, this.view, size, limits, this.inset);
  }

  resize(view: Size, dpr: number, inset: Inset): void {
    const first = this.view.width <= 1;
    this.view = view;
    this.dpr = dpr;
    this.inset = inset;
    this.limits = this.limitsFor(this.level);
    if (first || this.untouched) {
      this.target = this.fitTarget(this.level);
      this.cam = { ...this.target };
      return;
    }
    this.target = this.clamp(this.target);
  }

  /** Switches to map `id` behind a short dither; `focus` brings an agent into view once there. */
  go(id: string, focus: string | null = null): void {
    if (!this.world.map.levels.has(id)) return;
    if (this.switching && !this.switching.entered) {
      this.switching.to = id;
      this.switching.focus = focus;
      return;
    }
    if (id === this.level) {
      if (focus) this.focusActor(focus, true);
      return;
    }
    if (this.world.reducedMotion) {
      this.enter(id, focus);
      return;
    }
    this.switching = { to: id, start: performance.now() / 1000, focus, entered: false };
  }

  private placeAvatar(id: string, from: string | null): void {
    const level = this.levelOf(id);
    if (!level) return;
    const site = from ? this.world.map.campus.siteOf.get(from) : undefined;
    teleport(this.avatar, id === CAMPUS ? site?.door ?? this.world.map.campus.door : level.door);
    this.avatarLevel = id;
    const tile = tileAt(this.avatar.x, this.avatar.y);
    this.avatarTile = tile;
  }

  private enter(id: string, focus: string | null): void {
    const from = this.level;
    this.cams.set(from, { ...this.target });
    this.level = id;
    this.limits = this.limitsFor(id);
    const remembered = this.cams.get(id);
    this.target = remembered ? this.clamp(remembered) : this.fitTarget(id);
    this.untouched = !remembered;
    const site = id === CAMPUS ? this.world.map.campus.siteOf.get(from) : undefined;
    if (site) this.untouched = false;
    if (site) this.target = this.clamp(reveal(this.target, this.view, { x: site.x * TILE, y: site.y * TILE, w: site.w * TILE, h: site.h * TILE }, this.inset, 48 * this.dpr));
    this.cam = { ...this.target };
    this.following = false;
    this.flying = false;
    this.hoveredSite = null;
    if (this.avatarLevel !== id) this.placeAvatar(id, from);
    if (focus) this.focusActor(focus, true);
    this.events.level(id);
  }

  /** Moves only as far as needed, so an agent already in sight never shakes the room. */
  focusActor(id: string, roomy: boolean): void {
    const actor = this.world.actors.get(id);
    if (!actor) return;
    if (actor.level !== this.level) {
      this.go(actor.level, id);
      return;
    }
    const look = actorLook(actor);
    const free = Math.min(this.view.width - this.inset.right, this.view.height - this.inset.bottom - (this.inset.top ?? 0));
    const margin = roomy ? Math.min(96 * this.dpr, free / 4) : 24 * this.dpr;
    this.following = false;
    this.untouched = false;
    this.target = this.clamp(reveal(this.target, this.view, look.hit, this.inset, margin));
  }

  emote(id: string, icon: IconName): void {
    emote(this.world, id, icon);
  }

  fit(): void {
    this.following = false;
    this.target = this.fitTarget(this.level);
    this.untouched = true;
  }

  zoomTo(zoom: number, at?: Vec): void {
    this.untouched = false;
    this.target = this.clamp(zoomAt(this.target, this.view, at ?? { x: this.view.width / 2, y: this.view.height / 2 }, zoom));
    this.settleAt = 0;
  }

  centerMe(): void {
    if (this.avatarLevel !== this.level) this.placeAvatar(this.level, null);
    const zoom = Math.max(this.target.zoom, Math.min(this.limits.max, this.limits.min + 1));
    this.untouched = false;
    this.target = this.clamp(centerOn({ ...this.target, zoom }, { x: this.avatar.x, y: this.avatar.y - 10 }, this.inset));
    this.following = true;
  }

  setPaseo(on: boolean): void {
    this.paseo = on;
    this.keys.clear();
    this.pad.clear();
    if (!on) return;
    if (this.avatarLevel !== this.level) this.placeAvatar(this.level, null);
    this.following = true;
    this.untouched = false;
    this.target = this.clamp(follow(this.target, this.view, this.avatar, 0.35));
  }

  /** The building drawn under a screen point, its roof included. */
  siteAt(screen: Vec): Site | null {
    if (this.level !== CAMPUS) return null;
    const point = screenToWorld(this.cam, this.view, screen);
    for (const site of this.world.map.campus.sites) {
      if (point.x >= site.x * TILE - 2 && point.x < (site.x + site.w) * TILE + 2 && point.y >= site.y * TILE - SPRITE_PAD.top + 4 && point.y < (site.y + site.h) * TILE) return site;
    }
    return null;
  }

  /** The agent drawn under a screen point, the front-most first; inside, a desk counts for its owner. */
  pick(screen: Vec): string | null {
    let best: { id: string; y: number } | null = null;
    for (const entry of this.entries) {
      if (!entry.actor) continue;
      const box = screenOf(entry.look, this.cam, this.view);
      if (screen.x < box.left || screen.x > box.right || screen.y < box.top || screen.y > box.bottom) continue;
      if (!best || entry.actor.y > best.y) best = { id: entry.actor.id, y: entry.actor.y };
    }
    if (best) return best.id;
    const level = this.levelOf(this.level);
    if (!level || this.level === CAMPUS) return null;
    const point = screenToWorld(this.cam, this.view, screen);
    const desk = level.desks.findIndex((slot) => point.x >= slot.x * TILE && point.x < slot.x * TILE + 32
      && point.y >= Math.min(slot.deskY, slot.chairY) * TILE && point.y < (Math.max(slot.deskY, slot.chairY) + 1) * TILE);
    if (desk < 0) return null;
    for (const actor of this.world.actors.values()) if (actor.home === level.id && actor.desk === desk) return actor.id;
    return null;
  }

  /** Screen box of an agent in device px, or `null` when it is not on the map shown. */
  boxOf(id: string): ScreenRect | null {
    const entry = this.entries.find((item) => item.actor?.id === id);
    return entry ? screenOf(entry.look, this.cam, this.view) : null;
  }

  /** Whether a screen point falls on the doorway out of the building shown. */
  onExit(screen: Vec): boolean {
    const level = this.levelOf(this.level);
    if (!level || this.level === CAMPUS) return false;
    const point = screenToWorld(this.cam, this.view, screen);
    return point.y >= (level.rows - 1) * TILE - 4 && point.x >= level.door.tile.x * TILE && point.x < (level.door.tile.x + 2) * TILE;
  }

  private publish(): void {
    const atMin = this.target.zoom <= this.limits.min + 1e-6;
    const atMax = this.target.zoom >= this.limits.max - 1e-6;
    if (atMin !== this.edges.atMin || atMax !== this.edges.atMax) {
      this.edges = { atMin, atMax };
      this.events.edges(atMin, atMax);
    }
  }

  private countPeople(now: number): void {
    if (now - this.occupancyAt < 0.5) return;
    this.occupancyAt = now;
    const counts = new Map<string, number>();
    for (const actor of this.world.actors.values()) if (actor.pose !== 'hidden') counts.set(actor.level, (counts.get(actor.level) ?? 0) + 1);
    const same = counts.size === this.occupancy.size && [...counts].every(([id, count]) => this.occupancy.get(id) === count);
    if (same) return;
    this.occupancy = counts;
    this.events.occupancy(counts);
  }

  private doors(): void {
    if (!this.paseo || this.switching || this.avatarLevel !== this.level) return;
    const tile = tileAt(this.avatar.x, this.avatar.y);
    if (tile.x === this.avatarTile.x && tile.y === this.avatarTile.y) return;
    this.avatarTile = tile;
    if (this.level !== CAMPUS) {
      const door = this.levelOf(this.level)?.door.tile;
      if (door?.y === tile.y && (tile.x === door.x || tile.x === door.x + 1)) this.go(CAMPUS);
      return;
    }
    const site = this.world.map.campus.sites.find((item) => item.door.tile.x === tile.x && item.door.tile.y === tile.y);
    if (site && site.phase?.kind !== 'demolish') this.go(site.id);
  }

  /** One frame: the world moves, the operator walks, the camera eases, the map switch advances. */
  tick(nowMs: number, dt: number): void {
    const now = nowMs / 1000;
    stepWorld(this.world, dt);
    const held = this.held;
    held.x = 0;
    held.y = 0;
    for (const key of this.keys) {
      const vector = VECTORS[key] as Vec | undefined;
      if (vector) {
        held.x += vector.x;
        held.y += vector.y;
      }
    }
    for (const dir of this.pad) {
      held.x += PAD_VECTOR[dir].x;
      held.y += PAD_VECTOR[dir].y;
    }
    const level = this.levelOf(this.avatarLevel);
    if (this.paseo && !this.world.reducedMotion && level && this.avatarLevel === this.level) {
      stepAvatar(this.avatar, level, held, dt);
      if (held.x !== 0 || held.y !== 0) this.following = true;
    } else if (!this.paseo && (held.x !== 0 || held.y !== 0)) {
      this.following = false;
      const step = PAN_SPEED * this.dpr * Math.min(dt, 0.05);
      this.target = panBy(this.target, -held.x * step, -held.y * step);
      this.untouched = false;
    }
    if (!this.paseo && level) stepAvatar(this.avatar, level, { x: 0, y: 0 }, this.world.reducedMotion ? 0 : dt);
    this.doors();
    const followed = this.follow ? this.world.actors.get(this.follow) : undefined;
    if (followed && !this.switching) {
      if (followed.level !== this.level) this.go(followed.level);
      else {
        this.target = follow(this.target, this.view, { x: followed.x, y: followed.y - 10 }, 0.3);
        this.untouched = false;
      }
    }
    if (this.following && this.avatar.moving && this.avatarLevel === this.level) {
      this.target = follow(this.target, this.view, this.avatar, 0.35);
      this.untouched = false;
    }
    let gesturing = this.pinch !== null;
    for (const press of this.presses.values()) gesturing ||= press.dragging;
    if (!gesturing && nowMs >= this.settleAt && !Number.isInteger(this.target.zoom)) {
      this.target = zoomAt(this.target, this.view, { x: this.view.width / 2, y: this.view.height / 2 }, Math.round(this.target.zoom));
    }
    const partner = this.props.talkId && !gesturing && !this.flying ? this.world.actors.get(this.props.talkId) : undefined;
    if (partner?.level === this.level) this.target = reveal(this.target, this.view, actorLook(partner).hit, this.inset, 24 * this.dpr);
    this.target = this.clamp(this.target);
    this.cam = gesturing ? { ...this.target } : ease(this.cam, this.target, dt, this.world.reducedMotion, this.flying ? 4 : 10);
    if (this.flying && this.cam.x === this.target.x && this.cam.y === this.target.y) this.flying = false;
    this.advanceSwitch(now);
    let near: string | null = null;
    if (this.paseo && this.avatarLevel === this.level) {
      let used = 0;
      for (const entry of this.entries) {
        if (!entry.actor) continue;
        const slot = this.neighbours[used] ?? { id: '', x: 0, y: 0 };
        slot.id = entry.actor.id;
        slot.x = entry.actor.x;
        slot.y = entry.actor.y;
        this.neighbours[used] = slot;
        used += 1;
      }
      this.neighbours.length = used;
      near = nearbyAgent(this.avatar, this.neighbours);
    }
    if (near !== this.nearby) {
      this.nearby = near;
      this.events.nearby(near);
    }
    this.publish();
    this.countPeople(now);
  }

  private advanceSwitch(now: number): void {
    const switching = this.switching;
    if (!switching) {
      this.cover = 0;
      return;
    }
    const elapsed = now - switching.start;
    if (!switching.entered) {
      this.cover = Math.min(1, elapsed / CLOSE_S);
      if (elapsed >= CLOSE_S) {
        switching.entered = true;
        this.enter(switching.to, switching.focus);
      }
      return;
    }
    this.cover = Math.max(0, 1 - (elapsed - CLOSE_S) / OPEN_S);
    if (this.cover <= 0) this.switching = null;
  }

  private tags(): SiteTag[] {
    this.siteTags.length = 0;
    if (this.level !== CAMPUS) return this.siteTags;
    for (const site of this.world.map.campus.sites) {
      if (site.phase?.kind === 'demolish') continue;
      const stats = this.props.stats.get(site.id);
      const people = site.kind === 'group' ? stats?.members ?? 0 : this.occupancy.get(site.id) ?? 0;
      const alerts = site.kind === 'group' ? stats?.alerts ?? 0 : site.kind === 'shop' ? stats?.alerts ?? 0 : 0;
      const key = `${site.label}|${String(people)}|${String(alerts)}|${String(site.hue)}`;
      let memo = this.tagMemo.get(site.id);
      if (memo?.key !== key || memo.tag.site !== site) {
        memo = { key, tag: { site, text: people > 0 ? `${site.label} · ${String(people)}` : site.label, swatch: site.kind === 'group' ? teamTone(site.hue, 60, 55) : null, alerts } };
        this.tagMemo.set(site.id, memo);
      }
      this.siteTags.push(memo.tag);
    }
    return this.siteTags;
  }

  /** Draws the frame shown now onto `ctx`; time in seconds drives the ambient animation. */
  draw(ctx: CanvasRenderingContext2D, time: number): void {
    if (typeof ctx.drawImage !== 'function') return;
    const { world, props } = this;
    const campus = this.level === CAMPUS;
    const avatar = this.avatarLevel === this.level ? this.avatar : null;
    if (this.marker && this.marker.ok && !this.avatar.moving && this.avatar.route.length === 0 && time - this.marker.at > 0.3) this.marker = null;
    const art = this.art;
    art.time = time;
    art.night = this.night;
    art.avatar = avatar;
    art.selected = props.selected;
    art.hovered = props.hovered;
    art.highlight = props.highlight;
    art.nearby = this.nearby;
    if (this.marker) this.marker.age = Math.max(0, time - this.marker.at);
    art.marker = this.marker;
    art.hoveredSite = this.hoveredSite;
    art.now = Date.now() / 1000;
    const extras = updateExtras(this.extras, avatar, this.avatarLevel, this.level, this.world.reducedMotion ? 0 : time);
    let canvas: HTMLCanvasElement;
    if (campus) {
      const scene = this.scenes.campus(world.map.campus, this.night);
      this.entries = collect(world, CAMPUS, avatar, this.nearby, world.map.campus.sites);
      drawCampusArt(scene, art, this.entries, extras);
      canvas = scene.art;
    } else {
      const level = this.levelOf(this.level);
      if (!level) return;
      const scene = this.scenes.level(level, this.night);
      this.entries = collect(world, this.level, avatar, this.nearby);
      drawLevelArt(scene, art, this.entries, extras);
      canvas = scene.art;
    }
    if (!this.pattern || this.patternCtx !== ctx) {
      this.pattern = typeof ctx.createPattern === 'function' ? ctx.createPattern(this.scenes.backdrop, 'repeat') : null;
      this.patternCtx = ctx;
    }
    const screen = this.screen;
    screen.cam = this.cam;
    screen.view = this.view;
    screen.dpr = this.dpr;
    screen.time = time;
    screen.still = world.reducedMotion;
    screen.art = canvas;
    screen.backdrop = this.pattern;
    screen.night = this.night;
    screen.indoor = !campus && !this.levelOf(this.level)?.outdoor;
    screen.campus = campus;
    screen.entries = this.entries;
    screen.names = props.names;
    screen.selected = props.selected;
    screen.hovered = props.hovered;
    screen.nearby = this.nearby;
    screen.highlight = props.highlight;
    screen.avatar = avatar;
    screen.avatarHere = avatar !== null && this.paseo;
    screen.speech = props.speech;
    screen.groups = props.groups;
    screen.sites = this.tags();
    screen.hoveredSite = this.hoveredSite;
    screen.cover = this.cover;
    this.road.y = world.map.campus.roadY * TILE;
    this.road.walk = (world.map.campus.fenceY + 1) * TILE;
    screen.road = campus ? this.road : null;
    drawScreen(ctx, screen);
  }
}
