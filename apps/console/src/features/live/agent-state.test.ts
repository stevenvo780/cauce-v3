import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, FleetActivitySnapshot } from '../../api/types';
import { mockActivity, topology } from '../../mocks/data';
import { layoutHypergraph } from '../topology/hypergraph-layout';
import {
  BURST_MS,
  LIVE_STATE_META,
  agentKey,
  buildLiveViews,
  delegationEdges,
  detectPulses,
  AVATAR_MAX,
  AVATAR_MIN,
  AVATAR_UNIFORME,
  aggregateEdges,
  fleetVerdict,
  grosorDe,
  radioDe,
  humanOrigins,
  liveState,
  origenDeItem,
  ownerBucket,
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

  it('el pulso de cierre vence solo: pasado BURST_MS vuelve al estado estable', () => {
    const pulses = [{ kind: 'settled' as const, atMs: NOW, outcome: 'desconocido' as const }];
    expect(liveState(agent(), { nowMs: NOW + 1000, pulses }).state).toBe('settled');
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

  it('un delivery_id nuevo es "recibido" y uno que desaparece SALIÓ DE VUELO, sin decir cómo', () => {
    const before = rememberFleet(snapshot([agent({ in_flight_items: [{ delivery_id: 'd1' }] })]), NOW);
    const after = snapshot([agent({ in_flight_items: [{ delivery_id: 'd2' }] })]);
    const pulses = detectPulses(before, after, NOW + 4000);
    expect(pulses['Steven/zeus']).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'received', deliveryId: 'd2' }),
      expect.objectContaining({ kind: 'settled', deliveryId: 'd1' }),
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
      ['blocked', 'delegating', 'down', 'idle', 'receiving', 'settled', 'thinking'],
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

describe('ownerBucket', () => {
  it('reparte los siete estados en las tres respuestas que le importan al dueño', () => {
    expect(ownerBucket('down')).toBe('problema');
    expect(ownerBucket('blocked')).toBe('problema');
    expect(ownerBucket('idle')).toBe('libre');
    // El cubo se llama `ocupado` y NO `trabajando`: «Trabajando» es el rótulo del chip de
    // `thinking`, y usar la misma palabra para el cubo que agrupa cuatro estados es lo que hacía
    // que el veredicto dijera «4 trabajando» encima de un chip «Trabajando 2».
    expect(ownerBucket('thinking')).toBe('ocupado');
    expect(ownerBucket('delegating')).toBe('ocupado');
    expect(ownerBucket('receiving')).toBe('ocupado');
    expect(ownerBucket('settled')).toBe('ocupado');
  });
});

describe('fleetVerdict', () => {
  const RECIEN = '2026-08-22T10:00:00.000Z';
  const AHORA = Date.parse(RECIEN) + 2_000;

  function vistas(snapshotAgents: FleetActivityAgent[]) {
    return buildLiveViews(snapshot(snapshotAgents), {}, AHORA).views;
  }

  it('con la flota sana dice "Todo en orden" y cuenta libres sin llamarlos avería', () => {
    const veredicto = fleetVerdict(
      vistas([agent({ alias: 'zeus' }), agent({ alias: 'kant' })]),
      { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    expect(veredicto.tone).toBe('ok');
    expect(veredicto.frase).toBe('Todo en orden.');
    expect(veredicto.apoyo).toContain('2 libres');
    expect(veredicto.apoyo).toContain('ninguno trabado');
    expect(veredicto.culpables).toEqual([]);
  });

  it('NUNCA sale verde si la última lectura falló, por sano que se vea el snapshot anterior', () => {
    // Ésta es la regla innegociable de la vista. El snapshot que se está mostrando es de dos
    // agentes perfectamente ociosos: si la comprobación del error no fuera lo PRIMERO, cualquier
    // rama posterior devolvería "Todo en orden" sobre datos que ya nadie puede confirmar. Es
    // exactamente la mentira de un `systemctl is-active` sobre un proceso que dejó de atender.
    const veredicto = fleetVerdict(
      vistas([agent({ alias: 'zeus' }), agent({ alias: 'kant' })]),
      { error: new Error('actividad caída'), observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    expect(veredicto.tone).toBe('desconocido');
    expect(veredicto.tone).not.toBe('ok');
    expect(veredicto.frase).toMatch(/no lo sé/i);
    expect(veredicto.apoyo).toMatch(/última lectura buena/i);
  });

  it('NUNCA sale verde con el snapshot rancio, aunque no haya habido ningún error', () => {
    // Un fetch que nunca vuelve no produce `error`: produce silencio. Sin esta rama, la pantalla
    // seguiría afirmando en verde algo que midió hace tres minutos.
    const veredicto = fleetVerdict(
      vistas([agent({ alias: 'zeus' })]),
      { observedAt: RECIEN, nowMs: Date.parse(RECIEN) + 180_000, staleAfterMs: 12_000 },
    );
    expect(veredicto.tone).toBe('desconocido');
    expect(veredicto.apoyo).toMatch(/Datos de hace/);
  });

  it('sin hora del servidor tampoco acredita nada: un snapshot sin fecha no es un snapshot fresco', () => {
    const veredicto = fleetVerdict(vistas([agent({ alias: 'zeus' })]), {
      observedAt: null, nowMs: AHORA, staleAfterMs: 12_000,
    });
    expect(veredicto.tone).toBe('desconocido');
  });

  it('nombra a los culpables con un motivo comprobable, no con un recuento anónimo', () => {
    const veredicto = fleetVerdict(
      vistas([
        agent({ alias: 'zeus' }),
        agent({ alias: 'kratos', work_state: 'stalled', in_flight: 1, oldest_in_flight_seconds: 1_320 }),
      ]),
      { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    expect(veredicto.tone).toBe('alerta');
    expect(veredicto.frase).toBe('1 agente necesita atención.');
    expect(veredicto.culpables).toHaveLength(1);
    expect(veredicto.culpables[0].alias).toBe('kratos');
    expect(veredicto.culpables[0].motivo).toBe('trabado hace 22 min');
  });

  it('un agente trabado sin una sola señal no se reporta como "hace 0 s"', () => {
    const veredicto = fleetVerdict(
      vistas([agent({
        alias: 'hegel', work_state: 'working', in_flight: 2, flags: ['ack_stalled'],
        oldest_in_flight_seconds: null, seconds_since_last_ack: null,
      })]),
      { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    expect(veredicto.culpables[0].motivo).toBe('trabado, sin una sola señal');
    expect(veredicto.culpables[0].motivo).not.toContain('0 s');
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
// Los defectos de la revisión adversarial del 2026-08-22, cada uno con el caso concreto que lo
// destapó. Todos estaban DESPLEGADOS en producción cuando se escribieron estos tests.
// ================================================================================================

describe('D1 · atribución de quién pidió el trabajo', () => {
  // `origin` se copia byte a byte en cada salto (packages/protocol/src/schemas.ts): una cadena de
  // cinco agentes nacida en Telegram sigue diciendo adapter:'telegram' en el salto cinco — 2.374
  // de 2.429 entregas de 12 h medidas el 2026-07-27. Aceptar todo lo que no sea 'bus' como "una
  // persona" convertía cada delegación heredada de un puente en un encargo humano inventado.
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

describe('D2 · el veredicto sobre cero mediciones', () => {
  const RECIEN = '2026-08-22T10:00:00.000Z';
  const AHORA = Date.parse(RECIEN) + 2_000;

  it('sin un solo agente NO dice "Todo en orden": dice que no lo sabe', () => {
    // Alcanzable en producción sin ninguna avería: basta elegir en el selector un cliente cuyos
    // alias no aparezcan en /activity, o que el servidor devuelva agents: [].
    const veredicto = fleetVerdict([], { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 });
    expect(veredicto.tone).toBe('desconocido');
    expect(veredicto.tone).not.toBe('ok');
    expect(veredicto.frase).not.toBe('Todo en orden.');
    expect(veredicto.frase).toMatch(/no lo sé/i);
    expect(veredicto.apoyo).not.toMatch(/0 conectados/);
  });

  it('y el snapshot vacío del servidor da lo mismo que la lista vacía', () => {
    const veredicto = fleetVerdict(
      buildLiveViews({ observed_at: RECIEN, agents: [] }, {}, AHORA).views,
      { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    expect(veredicto.tone).toBe('desconocido');
  });
});

describe('D3 · una entrega que desaparece no es una entrega cerrada', () => {
  const conDeadline = (deadline: string) => snapshot([agent({
    in_flight: 1,
    in_flight_items: [{ delivery_id: 'd1', status: 'started', ack_deadline_at: deadline }],
  })]);

  it('la desaparición de un delivery_id NO se anuncia como cierre: el desenlace es desconocido', () => {
    // El SQL de /activity trae status IN ('leased','accepted','started'): de esa lista se sale
    // igual cerrando `done` que muriendo por deadline, yendo a `failed` o cayendo en dead-letter.
    const antes = rememberFleet(conDeadline(new Date(NOW + 600_000).toISOString()), NOW);
    const pulsos = detectPulses(antes, snapshot([agent({ in_flight_items: [] })]), NOW + 4_000);
    expect(pulsos['Steven/zeus']).toEqual([
      expect.objectContaining({ kind: 'settled', deliveryId: 'd1', outcome: 'desconocido' }),
    ]);

    const estado = liveState(agent(), { nowMs: NOW + 4_500, pulses: pulsos['Steven/zeus'] });
    expect(estado.state).toBe('settled');
    // Lo que no puede volver a aparecer: la afirmación de un cierre correcto.
    expect(estado.reason).not.toMatch(/cerró una entrega/i);
    expect(estado.reason).not.toMatch(/terminó el turno/i);
    expect(estado.reason).toMatch(/no se puede saber/i);
  });

  it('el estado que produce ese pulso NO es de tono positivo ni dice "respondiendo"', () => {
    // Éste era el fallo caro: el peor evento de la flota se anunciaba con el mismo verde y el
    // mismo texto que el mejor.
    expect(LIVE_STATE_META.settled.tone).not.toBe('positive');
    expect(LIVE_STATE_META.settled.label).not.toMatch(/respond/i);
    expect(LIVE_STATE_META.settled.hint).toMatch(/no se puede saber/i);
  });

  it('con el deadline de ACK ya vencido lo dice: eso NO fue un cierre limpio', () => {
    const antes = rememberFleet(conDeadline(new Date(NOW - 30_000).toISOString()), NOW);
    const pulsos = detectPulses(antes, snapshot([agent({ in_flight_items: [] })]), NOW + 4_000);
    expect(pulsos['Steven/zeus']).toEqual([
      expect.objectContaining({ kind: 'settled', outcome: 'deadline_vencido' }),
    ]);

    const estado = liveState(agent(), { nowMs: NOW + 4_500, pulses: pulsos['Steven/zeus'] });
    expect(estado.reason).toMatch(/deadline de ACK ya vencido/i);
    expect(estado.reason).not.toMatch(/terminó el turno/i);
  });

  it('sin ack_deadline_at del servidor no se inventa un vencimiento', () => {
    const antes = rememberFleet(snapshot([agent({ in_flight_items: [{ delivery_id: 'd1' }] })]), NOW);
    const pulsos = detectPulses(antes, snapshot([agent({ in_flight_items: [] })]), NOW + 4_000);
    expect(pulsos['Steven/zeus'][0].outcome).toBe('desconocido');
  });
});

describe('D4 · un alias fuera del registro no está "deshabilitado"', () => {
  // El backend calcula agent_enabled: COALESCE(ag.enabled, false) y el LEFT JOIN no encuentra fila
  // para un participante que entró por 'work' o por connection_leases. Ese false es el default del
  // COALESCE, no una baja.
  const sinRegistrar = agent({
    tenant_id: 'Miguel', alias: 'atlas', registered: false, agent_enabled: false,
    work_state: 'working', in_flight: 3, started: 3,
    presence: { online: true }, flags: ['unregistered'],
  });

  it('trabajando con tres entregas en vuelo NO se pinta caído con un motivo inventado', () => {
    const resultado = liveState(sinRegistrar, { nowMs: NOW });
    expect(resultado.state).not.toBe('down');
    expect(resultado.state).toBe('thinking');
    expect(resultado.reason).not.toMatch(/Deshabilitado en el registro/);
  });

  it('pero la salvedad se dice: el alias no está en el registro', () => {
    expect(liveState(sinRegistrar, { nowMs: NOW }).reason).toMatch(/no está en el registro/i);
  });

  it('una baja DE VERDAD en el registro sigue siendo caída', () => {
    const dadoDeBaja = agent({ registered: true, agent_enabled: false });
    const resultado = liveState(dadoDeBaja, { nowMs: NOW });
    expect(resultado.state).toBe('down');
    expect(resultado.reason).toMatch(/Deshabilitado en el registro/);
  });

  it('sin registro y con el lease vencido sigue estando caído, por el lease', () => {
    const resultado = liveState(
      agent({ registered: false, agent_enabled: false, flags: ['unregistered', 'lease_expired'] }),
      { nowMs: NOW },
    );
    expect(resultado.state).toBe('down');
    expect(resultado.reason).toMatch(/lease venció/i);
    expect(resultado.reason).not.toMatch(/Deshabilitado en el registro/);
  });
});
