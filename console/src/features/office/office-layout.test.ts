import { expect, it } from 'vitest';
import { officeLayoutProblem, officeRoomKey, officeRooms, rebaseOfficeDraft, reconcileOfficeLayout, reconcileOfficeLayoutIncludingSaved } from './office-layout';

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
it('conserva con su posición una sala que solo está en el plano releído y no duplica las conocidas', () => {
  const known = [{ tenant: 'One', id: 'general', label: 'General', agents: [] }, { tenant: 'Two', id: 'general', label: 'General', agents: [] }];
  const nueva = { tenant_id: 'One', room_id: 'nueva', x: 111, y: 222, width: 280, height: 210, parts: [] };
  const saved = [{ tenant_id: 'One', room_id: 'general', x: 600, y: 300, width: 300, height: 200, parts: [] }, nueva,
    { tenant_id: 'Two', room_id: 'general', x: 330, y: 0, width: 300, height: 260, parts: [] }];
  const layout = reconcileOfficeLayoutIncludingSaved(known, saved);
  expect(layout).toHaveLength(3); expect(layout.find(room => room.room_id === 'nueva')).toEqual(nueva);
  expect(layout.filter(room => room.room_id === 'general')).toHaveLength(2);
  expect(reconcileOfficeLayoutIncludingSaved([...known, { tenant: 'One', id: 'nueva', label: 'Nueva', agents: [] }], saved)).toHaveLength(3);
  const rebased = rebaseOfficeDraft(known.map(room => ({ tenant_id: room.tenant, room_id: room.id, x: 0, y: 0, width: 300, height: 260, parts: [] })),
    known.map(room => ({ tenant_id: room.tenant, room_id: room.id, x: 0, y: 0, width: 300, height: 260, parts: [] })), layout);
  expect(rebased.rooms.find(room => room.room_id === 'nueva')).toEqual(nueva); expect(rebased.overridden).toEqual([]);
  const knownOnly = [known[0]];
  const dropped = saved[2];
  expect(reconcileOfficeLayoutIncludingSaved(knownOnly, saved, [])).toEqual([saved[0]]);
  expect(reconcileOfficeLayoutIncludingSaved(knownOnly, saved, [officeRoomKey(dropped.tenant_id, dropped.room_id)])).toEqual([saved[0], dropped]);
  expect(reconcileOfficeLayoutIncludingSaved(known, saved, [officeRoomKey('One', 'nueva')])).toHaveLength(3);
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
it('reaplica un borrador sobre la versión nueva parte a parte y señala sólo lo que pisa', () => {
  const part = (id: string, label: string, x = 10) => ({ id, label, x, y: 10, width: 40, height: 40 });
  const room = (parts: ReturnType<typeof part>[], x = 0, y = 0) => ({ tenant_id: 'One', room_id: 'general', x, y, width: 300, height: 200, parts });
  const other = { tenant_id: 'Two', room_id: 'general', x: 330, y: 0, width: 300, height: 200, parts: [] };
  const base = [room([part('kept', 'Mesa'), part('mine-removed', 'Sofá'), part('theirs-removed', 'Pizarra'), part('both', 'Puerta')]), other];
  const mine = [room([part('kept', 'Mesa'), part('theirs-removed', 'Pizarra'), part('both', 'Entrada'), part('mine-added', 'Planta')], 50), other];
  const theirs = [room([part('kept', 'Mesa', 90), part('mine-removed', 'Sofá'), part('both', 'Salida'), part('theirs-added', 'Lámpara')], 0, 70),
    { ...other, x: 900 }];
  const rebased = rebaseOfficeDraft(base, mine, theirs);
  expect(rebased.rooms[0]).toEqual(room([part('kept', 'Mesa', 90), part('both', 'Entrada'), part('theirs-added', 'Lámpara'), part('mine-added', 'Planta')], 50, 70));
  expect(rebased.rooms[1]).toEqual({ ...other, x: 900 });
  expect(rebased.overridden).toEqual([officeRoomKey('One', 'general')]);
});
it('al reaplicar no recupera una parte que la otra persona quitó si el borrador no la cambió, y sí la que cambió', () => {
  const part = (label: string, width = 40) => ({ id: label, label, x: 0, y: 0, width, height: 40 });
  const room = (parts: ReturnType<typeof part>[]) => ({ tenant_id: 'One', room_id: 'general', x: 0, y: 0, width: 300, height: 200, parts });
  const base = [room([part('Mesa'), part('Sofá')])];
  expect(rebaseOfficeDraft(base, base, [room([])])).toEqual({ rooms: [room([])], overridden: [] });
  expect(rebaseOfficeDraft(base, [room([part('Mesa'), part('Sofá', 90)])], [room([])]))
    .toEqual({ rooms: [room([part('Sofá', 90)])], overridden: [officeRoomKey('One', 'general')] });
  // The draft removed a part the other person resized: the removal stands, and it is reported.
  expect(rebaseOfficeDraft(base, [room([part('Mesa')])], [room([part('Mesa'), part('Sofá', 70)])]))
    .toEqual({ rooms: [room([part('Mesa')])], overridden: [officeRoomKey('One', 'general')] });
});
