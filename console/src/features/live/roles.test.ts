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
  // Ni el null ni el texto en blanco crean un rol vacío: son «sin rol declarado».
  expect(catalogo.sinRol.map((entrada) => entrada.alias)).toEqual(['iza', 'midas']);
  expect(catalogo.todos).toHaveLength(5);
});

// CONTROL NEGATIVO del medidor: si `utf16` se calculara igual que `puntos`, este rol se declararía
// dentro del tope y el adaptador desplegado rechazaría cada sobre en silencio.
it('mide el rol en las DOS unidades y lo declara pasado cuando cualquiera de las dos se pasa', () => {
  // 1150 puntos de código, pero cada emoji ocupa dos unidades UTF-16: 1150 vs 2300.
  const conEmojis = '🙂'.repeat(1150);
  const catalogo = catalogoDeRoles([agente('zeus', conEmojis)]);
  const rol = catalogo.roles[0];

  expect(rol.puntos).toBe(1150);
  expect(rol.utf16).toBe(2300);
  expect(rol.puntos).toBeLessThanOrEqual(1200);
  expect(rol.pasado).toBe(true);

  // Y el caso simétrico: texto normal dentro del tope, las dos unidades coinciden y NO está pasado.
  const normal = catalogoDeRoles([agente('kant', 'a'.repeat(1150))]).roles[0];
  expect(normal.puntos).toBe(1150);
  expect(normal.utf16).toBe(1150);
  expect(normal.pasado).toBe(false);
});

it('no inventa un catálogo cuando el gateway no publica el registro de agentes', () => {
  // Clave ausente no es lista vacía: las dos dan cero roles y la pantalla las distingue mirando el
  // snapshot, no este resultado.
  expect(catalogoDeRoles(undefined)).toEqual({ roles: [], sinRol: [], todos: [] });
  expect(catalogoDeRoles(null)).toEqual({ roles: [], sinRol: [], todos: [] });
  // Una fila sin alias utilizable no identifica a ningún bot y no entra en el catálogo.
  expect(catalogoDeRoles([{ tenant_id: 'Steven', role_brief: 'algo' }]).todos).toEqual([]);
});

it('resume el rol por su primera línea y dice que es un resumen, no un nombre', () => {
  expect(resumenDeRol('Orquestador residente\nDetalle largo que no cabe.')).toBe('Orquestador residente');
  expect(resumenDeRol('x'.repeat(200))).toHaveLength(72);
});
