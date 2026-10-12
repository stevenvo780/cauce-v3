import { expect, it } from 'vitest';
import { officeLayoutProblem, officeRooms, reconcileOfficeLayout } from './office-layout';

it('no confunde salas homónimas y elimina del plano los recursos retirados', () => {
  const rooms = officeRooms({ tenants: [{ id: 'One', rooms: [{ id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }] }] },
    { id: 'Two', rooms: [{ id: 'general', label: 'General', members: [{ alias: 'worker', enabled: true }, { alias: 'off', enabled: false }] }] }] });
  const layout = reconcileOfficeLayout(rooms, [{ tenant_id: 'Two', room_id: 'general', x: 650, y: 90, width: 240, height: 300,
    parts: [{ id: 'desk', label: 'Escritorio', x: 20, y: 30, width: 40, height: 60 }] },
  { tenant_id: 'OtherCompany', room_id: 'old', x: 0, y: 0, width: 1, height: 1, parts: [] }]);
  expect(rooms.map(room => room.agents)).toEqual([['One/worker'], ['Two/worker']]);
  expect(layout).toHaveLength(2); expect(layout[1]).toMatchObject({ tenant_id: 'Two', room_id: 'general', x: 650 });
  expect(layout[0].x).toBe(0); expect(officeLayoutProblem(layout)).toBeUndefined();
});
it('rechaza geometrías no finitas y tamaños sin área', () => {
  const room = { tenant_id: 'One', room_id: 'general', x: 0, y: 0, width: 1, height: 1, parts: [] };
  expect(officeLayoutProblem([{ ...room, width: 0 }])).toMatch(/mayores que cero/u);
  expect(officeLayoutProblem([{ ...room, x: NaN }])).toMatch(/finitos/u);
});
it('limita las salas del plano a las que el servidor puede guardar', () => {
  const topology = { tenants: [{ id: 'One', rooms: [{ id: 'on' }, { id: 'off', enabled: false }] }, { id: 'Linked', rooms: [{ id: 'hub' }] }] };
  expect(officeRooms(topology, [{ tenant_id: 'One', room_id: 'on' }]).map(room => room.id)).toEqual(['on']);
  expect(officeRooms(topology).map(room => room.id)).toEqual(['on', 'off', 'hub']);
});
