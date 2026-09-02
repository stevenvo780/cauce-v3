import { screen, waitFor } from '@testing-library/react';
import { App } from './App';
import { ROUTE_ALIAS_TABLE, ROUTE_TABLE } from './App';
import { NAV_ENTRIES } from './nav';
import { renderWithApi } from './test/render';

/**
 * Tests on the route and alias tables and structure of the console router.
 */

/** What must be seen when a route resolves WELL. It is the contract, not a copy of the code. */
interface Destino {
  /** Text of the view's `<h1>`, or `undefined` if the view has no own header. */
  encabezado?: RegExp;
  /** Text marker for views without an `<h1>` (the retired-route notices). */
  marca?: RegExp;
}

const DESTINOS: Record<string, Destino> = {
  '': { encabezado: /cauce en una pantalla/i },
  live: { encabezado: /^la flota ahora$/i },
  accounts: { encabezado: /^cuentas y cuotas$/i },
  messages: { encabezado: /^mensajes$/i },
  queues: { encabezado: /colas y dlq operativo/i },
  observability: { encabezado: /^señales y auditoría$/i },
  /* The `h1` matches the menu entry name exactly. The `^…$` anchor ensures title consistency. */
  config: { encabezado: /^ajustes y altas$/i },
  terminal: { encabezado: /^terminal de agentes$/i },
  ayuda: { encabezado: /^ayuda y documentación$/i },
};

/** How each hidden route is reached: they have no menu entry. */
const RUTA_DIRECTA: Record<string, string> = {
  ayuda: '/ayuda',
};

/** The deep link of every route that declares an `arity`, as the segments past its id. */
const ENLACE_PROFUNDO: Record<string, readonly string[]> = {
  messages: ['Steven', 'kant'],
  terminal: ['Steven', 'kant'],
};

const CON_ARIDAD = ROUTE_TABLE.filter((route) => route.arity !== undefined);

async function verDestino(id: string) {
  const destino: Destino | undefined = (DESTINOS as Partial<Record<string, Destino>>)[id];
  if (!destino) throw new Error(`the DESTINOS table does not declare what is shown at "/${id}"`);
  if (destino.encabezado) {
    return screen.findByRole('heading', { level: 1, name: destino.encabezado }, { timeout: 10_000 });
  }
  if (!destino.marca) {
    throw new Error(`the destination "/${id}" declares neither header nor marker`);
  }
  return screen.findByText(destino.marca, undefined, { timeout: 10_000 });
}

// ================================================================================================
// Level 1 · structural. Without mounting anything: it says WHY it failed.
// ================================================================================================

describe('the route table', () => {
  it('does not declare the same id twice', () => {
    const ids = ROUTE_TABLE.map((route) => route.id);
    expect([...new Set(ids)]).toEqual(ids);
  });

  it('every declared route has a component: an `undefined` here is a blank screen', () => {
    // `routes` is built by mapping NAV_ENTRIES against the PAGES dictionary. A menu id missing
    // from PAGES enters the list with `component: undefined`, passes the typecheck, and blows up
    // at render. It is the cheapest failure when integrating two branches that touch both lists.
    const sinComponente = ROUTE_TABLE.filter((route) => typeof route.component !== 'function');
    expect(sinComponente.map((route) => route.id)).toEqual([]);
  });

  it('menu entries are exactly those with a label, and none is empty', () => {
    const conRotulo = ROUTE_TABLE.filter((route) => route.label !== '');
    expect(conRotulo.map((route) => route.id)).toEqual(NAV_ENTRIES.map((entry) => entry.id));
    for (const entrada of conRotulo) expect(entrada.label.trim()).not.toBe('');
  });

  it("this file's table covers ALL routes: a new route with no declared destination fails here", () => {
    // Without this, adding a route and forgetting to test it would not break anything: the table
    // below would simply not walk it, and the gap would be invisible.
    expect(ROUTE_TABLE.map((route) => route.id).filter((id) => !(id in DESTINOS))).toEqual([]);
  });
});

describe('the alias table', () => {
  it('every alias points to a route that EXISTS', () => {
    const ids = new Set(ROUTE_TABLE.map((route) => route.id));
    const rotos = Object.entries(ROUTE_ALIAS_TABLE).filter(([, destino]) => !ids.has(destino));
    expect(rotos).toEqual([]);
  });

  it('🔴 NO alias points to another alias: `matchRoute` resolves the map a SINGLE time', () => {
    // The failure this test exists to prevent: `licenses → quotas` when `quotas → accounts`.
    // The resolved id (`quotas`) is no longer in `routes`, so `/licenses` ends up in the fallback
    // with the address bar still saying `/licenses`. There is no error of any kind.
    const claves = new Set(Object.keys(ROUTE_ALIAS_TABLE));
    const encadenados = Object.entries(ROUTE_ALIAS_TABLE)
      .filter(([, destino]) => claves.has(destino))
      .map(([origen, destino]) => `${origen} → ${destino} → ${ROUTE_ALIAS_TABLE[destino]}`);
    expect(encadenados).toEqual([]);
  });

  it('🔴 no route id is COVERED by an alias', () => {
    // An id that is also an alias key can never be reached: `matchRoute` looks at the map
    // BEFORE `routes`. The route entry stays alive in code, with its import and its component,
    // and no way to reach it. That happened with `topology`.
    const claves = new Set(Object.keys(ROUTE_ALIAS_TABLE));
    const tapadas = ROUTE_TABLE
      .map((route) => route.id)
      .filter((id) => claves.has(id));
    expect(tapadas).toEqual([]);
  });

  it('no alias shares a name with a menu entry', () => {
    const menu = new Set(NAV_ENTRIES.map((entry) => entry.id));
    expect(Object.keys(ROUTE_ALIAS_TABLE).filter((clave) => menu.has(clave))).toEqual([]);
  });
});

