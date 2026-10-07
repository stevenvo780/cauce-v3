import type { Camera, Inset, Size, Vec, ZoomLimits } from './camera';
import { clampZoom } from './camera';
import { TILE, type OfficeLayout, type Room, type RoomId, type Spot } from './layout';

export const ROOM_NAMES: Readonly<Record<RoomId, string>> = {
  programadores: 'Programadores',
  cocina: 'Cocina',
  patio: 'Patio de juegos',
  jardin: 'Jardín',
  dormitorio: 'Dormitorio',
};

/** The room whose floor holds `point` (art px), or `null` for walls and doorways. */
export function roomAt(layout: Pick<OfficeLayout, 'rooms'>, point: Vec): Room | null {
  const x = Math.floor(point.x / TILE);
  const y = Math.floor(point.y / TILE);
  return layout.rooms.find((room) => x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) ?? null;
}

/**
 * Camera on a room, its wall included, as large as a whole zoom step allows; always at least one
 * step closer than the whole building, so flying somewhere visibly goes there.
 */
export function roomCamera(room: Room, view: Size, limits: ZoomLimits, inset: Inset): Camera {
  const width = (room.w + 1) * TILE;
  const height = (room.h + 2) * TILE;
  const fit = Math.floor(Math.min((view.width - inset.right) / width, (view.height - inset.bottom) / height));
  const zoom = clampZoom(Math.max(limits.min + 1, fit), limits);
  return {
    zoom,
    x: (room.x + room.w / 2) * TILE + inset.right / (2 * zoom),
    y: (room.y + room.h / 2 - 0.5) * TILE + inset.bottom / (2 * zoom),
  };
}

export type RoomCounts = Readonly<Partial<Record<RoomId, number>>>;

/** How many people are in, or on their way to, each room. */
export function roomCounts(layout: Pick<OfficeLayout, 'rooms'>, actors: Iterable<{ rest: Spot }>): RoomCounts {
  const counts: Partial<Record<RoomId, number>> = {};
  for (const actor of actors) {
    const id = roomAt(layout, actor.rest.px)?.id;
    if (id) counts[id] = (counts[id] ?? 0) + 1;
  }
  return counts;
}

export function sameCounts(a: RoomCounts, b: RoomCounts): boolean {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)] as RoomId[]);
  return [...keys].every((key) => a[key] === b[key]);
}
