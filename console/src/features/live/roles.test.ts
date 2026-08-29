import { catalogoDeRoles, resumenDeRol } from './roles';

const agente = (alias: string, role_brief: unknown) =>
  ({ tenant_id: 'Steven', alias, role_brief, display_name: alias });

it('agrupa por rol a los bots que llevan el MISMO texto, aunque difieran en espacios de sobra', () => {
  const catalogo = catalogoDeRoles([
    agente('zeus', 'Sos el orquestador de la flota.'),
    // The store trims before saving, so for the server these two are the same role.
    agente('kant', '  Sos el orquestador de la flota.\n'),
    agente('argos', 'Sos el que persigue lo pendiente.'),
    agente('iza', null),
    agente('midas', '   '),
  ]);

  expect(catalogo.roles.map((rol) => rol.portadores.map((p) => p.alias))).toEqual([
    ['zeus', 'kant'],
    ['argos'],
  ]);
  // Neither null nor blank text creates an empty role: they are "role not declared".
  expect(catalogo.sinRol.map((entrada) => entrada.alias)).toEqual(['iza', 'midas']);
  expect(catalogo.todos).toHaveLength(5);
});

// NEGATIVE CONTROL of the meter: if `utf16` were calculated the same as `puntos`, this role would be
// declared within the cap and the deployed adapter would silently reject every envelope.
it('mide el rol en las DOS unidades y lo declara pasado cuando cualquiera de las dos se pasa', () => {
  // 1150 code points, but each emoji takes two UTF-16 units: 1150 vs 2300.
  const conEmojis = '🙂'.repeat(1150);
  const catalogo = catalogoDeRoles([agente('zeus', conEmojis)]);
  const rol = catalogo.roles[0];

  expect(rol.puntos).toBe(1150);
  expect(rol.utf16).toBe(2300);
  expect(rol.puntos).toBeLessThanOrEqual(1200);
  expect(rol.pasado).toBe(true);

  // And the symmetric case: normal text within the cap, the two units match and it is NOT over.
  const normal = catalogoDeRoles([agente('kant', 'a'.repeat(1150))]).roles[0];
  expect(normal.puntos).toBe(1150);
  expect(normal.utf16).toBe(1150);
  expect(normal.pasado).toBe(false);
});

it('no inventa un catálogo cuando el gateway no publica el registro de agentes', () => {
  // Missing key is not an empty list: both yield zero roles and the UI distinguishes them by looking
  // at the snapshot, not at this result.
  expect(catalogoDeRoles(undefined)).toEqual({ roles: [], sinRol: [], todos: [] });
  expect(catalogoDeRoles(null)).toEqual({ roles: [], sinRol: [], todos: [] });
  // A row without a usable alias identifies no bot and does not enter the catalog.
  expect(catalogoDeRoles([{ tenant_id: 'Steven', role_brief: 'algo' }]).todos).toEqual([]);
});

it('resume el rol por su primera línea y dice que es un resumen, no un nombre', () => {
  expect(resumenDeRol('Orquestador residente\nDetalle largo que no cabe.')).toBe('Orquestador residente');
  expect(resumenDeRol('x'.repeat(200))).toHaveLength(72);
});
