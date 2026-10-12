import type { OfficeRoom } from '../../api/client/company-client';
import type { TopologySnapshot } from '../../api/types';

export const officeRoomKey = (tenant: string, room: string) => JSON.stringify([tenant, room]);
export interface OfficeRoomInfo { tenant: string; id: string; label: string; agents: string[] }
export function officeRooms(topology?: TopologySnapshot, available?: readonly { tenant_id: string; room_id: string }[]): OfficeRoomInfo[] {
  const savable = available && new Set(available.map(room => officeRoomKey(room.tenant_id, room.room_id)));
  return (topology?.tenants ?? []).flatMap(tenant => tenant.id ? (tenant.rooms ?? []).flatMap(room => room.id ? [{
    tenant: tenant.id ?? '', id: room.id, label: (room.label?.trim() ?? '') || room.id,
    agents: (room.members ?? []).filter(member => member.alias && member.enabled !== false && member.agent_enabled !== false)
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
