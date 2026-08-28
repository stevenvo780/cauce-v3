import { describe, expect, it } from 'vitest';
import { mockActivity, topology } from '../../mocks/data';
import { layoutHypergraph } from './hypergraph/hypergraph-layout';
import {
  agentKey,
  buildLiveViews,
  delegationEdges,
  AVATAR_MAX,
  AVATAR_MIN,
  AVATAR_UNIFORME,
  aggregateEdges,
  grosorDe,
  radioDe,
  humanOrigins,
  origenDeItem,
} from './agent-state';
import { agent, snapshot } from './agent-state-fixtures';

const NOW = 1_700_000_000_000;

describe('delegationEdges', () => {
  it('deriva la arista a→b de la entrega que b tiene en vuelo y mandó a', () => {
    const edges = delegationEdges(snapshot([
      agent({ tenant_id: 'Steven', alias: 'kant' }),
      agent({
        tenant_id: 'Miguel',
        alias: 'kratos',
        in_flight: 1,
        in_flight_items: [{ delivery_id: 'd1', from_tenant: 'Steven', from_alias: 'kant', lane: 'interactive' }],
      }),
    ]));
    expect(edges).toEqual([expect.objectContaining({ from: 'Steven/kant', to: 'Miguel/kratos', deliveryId: 'd1' })]);
  });

  it('descarta la auto-arista del puente de Telegram (una persona escribiendo, no una delegación)', () => {
    // El puente publica el mensaje del dueño con el alias del propio agente: from == to.
    const edges = delegationEdges(snapshot([
      agent({
        tenant_id: 'Isa',
        alias: 'salva',
        in_flight_items: [{ delivery_id: 'd1', from_tenant: 'Isa', from_alias: 'salva', origin_adapter: 'telegram' }],
      }),
    ]));
    expect(edges).toEqual([]);
  });

  it('descarta un emisor que no es ningún alias de la flota', () => {
    const edges = delegationEdges(snapshot([
      agent({ in_flight_items: [{ delivery_id: 'd1', from_tenant: 'Steven', from_alias: 'una-persona' }] }),
    ]));
    expect(edges).toEqual([]);
  });
});

describe('buildLiveViews', () => {
  it('cruza aristas y estados: el emisor delega y el receptor trabaja', () => {
    const { views, edges } = buildLiveViews(snapshot([
      agent({ tenant_id: 'Steven', alias: 'kant', work_state: 'idle' }),
      agent({
        tenant_id: 'Miguel',
        alias: 'kratos',
        work_state: 'working',
        in_flight: 1,
        started: 1,
        in_flight_items: [{ delivery_id: 'd1', from_tenant: 'Steven', from_alias: 'kant', status: 'started' }],
      }),
    ]), {}, NOW);

    expect(edges).toHaveLength(1);
    const kant = views.find((view) => view.alias === 'kant');
    const kratos = views.find((view) => view.alias === 'kratos');
    expect(kant?.state).toBe('delegating');
    expect(kant?.delegatesTo).toEqual(['Miguel/kratos']);
    expect(kratos?.state).toBe('thinking');
    expect(kratos?.delegatedFrom).toEqual(['Steven/kant']);
  });

  it('sobrevive a un snapshot ausente sin inventar agentes', () => {
    expect(buildLiveViews(undefined, {}, NOW)).toEqual({ views: [], edges: [] });
  });
});

/**
 * El panel "quién le habla a quién, ahora" sólo dibuja flechas si el snapshot trae entregas en
 * vuelo con emisor. Esto no es una propiedad del componente sino del DATO, y es exactamente lo que
 * se rompió antes: la vista se publicó con un fixture cuyas entregas eran anónimas o venían de
 * alias que la topología no declara, así que se veían los muñecos y las salas y ni una delegación.
 * Un dibujo vacío no se distingue de "nadie está trabajando", que es la respuesta contraria.
 */
