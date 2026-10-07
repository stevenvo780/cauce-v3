/** Camera over the art-pixel world. `x`/`y` is the world point at the viewport centre; `zoom` is device px per art px. */
export interface Camera { x: number; y: number; zoom: number }
export interface Size { width: number; height: number }
export interface Vec { x: number; y: number }
export interface ZoomLimits { min: number; max: number }
/** Device px of the viewport covered by a panel on the right or at the bottom. */
export interface Inset { right: number; bottom: number }
export const NO_INSET: Inset = { right: 0, bottom: 0 };

/** Room the camera may show past each edge, in art px, so the walls never feel glued to the frame. */
export const EDGE_SLACK = 12;

export function fitZoom(view: Size, world: Size): number {
  return Math.max(1, Math.floor(Math.min(view.width / world.width, view.height / world.height)));
}

export function zoomLimits(view: Size, world: Size, dpr: number): ZoomLimits {
  const fit = fitZoom(view, world);
  return { min: fit, max: Math.max(fit * 2, Math.round(8 * dpr)) };
}

export const clampZoom = (zoom: number, limits: ZoomLimits) => Math.min(limits.max, Math.max(limits.min, zoom));

function clampAxis(center: number, span: number, extent: number, covered: number): number {
  const visible = Math.max(1, span - covered);
  const half = visible / 2;
  const mid = center - covered / 2;
  const clamped = extent <= visible ? extent / 2 : Math.min(extent - half + EDGE_SLACK, Math.max(half - EDGE_SLACK, mid));
  return clamped + covered / 2;
}

/**
 * Keeps the room in the uncovered part of the view: centred when it fits, otherwise no further
 * than `EDGE_SLACK` past an edge.
 */
export function clampCamera(cam: Camera, view: Size, world: Size, limits: ZoomLimits, inset: Inset = NO_INSET): Camera {
  const zoom = clampZoom(cam.zoom, limits);
  return {
    zoom,
    x: clampAxis(cam.x, view.width / zoom, world.width, inset.right / zoom),
    y: clampAxis(cam.y, view.height / zoom, world.height, inset.bottom / zoom),
  };
}

/** Device-px position of the world origin, rounded so art pixels land on whole device pixels. */
export function originOf(cam: Camera, view: Size): Vec {
  return { x: Math.round(view.width / 2 - cam.x * cam.zoom), y: Math.round(view.height / 2 - cam.y * cam.zoom) };
}

export function worldToScreen(cam: Camera, view: Size, point: Vec): Vec {
  const origin = originOf(cam, view);
  return { x: origin.x + point.x * cam.zoom, y: origin.y + point.y * cam.zoom };
}

export function screenToWorld(cam: Camera, view: Size, point: Vec): Vec {
  const origin = originOf(cam, view);
  return { x: (point.x - origin.x) / cam.zoom, y: (point.y - origin.y) / cam.zoom };
}

/** Changes zoom while the world point under `screen` stays under it. */
export function zoomAt(cam: Camera, view: Size, screen: Vec, zoom: number): Camera {
  const anchor = {
    x: cam.x + (screen.x - view.width / 2) / cam.zoom,
    y: cam.y + (screen.y - view.height / 2) / cam.zoom,
  };
  return { zoom, x: anchor.x - (screen.x - view.width / 2) / zoom, y: anchor.y - (screen.y - view.height / 2) / zoom };
}

export function panBy(cam: Camera, dx: number, dy: number): Camera {
  return { ...cam, x: cam.x - dx / cam.zoom, y: cam.y - dy / cam.zoom };
}

/** One whole zoom step in or out from wherever the zoom is now, so steps always land on crisp scales. */
export function stepZoom(zoom: number, direction: 1 | -1, limits: ZoomLimits): number {
  const next = direction > 0 ? Math.floor(zoom + 1e-6) + 1 : Math.ceil(zoom - 1e-6) - 1;
  return clampZoom(next, limits);
}

/** A double tap zooms in noticeably; at the top it goes back out to the whole room. */
export function doubleTapZoom(zoom: number, limits: ZoomLimits): number {
  if (zoom >= limits.max - 1e-6) return limits.min;
  return clampZoom(Math.max(Math.floor(zoom) + 1, Math.round(zoom * 1.75)), limits);
}

/** Centres `point` in the part of the viewport the inset leaves uncovered. */
export function centerOn(cam: Camera, point: Vec, inset: Inset = NO_INSET): Camera {
  return { ...cam, x: point.x + inset.right / (2 * cam.zoom), y: point.y + inset.bottom / (2 * cam.zoom) };
}

/**
 * Brings `box` (world px) into the uncovered part of the view with `margin` device px to spare,
 * moving each axis only when it is not already there.
 */
export function reveal(cam: Camera, view: Size, box: { x: number; y: number; w: number; h: number }, inset: Inset, margin: number): Camera {
  const axis = (center: number, start: number, size: number, span: number, covered: number) => {
    const left = center - span / (2 * cam.zoom);
    const lo = left + margin / cam.zoom;
    const hi = left + (span - covered - margin) / cam.zoom;
    if (hi - lo < size) return start + size / 2 - (span - covered) / (2 * cam.zoom) + span / (2 * cam.zoom);
    if (start < lo) return center - (lo - start);
    if (start + size > hi) return center + (start + size - hi);
    return center;
  };
  return {
    ...cam,
    x: axis(cam.x, box.x, box.w, view.width, inset.right),
    y: axis(cam.y, box.y, box.h, view.height, inset.bottom),
  };
}

/** Moves the camera just enough that `point` sits inside the central `deadzone` fraction of the view. */
export function follow(cam: Camera, view: Size, point: Vec, deadzone = 0.3): Camera {
  const halfW = (view.width / cam.zoom / 2) * deadzone;
  const halfH = (view.height / cam.zoom / 2) * deadzone;
  const dx = point.x - cam.x;
  const dy = point.y - cam.y;
  return {
    ...cam,
    x: Math.abs(dx) > halfW ? cam.x + dx - Math.sign(dx) * halfW : cam.x,
    y: Math.abs(dy) > halfH ? cam.y + dy - Math.sign(dy) * halfH : cam.y,
  };
}

/** Exponential approach to `target`; snaps when close or when motion is reduced. */
export function ease(current: Camera, target: Camera, dt: number, reduced: boolean, rate = 10): Camera {
  const k = reduced ? 1 : 1 - Math.exp(-rate * Math.max(0, dt));
  const next = {
    x: current.x + (target.x - current.x) * k,
    y: current.y + (target.y - current.y) * k,
    zoom: current.zoom + (target.zoom - current.zoom) * k,
  };
  const close = Math.abs(next.x - target.x) < 0.05 && Math.abs(next.y - target.y) < 0.05 && Math.abs(next.zoom - target.zoom) < 0.01;
  return close ? { ...target } : next;
}

export const sameCamera = (a: Camera, b: Camera) => a.x === b.x && a.y === b.y && a.zoom === b.zoom;
