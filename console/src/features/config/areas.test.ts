import { AREA_POR_DEFECTO, CONFIG_AREAS, agruparPorArea, areaDeColeccion, type ConfigArea } from './areas';
import { configCollections } from './collections';

const LARGO_DESCRIPCION = 90;
const vacia = (key: string) => ({ key, title: key, rows: [] });

it('reparte las colecciones propias de Ajustes por área, sin perder ninguna', () => {
  const colecciones = configCollections({ revision: 1, tenants: [], rooms: [] });
  const repartidas = agruparPorArea(colecciones).flatMap((entrada) => entrada.colecciones.map((c) => c.key));

  // The grouper is not a filter: what goes in is what comes out.
  expect(repartidas.sort()).toEqual(colecciones.map((c) => c.key).sort());
  expect(areaDeColeccion('memberships')).toBe('espacios');
  expect(areaDeColeccion('acl_edges')).toBe('permisos');
  expect(areaDeColeccion('agents')).toBe('agentes');
  expect(areaDeColeccion('chain_policies')).toBe('avisos');
});

/**
 * NEGATIVE CONTROL of the grouper. What is being checked is not that "Otros" exists, but that
 * it appears ONLY when there is something unclassifiable. If the `filter` of `agruparPorArea`
 * were deleted, the first half of this test would still pass and the second would fail: the tab
 * would always appear empty, and the operator would learn to ignore it just before it matters.
 */
it('una colección que la consola no conoce cae en «Otros» en vez de desaparecer, y «Otros» no sale si no hay ninguna', () => {
  const conDesconocida = agruparPorArea([vacia('tenants'), vacia('gizmos')]);
  const otros = conDesconocida.find((entrada) => entrada.area.id === 'otros');
  expect(otros?.colecciones.map((c) => c.key)).toEqual(['gizmos']);

  const sinDesconocida = agruparPorArea([vacia('tenants')]);
  expect(sinDesconocida.map((entrada) => entrada.area.id)).not.toContain('otros');
});

it('«Historial» sale siempre, aunque no tenga ninguna colección detrás', () => {
  const areas = agruparPorArea([]).map((entrada) => entrada.area.id);

  expect(areas).toEqual(['espacios', 'permisos', 'agentes', 'avisos', 'historial']);
  expect(areas[0]).toBe(AREA_POR_DEFECTO);
});

/** The report, not a boolean: it must be possible to feed it a broken area and see it named. */
export function prosaDemasiadoLarga(areas: readonly ConfigArea[]): string[] {
  const fallos: string[] = [];
  for (const area of areas) {
    if (area.descripcion.length > LARGO_DESCRIPCION) {
      fallos.push(`«${area.label}»: la descripción son ${String(area.descripcion.length)} caracteres, el tope es ${String(LARGO_DESCRIPCION)}`);
    }
    // ONE sentence. Two consecutive periods are two sentences, and the second is exactly the one read one too many times.
    const frases = area.descripcion.split(/\.\s/).filter((parte) => parte.trim() !== '');
    if (frases.length > 1) fallos.push(`«${area.label}»: la descripción son ${String(frases.length)} frases, tiene que ser una`);
    if (area.detalle.trim() === '') fallos.push(`«${area.label}»: no tiene detalle plegado`);
  }
  return fallos;
}

it('la frase que se lee al entrar en cada pestaña es UNA, y cabe en 90 caracteres', () => {
  expect(prosaDemasiadoLarga(CONFIG_AREAS)).toEqual([]);
});

/**
 * NEGATIVE CONTROL BY MUTATION. The guard is fed the EXACT text that was deployed —194 chars
 * and three sentences— and must flag it for both reasons. Without this, `prosaDemasiadoLarga()`
 * could return `[]` by looking at nothing.
 */
it('CONTROL NEGATIVO — marca la descripción que estaba desplegada (194 caracteres, tres frases)', () => {
  const desplegada: ConfigArea = {
    id: 'espacios',
    label: 'Espacios y miembros',
    descripcion: 'Los clientes, sus salas y quién está dentro de cada sala. Es de acá de donde el '
      + 'enrutado saca la flota: un alias sin membership habilitada no recibe entregas, aunque esté '
      + 'en el registro de agentes.',
    detalle: 'lo que sea',
  };
  const fallos = prosaDemasiadoLarga([desplegada]);
  expect(fallos).toContainEqual(expect.stringContaining('caracteres'));
  expect(fallos).toContainEqual(expect.stringContaining('frases'));
  // And an area with nothing folded is also flagged: folding is half the bargain, deleting isn't.
  expect(prosaDemasiadoLarga([{ ...desplegada, descripcion: 'Corta.', detalle: '' }]))
    .toContainEqual(expect.stringContaining('no tiene detalle plegado'));
});

/**
 * What was folded MUST not get lost on the way. This sentence is what answers the most expensive
 * question from the console —"the alias is in the registry, why does nothing reach it?"— and it
 * would disappear without any test noticing: a text nobody asserts is a text anyone can delete.
 */
it('lo que se plegó sigue estando: de dónde saca el enrutado la flota, y que todo empieza denegado', () => {
  const espacios = CONFIG_AREAS.find((area) => area.id === 'espacios');
  expect(espacios?.detalle).toMatch(/un alias sin membership habilitada no recibe entregas/i);
  expect(espacios?.detalle).toMatch(/Rol de permisos.*role_policy/i);
  expect(espacios?.detalle).toMatch(/no es el contexto ni el rol declarado/i);
  const permisos = CONFIG_AREAS.find((area) => area.id === 'permisos');
  expect(permisos?.detalle).toMatch(/todo empieza denegado/i);
});

it('«Agentes» ya no promete cuentas ni decir con qué programa corre cada bot', () => {
  const agentes = CONFIG_AREAS.find((area) => area.id === 'agentes');
  expect(agentes?.label).toBe('Agentes');
  expect(agentes?.descripcion).not.toMatch(/cuentas/i);
  expect(agentes?.descripcion).not.toMatch(/con qué programa corre/i);
  // And it says it where it is read in full, not kept quiet: the folded detail names where it comes from.
  expect(agentes?.detalle).toMatch(/binario en ejecución/i);
  // NEGATIVE CONTROL: what it already said and is still true has not been lost on the way.
  expect(agentes?.detalle).toMatch(/membres/i);
});

it('«Avisos y cadena» dice que los topes de delegación se editan ACÁ, ya no que no se pueden tocar', () => {
  const avisos = CONFIG_AREAS.find((area) => area.id === 'avisos');
  expect(avisos?.detalle).toMatch(/topes de delegación|delegación/i);
  // The confession must no longer be there: it would be a screen lying in the opposite direction.
  expect(avisos?.detalle).not.toMatch(/no se (ven|editan)|ni se ven ni se editan|sólo se cambian por SQL/i);
  expect(avisos?.detalle).toMatch(/compuerta humana/i);
  // NEGATIVE CONTROL: what the tab already explained and is still true has not been lost.
  expect(avisos?.detalle).toMatch(/aviso proactivo/i);
});
