import { pixelIconPath, requestPixelIcon } from '../../components/pixel-icons/pixel-icon-cache';
import { accessoryRows } from './accessories';
import { orbHues } from '../../orb-hues';
import { accessoryOf, type FleetLook } from './looks';
import { OPERATOR_PALETTE, accessoryPalette, characterPalette, hslHex, OFFICE, type CharPalette } from './palette';
import { CHAR_H, CHAR_W, LIE_H, LIE_W, characterFrame, lyingFrame, type Facing, type FrameName } from './sprites';

export type Ctx = CanvasRenderingContext2D;
export type MakeCanvas = (width: number, height: number) => HTMLCanvasElement;

/** Seed reserved for the operator; agent ids always carry a tenant prefix, so it cannot collide. */
export const OPERATOR_ID = '@vos';

/** Pixelarticons are drawn on a 24-unit grid. */
const ICON_GRID = 24;
/** Badge over a character away from its desk: a light tile of the agent's hue with the icon inside. */
const BADGE = 8;
/** Glyph on a desk monitor: fits the screen beside the code lines. */
const SCREEN_MARK = 6;
/** Accessories that take a frame's head and body; sleeping and napping frames keep their own look. */
const DRESSED: ReadonlySet<FrameName> = new Set(['stand', 'walk', 'sit', 'stretch']);

export function rect(ctx: Ctx, x: number, y: number, w: number, h: number, color: string): void {
  ctx.fillStyle = color;
  ctx.fillRect(x, y, w, h);
}

/** Paints a pixel map, merging horizontal runs of one key into a single rectangle. */
export function paintRows(ctx: Ctx, rows: readonly string[], x: number, y: number, colors: Readonly<Record<string, string>>): void {
  rows.forEach((row, dy) => {
    let start = 0;
    for (let dx = 1; dx <= row.length; dx += 1) {
      if (dx < row.length && row[dx] === row[start]) continue;
      const key = row[start];
      const color = key === '.' ? undefined : colors[key];
      if (color) rect(ctx, x + start, y + dy, dx - start, 1, color);
      start = dx;
    }
  });
}

/**
 * Sprites are cached by look, so a changed appearance repaints only that agent. Icons whose
 * chunk has not arrived yet are simply absent; the office redraws when the chunk lands.
 */
export class SpriteCache {
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  private readonly palettes = new Map<string, CharPalette>();
  private readonly glyphs = new Map<string, Path2D>();
  private looks: ReadonlyMap<string, FleetLook> = new Map();

  constructor(private readonly make: MakeCanvas) {}

  /** The chosen look per agent; a change only invalidates the sprites drawn with the old one. */
  setLooks(looks: ReadonlyMap<string, FleetLook>): void {
    this.looks = looks;
    for (const look of looks.values()) if (look.icon) requestPixelIcon(look.icon);
  }

  private lookKey(seed: string): string {
    const look = this.looks.get(seed);
    return `${seed}|${String(look?.hue ?? '')}|${look?.style ?? ''}`;
  }

  palette(seed: string, ghost: boolean): CharPalette {
    if (seed === OPERATOR_ID) return OPERATOR_PALETTE;
    const key = `${this.lookKey(seed)}|${String(ghost)}`;
    let palette = this.palettes.get(key);
    if (!palette) {
      palette = characterPalette(seed, ghost, this.looks.get(seed)?.hue);
      this.palettes.set(key, palette);
    }
    return palette;
  }

  private cached(key: string, width: number, height: number, paint: (ctx: Ctx) => void): HTMLCanvasElement {
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = this.make(width, height);
      const ctx = sprite.getContext('2d');
      if (ctx) paint(ctx);
      this.sprites.set(key, sprite);
    }
    return sprite;
  }

  character(seed: string, ghost: boolean, frame: FrameName, facing: Facing, step: number): HTMLCanvasElement {
    const key = `${this.lookKey(seed)}|${String(ghost)}|${frame}|${facing}|${String(step % 4)}`;
    const style = this.looks.get(seed)?.style ?? 'orb';
    const accessory = !ghost && DRESSED.has(frame) ? accessoryOf(style) : null;
    return this.cached(key, CHAR_W, CHAR_H, (ctx) => {
      paintRows(ctx, characterFrame(frame, facing, step), 0, 0, this.palette(seed, ghost));
      if (accessory) paintRows(ctx, accessoryRows(accessory, facing), 0, 0, accessoryPalette(seed, this.looks.get(seed)?.hue));
    });
  }

  lying(seed: string): HTMLCanvasElement {
    return this.cached(`${this.lookKey(seed)}|lie`, LIE_W, LIE_H, (ctx) => {
      paintRows(ctx, lyingFrame(), 0, 0, this.palette(seed, false));
    });
  }

  /** The pixel icon of an agent drawn in `color`, or `null` while the icon is unknown or still loading. */
  icon(seed: string, color: string, size: number): HTMLCanvasElement | null {
    const name = this.looks.get(seed)?.icon;
    const glyph = name ? this.glyph(name) : null;
    if (!name || !glyph) return null;
    return this.cached(`icon|${name}|${color}|${String(size)}`, size, size, (ctx) => {
      ctx.setTransform(size / ICON_GRID, 0, 0, size / ICON_GRID, 0, 0);
      ctx.fillStyle = color;
      ctx.fill(glyph);
    });
  }

  /** The agent's icon on a light tile in its hue, for a character standing away from its desk. */
  badge(seed: string): HTMLCanvasElement | null {
    const hue = this.looks.get(seed)?.hue;
    const first = orbHues(seed, hue)[0];
    const mark = this.icon(seed, hslHex(first, 70, 28), BADGE - 2);
    if (!mark) return null;
    return this.cached(`badge|${this.lookKey(seed)}|${String(this.looks.get(seed)?.icon)}`, BADGE, BADGE, (ctx) => {
      rect(ctx, 0, 0, BADGE, BADGE, OFFICE.outline);
      rect(ctx, 1, 1, BADGE - 2, BADGE - 2, hslHex(first, 75, 90));
      ctx.drawImage(mark, 1, 1);
    });
  }

  /** The agent's icon for a desk screen, in a bright shade of its hue. */
  screenMark(seed: string): HTMLCanvasElement | null {
    return this.icon(seed, hslHex(orbHues(seed, this.looks.get(seed)?.hue)[0], 80, 74), SCREEN_MARK);
  }

  private glyph(name: string): Path2D | null {
    const cached = this.glyphs.get(name);
    if (cached) return cached;
    const path = pixelIconPath(name);
    if (!path || typeof Path2D === 'undefined') return null;
    const glyph = new Path2D(path);
    this.glyphs.set(name, glyph);
    return glyph;
  }
}
