import { screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { ROUTE_ALIAS_TABLE, ROUTE_TABLE } from './App';
import { NAV_ENTRIES } from './nav';
import { renderWithApi } from './test/render';

/**
 * **Las invariantes del router, como TABLA y no como casos sueltos.**
 *
 * Por qué existe este fichero, y por qué es una tabla.
 *
 * El 2026-08-22 cinco grupos reformaron la consola a la vez: dos retiraron vistas, dos las
 * fundieron y uno renombró una. Los cinco tocaron el MISMO array `routes` y el MISMO
 * `ROUTE_ALIASES`, y cada uno los dejó consistentes con su propia rama. El peligro de juntarlos no
 * es el conflicto ruidoso —ese lo canta git— sino el SILENCIOSO, y este router tiene dos de los
 * peores que hay:
 *
 *   1. **Un id de ruta que no está en `routes` cae al `fallback` sin decir nada.** No hay error, no
 *      hay log, no hay 404: se dibuja otra página. Basta con que una fusión retire una vista y otra
 *      rama deje un enlace apuntándole.
 *   2. **Un alias ENCADENADO (a → b → c) hace exactamente lo mismo.** `matchRoute` resuelve
 *      `ROUTE_ALIASES` **una sola vez**: si `licenses → quotas` y `quotas → accounts`, entonces
 *      `/licenses` resuelve a `quotas`, que ya no es una ruta, y termina en el fallback. Un alias
 *      encadenado no es un alias: es un 404 silencioso con otra cara.
 *
 * Escrito como casos sueltos, esto envejece: se agrega una entrada al menú y nadie escribe su
 * caso. Escrito como tabla, agregar una entrada sin página o un alias que apunte a otro alias
 * rompe la suite el mismo día, sin que nadie tenga que acordarse.
 *
 * La tabla se recorre en DOS niveles, y hacen falta los dos:
 *
 *   - **estructural**, sobre `ROUTE_TABLE` y `ROUTE_ALIAS_TABLE`: barato, exhaustivo y capaz de
 *     decir *por qué* falla. Detecta la cadena de alias y el id sin componente.
 *   - **montando la App de verdad**: porque «el id está en la lista» no prueba que la vista se
 *     pinte. Un componente que no monta, un import circular o un alias tapado por otro se ven
 *     acá y no en la comprobación estructural.
 */

/** Qué tiene que verse cuando una ruta resuelve BIEN. Es el contrato, no una copia del código. */
interface Destino {
  /** Texto del `<h1>` de la vista, o `undefined` si la vista no tiene encabezado propio. */
  encabezado?: RegExp;
  /** Marca de texto para las vistas sin `<h1>` (los avisos de ruta retirada). */
  marca?: RegExp;
}

const DESTINOS: Record<string, Destino> = {
  '': { encabezado: /cauce en una pantalla/i },
  live: { encabezado: /^la flota ahora$/i },
  accounts: { encabezado: /^cuentas y cuotas$/i },
  messages: { encabezado: /^mensajes$/i },
  queues: { encabezado: /queues, retries & dlq/i },
  observability: { encabezado: /^señales y auditoría$/i },
  /*
   * El `h1` dice EXACTAMENTE lo que dice la entrada del menú. Decía «Ajustes & rollback» debajo de
   * un antetítulo en inglés («ATOMIC CONTROL PLANE») mientras el menú decía «Ajustes y altas»:
   * tres nombres para una pantalla, y ninguno de los tres confirma que llegaste a donde ibas. El
   * ancla `^…$` no es decoración — es lo que impide que vuelva a haber dos nombres.
   */
  config: { encabezado: /^ajustes y altas$/i },
  terminal: { encabezado: /^ultimate terminal$/i },
  /** Sin `<h1>`: son avisos, no vistas. Ver `FleetRouteNotice` y `JobsRetiredNotice`. */
  fleet: { marca: /esa dirección ya no identifica a nadie/i },
  jobs: { marca: /«Jobs» ya no es una vista de esta consola/i },
};

/**
 * `/fleet` es el ÚNICO id que a la vez es una ruta declarada y una clave de alias, y no es un
 * descuido: el alias vale para `/fleet` a secas —la lista, que se fundió en «La flota ahora»— y
 * NO para `/fleet/:tenant/:alias`, que es el detalle de un bot y sigue siendo el destino del pie
 * del cajón. `matchRoute` tiene ese caso escrito con nombre y apellido.
 *
 * La excepción se declara acá, en una lista de UNO, justamente para que agregar una segunda rompa
 * la suite: cualquier otro id tapado por un alias es inalcanzable y nadie se entera. Fue lo que
 * pasó con `topology`, que tenía entrada de ruta, alias hacia `live` y un comentario en
 * `TopologyPage.tsx` prometiendo que «sigue siendo alcanzable». No lo era.
 */
const SOMBRA_PERMITIDA = ['fleet'];

/** Cómo se alcanza cada ruta oculta: no tienen entrada de menú, y algunas piden parámetros. */
const RUTA_DIRECTA: Record<string, string> = {
  /** Con UN parámetro: con dos sería el detalle de un bot, y con cero manda el alias a `/live`. */
  fleet: '/fleet/Miguel',
  jobs: '/jobs',
};

async function verDestino(id: string) {
  const destino = DESTINOS[id];
  if (!destino) throw new Error(`la tabla DESTINOS no declara qué se ve en «/${id}»`);
  if (destino.encabezado) {
    return screen.findByRole('heading', { level: 1, name: destino.encabezado });
  }
  return screen.findByText(destino.marca!);
}

// ================================================================================================
// Nivel 1 · estructural. Sin montar nada: dice POR QUÉ falla.
// ================================================================================================

describe('la tabla de rutas', () => {
  it('no declara dos veces el mismo id', () => {
    const ids = ROUTE_TABLE.map((route) => route.id);
    expect([...new Set(ids)]).toEqual(ids);
  });

  it('cada ruta declarada tiene un componente: un `undefined` acá es una pantalla en blanco', () => {
    // `routes` se construye mapeando NAV_ENTRIES contra el diccionario PAGES. Un id del menú que
    // falte en PAGES entra en la lista con `component: undefined`, pasa el typecheck y revienta al
    // renderizar. Es el fallo más barato de cometer al integrar dos ramas que tocan las dos listas.
    const sinComponente = ROUTE_TABLE.filter((route) => typeof route.component !== 'function');
    expect(sinComponente.map((route) => route.id)).toEqual([]);
  });

  it('las entradas del menú son exactamente las que tienen rótulo, y ninguna está vacía', () => {
    const conRotulo = ROUTE_TABLE.filter((route) => route.label !== '');
    expect(conRotulo.map((route) => route.id)).toEqual(NAV_ENTRIES.map((entry) => entry.id));
    for (const entrada of conRotulo) expect(entrada.label.trim()).not.toBe('');
  });

  it('la tabla de este fichero cubre TODAS las rutas: una ruta nueva sin destino declarado falla acá', () => {
    // Sin esto, agregar una ruta y olvidarse de probarla no rompería nada: la tabla de abajo
    // simplemente no la recorrería, y el hueco sería invisible.
    expect(ROUTE_TABLE.map((route) => route.id).filter((id) => !(id in DESTINOS))).toEqual([]);
  });
});

describe('la tabla de alias', () => {
  it('cada alias apunta a una ruta que EXISTE', () => {
    const ids = new Set(ROUTE_TABLE.map((route) => route.id));
    const rotos = Object.entries(ROUTE_ALIAS_TABLE).filter(([, destino]) => !ids.has(destino));
    expect(rotos).toEqual([]);
  });

  it('🔴 NINGÚN alias apunta a otro alias: `matchRoute` resuelve el mapa UNA sola vez', () => {
    // El fallo que este test existe para impedir: `licenses → quotas` cuando `quotas → accounts`.
    // El id resuelto (`quotas`) ya no está en `routes`, así que `/licenses` termina en el fallback
    // con la barra de direcciones diciendo `/licenses`. No hay error de ningún tipo.
    const claves = new Set(Object.keys(ROUTE_ALIAS_TABLE));
    const encadenados = Object.entries(ROUTE_ALIAS_TABLE)
      .filter(([, destino]) => claves.has(destino))
      .map(([origen, destino]) => `${origen} → ${destino} → ${ROUTE_ALIAS_TABLE[destino]}`);
    expect(encadenados).toEqual([]);
  });

  it('🔴 ningún id de ruta queda TAPADO por un alias, salvo la excepción declarada de /fleet', () => {
    // Un id que es también clave de alias no se puede alcanzar nunca: `matchRoute` mira el mapa
    // ANTES que `routes`. La entrada de ruta queda viva en el código, con su import y su
    // componente, y sin forma de llegar. Pasó con `topology`.
    const claves = new Set(Object.keys(ROUTE_ALIAS_TABLE));
    const tapadas = ROUTE_TABLE
      .map((route) => route.id)
      .filter((id) => claves.has(id) && !SOMBRA_PERMITIDA.includes(id));
    expect(tapadas).toEqual([]);
  });

  it('ningún alias se llama igual que una entrada del menú', () => {
    const menu = new Set(NAV_ENTRIES.map((entry) => entry.id));
    expect(Object.keys(ROUTE_ALIAS_TABLE).filter((clave) => menu.has(clave))).toEqual([]);
  });
});

// ================================================================================================
// Nivel 2 · montando la App. «Está en la lista» no es «se pinta».
// ================================================================================================

beforeEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('cada entrada del MENÚ resuelve a una vista real', () => {
  it.each(NAV_ENTRIES.map((entry) => [entry.id || '(portada)', entry.id, entry.label] as const))(
    '/%s → «%s» dibuja «%s»',
    async (_nombre, id) => {
      window.history.pushState({}, '', `/${id}`);
      renderWithApi(<App />);

      expect(await verDestino(id)).toBeInTheDocument();
      // Y NO cayó al fallback: la portada tiene su propio encabezado, y ninguna otra vista puede
      // mostrarlo. Sin esta línea, un id retirado pasaría el test dibujando la portada.
      if (id !== '') {
        expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
      }
      // La barra de direcciones no se mueve: una ruta canónica no es un alias.
      expect(window.location.pathname).toBe(`/${id}`);
    },
  );
});

describe('cada ruta OCULTA resuelve a lo suyo, que no es el fallback', () => {
  it.each(
    ROUTE_TABLE.filter((route) => route.label === '').map((route) => [route.id] as const),
  )('/%s no cae en la portada', async (id) => {
    window.history.pushState({}, '', RUTA_DIRECTA[id] ?? `/${id}`);
    renderWithApi(<App />);

    expect(await verDestino(id)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
  });
});

describe('cada ALIAS declarado llega a su heredera y reescribe la barra de direcciones', () => {
  it.each(Object.entries(ROUTE_ALIAS_TABLE).map(([origen, destino]) => [origen, destino] as const))(
    '/%s → /%s',
    async (origen, destino) => {
      window.history.pushState({}, '', `/${origen}`);
      renderWithApi(<App />);

      // 1) Se ve la vista heredera, no el fallback. Ésta es la mitad que agarra el alias
      //    encadenado: un alias roto dibuja la portada y la comprobación de abajo la delataría
      //    igual, pero ésta dice cuál es la vista que faltó.
      expect(await verDestino(destino)).toBeInTheDocument();
      // 2) Y la URL se reescribió. Un alias que dibuja bien pero deja la barra en la ruta muerta
      //    deja al botón «atrás» dando vueltas, que es el defecto que ROUTE_ALIASES existe para
      //    evitar. `replaceState` corre en un efecto, así que se espera.
      await waitFor(() => expect(window.location.pathname).toBe(`/${destino}`));
    },
  );
});

/**
 * El CONTROL NEGATIVO de todo lo de arriba.
 *
 * Sin él, esta suite podría estar pasando porque el fallback dibuja algo parecido a todo. Estos
 * dos casos fijan qué pinta tiene el fallback de verdad, para que «resolvió bien» signifique algo.
 */
describe('el fallback, para que «no cayó al fallback» quiera decir algo', () => {
  it('un id que NO existe cae en la portada, y ahí sí se ve su encabezado', async () => {
    window.history.pushState({}, '', '/ruta-que-nadie-declaro');
    renderWithApi(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeInTheDocument();
  });

  it('un id retirado SIN alias ni ruta oculta también cae ahí: por eso /jobs tiene su aviso', async () => {
    // `/adapters` tiene alias, `/jobs` tiene aviso. Éste no tiene ninguno de los dos, y se ve.
    window.history.pushState({}, '', '/assignments-viejo');
    renderWithApi(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeInTheDocument();
  });
});
