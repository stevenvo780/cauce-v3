import type { Campus } from './campus';
import { deskMonitor } from './monitor';
import { CAMPUS, TILE, type Level, type Point } from './level';
import { SpriteCache, type MakeCanvas } from './paint';
import { OFFICE } from './palette';
import { paintSiteSprite } from './render-buildings';
import { paintCampusGround, paintCampusOver } from './render-campus';
import { furnitureDrawables, type DeskState, type Drawable } from './render';
import { paintInterior } from './render-walls';
import type { Actor, World } from './simulation';
import { trayCount } from './tubes';

export interface LevelScene {
  level: Level;
  bg: HTMLCanvasElement;
  art: HTMLCanvasElement;
  furniture: Drawable[];
  /** Who sits at each desk this frame, refreshed before drawing. */
  owners: (Actor | undefined)[];
  lamps: readonly Point[];
  night: boolean;
}

export interface CampusScene {
  campus: Campus;
  bg: HTMLCanvasElement;
  over: HTMLCanvasElement;
  art: HTMLCanvasElement;
  sprites: Map<string, HTMLCanvasElement>;
  night: boolean;
}

const GLOW_PX = 24;
const BACKDROP = 64;

function backdropTile(make: MakeCanvas): HTMLCanvasElement {
  const tile = make(BACKDROP, BACKDROP);
  const ctx = tile.getContext('2d');
  if (!ctx || typeof ctx.fillRect !== 'function') return tile;
  for (let ty = 0; ty < BACKDROP / TILE; ty += 1) {
    for (let tx = 0; tx < BACKDROP / TILE; tx += 1) {
      ctx.fillStyle = (tx + ty) % 2 === 0 ? OFFICE.grass : OFFICE.grassAlt;
      ctx.fillRect(tx * TILE, ty * TILE, TILE, TILE);
    }
  }
  ctx.fillStyle = OFFICE.grassBlade;
  for (const [x, y] of [[5, 7], [21, 3], [40, 12], [55, 30], [12, 44], [33, 50], [47, 58], [27, 26], [60, 9], [3, 61]] as const) ctx.fillRect(x, y, 1, 2);
  ctx.fillStyle = OFFICE.petals[0];
  ctx.fillRect(17, 37, 2, 2);
  ctx.fillStyle = OFFICE.petals[1];
  ctx.fillRect(50, 20, 2, 2);
  return tile;
}

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

/**
 * Painted backgrounds and furniture per map, kept until the map or the hour changes; building
 * sprites are kept by their look, so one house changing repaints only that house.
 */
export class Scenes {
  readonly sprites: SpriteCache;
  readonly glow: HTMLCanvasElement | null;
  readonly backdrop: HTMLCanvasElement;
  private readonly levels = new Map<string, LevelScene>();
  private campusScene: CampusScene | null = null;

  constructor(private readonly make: MakeCanvas, private readonly world: World) {
    this.sprites = new SpriteCache(make);
    this.glow = lampGlow(make);
    this.backdrop = backdropTile(make);
  }

  level(level: Level, night: boolean): LevelScene {
    const cached = this.levels.get(level.id);
    if (cached?.level === level && cached.night === night) return cached;
    const width = level.cols * TILE;
    const height = level.rows * TILE;
    const bg = this.make(width, height);
    const ctx = bg.getContext('2d');
    if (ctx && typeof ctx.drawImage === 'function') paintInterior(ctx, level, night);
    const owners: (Actor | undefined)[] = [];
    const world = this.world;
    const deskState = (slot: number): DeskState => {
      const owner = owners[slot];
      if (!owner) return { monitor: 'off', typing: false, offline: false, lit: night };
      const desk = level.desks[slot];
      const atDesk = owner.level === level.id && Math.abs(owner.x - desk.seat.px.x) < 1 && Math.abs(owner.y - desk.seat.px.y) < 1;
      return {
        monitor: deskMonitor(owner.state, owner.pose === 'lie'),
        typing: atDesk && owner.pose === 'type',
        hands: this.sprites.palette(owner.id, false).s,
        offline: owner.state === 'down',
        mark: this.sprites.screenMark(owner.id),
        lit: night,
      };
    };
    const here = (test: (actor: Actor) => boolean) => {
      for (const actor of world.actors.values()) if (actor.level === level.id && test(actor)) return true;
      return false;
    };
    const furniture = furnitureDrawables(level, {
      desk: deskState,
      playing: (game, station) => here((actor) => actor.pose === 'play' && actor.rest.game === game && actor.rest.station === station),
      cooking: (x, y) => here((actor) => actor.pose === 'cook' && actor.rest.tile.x === x && actor.rest.tile.y === y + 1),
      fixtures: {
        tray: (id) => trayCount(world.line, id),
        rang: (id) => world.time - (world.line.dings.get(id) ?? -1000),
        occupied: (x, y) => here((actor) => actor.pose === 'lie' && actor.rest.rest === 'pod' && Math.floor(actor.rest.px.x / TILE) === x + 1 && Math.floor(actor.rest.px.y / TILE) === y),
        night,
      },
    });
    const lamps = level.desks.map((desk) => ({ x: desk.x * TILE + 4, y: desk.deskY * TILE - 4 }));
    const scene: LevelScene = { level, bg, art: this.make(width, height), furniture, owners, lamps, night };
    this.levels.set(level.id, scene);
    return scene;
  }

  campus(campus: Campus, night: boolean): CampusScene {
    const cached = this.campusScene;
    if (cached?.campus === campus && cached.night === night) return cached;
    const width = campus.cols * TILE;
    const height = campus.rows * TILE;
    const reuse = cached?.campus.cols === campus.cols && cached.campus.rows === campus.rows;
    const bg = reuse ? cached.bg : this.make(width, height);
    const over = reuse ? cached.over : this.make(width, height);
    for (const [canvas, paint] of [[bg, paintCampusGround], [over, paintCampusOver]] as const) {
      const ctx = canvas.getContext('2d');
      if (!ctx || typeof ctx.drawImage !== 'function') continue;
      ctx.clearRect(0, 0, width, height);
      paint(ctx, campus);
    }
    const scene: CampusScene = { campus, bg, over, art: reuse ? cached.art : this.make(width, height), sprites: cached?.sprites ?? new Map<string, HTMLCanvasElement>(), night };
    this.campusScene = scene;
    return scene;
  }

  /** The still sprite of a building, painted on first use and whenever its look changes. */
  site(scene: CampusScene, site: Campus['sites'][number]): HTMLCanvasElement {
    const key = `${site.id}|${site.kind}|${String(site.w)}x${String(site.h)}|${site.label}|${String(site.hue)}`;
    let sprite = scene.sprites.get(key);
    if (!sprite) {
      sprite = paintSiteSprite(this.make, site);
      scene.sprites.set(key, sprite);
    }
    return sprite;
  }

  forget(id: string): void {
    if (id !== CAMPUS) this.levels.delete(id);
  }
}