describe('la topología y la actividad de demostración se corresponden', () => {
  const actividad = mockActivity();
  const agentes = actividad.agents ?? [];
  const nodos = new Set(
    layoutHypergraph(topology, { width: 1040, height: 660, padding: 46, nodeSpacing: 96 })
      .nodes.map((node) => `${node.tenants[0]}/${node.alias}`),
  );

  it('coloca a cada agente de la actividad dentro de una sala declarada', () => {
    const sinSala = agentes.map(agentKey).filter((key) => !nodos.has(key));
    expect(sinSala).toEqual([]);
  });

  it('produce delegaciones dibujables entre alias que la topología ubica', () => {
    const edges = delegationEdges(actividad);
    const dibujables = edges.filter((edge) => nodos.has(edge.from) && nodos.has(edge.to));
    // El umbral es deliberadamente flojo: lo que hay que impedir es el CERO y el "una sola
    // relación repetida", no clavar un número que se rompa al ajustar el fixture.
    expect(dibujables.length).toBeGreaterThanOrEqual(10);
    expect(new Set(dibujables.map((edge) => `${edge.from}->${edge.to}`)).size).toBeGreaterThanOrEqual(6);
  });

  it('incluye alguna entrega pasada de los 300 s, que es la que se pinta en ámbar', () => {
    const lentas = delegationEdges(actividad).filter((edge) => (edge.secondsInFlight ?? 0) > 300);
    expect(lentas.length).toBeGreaterThan(0);
  });

  it('no dibuja el mensaje que un alias se publica a sí mismo: es una persona, no una delegación', () => {
    const propias = agentes.flatMap((a) => (a.in_flight_items ?? [])
      .filter((item) => item.from_tenant === a.tenant_id && item.from_alias === a.alias));
    expect(propias.length).toBeGreaterThan(0);
    expect(delegationEdges(actividad).some((edge) => edge.from === edge.to)).toBe(false);
  });
});

describe('aggregateEdges', () => {
  it('junta en UNA arista las N entregas del mismo par y se queda con la más vieja', () => {
    const agregadas = aggregateEdges([
      { from: 'Steven/zeus', to: 'Steven/kant', secondsInFlight: 40 },
      { from: 'Steven/zeus', to: 'Steven/kant', secondsInFlight: 610 },
      { from: 'Steven/argos', to: 'Steven/kant', secondsInFlight: 10 },
    ]);
    expect(agregadas.size).toBe(2);
    const par = agregadas.get('Steven/zeus→Steven/kant');
    expect(par?.inFlight).toBe(2);
    expect(par?.oldestSeconds).toBe(610);
    expect(par?.totalFromServer).toBe(false);
  });

  it('la ida y la vuelta son DOS aristas: contarlas juntas duplicaría cada conversación', () => {
    const agregadas = aggregateEdges([
      { from: 'Miguel/kratos', to: 'Miguel/janus', secondsInFlight: 10 },
      { from: 'Miguel/janus', to: 'Miguel/kratos', secondsInFlight: 10 },
    ]);
    expect([...agregadas.keys()].sort()).toEqual([
      'Miguel/janus→Miguel/kratos', 'Miguel/kratos→Miguel/janus',
    ]);
  });

  it('el volumen de la ventana lo manda el servidor, y el "en vuelo" sigue siendo el del snapshot', () => {
    const agregadas = aggregateEdges(
      [{ from: 'Steven/zeus', to: 'Steven/kant', secondsInFlight: 40 }],
      [{ from_tenant: 'Steven', from_alias: 'zeus', to_tenant: 'Steven', to_alias: 'kant', in_flight: 99, total_window: 47 }],
    );
    const par = agregadas.get('Steven/zeus→Steven/kant');
    expect(par?.total).toBe(47);
    expect(par?.totalFromServer).toBe(true);
    // El 99 del servidor NO pisa al 1 del snapshot: los muñecos que se están dibujando en esta
    // pasada salen del snapshot, y una flecha que no coincide con ellos es una flecha que miente.
    expect(par?.inFlight).toBe(1);
  });

  it('una arista que sólo conoce el servidor existe igual, con cero en vuelo', () => {
    const agregadas = aggregateEdges([], [
      { from_tenant: 'Pablo', from_alias: 'midas', to_tenant: 'Pablo', to_alias: 'seneca', in_flight: 0, total_window: 12 },
    ]);
    const par = agregadas.get('Pablo/midas→Pablo/seneca');
    expect(par?.inFlight).toBe(0);
    expect(par?.total).toBe(12);
  });
});

