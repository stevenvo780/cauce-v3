import { AREA_POR_DEFECTO, CONFIG_AREAS, LARGO_DESCRIPCION, agruparPorArea, areaDeColeccion, type ConfigArea } from './areas';
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


/* --- La prosa que se lee al entrar ------------------------------------------------------------
 *
 * MEDIDO en Chrome sobre `/config`: entre el título y el primer control había TRES párrafos de
 * prosa gris a 12,5 px, uno de ellos cruzando 1.250 px de renglón. Quien entra veinte veces al día
 * ya sabe qué es la pantalla y los vuelve a saltar veinte veces, pagando el scroll cada vez.
 *
 * La regla: lo que se lee sin plegar es UNA frase. Lo que sobra no se borra —es lo que explica por
 * qué la pestaña importa— sino que va a `detalle`, dentro de un `<details>` cerrado.
 */

/** El informe, no un booleano: hace falta poder darle de comer un área rota y ver que la nombra. */
export function prosaDemasiadoLarga(areas: readonly ConfigArea[]): string[] {
  const fallos: string[] = [];
  for (const area of areas) {
    if (area.descripcion.length > LARGO_DESCRIPCION) {
      fallos.push(`«${area.label}»: la descripción son ${area.descripcion.length} caracteres, el tope es ${LARGO_DESCRIPCION}`);
    }
    // UNA frase. Dos puntos seguidos son dos frases, y la segunda es justo la que se relee de más.
    const frases = area.descripcion.split(/\.\s/).filter((parte) => parte.trim() !== '');
    if (frases.length > 1) fallos.push(`«${area.label}»: la descripción son ${frases.length} frases, tiene que ser una`);
    if (area.detalle.trim() === '') fallos.push(`«${area.label}»: no tiene detalle plegado`);
  }
  return fallos;
}

it('la frase que se lee al entrar en cada pestaña es UNA, y cabe en 90 caracteres', () => {
  expect(prosaDemasiadoLarga(CONFIG_AREAS)).toEqual([]);
});

/**
 * CONTROL NEGATIVO POR MUTACIÓN. Se le da de comer al guardia el texto EXACTO que estaba
 * desplegado —194 caracteres y tres frases— y se exige que lo marque por las dos cosas. Sin esto,
 * `prosaDemasiadoLarga()` podría estar devolviendo `[]` por no mirar nada.
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
  // Y un área sin nada plegado también se marca: plegar es la mitad del trato, borrar no lo es.
  expect(prosaDemasiadoLarga([{ ...desplegada, descripcion: 'Corta.', detalle: '' }]))
    .toContainEqual(expect.stringContaining('no tiene detalle plegado'));
});

/**
 * Lo plegado NO puede perderse por el camino. Esta frase es la que contesta la pregunta más cara
 * de la consola —«el alias está en el registro, ¿por qué no le llega nada?»— y desaparecería sin
 * que ninguna prueba se enterara: un texto que nadie afirma es un texto que cualquiera borra.
 */
it('lo que se plegó sigue estando: de dónde saca el enrutado la flota, y que todo empieza denegado', () => {
  const espacios = CONFIG_AREAS.find((area) => area.id === 'espacios');
  expect(espacios?.detalle).toMatch(/un alias sin membership habilitada no recibe entregas/i);
  const permisos = CONFIG_AREAS.find((area) => area.id === 'permisos');
  expect(permisos?.detalle).toMatch(/todo empieza denegado/i);
});

/**
 * **La descripción de «Agentes y cuentas» decía justo lo que la pantalla NO hace.**
 *
 * Estaba desplegada así: «El registro de bots, con qué programa corre cada uno y a qué cuentas de IA
 * llega». La primera mitad es falsa: `agents.harness_id` no decide con qué programa corre el bot —el
 * arnés real se deduce del binario en ejecución (`harnessFromCommand`,
 * services/gateway/src/console/agent-documents.ts:585).
 */
it('«Agentes y cuentas» ya no promete decir con qué programa corre cada bot', () => {
  const agentes = CONFIG_AREAS.find((area) => area.id === 'agentes');
  expect(agentes?.descripcion).not.toMatch(/con qué programa corre/i);
  // Y lo dice donde se lee entero, no lo calla: el detalle plegado nombra de dónde sale de verdad.
  expect(agentes?.detalle).toMatch(/binario en ejecución/i);
  // CONTROL NEGATIVO: no se perdió por el camino lo que ya decía y sigue siendo cierto.
  expect(agentes?.detalle).toMatch(/membres/i);
});

/**
 * Verifica que el área de Avisos y cadena declare los topes de delegación
 * aplicados por `loadChainPolicy` en el backend.
 */
it('«Avisos y cadena» dice que los topes de delegación se editan ACÁ, ya no que no se pueden tocar', () => {
  const avisos = CONFIG_AREAS.find((area) => area.id === 'avisos');
  expect(avisos?.detalle).toMatch(/topes de delegación|delegación/i);
  // La confesión ya no puede estar: sería una pantalla mintiendo en la dirección contraria.
  expect(avisos?.detalle).not.toMatch(/no se (ven|editan)|ni se ven ni se editan|sólo se cambian por SQL/i);
  expect(avisos?.detalle).toMatch(/compuerta humana/i);
  // CONTROL NEGATIVO: no se perdió lo que la pestaña ya explicaba y sigue siendo cierto.
  expect(avisos?.detalle).toMatch(/aviso proactivo/i);
});
