import type { LiveState } from '../live/agent-state';
import { behaviourFor } from './behaviour';
import type { Camera, Inset, Size, Vec, ZoomLimits } from './camera';
import { clampZoom } from './camera';
import { TILE, type OfficeLayout, type Room, type RoomId, type Spot } from './layout';

export const ROOM_NAMES: Readonly<Record<RoomId, string>> = {
  programadores: 'Programadores',
  cocina: 'Cocina',
  patio: 'Patio de juegos',
  dormitorio: 'Dormitorio',
};

/** The room whose floor holds `point` (art px), or `null` for walls and doorways. */
export function roomAt(layout: Pick<OfficeLayout, 'rooms'>, point: Vec): Room | null {
  const x = Math.floor(point.x / TILE);
  const y = Math.floor(point.y / TILE);
  return layout.rooms.find((room) => x >= room.x && x < room.x + room.w && y >= room.y && y < room.y + room.h) ?? null;
}

/** The room a state sends people to, regardless of where they stand now. */
export function roomForState(state: LiveState, awake = false): RoomId {
  const rest = behaviourFor(state, awake).rest;
  return rest === 'bed' ? 'dormitorio' : rest === 'patio' ? 'patio' : 'programadores';
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

export interface Resting { id: string; desk: number; state: LiveState; awake?: boolean }

/**
 * Where everyone finally settles: workers at their own desk, sleepers in their own bed (bed `i`
 * is desk `i`'s, any free one otherwise), players at the games in order and then around them.
 */
export function assignRest(layout: OfficeLayout, people: readonly Resting[]): Map<string, Spot> {
  const spots = new Map<string, Spot>();
  const ordered = [...people].sort((a, b) => a.id.localeCompare(b.id));
  const sleepers = ordered.filter((person) => behaviourFor(person.state, person.awake).rest === 'bed');
  const takenBeds = new Set<number>();
  const homeless: Resting[] = [];
  for (const person of sleepers) {
    if (layout.beds[person.desk] && !takenBeds.has(person.desk)) {
      takenBeds.add(person.desk);
      spots.set(person.id, layout.beds[person.desk]);
    } else {
      homeless.push(person);
    }
  }
  for (const person of homeless) {
    const free = layout.beds.findIndex((_, index) => !takenBeds.has(index));
    if (free >= 0) {
      takenBeds.add(free);
      spots.set(person.id, layout.beds[free]);
    }
  }
  const outdoor = [...layout.play, ...layout.watch];
  let rank = 0;
  for (const person of ordered) {
    if (spots.has(person.id)) continue;
    const rest = behaviourFor(person.state, person.awake).rest;
    const desk = layout.desks[person.desk]?.seat ?? layout.desks[0].seat;
    if (rest === 'desk') {
      spots.set(person.id, desk);
      continue;
    }
    const spot = outdoor.at(rank);
    const tile = layout.wander.at(rank % Math.max(1, layout.wander.length));
    spots.set(person.id, spot ?? (tile ? { tile, px: { x: tile.x * TILE + TILE / 2, y: tile.y * TILE + TILE - 3 }, dir: 'down' } : desk));
    rank += 1;
  }
  return spots;
}
