import { clampZoom, stepZoom, type Vec, type ZoomLimits } from './camera';

/** How far, in CSS px, a press may wander and still count as a tap rather than a drag. */
export const TAP_SLOP: Readonly<Record<string, number>> = { mouse: 4, pen: 6, touch: 10 };
const TAP_MS = 650;
export const DOUBLE_MS = 340;
const DOUBLE_SLOP = 28;

export function slopFor(pointerType: string): number {
  return TAP_SLOP[pointerType] ?? TAP_SLOP.touch;
}

export function movedPast(start: Vec, now: Vec, pointerType: string): boolean {
  return Math.hypot(now.x - start.x, now.y - start.y) > slopFor(pointerType);
}

export function isTap(start: Vec, end: Vec, pointerType: string, ms: number): boolean {
  return ms <= TAP_MS && !movedPast(start, end, pointerType);
}

export interface TapMark { at: number; x: number; y: number }

export function isDoubleTap(previous: TapMark | null, now: TapMark): boolean {
  return previous !== null && now.at - previous.at <= DOUBLE_MS
    && Math.hypot(now.x - previous.x, now.y - previous.y) <= DOUBLE_SLOP;
}

export interface Pinch { distance: number; mid: Vec }

export function pinchOf(a: Vec, b: Vec): Pinch {
  return { distance: Math.max(1, Math.hypot(b.x - a.x, b.y - a.y)), mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 } };
}

/** Continuous while the fingers move; the caller settles it on a whole step when they lift. */
export function pinchZoom(startZoom: number, start: Pinch, now: Pinch, limits: ZoomLimits): number {
  return clampZoom(startZoom * (now.distance / start.distance), limits);
}

export interface WheelInput { deltaY: number; deltaMode: number; ctrlKey: boolean }

/**
 * A mouse notch is one whole zoom step; a trackpad pinch (ctrl + small deltas) zooms smoothly and is
 * settled later.
 */
export function wheelZoom(zoom: number, input: WheelInput, limits: ZoomLimits): number {
  const pixels = input.deltaMode === 1 ? input.deltaY * 16 : input.deltaMode === 2 ? input.deltaY * 400 : input.deltaY;
  if (pixels === 0) return zoom;
  if (!input.ctrlKey && Math.abs(pixels) >= 40) return stepZoom(zoom, pixels < 0 ? 1 : -1, limits);
  return clampZoom(zoom * Math.exp(-pixels * 0.012), limits);
}

/** Whether the canvas is cut off by the edges of the scrolling page. */
export interface Clipping { above: boolean; below: boolean }

/**
 * At a zoom limit, or while the canvas is cut off in the direction of the scroll, the wheel belongs
 * to the page so the canvas never traps it.
 */
export function wheelPassesThrough(zoom: number, input: WheelInput, limits: ZoomLimits, clipping: Clipping = { above: false, below: false }): boolean {
  if (input.ctrlKey) return false;
  if (input.deltaY < 0) return clipping.above || zoom >= limits.max - 1e-6;
  if (input.deltaY > 0) return clipping.below || zoom <= limits.min + 1e-6;
  return false;
}