describe('the routes that accept a deep link', () => {
  it('🔴 every route with an arity declares a deep link of exactly that length', () => {
    const sinEnlace = CON_ARIDAD.filter((route) => ENLACE_PROFUNDO[route.id]?.length !== route.arity);
    expect(sinEnlace.map((route) => route.id)).toEqual([]);
  });

  it('no deep link is declared for a route that would reject every segment', () => {
    const conAridad = new Set(CON_ARIDAD.map((route) => route.id));
    expect(Object.keys(ENLACE_PROFUNDO).filter((id) => !conAridad.has(id))).toEqual([]);
  });
});

// ================================================================================================
// Level 2 · mounting the App. "It is in the list" is not "it gets drawn".
// ================================================================================================

beforeEach(() => {
  window.history.replaceState({}, '', '/');
});

describe('every MENU entry resolves to a real view', () => {
  it.each(NAV_ENTRIES.map((entry) => [entry.id || '(cover)', entry.id, entry.label] as const))(
    '/%s → "%s" draws "%s"',
    async (_nombre, id) => {
      window.history.pushState({}, '', `/${id}`);
      renderWithApi(<App />);

      expect(await verDestino(id)).toBeInTheDocument();
      // And it did NOT fall back to the cover: the cover has its own header, and no other view
      // can show it. Without this line, a retired id would pass the test by drawing the cover.
      if (id !== '') {
        expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
      }
      // The address bar does not move: a canonical route is not an alias.
      expect(window.location.pathname).toBe(`/${id}`);
    },
  );
});

describe('every HIDDEN route resolves to its own, which is not the fallback', () => {
  it.each(
    ROUTE_TABLE.filter((route) => route.label === '').map((route) => [route.id] as const),
  )('/%s does not fall into the cover', async (id) => {
    window.history.pushState({}, '', RUTA_DIRECTA[id] ?? `/${id}`);
    renderWithApi(<App />);

    expect(await verDestino(id)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
  });
});

describe('every declared ALIAS reaches its heir and rewrites the address bar', () => {
  it.each(Object.entries(ROUTE_ALIAS_TABLE).map(([origen, destino]) => [origen, destino] as const))(
    '/%s → /%s',
    async (origen, destino) => {
      window.history.pushState({}, '', `/${origen}`);
      renderWithApi(<App />);

      // 1) The heir view is shown, not the fallback. This is the half that catches a chained
      //    alias: a broken alias draws the cover and the check below would catch it too, but
      //    this one says WHICH view was missing.
      expect(await verDestino(destino)).toBeInTheDocument();
      // 2) And the URL was rewritten. An alias that draws fine but leaves the bar on the dead
      //    route leaves the "back" button spinning, which is the defect ROUTE_ALIASES exists to
      //    prevent. `replaceState` runs in an effect, so it is awaited.
      await waitFor(() => { expect(window.location.pathname).toBe(`/${destino}`); });
    },
  );
});

describe('a deep link draws its view, and any other arity the explicit 404', () => {
  const casos = CON_ARIDAD.map((route) => [route.id, ENLACE_PROFUNDO[route.id]] as const);

  it.each(casos)('/%s/… reaches the view that declares the arity', async (id, segmentos) => {
    window.history.pushState({}, '', `/${id}/${segmentos.join('/')}`);
    renderWithApi(<App />);

    expect(await verDestino(id)).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeNull();
  });

  it.each(casos)('CONTROL — /%s/… with one extra segment keeps the address as a 404', async (id, segmentos) => {
    const ruta = `/${id}/${segmentos.join('/')}/sobrante`;
    window.history.pushState({}, '', ruta);
    renderWithApi(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i }, { timeout: 10_000 }))
      .toBeInTheDocument();
    expect(window.location.pathname).toBe(ruta);
  });
});

/** The NEGATIVE CONTROL of everything above: without it the suite would not demonstrate that an
    address outside the tables keeps its URL and is distinguishable from a valid view. */
describe('the explicit state for unknown addresses', () => {
  it('an id that DOES NOT exist keeps the URL and does not invent the cover', async () => {
    window.history.pushState({}, '', '/ruta-que-nadie-declaro');
    renderWithApi(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeInTheDocument();
    expect(screen.getByText('/ruta-que-nadie-declaro')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
    expect(window.location.pathname).toBe('/ruta-que-nadie-declaro');
  });

  it('a retired id without an alias is also declared broken', async () => {
    window.history.pushState({}, '', '/assignments-viejo');
    renderWithApi(<App />);

    expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
  });
});
