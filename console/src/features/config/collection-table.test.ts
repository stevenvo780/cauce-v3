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

/*
 * Los toggles de `enabled` y de los tres permisos de una arista dejaron de ser botones de texto en
 * una columna «Acciones»: son interruptores, y sus mutaciones se prueban en `interruptores.test.ts`.
 */

it('funde «Desde» y «Hacia» en una sola columna de arista, que se lee de un golpe', () => {
  const filas = [{ from_tenant: 'Steven', to_tenant: 'Miguel', enabled: true, allow_route: true }];
  expect(columnasDe('acl_edges', filas).map((columna) => columna.etiqueta))
    .toEqual(['Arista', 'Habilitado', 'Ruta']);
  expect(identidadFundida('acl_edges', filas[0])).toBe('Steven → Miguel');
});

it('no funde una arista a medias: sin los dos extremos se siguen viendo las columnas del servidor', () => {
  // «Steven → » sin saber hacia dónde sería peor que dos columnas separadas.
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


/* --- Columnas de números ----------------------------------------------------------------------
 *
 * Una columna de números alineada a la izquierda obliga a comparar magnitudes contando dígitos:
 * `8` y `120` empiezan en el mismo píxel y el que PARECE más grande es el que tiene más
 * caracteres. `/config` tiene unas cuantas —`max_per_hour`, `contact_ttl_days`, `priority`— y
 * todas se leen para comparar.
 */
it('reconoce una columna de números y no se deja engañar por lo que sólo se le parece', () => {
  expect(columnaNumerica([{ n: 1 }, { n: 120 }], 'n')).toBe(true);
  // Los nulos y las claves ausentes no desmienten nada: sigue siendo la columna de un número.
  expect(columnaNumerica([{ n: 1 }, { n: null }, {}], 'n')).toBe(true);

  // Un booleano NO es un número aunque se le parezca desde lejos, y una columna mixta alineada a
  // la derecha se lee PEOR que a la izquierda: «12» y «sin límite» dejan de compartir margen.
  expect(columnaNumerica([{ n: true }, { n: false }], 'n')).toBe(false);
  expect(columnaNumerica([{ n: 1 }, { n: 'sin límite' }], 'n')).toBe(false);
  expect(columnaNumerica([{ n: '12' }], 'n')).toBe(false);
  expect(columnaNumerica([{ n: Number.NaN }], 'n')).toBe(false);

  // Y sin ningún número no hay columna numérica: si no, una tabla vacía alinearía todo a la
  // derecha y una columna de puros `null` se leería como si tuviera cifras.
  expect(columnaNumerica([], 'n')).toBe(false);
  expect(columnaNumerica([{ n: null }, {}], 'n')).toBe(false);
});
