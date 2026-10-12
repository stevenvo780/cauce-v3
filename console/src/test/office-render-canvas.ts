import { createHash } from 'node:crypto';
import { createCanvas, Path2D as NativePath2D } from '@napi-rs/canvas';
import { vi } from 'vitest';
import type { Inset, Size } from '../features/office/camera';
import { OfficeEngine, type EngineEvents } from '../features/office/engine';
import type { MakeCanvas } from '../features/office/paint';
import type { WorldMap } from '../features/office/world-map';

export { NativePath2D };

export const makeRenderCanvas: MakeCanvas = (width, height) => createCanvas(width, height) as unknown as HTMLCanvasElement;

export function canvasContext(canvas: HTMLCanvasElement): CanvasRenderingContext2D {
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('Missing native Canvas2D context');
  return ctx;
}

export interface ImageRegion { x: number; y: number; width: number; height: number }

export function pixels(canvas: HTMLCanvasElement, region: ImageRegion = { x: 0, y: 0, width: canvas.width, height: canvas.height }): Uint8ClampedArray {
  return canvasContext(canvas).getImageData(region.x, region.y, region.width, region.height).data;
}

export function pixel(canvas: HTMLCanvasElement, x: number, y: number): number[] {
  return Array.from(pixels(canvas, { x, y, width: 1, height: 1 }));
}

export function rgba(color: string): number[] {
  const canvas = makeRenderCanvas(1, 1);
  const ctx = canvasContext(canvas);
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, 1, 1);
  return pixel(canvas, 0, 0);
}

export function countColor(canvas: HTMLCanvasElement, color: string, region?: ImageRegion): number {
  const data = pixels(canvas, region);
  const expected = rgba(color);
  let count = 0;
  for (let index = 0; index < data.length; index += 4) {
    if (expected.every((value, channel) => data[index + channel] === value)) count += 1;
  }
  return count;
}

export function imageDigest(canvas: HTMLCanvasElement, region?: ImageRegion): string {
  return createHash('sha256').update(pixels(canvas, region)).digest('hex');
}

export function createRenderHarness({ map, reducedMotion = true, view = { width: 960, height: 640 }, dpr = 1, inset = { top: 0, bottom: 0, right: 0 } }: {
  map: WorldMap; reducedMotion?: boolean; view?: Size; dpr?: number; inset?: Inset;
}) {
  const events: EngineEvents = { level: vi.fn(), nearby: vi.fn(), edges: vi.fn(), occupancy: vi.fn(), tube: vi.fn() };
  const game = new OfficeEngine(map, reducedMotion, makeRenderCanvas, events, new Set());
  game.resize(view, dpr, inset);
  const canvas = makeRenderCanvas(view.width, view.height);
  const ctx = canvasContext(canvas);
  const render = (time = 0) => { game.draw(ctx, time); return canvas; };
  return { game, events, canvas, ctx, render };
}
