import { AREA_POR_DEFECTO, agruparPorArea, areaDeColeccion } from './areas';
import { configCollections } from './collections';

const vacia = (key: string) => ({ key, title: key, rows: [] });

it('reparte las doce colecciones conocidas por área, sin perder ninguna', () => {
  const colecciones = configCollections({ revision: 1, tenants: [], rooms: [] } as never);
  const repartidas = agruparPorArea(colecciones).flatMap((entrada) => entrada.colecciones.map((c) => c.key));

  // El agrupador no es un filtro: entra lo mismo que sale.
  expect(repartidas.sort()).toEqual(colecciones.map((c) => c.key).sort());
  expect(areaDeColeccion('memberships')).toBe('espacios');
  expect(areaDeColeccion('acl_edges')).toBe('permisos');
  expect(areaDeColeccion('agents')).toBe('agentes');
  expect(areaDeColeccion('chain_policies')).toBe('avisos');
});

/**
 * CONTROL NEGATIVO del agrupador. Lo que se está comprobando no es que «Otros» exista, sino que
 * aparece SÓLO cuando hay algo que no se supo clasificar. Si el `filter` de `agruparPorArea` se
 * borrara, la primera mitad de esta prueba seguiría pasando y la segunda fallaría: la pestaña
 * saldría siempre, vacía, y el operador aprendería a ignorarla justo antes del día en que importa.
 */
it('una colección que la consola no conoce cae en «Otros» en vez de desaparecer, y «Otros» no sale si no hay ninguna', () => {
  const conDesconocida = agruparPorArea([vacia('tenants'), vacia('gizmos')]);
  const otros = conDesconocida.find((entrada) => entrada.area.id === 'otros');
  expect(otros?.colecciones.map((c) => c.key)).toEqual(['gizmos']);

  const sinDesconocida = agruparPorArea([vacia('tenants')]);
  expect(sinDesconocida.map((entrada) => entrada.area.id)).not.toContain('otros');
});

it('«Roles» e «Historial» salen siempre, aunque no tengan ninguna colección detrás', () => {
  const areas = agruparPorArea([]).map((entrada) => entrada.area.id);

  expect(areas).toEqual(['espacios', 'permisos', 'roles', 'agentes', 'avisos', 'historial']);
  expect(areas[0]).toBe(AREA_POR_DEFECTO);
});
