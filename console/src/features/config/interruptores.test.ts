import {
  esCampoConmutable, explicacionDeCampo, interruptorDeFila, sujetoDeFila,
} from './interruptores';

const arista = {
  from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true,
  allow_route: true, allow_read: true, allow_control: false, created_at: '2026-07-01T10:00:00.000Z',
};

const membresia = {
  tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', role: 'agent',
  enabled: true, created_at: '2026-07-01T10:00:00.000Z',
};

it('arma la mutación de un permiso con SÓLO el campo que cambia y la dirección puesta', () => {
  const interruptor = interruptorDeFila('acl_edges', arista, 'allow_route', 0);
  expect(interruptor?.mutation).toEqual({
    resource: 'acl_edge', action: 'update', from_tenant: 'Steven', to_tenant: 'Miguel',
    value: { allow_route: false },
  });
  // The store merges field by field: sending only `allow_route` does not clobber the `allow_read`
  // another operator just changed on the same edge.
  expect(Object.keys(interruptor?.mutation.value as object)).toEqual(['allow_route']);
});

it('el apagado propone encender, y al revés', () => {
  expect(interruptorDeFila('acl_edges', arista, 'allow_control', 0)?.mutation)
    .toMatchObject({ value: { allow_control: true } });
  expect(interruptorDeFila('acl_edges', { ...arista, allow_control: true }, 'allow_control', 0)?.mutation)
    .toMatchObject({ value: { allow_control: false } });
});

it('el aria-label nombra la FILA y el permiso, no sólo el permiso', () => {
  // Twenty-four controls that only say "Route" are twenty-four indistinguishable controls to
  // anyone not looking at the table.
  expect(interruptorDeFila('acl_edges', arista, 'allow_route', 0)?.aria)
    .toBe('Ruta en la arista Steven → Miguel');
  expect(interruptorDeFila('memberships', membresia, 'enabled', 0)?.aria)
    .toBe('Habilitado en la membresía Miguel/grp.miguel/janus');
});

it('no ofrece interruptor cuando el valor no es booleano', () => {
  // You cannot write "the opposite" of a value you do not know: instead of turning something off
  // by assuming it was on, the cell stays as read-only data.
  expect(interruptorDeFila('acl_edges', { ...arista, allow_read: null }, 'allow_read', 0)).toBeUndefined();
  expect(interruptorDeFila('tenants', { id: 'Isa', enabled: 'sí' }, 'enabled', 0)).toBeUndefined();
});

it('no ofrece interruptor cuando la fila no trae la identidad que la mutación necesita', () => {
  expect(interruptorDeFila('acl_edges', { to_tenant: 'Miguel', enabled: true }, 'enabled', 0)).toBeUndefined();
  expect(interruptorDeFila('memberships', { alias: 'janus', enabled: true }, 'enabled', 0)).toBeUndefined();
});

it('no conmuta lo que no está declarado conmutable, aunque sea booleano', () => {
  // `is_hub` is boolean and the schema accepts it, but moving the hub of a fleet is not a
  // one-click operation next to "Enabled".
  expect(esCampoConmutable('tenants', 'is_hub')).toBe(false);
  expect(interruptorDeFila('tenants', { id: 'Steven', is_hub: true, enabled: true }, 'is_hub', 0))
    .toBeUndefined();
  expect(interruptorDeFila('agents', { tenant_id: 'Steven', alias: 'kant', enabled: true }, 'enabled', 0))
    .toBeUndefined();
});

it('la ÚNICA confirmación que queda es quitar Control; concederlo no confirma nada', () => {
  // Confirming twenty times in a row does not protect: it teaches people to mash "Confirm" without
  // reading, and the day the one that matters shows up nobody reads it anymore.
  const quitar = interruptorDeFila('acl_edges', { ...arista, allow_control: true }, 'allow_control', 0);
  expect(quitar?.confirmar).toMatch(/no vas a poder devolvértelo desde acá/i);

  expect(interruptorDeFila('acl_edges', arista, 'allow_control', 0)?.confirmar).toBeUndefined();
  expect(interruptorDeFila('acl_edges', arista, 'allow_route', 0)?.confirmar).toBeUndefined();
  expect(interruptorDeFila('acl_edges', arista, 'enabled', 0)?.confirmar).toBeUndefined();
  expect(interruptorDeFila('memberships', membresia, 'enabled', 0)?.confirmar).toBeUndefined();
});

it('cada permiso explica en castellano qué concede: la cabecera ya no es el nombre de la columna', () => {
  expect(explicacionDeCampo('acl_edges', 'allow_control')).toMatch(/ESCRIBA sobre el de la derecha/);
  expect(explicacionDeCampo('acl_edges', 'allow_route')).toMatch(/MANDE mensajes/);
  expect(explicacionDeCampo('memberships', 'enabled')).toMatch(/no recibe/);
  // A field this console does not know how to explain does not invent an explanation.
  expect(explicacionDeCampo('acl_edges', 'created_at')).toBeUndefined();
  expect(explicacionDeCampo('provider_accounts', 'enabled')).toBeUndefined();
});

it('la clave identifica el interruptor por colección, fila y campo', () => {
  expect(interruptorDeFila('acl_edges', arista, 'allow_read', 0)?.clave)
    .toBe('acl_edges|Steven/Miguel|allow_read');
  expect(sujetoDeFila('role_policies', { role: 'operator' })).toBe('el rol operator');
});

it('los permisos de un ROL también son interruptores, con la mutación de role_policy', () => {
  const politica = { role: 'agent', allow_route: true, allow_read: true, allow_control: false, allow_notify: false };
  expect(interruptorDeFila('role_policies', politica, 'allow_notify', 0)?.mutation).toEqual({
    resource: 'role_policy', action: 'update', role: 'agent', value: { allow_notify: true },
  });
});
