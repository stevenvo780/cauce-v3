import type { LiveState } from '../live/agent-state';
import type { Vec } from './camera';
import { alongRoute, type Campus } from './campus';
import { CAMPUS, TILE } from './level';
import { STATE_PIXEL } from './hud-style';
import type { World } from './simulation';
import { teamTone } from './teams';

const scratch = { x: 0, y: 0 };
const SHARED_FILL: Readonly<Record<string, string>> = {
  cafe: '#b5543f', dorm: '#5a5fa8', lobby: '#7e8796', shop: '#8a929e', park: '#3f8a44',
};

/** Largest CSS size of the map inside `max`, keeping the campus proportions. */
export function minimapSize(campus: Pick<Campus, 'cols' | 'rows'>, max: { width: number; height: number }): { width: number; height: number } {
  const k = Math.min(max.width / (campus.cols * TILE), max.height / (campus.rows * TILE));
  return { width: Math.round(campus.cols * TILE * k), height: Math.round(campus.rows * TILE * k) };
}

/** Where a click on the map lands on the campus, given the map's own CSS box. */
export function minimapToWorld(campus: Pick<Campus, 'cols' | 'rows'>, box: { left: number; top: number; width: number; height: number }, client: Vec): Vec {
  return {
    x: ((client.x - box.left) / box.width) * campus.cols * TILE,
    y: ((client.y - box.top) / box.height) * campus.rows * TILE,
  };
}

export interface MinimapInput {
  campus: Campus;
  world: World;
  /** The map shown now; its house is outlined. */
  level: string;
  /** The part of the campus the camera shows, in art px, while the campus is shown. */
  view: { x: number; y: number; w: number; h: number } | null;
  alerts: ReadonlyMap<string, number>;
  states: ReadonlyMap<string, LiveState>;
}

export function drawMinimap(ctx: CanvasRenderingContext2D, input: MinimapInput, width: number, height: number, time: number): void {
  const { campus } = input;
  const k = width / (campus.cols * TILE);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = '#5aa957';
  ctx.fillRect(0, 0, width, height);
  for (const zone of campus.zones) {
    if (zone.kind !== 'street' && zone.kind !== 'plaza' && zone.kind !== 'road' && zone.kind !== 'sidewalk') continue;
    ctx.fillStyle = zone.kind === 'road' ? '#4a4e5a' : zone.kind === 'plaza' ? '#e2d9c6' : '#c9c2b4';
    ctx.fillRect(zone.x * TILE * k, zone.y * TILE * k, zone.w * TILE * k, zone.h * TILE * k);
  }
  const blink = Math.floor(time * 2) % 2 === 0;
  for (const site of campus.sites) {
    const x = Math.round(site.x * TILE * k);
    const y = Math.round(site.y * TILE * k);
    const w = Math.max(2, Math.round(site.w * TILE * k));
    const h = Math.max(2, Math.round(site.h * TILE * k));
    ctx.fillStyle = '#0e0f17';
    ctx.fillRect(x - 1, y - 1, w + 2, h + 2);
    ctx.fillStyle = site.kind === 'group' ? teamTone(site.hue, 50, 50) : SHARED_FILL[site.kind] ?? '#7e8796';
    if (site.phase?.kind === 'demolish') ctx.globalAlpha = 0.4;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = 1;
    if (site.id === input.level) {
      ctx.strokeStyle = '#ffcd75';
      ctx.lineWidth = 2;
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
    }
    if ((input.alerts.get(site.id) ?? 0) > 0 && blink) {
      ctx.fillStyle = '#b13e53';
      ctx.fillRect(x + w - 4, y - 2, 5, 5);
    }
  }
  ctx.fillStyle = '#ffcd75';
  ctx.fillRect(Math.round(campus.hub.x * k) - 2, Math.round(campus.hub.y * k) - 2, 4, 4);
  const dot = Math.max(2, Math.round(width / 70));
  for (const actor of input.world.actors.values()) {
    if (actor.level !== CAMPUS || actor.pose === 'hidden') continue;
    ctx.fillStyle = '#0e0f17';
    ctx.fillRect(Math.round(actor.x * k - dot / 2) - 1, Math.round((actor.y - 6) * k - dot / 2) - 1, dot + 2, dot + 2);
    ctx.fillStyle = STATE_PIXEL[input.states.get(actor.id) ?? actor.state];
    ctx.fillRect(Math.round(actor.x * k - dot / 2), Math.round((actor.y - 6) * k - dot / 2), dot, dot);
  }
  for (const capsule of input.world.line.capsules) {
    if (capsule.phase !== 'flying' || capsule.at < 0) continue;
    ctx.fillStyle = '#ffcd75';
    alongRoute(capsule.route, capsule.at, scratch);
    ctx.fillRect(Math.round(scratch.x * k) - 1, Math.round(scratch.y * k) - 1, 3, 3);
  }
  if (!input.view) return;
  const unit = Math.max(1, Math.round(width / 160));
  ctx.strokeStyle = '#f4f4f4';
  ctx.lineWidth = unit;
  const left = Math.max(0, input.view.x * k);
  const top = Math.max(0, input.view.y * k);
  const right = Math.min(width, (input.view.x + input.view.w) * k);
  const bottom = Math.min(height, (input.view.y + input.view.h) * k);
  ctx.strokeRect(left + unit / 2, top + unit / 2, Math.max(0, right - left - unit), Math.max(0, bottom - top - unit));
}
