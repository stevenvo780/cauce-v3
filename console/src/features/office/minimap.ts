import type { LiveState } from '../live/agent-state';
import type { Vec } from './camera';
import { TILE, type OfficeLayout, type RoomId } from './layout';
import { OFFICE } from './palette';
import { teamTone } from './teams';

const ROOM_FILL: Readonly<Record<RoomId, string>> = {
  programadores: OFFICE.carpet,
  cocina: OFFICE.tile,
  patio: OFFICE.playFloor,
  jardin: OFFICE.grass,
  dormitorio: OFFICE.rest,
};

const DOT: Readonly<Record<LiveState, string>> = {
  thinking: '#3b6fd1',
  receiving: '#d99a1e',
  delegating: '#1f9a8a',
  blocked: '#e5484d',
  settled: '#2f8f5b',
  idle: '#7a5bc4',
  down: '#8c929c',
};

/** Largest CSS size of the map inside `max`, keeping the building's proportions. */
export function minimapSize(layout: Pick<OfficeLayout, 'cols' | 'rows'>, max: { width: number; height: number }): { width: number; height: number } {
  const k = Math.min(max.width / (layout.cols * TILE), max.height / (layout.rows * TILE));
  return { width: Math.round(layout.cols * TILE * k), height: Math.round(layout.rows * TILE * k) };
}

/** Where a click on the map lands in the art, given the map's own CSS box. */
export function minimapToWorld(layout: Pick<OfficeLayout, 'cols' | 'rows'>, box: { left: number; top: number; width: number; height: number }, client: Vec): Vec {
  return {
    x: ((client.x - box.left) / box.width) * layout.cols * TILE,
    y: ((client.y - box.top) / box.height) * layout.rows * TILE,
  };
}

export interface MinimapInput {
  layout: OfficeLayout;
  people: readonly { x: number; y: number; state: LiveState }[];
  avatar: Vec | null;
  /** The part of the art the camera shows, in art px. */
  view: { x: number; y: number; w: number; h: number };
}

export function drawMinimap(ctx: CanvasRenderingContext2D, input: MinimapInput, width: number, height: number): void {
  const { layout } = input;
  const k = width / (layout.cols * TILE);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, width, height);
  ctx.fillStyle = OFFICE.wallTop;
  ctx.fillRect(0, 0, width, height);
  for (const room of layout.rooms) {
    ctx.fillStyle = ROOM_FILL[room.id];
    ctx.fillRect(room.x * TILE * k, room.y * TILE * k, room.w * TILE * k, room.h * TILE * k);
  }
  for (const team of layout.teams) {
    ctx.fillStyle = teamTone(team.hue, 50, 58);
    ctx.fillRect(team.rug.x * TILE * k, team.sign.y * TILE * k, team.rug.w * TILE * k, (team.rug.h + 1) * TILE * k);
  }
  const dot = Math.max(2, Math.round(width / 60));
  for (const person of input.people) {
    ctx.fillStyle = OFFICE.outline;
    ctx.fillRect(Math.round(person.x * k - dot / 2) - 1, Math.round((person.y - 6) * k - dot / 2) - 1, dot + 2, dot + 2);
    ctx.fillStyle = DOT[person.state];
    ctx.fillRect(Math.round(person.x * k - dot / 2), Math.round((person.y - 6) * k - dot / 2), dot, dot);
  }
  if (input.avatar) {
    const size = dot + 2;
    const x = Math.round(input.avatar.x * k - size / 2);
    const y = Math.round((input.avatar.y - 6) * k - size / 2);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(x - 1, y - 1, size + 2, size + 2);
    ctx.fillStyle = OFFICE.operatorMark;
    ctx.fillRect(x, y, size, size);
  }
  const unit = Math.max(1, Math.round(width / 160));
  ctx.strokeStyle = OFFICE.outline;
  ctx.lineWidth = unit;
  const left = Math.max(0, input.view.x * k);
  const top = Math.max(0, input.view.y * k);
  const right = Math.min(width, (input.view.x + input.view.w) * k);
  const bottom = Math.min(height, (input.view.y + input.view.h) * k);
  ctx.strokeRect(left + unit / 2, top + unit / 2, Math.max(0, right - left - unit), Math.max(0, bottom - top - unit));
}