describe('humanOrigins', () => {
  it('rescata el encargo que entró por un puente, que delegationEdges tira por from === to', () => {
    // El puente de Telegram publica el mensaje del dueño CON EL ALIAS DEL PROPIO AGENTE. Como
    // delegación es falsa —y por eso se descarta— pero descartarla entera pierde la procedencia:
    // el trabajo aparece de la nada y el mapa sugiere que el agente se lo inventó solo.
    const nieve = snapshot([agent({
      tenant_id: 'Jhon', alias: 'hegel', in_flight: 1,
      in_flight_items: [{
        delivery_id: 'd-1', from_tenant: 'Jhon', from_alias: 'hegel',
        origin_adapter: 'telegram', status: 'leased',
      }],
    })]);

    expect(delegationEdges(nieve)).toEqual([]);
    expect(humanOrigins(nieve)).toEqual([{ agentKey: 'Jhon/hegel', adapter: 'telegram', count: 1 }]);
  });

  it('el tráfico entre agentes ("bus") NO produce un nodo persona: ya lo cuenta la delegación', () => {
    const nieve = snapshot([agent({
      tenant_id: 'Steven', alias: 'kant', in_flight: 1,
      in_flight_items: [{
        delivery_id: 'd-2', from_tenant: 'Steven', from_alias: 'zeus',
        origin_adapter: 'bus', status: 'started',
      }],
    })]);
    expect(humanOrigins(nieve)).toEqual([]);
  });
});

describe('buildLiveViews y el campo que el servidor puede no traer', () => {
  it('closed_24h ausente NO se convierte en cero: queda undefined y la vista lo declara', () => {
    // "No sé cuánto cerró" y "cerró cero" son afirmaciones distintas, y en una pantalla donde el
    // tamaño del muñeco significa "cuánto trabajó", confundirlas es una acusación falsa.
    const { views } = buildLiveViews(snapshot([agent({ alias: 'zeus' })]), {}, NOW);
    expect(views[0].closed24h).toBeUndefined();

    const conDato = buildLiveViews(snapshot([agent({ alias: 'zeus', closed_24h: 0 })]), {}, NOW);
    expect(conDato.views[0].closed24h).toBe(0);
  });
});

describe('radioDe', () => {
  it('sin el campo en NINGÚN agente, todos miden lo mismo: no se inventa una escala', () => {
    // `maxClosed === null` es "el servidor no informa el cierre de 24 h". Dibujar a toda la flota
    // en el radio mínimo haría que "no lo sé" se vea idéntico a "no cerró nada", que en una
    // pantalla donde el tamaño significa cuánto trabajó cada uno es una acusación falsa.
    expect(radioDe(undefined, null)).toBe(AVATAR_UNIFORME);
    expect(radioDe(41, null)).toBe(AVATAR_UNIFORME);
  });

  it('cerrar CERO es un dato y se dibuja en el mínimo; no traer el campo, no', () => {
    expect(radioDe(0, 41)).toBe(AVATAR_MIN);
    // El alias del que el servidor no informa dentro de una flota que sí informa: mínimo también,
    // pero por otra razón — y el globo le quita el pie, que es donde se nota la diferencia.
    expect(radioDe(undefined, 41)).toBe(AVATAR_MIN);
  });

  it('el máximo de la flota llega al tope y ninguno se pasa', () => {
    expect(radioDe(41, 41)).toBe(AVATAR_MAX);
    expect(radioDe(99, 41)).toBe(AVATAR_MAX);
  });

  it('escala por ÁREA, no por radio: el doble de trabajo no puede parecer el cuádruple', () => {
    const mitad = radioDe(50, 100);
    // Con escala lineal sobre el radio, 50/100 daría el punto medio exacto entre 22 y 34 (28).
    // Con raíz, queda por encima — que es lo que hace que las áreas se comparen bien.
    expect(mitad).toBeGreaterThan((AVATAR_MIN + AVATAR_MAX) / 2);
    expect(mitad).toBeLessThan(AVATAR_MAX);
  });
});

