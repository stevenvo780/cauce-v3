import { CONFIG_SECTIONS, SECCION_POR_DEFECTO, coleccionesDe, seccionDeColeccion } from './sections';
import { configCollections } from './collections';

const vacia = (key: string) => ({ key, title: key, rows: [] });

it('reparte cada colección publicada en una sola sección, sin perder ninguna', () => {
  const colecciones = configCollections({ revision: 1, tenants: [], rooms: [] });
  const repartidas = CONFIG_SECTIONS.flatMap((s) => coleccionesDe(s.id, colecciones).map((c) => c.key));
  expect(repartidas.sort()).toEqual(colecciones.map((c) => c.key).sort());
  expect(seccionDeColeccion('memberships')).toBe('espacios');
  expect(seccionDeColeccion('acl_edges')).toBe('acceso');
  expect(seccionDeColeccion('egress_destinations')).toBe('acceso');
  expect(seccionDeColeccion('harness_definitions')).toBe('arneses');
  expect(seccionDeColeccion('agents')).toBe('agentes');
  expect(seccionDeColeccion('chain_policies')).toBe('general');
});

/** The negative control: an unknown key must land in «Avanzado», and `toString` must not inherit a section. */
it('una colección desconocida cae en «Avanzado» en vez de desaparecer', () => {
  expect(seccionDeColeccion('gizmos')).toBe('avanzado');
  expect(seccionDeColeccion('toString')).toBe('avanzado');
  expect(coleccionesDe('avanzado', [vacia('tenants'), vacia('gizmos')]).map((c) => c.key)).toEqual(['gizmos']);
});

it('las secciones salen en el orden en que se monta una flota y abren en General', () => {
  expect(CONFIG_SECTIONS.map((s) => s.id)).toEqual(['general', 'espacios', 'agentes', 'arneses', 'acceso', 'avanzado']);
  expect(CONFIG_SECTIONS[0].id).toBe(SECCION_POR_DEFECTO);
});

it('cada sección dice su propósito en UNA frase y guarda el resto plegado', () => {
  for (const seccion of CONFIG_SECTIONS) {
    expect(seccion.proposito.length, seccion.label).toBeLessThanOrEqual(120);
    expect(seccion.proposito.split(/\.\s/).filter((p) => p.trim()), seccion.label).toHaveLength(1);
    expect(seccion.detalle.trim(), seccion.label).not.toBe('');
  }
});
