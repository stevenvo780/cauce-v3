import {
  accionDeRol, claveDeFila, columnaNumerica, columnasDe, identidadFundida, rolesDisponibles,
} from './collection-table';

const membership = {
  tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', role: 'agent',
  enabled: true, created_at: '2026-07-01T10:00:00.000Z',
};

it('ordena las columnas conocidas y no inventa las que el servidor no publica', () => {
  const filas = [{ tenant_id: 'Miguel', room_id: 'grp.miguel', alias: 'janus', role: 'agent', enabled: true }];
  expect(columnasDe('memberships', filas).map((columna) => columna.clave))
    .toEqual(['tenant_id', 'room_id', 'alias', 'role', 'enabled']);
  // `created_at` is not in any row: an entire UNKNOWN column isn't a missing data point, it's a
  // column this gateway doesn't have.
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

/*
 * The toggles for `enabled` and for the three permissions of an edge stopped being text buttons
 * in an "Actions" column: they are switches, and their mutations are tested in `interruptores.test.ts`.
 */

it('funde «Desde» y «Hacia» en una sola columna de arista, que se lee de un golpe', () => {
  const filas = [{ from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true }];
  expect(columnasDe('acl_edges', filas).map((columna) => columna.etiqueta))
    .toEqual(['Arista', 'Habilitado', 'Ruta']);
  expect(identidadFundida('acl_edges', filas[0])).toBe('Steven → Miguel');
});

it('no funde una arista a medias: sin los dos extremos se siguen viendo las columnas del servidor', () => {
  // "Steven → " without knowing toward where would be worse than two separate columns.
  const filas = [{ from_tenant: 'Steven', enabled: true }];
  expect(columnasDe('acl_edges', filas).map((columna) => columna.clave)).toEqual(['from_tenant', 'enabled']);
  expect(identidadFundida('acl_edges', filas[0])).toBeUndefined();
});

it('los permisos dejan de rotularse con el nombre de la columna de Postgres', () => {
  const columnas = columnasDe('role_policies', [{ role: 'agent', allow_route: true, allow_control: false }]);
  expect(columnas.map((columna) => columna.etiqueta)).toEqual(['Rol', 'Ruta', 'Control']);
});

it('arma el cambio de rol y rechaza lo que el gateway rechazaría igual', () => {
  expect(accionDeRol(membership, 'operator')?.mutation).toEqual({
    resource: 'membership', action: 'update', tenant_id: 'Miguel', room_id: 'grp.miguel',
    alias: 'janus', value: { role: 'operator' },
  });
  // Same role: it's not a change, and would waste an audit trail review for nothing.
  expect(accionDeRol(membership, 'agent')).toBeUndefined();
  expect(accionDeRol(membership, 'Operador Jefe')).toBeUndefined();
});

it('ofrece los roles de role_policies sin esconder el que la fila ya tiene', () => {
  const politicas = [{ role: 'operator' }, { role: 'agent' }];
  expect(rolesDisponibles(politicas, 'agent')).toEqual(['agent', 'operator']);
  // An orphan role —without a policy— keeps being offered: hiding it would make the selector
  // lie about what the row says.
  expect(rolesDisponibles(politicas, 'legado')).toEqual(['agent', 'legado', 'operator']);
  expect(rolesDisponibles(undefined, undefined)).toEqual([]);
});

it('identifica la fila por su clave primaria y sólo cae al índice si le falta un campo', () => {
  expect(claveDeFila('memberships', membership, 3)).toBe('Miguel/grp.miguel/janus');
  expect(claveDeFila('acl_edges', { from_tenant: 'Steven', to_tenant: 'Isa' }, 0)).toBe('Steven/Isa');
  expect(claveDeFila('memberships', { alias: 'janus' }, 7)).toBe('fila-7');
});


/* --- Number columns ---------------------------------------------------------------------------
 *
 * A left-aligned number column forces you to compare magnitudes by counting digits: `8` and
 * `120` start at the same pixel and the one that LOOKS bigger is the one with more characters.
 * `/config` has a few —`max_per_hour`, `contact_ttl_days`, `priority`— and they are all read
 * for comparison.
 */
it('reconoce una columna de números y no se deja engañar por lo que sólo se le parece', () => {
  expect(columnaNumerica([{ n: 1 }, { n: 120 }], 'n')).toBe(true);
  // Nulls and missing keys don't disprove anything: it's still a number column.
  expect(columnaNumerica([{ n: 1 }, { n: null }, {}], 'n')).toBe(true);

  // A boolean is NOT a number even if it looks similar from afar, and a mixed column aligned
  // right reads WORSE than left-aligned: "12" and "no limit" stop sharing the margin.
  expect(columnaNumerica([{ n: true }, { n: false }], 'n')).toBe(false);
  expect(columnaNumerica([{ n: 1 }, { n: 'sin límite' }], 'n')).toBe(false);
  expect(columnaNumerica([{ n: '12' }], 'n')).toBe(false);
  expect(columnaNumerica([{ n: Number.NaN }], 'n')).toBe(false);

  // And without any number there's no number column: otherwise, an empty table would align
  // everything right and a column of all `null` would read as if it had figures.
  expect(columnaNumerica([], 'n')).toBe(false);
  expect(columnaNumerica([{ n: null }, {}], 'n')).toBe(false);
});
