import { describe, expect, it } from 'vitest';
import { mockActivity, topology } from '../../mocks/data';
import {
  agentKey,
  buildLiveViews,
  delegationEdges,
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
    // The bridge publishes the owner's message using the agent's own alias: from == to.
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
 * The "who is talking to whom, now" panel only draws arrows if the snapshot brings in-flight
 * deliveries with a sender. This is not a property of the component but of the DATA, and it is
 * exactly what broke before: the view was published with a fixture whose deliveries were
 * anonymous or came from aliases the topology does not declare, so the bots and the rooms showed
 * up and not a single delegation. An empty drawing is indistinguishable from "nobody is
 * working", which is the opposite answer.
 */
describe('la topología y la actividad de demostración se corresponden', () => {
  const actividad = mockActivity();
  const agentes = actividad.agents ?? [];
  const nodos = new Set((topology.tenants ?? []).flatMap((tenant) => (tenant.rooms ?? [])
    .flatMap((room) => (room.members ?? []).map((member) => `${tenant.id ?? ''}/${member.alias ?? ''}`))));

  it('coloca a cada agente de la actividad dentro de una sala declarada', () => {
    const sinSala = agentes.map(agentKey).filter((key) => !nodos.has(key));
    expect(sinSala).toEqual([]);
  });

  it('produce delegaciones dibujables entre alias que la topología ubica', () => {
    const edges = delegationEdges(actividad);
    const dibujables = edges.filter((edge) => nodos.has(edge.from) && nodos.has(edge.to));
    // The threshold is deliberately loose: what must be prevented is ZERO and "one repeated
    // relation", not pinning a number that breaks when the fixture is adjusted.
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

describe('origen de un encargo que entró por un puente', () => {
  it('rescata el encargo que entró por un puente, que delegationEdges tira por from === to', () => {
    // The Telegram bridge publishes the owner's message USING THE AGENT'S OWN ALIAS. As a
    // delegation it is false — and that is why it is discarded — but discarding it entirely loses
    // the provenance: the work appears from nowhere and the map suggests the agent made it up.
    const nieve = snapshot([agent({
      tenant_id: 'Jhon', alias: 'hegel', in_flight: 1,
      in_flight_items: [{
        delivery_id: 'd-1', from_tenant: 'Jhon', from_alias: 'hegel',
        origin_adapter: 'telegram', status: 'leased',
      }],
    })]);

    expect(delegationEdges(nieve)).toEqual([]);
    expect(buildLiveViews(nieve, {}, NOW).views[0].origenes).toEqual([{ tipo: 'puente', adapter: 'telegram' }]);
  });

  it('el tráfico entre agentes ("bus") NO se atribuye a una persona', () => {
    const nieve = snapshot([agent({
      tenant_id: 'Steven', alias: 'kant', in_flight: 1,
      in_flight_items: [{
        delivery_id: 'd-2', from_tenant: 'Steven', from_alias: 'zeus',
        origin_adapter: 'bus', status: 'started',
      }],
    })]);
    expect(buildLiveViews(nieve, {}, NOW).views[0].origenes.some((origen) => origen.tipo === 'puente')).toBe(false);
  });
});

describe('buildLiveViews y el campo que el servidor puede no traer', () => {
  it('closed_24h ausente NO se convierte en cero: queda undefined y la vista lo declara', () => {
    // "I don't know how much it closed" and "closed zero" are different assertions, and on a
    // screen where the bot's size means "how much it worked", confusing them is a false
    // accusation.
    const { views } = buildLiveViews(snapshot([agent({ alias: 'zeus' })]), {}, NOW);
    expect(views[0].closed24h).toBeUndefined();

    const conDato = buildLiveViews(snapshot([agent({ alias: 'zeus', closed_24h: 0 })]), {}, NOW);
    expect(conDato.views[0].closed24h).toBe(0);
  });
});

// ================================================================================================
// Test cases for state derivation and origin attribution
// ================================================================================================

describe('D1 · atribución de quién pidió el trabajo', () => {
  // `origin` is copied byte for byte at every hop (packages/protocol/src/schemas.ts).
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
    expect(buildLiveViews(cadenaHeredada, {}, NOW).views.flatMap((view) => view.origenes)
      .some((origen) => origen.tipo === 'puente')).toBe(false);
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
    // Not a laboratory case: it has been in the demo data since before the fix.
    const actividad = mockActivity();
    const kant = (actividad.agents ?? []).find((a) => a.alias === 'kant');
    const heredada = (kant?.in_flight_items ?? []).find((item) => item.origin_adapter === 'telegram');
    expect(heredada?.from_alias).toBe('argos');
    const vista = buildLiveViews(actividad, {}, NOW).views.find((view) => view.key === 'Steven/kant');
    expect(vista?.origenes.some((origen) => origen.tipo === 'puente')).toBe(false);
  });
});