describe('grosorDe', () => {
  it('una sola entrega es la línea más fina, y el máximo de la flota la más gruesa', () => {
    expect(grosorDe(1, 1)).toBe(1.5);
    expect(grosorDe(1, 8)).toBe(1.5);
    expect(grosorDe(8, 8)).toBe(5);
  });

  it('tiene techo: una relación muy cargada no puede tapar el mapa', () => {
    expect(grosorDe(500, 8)).toBe(5);
  });
});

// ================================================================================================
// Casos de prueba de derivación de estados y atribución de origen
// ================================================================================================

describe('D1 · atribución de quién pidió el trabajo', () => {
  // `origin` se copia byte a byte en cada salto (packages/protocol/src/schemas.ts).
  const cadenaHeredada = snapshot([
    agent({ tenant_id: 'Steven', alias: 'zeus' }),
    agent({
      tenant_id: 'Steven', alias: 'kant', in_flight: 1,
      in_flight_items: [{
        delivery_id: 'd-heredada', from_tenant: 'Steven', from_alias: 'zeus',
        origin_adapter: 'telegram', status: 'started',
      }],
    }),
  ]);

  it('el MISMO ítem no puede ser a la vez una delegación zeus→kant y un encargo humano', () => {
    expect(delegationEdges(cadenaHeredada)).toEqual([
      expect.objectContaining({ from: 'Steven/zeus', to: 'Steven/kant' }),
    ]);
    expect(humanOrigins(cadenaHeredada)).toEqual([]);
  });

  it('la vista de kant dice que se lo pidió zeus, no "una persona por telegram"', () => {
    const { views } = buildLiveViews(cadenaHeredada, {}, NOW);
    const kant = views.find((view) => view.alias === 'kant');
    expect(kant?.origenes).toEqual([{ tipo: 'agente', tenant: 'Steven', alias: 'zeus' }]);
  });

  it('el puente de verdad SIGUE siendo un puente: from === to es el dueño escribiendo', () => {
    const porTelegram = snapshot([agent({
      tenant_id: 'Jhon', alias: 'hegel', in_flight: 1,
      in_flight_items: [{
        delivery_id: 'd-puente', from_tenant: 'Jhon', from_alias: 'hegel',
        origin_adapter: 'telegram', status: 'leased',
      }],
    })]);
    expect(humanOrigins(porTelegram)).toEqual([{ agentKey: 'Jhon/hegel', adapter: 'telegram', count: 1 }]);
    expect(buildLiveViews(porTelegram, {}, NOW).views[0].origenes)
      .toEqual([{ tipo: 'puente', adapter: 'telegram' }]);
  });

  it('un emisor que no es alias de la flota se nombra, pero no se asciende a "persona"', () => {
    const known = new Set(['Steven/kant']);
    expect(origenDeItem({ from_tenant: 'Steven', from_alias: 'una-persona' }, { selfKey: 'Steven/kant', known }))
      .toEqual({ tipo: 'actor', tenant: 'Steven', alias: 'una-persona' });
  });

  it('sin emisor y por el bus no se atribuye a nadie: se declara desconocido', () => {
    const known = new Set(['Steven/kant']);
    expect(origenDeItem({ origin_adapter: 'bus' }, { selfKey: 'Steven/kant', known }))
      .toEqual({ tipo: 'desconocido' });
    expect(origenDeItem({ from_tenant: 'Steven', from_alias: 'kant', origin_adapter: 'bus' }, { selfKey: 'Steven/kant', known }))
      .toEqual({ tipo: 'desconocido' });
  });

  it('el fixture real de kant trae el caso: argos le delegó con origin_adapter telegram', () => {
    // No es un caso de laboratorio: está en los datos de demostración desde antes del arreglo.
    const actividad = mockActivity();
    const kant = (actividad.agents ?? []).find((a) => a.alias === 'kant');
    const heredada = (kant?.in_flight_items ?? []).find((item) => item.origin_adapter === 'telegram');
    expect(heredada?.from_alias).toBe('argos');
    expect(humanOrigins(actividad).some((origen) => origen.agentKey === 'Steven/kant')).toBe(false);
  });
});
