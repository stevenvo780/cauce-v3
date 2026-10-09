import type { MakeCanvas } from './paint';
import { paintText, textWidth, TEXT_HEIGHT } from './pixel-font';

export type LabelTone = 'normal' | 'selected' | 'dim' | 'operator' | 'alert';

const FILL: Readonly<Record<LabelTone, string>> = {
  normal: '#1a1c2c',
  selected: '#6c63ff',
  dim: 'rgba(26, 28, 44, 0.55)',
  operator: '#15803d',
  alert: '#b13e53',
};
const LIMIT = 400;

export interface LabelSprite { canvas: HTMLCanvasElement; width: number; height: number }

/**
 * Name tags set in the pixel font straight in device px, so they stay crisp at any zoom. Each
 * text, tone and size is painted once; the cache drops everything when it grows past its limit.
 */
export class PixelLabels {
  private readonly cache = new Map<string, LabelSprite>();

  constructor(private readonly make: MakeCanvas) {}

  get(text: string, tone: LabelTone, unit: number, swatch: string | null = null): LabelSprite {
    const key = `${tone}|${String(unit)}|${swatch ?? ''}|${text}`;
    const cached = this.cache.get(key);
    if (cached) return cached;
    if (this.cache.size > LIMIT) this.cache.clear();
    const pad = unit * 2;
    const box = swatch ? unit * 5 : 0;
    const width = textWidth(text, unit) + pad * 2 + (swatch ? box + unit * 2 : 0) + unit * 2;
    const height = TEXT_HEIGHT(unit) + pad * 2 + unit * 2;
    const canvas = this.make(Math.max(1, width), Math.max(1, height));
    const ctx = canvas.getContext('2d');
    if (ctx && typeof ctx.fillRect === 'function') {
      ctx.fillStyle = '#0e0f17';
      ctx.fillRect(unit, 0, width - unit * 2, height);
      ctx.fillRect(0, unit, width, height - unit * 2);
      ctx.fillStyle = FILL[tone];
      ctx.fillRect(unit, unit, width - unit * 2, height - unit * 2);
      let x = unit + pad;
      if (swatch) {
        ctx.fillStyle = swatch;
        ctx.fillRect(x, unit + pad, box, TEXT_HEIGHT(unit));
        x += box + unit * 2;
      }
      paintText(ctx, text, x, unit + pad, unit, tone === 'dim' ? 'rgba(255, 255, 255, 0.6)' : '#ffffff');
    }
    const sprite = { canvas, width, height };
    this.cache.set(key, sprite);
    return sprite;
  }
}
