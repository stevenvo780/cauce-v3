import {
  accionDeRol, accionesDeFila, claveDeFila, columnasDe, rolesDisponibles,
} from './collection-table';

const membership = {
  tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', role: 'agent',
  enabled: true, created_at: '2026-07-01T10:00:00.000Z',
};

it('ordena las columnas conocidas y no inventa las que el servidor no publica', () => {
  const filas = [{ tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', role: 'agent', enabled: true }];
  expect(columnasDe('memberships', filas).map((columna) => columna.clave))
    .toEqual(['tenant_id', 'room_id', 'alias', 'role', 'enabled']);
  // `created_at` no está en ninguna fila: una columna entera de UNKNOWN no es un dato faltante,
  // es una columna que este gateway no tiene.
  expect(columnasDe('memberships', filas).some((columna) => columna.clave === 'created_at')).toBe(false);
});

it('muestra igual los campos que el servidor agregue y esta consola no conoce', () => {
  const columnas = columnasDe('memberships', [{ ...membership, campo_nuevo: 'x' }]);
  expect(columnas.at(-1)).toEqual({ clave: 'campo_nuevo', etiqueta: 'campo_nuevo' });
});

it('deriva la tabla de una colección sin forma conocida a partir de las propias filas', () => {
  expect(columnasDe('role_policies', [{ role: 'agent', allow_route: true }]).map((columna) => columna.clave))
    .toEqual(['role', 'allow_route']);
});

it('arma el toggle de una membership con la mutación exacta y sólo el campo que cambia', () => {
  const [accion] = accionesDeFila('memberships', membership);
  expect(accion.etiqueta).toBe('Deshabilitar');
  expect(accion.mutation).toEqual({
    resource: 'membership', action: 'update', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'janus', value: { enabled: false },
  });
  // El store hace merge campo por campo: mandar sólo `enabled` no pisa el `role` de otro operador.
  expect(Object.keys(accion.mutation.value as object)).toEqual(['enabled']);
});

it('propone habilitar —y no deshabilitar— la fila que está apagada', () => {
  const [accion] = accionesDeFila('memberships', { ...membership, enabled: false });
  expect(accion.etiqueta).toBe('Habilitar');
  expect(accion.mutation.value).toEqual({ enabled: true });
});

it('no ofrece ningún botón cuando `enabled` no es booleano', () => {
  // No se puede escribir «el contrario» de un valor que no se conoce: antes que apagar algo por
  // suponer que estaba encendido, la fila se queda sin acciones.
  expect(accionesDeFila('memberships', { ...membership, enabled: null })).toEqual([]);
  expect(accionesDeFila('tenants', { id: 'Isa', enabled: 'sí' })).toEqual([]);
});

it('da a una arista ACL el toggle de enabled más uno por cada permiso, con la dirección puesta', () => {
  const acciones = accionesDeFila('acl_edges', {
    from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true,
    allow_route: true, allow_read: true, allow_control: false,
  });
  expect(acciones.map((accion) => accion.id)).toEqual(['enabled', 'allow_route', 'allow_read', 'allow_control']);
  expect(acciones[1].descripcion).toBe('Quitar allow_route en la arista Steven → Miguel');
  expect(acciones[1].mutation).toEqual({
    resource: 'acl_edge', action: 'update', from_tenant: 'Steven', to_tenant: 'Miguel',
    value: { allow_route: false },
  });
  expect(acciones[3].descripcion).toBe('Conceder allow_control en la arista Steven → Miguel');
  expect(acciones[3].mutation).toMatchObject({ value: { allow_control: true } });
});

it('arma el cambio de rol y rechaza lo que el gateway rechazaría igual', () => {
  expect(accionDeRol(membership, 'operator')?.mutation).toEqual({
    resource: 'membership', action: 'update', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'janus', value: { role: 'operator' },
  });
  // Mismo rol: no es un cambio, y gastaría una revisión del audit trail para nada.
  expect(accionDeRol(membership, 'agent')).toBeUndefined();
  expect(accionDeRol(membership, 'Operador Jefe')).toBeUndefined();
});

it('ofrece los roles de role_policies sin esconder el que la fila ya tiene', () => {
  const politicas = [{ role: 'operator' }, { role: 'agent' }];
  expect(rolesDisponibles(politicas, 'agent')).toEqual(['agent', 'operator']);
  // Un rol huérfano —sin política— se sigue ofreciendo: esconderlo haría que el selector mintiera
  // sobre lo que la fila dice.
  expect(rolesDisponibles(politicas, 'legado')).toEqual(['agent', 'legado', 'operator']);
  expect(rolesDisponibles(undefined, undefined)).toEqual([]);
});

it('identifica la fila por su clave primaria y sólo cae al índice si le falta un campo', () => {
  expect(claveDeFila('memberships', membership, 3)).toBe('Miguel/grp.miguel/janus');
  expect(claveDeFila('acl_edges', { from_tenant: 'Steven', to_tenant: 'Isa' }, 0)).toBe('Steven/Isa');
  expect(claveDeFila('memberships', { alias: 'janus' }, 7)).toBe('fila-7');
});
