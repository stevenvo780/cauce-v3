import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, FleetActivitySnapshot } from '../../api/types';
import { mockActivity, topology } from '../../mocks/data';
import { layoutHypergraph } from '../topology/hypergraph-layout';
import {
  BURST_MS,
  agentKey,
  buildLiveViews,
  delegationEdges,
  detectPulses,
  liveState,
  rememberFleet,
  stateTally,
} from './agent-state';

const NOW = 1_700_000_000_000;

function agent(overrides: Partial<FleetActivityAgent> = {}): FleetActivityAgent {
  return {
    tenant_id: 'Steven',
    alias: 'zeus',
    registered: true,
    agent_enabled: true,
    presence: { online: true, lease_until: '2026-08-06T03:00:00.000Z' },
    work_state: 'idle',
    flags: [],
    in_flight: 0,
    started: 0,
    claimed_not_started: 0,
    queued: 0,
    in_flight_items: [],
    ...overrides,
  };
}

function snapshot(agents: FleetActivityAgent[]): FleetActivitySnapshot {
  return { observed_at: '2026-08-06T02:54:49.452Z', thresholds: { saturation_in_flight: 8, stall_after_seconds: 300 }, agents };
}

describe('liveState', () => {
  it('un lease vivo con trabajo tomado hace mucho es BLOQUEADO, no trabajando', () => {
    // Ésta es la lección cara: `presence.online` sigue en true y el latido está fresco. El
    // agente parece sano por todas las señales de conexión y está mudo igual.
    const result = liveState(
      agent({ work_state: 'stalled', in_flight: 1, oldest_in_flight_seconds: 2400, presence: { online: true } }),
      { nowMs: NOW, thresholds: { stall_after_seconds: 300 } },
    );
    expect(result.state).toBe('blocked');
    expect(result.reason).toContain('40 min');
  });

  it('ack_stalled sin ningún ACK en la ventana no se reporta como "hace 0 s"', () => {
    const result = liveState(
      agent({ work_state: 'working', in_flight: 2, flags: ['ack_stalled'], seconds_since_last_ack: null }),
      { nowMs: NOW },
    );
    expect(result.state).toBe('blocked');
    expect(result.reason).toContain('ningún ACK');
    expect(result.reason).not.toContain('0 s');
  });

  it('lease vencido es CAÍDO aunque el agente figure habilitado', () => {
    expect(liveState(agent({ flags: ['lease_expired'] }), { nowMs: NOW }).state).toBe('down');
    expect(liveState(agent({ flags: ['never_connected'] }), { nowMs: NOW }).state).toBe('down');
    expect(liveState(agent({ agent_enabled: false }), { nowMs: NOW }).state).toBe('down');
  });

  it('bloqueado gana sobre delegando: un agente trabado que delegó sigue estando trabado', () => {
    const result = liveState(
      agent({ work_state: 'stalled', in_flight: 1, oldest_in_flight_seconds: 900 }),
      { nowMs: NOW, delegatesTo: ['Steven/kant'] },
    );
    expect(result.state).toBe('blocked');
  });

  it('delegar gana sobre trabajar, y nombra a quién le pasó el trabajo', () => {
    const result = liveState(
      agent({ work_state: 'working', in_flight: 1 }),
      { nowMs: NOW, delegatesTo: ['Miguel/kratos', 'Pablo/midas'] },
    );
    expect(result.state).toBe('delegating');
    expect(result.reason).toContain('kratos');
    expect(result.reason).toContain('midas');
  });

  it('el pulso de respuesta vence solo: pasado BURST_MS vuelve al estado estable', () => {
    const pulses = [{ kind: 'answered' as const, atMs: NOW }];
    expect(liveState(agent(), { nowMs: NOW + 1000, pulses }).state).toBe('responding');
    expect(liveState(agent(), { nowMs: NOW + BURST_MS + 1, pulses }).state).toBe('idle');
  });

  it('entrega tomada y no empezada es RECIBIENDO, no trabajando', () => {
    const result = liveState(agent({ in_flight: 1, claimed_not_started: 1, started: 0 }), { nowMs: NOW });
    expect(result.state).toBe('receiving');
  });

  it('marca saturación contra el umbral del servidor, no contra un número fijo del cliente', () => {
    const busy = agent({ work_state: 'working', in_flight: 4 });
    expect(liveState(busy, { nowMs: NOW, thresholds: { saturation_in_flight: 8 } }).overloaded).toBe(false);
    expect(liveState(busy, { nowMs: NOW, thresholds: { saturation_in_flight: 3 } }).overloaded).toBe(true);
  });

  it('conectado y sin nada en vuelo es OCIOSO', () => {
    expect(liveState(agent(), { nowMs: NOW }).state).toBe('idle');
  });
});

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

describe('detectPulses', () => {
  it('no emite nada en el primer snapshot: abrir la consola no dispara animaciones falsas', () => {
    const first = snapshot([agent({ in_flight: 1, in_flight_items: [{ delivery_id: 'd1' }] })]);
    expect(detectPulses({}, first, NOW)).toEqual({});
  });

  it('un delivery_id nuevo es "recibido" y uno que desaparece es "respondido"', () => {
    const before = rememberFleet(snapshot([agent({ in_flight_items: [{ delivery_id: 'd1' }] })]), NOW);
    const after = snapshot([agent({ in_flight_items: [{ delivery_id: 'd2' }] })]);
    const pulses = detectPulses(before, after, NOW + 4000);
    expect(pulses['Steven/zeus']).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'received', deliveryId: 'd2' }),
      expect.objectContaining({ kind: 'answered', deliveryId: 'd1' }),
    ]));
  });

  it('una cola que crece sin entrega en vuelo también cuenta como trabajo entrante', () => {
    const before = rememberFleet(snapshot([agent({ queued: 0 })]), NOW);
    const pulses = detectPulses(before, snapshot([agent({ queued: 2 })]), NOW + 4000);
    expect(pulses['Steven/zeus']).toEqual([expect.objectContaining({ kind: 'received' })]);
  });

  it('sin cambios no hay pulsos', () => {
    const before = rememberFleet(snapshot([agent({ in_flight_items: [{ delivery_id: 'd1' }] })]), NOW);
    expect(detectPulses(before, snapshot([agent({ in_flight_items: [{ delivery_id: 'd1' }] })]), NOW + 4000)).toEqual({});
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

  it('el recuento publica los siete estados aunque estén en cero', () => {
    const { views } = buildLiveViews(snapshot([agent()]), {}, NOW);
    const tally = stateTally(views);
    expect(Object.keys(tally).sort()).toEqual(
      ['blocked', 'delegating', 'down', 'idle', 'receiving', 'responding', 'thinking'],
    );
    expect(tally.idle).toBe(1);
    expect(tally.down).toBe(0);
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
