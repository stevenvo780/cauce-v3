import { screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { ROUTE_ALIAS_TABLE, ROUTE_TABLE } from './App';
import { NAV_ENTRIES } from './nav';
import { renderWithApi } from './test/render';

/**
 * Pruebas sobre la tabla y estructura de rutas y alias del enrutador de la consola.
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
  queues: { encabezado: /colas y dlq operativo/i },
  observability: { encabezado: /^señales y auditoría$/i },
  /*
   * El `h1` dice EXACTAMENTE lo que dice la entrada del menú. Decía «Ajustes & rollback» debajo de
   * un antetítulo en inglés («ATOMIC CONTROL PLANE») mientras el menú decía «Ajustes y altas»:
   * tres nombres para una pantalla, y ninguno de los tres confirma que llegaste a donde ibas. El
   * ancla `^…$` no es decoración — es lo que impide que vuelva a haber dos nombres.
   */
  config: { encabezado: /^ajustes y altas$/i },
  terminal: { encabezado: /^terminal de agentes$/i },
  ayuda: { encabezado: /^ayuda y documentación$/i },
};

/** Cómo se alcanza cada ruta oculta: no tienen entrada de menú. */
const RUTA_DIRECTA: Record<string, string> = {
  ayuda: '/ayuda',
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

  it('🔴 ningún id de ruta queda TAPADO por un alias', () => {
    // Un id que es también clave de alias no se puede alcanzar nunca: `matchRoute` mira el mapa
    // ANTES que `routes`. La entrada de ruta queda viva en el código, con su import y su
    // componente, y sin forma de llegar. Pasó con `topology`.
    const claves = new Set(Object.keys(ROUTE_ALIAS_TABLE));
    const tapadas = ROUTE_TABLE
      .map((route) => route.id)
      .filter((id) => claves.has(id));
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
 * Sin él, la suite no demostraría que una dirección ajena a las tablas conserva su URL y se
 * distingue de una vista válida. Estos casos fijan la cara del 404 explícito.
 */
describe('el estado explícito para direcciones desconocidas', () => {
  it('un id que NO existe conserva la URL y no inventa la portada', async () => {
    window.history.pushState({}, '', '/ruta-que-nadie-declaro');
    renderWithApi(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeInTheDocument();
    expect(screen.getByText('/ruta-que-nadie-declaro')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
    expect(window.location.pathname).toBe('/ruta-que-nadie-declaro');
  });

  it('un id retirado sin alias también se declara roto', async () => {
    window.history.pushState({}, '', '/assignments-viejo');
    renderWithApi(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
  });
});
