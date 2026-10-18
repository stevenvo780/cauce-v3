import type { OfficePart, OfficeRoom } from '../../api/client/company-client';
import type { TopologySnapshot } from '../../api/types';

export const officeRoomKey = (tenant: string, room: string) => JSON.stringify([tenant, room]);
export interface OfficeRoomInfo { tenant: string; id: string; label: string; agents: string[] }
export function officeRooms(topology?: TopologySnapshot, available?: readonly { tenant_id: string; room_id: string }[]): OfficeRoomInfo[] {
  const savable = available && new Set(available.map(room => officeRoomKey(room.tenant_id, room.room_id)));
  return (topology?.tenants ?? []).flatMap(tenant => tenant.id ? (tenant.rooms ?? []).flatMap(room => room.id ? [{
    tenant: tenant.id ?? '', id: room.id, label: (room.label?.trim() ?? '') || room.id,
    agents: (room.members ?? []).filter(member => member.alias && member.enabled !== false)
      .map(member => `${tenant.id ?? ''}/${member.alias ?? ''}`),
  }] : []) : []).filter(room => !savable || savable.has(officeRoomKey(room.tenant, room.id)));
}
export function reconcileOfficeLayout(rooms: readonly OfficeRoomInfo[], saved: readonly OfficeRoom[]): OfficeRoom[] {
  const layouts = new Map(saved.map(room => [officeRoomKey(room.tenant_id, room.room_id), room]));
  return rooms.map((room, index) => layouts.get(officeRoomKey(room.tenant, room.id)) ?? {
    tenant_id: room.tenant, room_id: room.id, x: index % 3 * 330, y: Math.floor(index / 3) * 290,
    width: 300, height: 260, parts: [],
  });
}
/** Reconciled rooms plus saved rooms the known list does not name. `introduced` keeps only those keys. */
export function reconcileOfficeLayoutIncludingSaved(rooms: readonly OfficeRoomInfo[], saved: readonly OfficeRoom[], introduced?: readonly string[]): OfficeRoom[] {
  const known = new Set(rooms.map(room => officeRoomKey(room.tenant, room.id)));
  const extras = introduced && new Set(introduced);
  return [...reconcileOfficeLayout(rooms, saved), ...saved.filter(room => {
    const key = officeRoomKey(room.tenant_id, room.room_id);
    return !known.has(key) && (!extras || extras.has(key));
  })];
}

/** Rooms of a draft rebuilt on a newer saved plan, and the rooms where the draft overrides a change of that plan. */
export interface OfficeDraftRebase { rooms: OfficeRoom[]; overridden: string[] }

/**
 * Reapplies only what the draft changed against the plan it started from (`base`) onto the newer saved plan
 * (`theirs`): every value the draft left alone follows the newer plan. Where both changed the same value the draft
 * wins and the room is reported in `overridden`, so the person sees it before saving.
 */
export function rebaseOfficeDraft(base: readonly OfficeRoom[], mine: readonly OfficeRoom[], theirs: readonly OfficeRoom[]): OfficeDraftRebase {
  const before = new Map(base.map(room => [officeRoomKey(room.tenant_id, room.room_id), room]));
  const draft = new Map(mine.map(room => [officeRoomKey(room.tenant_id, room.room_id), room]));
  const overridden: string[] = [];
  const rooms = theirs.map(current => {
    const key = officeRoomKey(current.tenant_id, current.room_id);
    const original = before.get(key); const edited = draft.get(key);
    if (!original || !edited) return current;
    const conflict = { found: false };
    const clash = () => { conflict.found = true; };
    const room = { ...current, ...geometry(original, edited, current, clash), parts: rebaseParts(original.parts, edited.parts, current.parts, clash) };
    if (conflict.found) overridden.push(key);
    return room;
  });
  return { rooms, overridden };
}
function pick<T>(base: T, mine: T, theirs: T, clash: () => void): T {
  if (mine === base) return theirs;
  if (theirs !== base && theirs !== mine) clash();
  return mine;
}
type Geometry = Pick<OfficeRoom, 'x' | 'y' | 'width' | 'height'>;
function geometry(base: Geometry, mine: Geometry, theirs: Geometry, clash: () => void): Geometry {
  return { x: pick(base.x, mine.x, theirs.x, clash), y: pick(base.y, mine.y, theirs.y, clash),
    width: pick(base.width, mine.width, theirs.width, clash), height: pick(base.height, mine.height, theirs.height, clash) };
}
function samePart(left: OfficePart, right: OfficePart): boolean {
  return left.label === right.label && left.x === right.x && left.y === right.y && left.width === right.width && left.height === right.height;
}
function rebaseParts(base: readonly OfficePart[], mine: readonly OfficePart[], theirs: readonly OfficePart[], clash: () => void): OfficePart[] {
  const before = new Map(base.map(part => [part.id, part]));
  const draft = new Map(mine.map(part => [part.id, part]));
  const newer = new Set(theirs.map(part => part.id));
  const parts: OfficePart[] = [];
  for (const current of theirs) {
    const original = before.get(current.id); const edited = draft.get(current.id);
    // A part the newer plan added stays; a part the draft removed stays removed, even if the newer plan changed it.
    if (!original) { parts.push(current); continue; }
    if (!edited) { if (!samePart(original, current)) clash(); continue; }
    parts.push({ ...current, label: pick(original.label, edited.label, current.label, clash), ...geometry(original, edited, current, clash) });
  }
  for (const edited of mine) {
    if (newer.has(edited.id)) continue;
    const original = before.get(edited.id);
    // A part the draft added is appended; one the newer plan removed comes back only if the draft changed it.
    if (!original) parts.push(edited);
    else if (!samePart(original, edited)) { clash(); parts.push(edited); }
  }
  return parts;
}

export function officeLayoutProblem(rooms: readonly OfficeRoom[]): string | undefined {
  for (const room of rooms) {
    for (const item of [room, ...room.parts]) {
      if (![item.x, item.y, item.width, item.height].every(Number.isFinite)
        || item.width <= 0 || item.height <= 0 || Math.abs(item.x) > 100_000 || Math.abs(item.y) > 100_000
        || item.width > 100_000 || item.height > 100_000) return 'Las posiciones deben ser números finitos y los tamaños mayores que cero.';
    }
    if (room.parts.some(part => !part.label.trim() || part.label.length > 120)) return 'Cada parte necesita un nombre de 1 a 120 caracteres.';
  }
  return undefined;
}
