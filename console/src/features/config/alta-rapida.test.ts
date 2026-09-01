import { BORRADOR_VACIO, errorDeAlta, mutacionDeAlta } from './alta-rapida';

it('arma el alta de una membership tal como la espera MembershipConfigMutationSchema', () => {
  const borrador = { ...BORRADOR_VACIO, tenantId: 'Miguel', roomId: 'grp.miguel', alias: 'atlas', role: 'agent' };
  expect(errorDeAlta('membership', borrador)).toBeUndefined();
  expect(mutacionDeAlta('membership', borrador)).toEqual({
    resource: 'membership', action: 'create', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'atlas', value: { role: 'agent', enabled: true },
  });
});

it('rechaza el alias y el rol que el zod del gateway rechazaría, con el motivo escrito', () => {
  const base = { ...BORRADOR_VACIO, tenantId: 'Miguel', roomId: 'grp.miguel', alias: 'atlas' };
  expect(errorDeAlta('membership', { ...base, alias: 'Atlas' })).toMatch(/alias debe ser minúsculas/i);
  expect(errorDeAlta('membership', { ...base, role: '' })).toMatch(/rol de permisos debe ser minúsculas/i);
  expect(errorDeAlta('membership', { ...base, tenantId: '1Miguel' })).toMatch(/tenant debe empezar con letra/i);
});

it('crea la arista ACL en default-deny: los tres permisos arrancan en NO', () => {
  const borrador = { ...BORRADOR_VACIO, desde: 'Steven', hacia: 'Isa' };
  expect(errorDeAlta('acl_edge', borrador)).toBeUndefined();
  expect(mutacionDeAlta('acl_edge', borrador)).toEqual({
    resource: 'acl_edge', action: 'create', from_tenant: 'Steven', to_tenant: 'Isa',
    value: { enabled: true, allow_route: false, allow_read: false, allow_control: false },
  });
});

it('avisa de la arista de un tenant hacia sí mismo antes de gastar el viaje al 409', () => {
  expect(errorDeAlta('acl_edge', { ...BORRADOR_VACIO, desde: 'Steven', hacia: 'Steven' }))
    .toMatch(/hacia sí mismo está prohibida/i);
});

it('manda display_name null cuando el nombre queda vacío, no la cadena vacía que el CHECK rechaza', () => {
  expect(mutacionDeAlta('tenant', { ...BORRADOR_VACIO, tenantId: 'Acme' }).value)
    .toEqual({ display_name: null, is_hub: false, enabled: true });
  expect(mutacionDeAlta('room', { ...BORRADOR_VACIO, tenantId: 'Acme', roomId: 'grp.acme', nombre: 'Sala' }))
    .toEqual({
      resource: 'room', action: 'create', tenant_id: 'Acme', id: 'grp.acme',
      value: { display_name: 'Sala', enabled: true },
    });
});
