import { OPERATOR_PALETTE, characterPalette, type CharPalette } from './palette';
import { CHAR_H, CHAR_W, LIE_H, LIE_W, characterFrame, lyingFrame, type Facing, type FrameName } from './sprites';

export type Ctx = CanvasRenderingContext2D;
export type MakeCanvas = (width: number, height: number) => HTMLCanvasElement;

/** Seed reserved for the operator; agent ids always carry a tenant prefix, so it cannot collide. */
export const OPERATOR_ID = '@vos';

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

export class SpriteCache {
  private readonly sprites = new Map<string, HTMLCanvasElement>();
  private readonly palettes = new Map<string, CharPalette>();
  private hues: ReadonlyMap<string, number> = new Map();

  constructor(private readonly make: MakeCanvas) {}

  /** Chosen hues per agent; a change only invalidates the sprites drawn with the old one. */
  setHues(hues: ReadonlyMap<string, number>): void {
    this.hues = hues;
  }

  private look(seed: string): string {
    return `${seed}|${String(this.hues.get(seed) ?? '')}`;
  }

  palette(seed: string, ghost: boolean): CharPalette {
    if (seed === OPERATOR_ID) return OPERATOR_PALETTE;
    const key = `${this.look(seed)}|${String(ghost)}`;
    let palette = this.palettes.get(key);
    if (!palette) {
      palette = characterPalette(seed, ghost, this.hues.get(seed));
      this.palettes.set(key, palette);
    }
    return palette;
  }

  private cached(key: string, width: number, height: number, rows: () => readonly string[], palette: CharPalette): HTMLCanvasElement {
    let sprite = this.sprites.get(key);
    if (!sprite) {
      sprite = this.make(width, height);
      const ctx = sprite.getContext('2d');
      if (ctx) paintRows(ctx, rows(), 0, 0, palette);
      this.sprites.set(key, sprite);
    }
    return sprite;
  }

  character(seed: string, ghost: boolean, frame: FrameName, facing: Facing, step: number): HTMLCanvasElement {
    const key = `${this.look(seed)}|${String(ghost)}|${frame}|${facing}|${String(step % 4)}`;
    return this.cached(key, CHAR_W, CHAR_H, () => characterFrame(frame, facing, step), this.palette(seed, ghost));
  }

  lying(seed: string): HTMLCanvasElement {
    return this.cached(`${this.look(seed)}|lie`, LIE_W, LIE_H, lyingFrame, this.palette(seed, false));
  }
}
