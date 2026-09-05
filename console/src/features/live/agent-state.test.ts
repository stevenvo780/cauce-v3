import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent } from '../../api/types';
import {
  BURST_MS,
  LIVE_STATE_META,
  buildLiveViews,
  detectPulses,
  fleetVerdict,
  liveState,
  ownerBucket,
  rememberFleet,
  stateTally,
} from './agent-state';
import { agent, snapshot } from './agent-state-fixtures';

const NOW = 1_700_000_000_000;

describe('liveState', () => {
  it('un lease vivo con trabajo tomado hace mucho es BLOQUEADO, no trabajando', () => {
    // This is the expensive lesson: `presence.online` stays true and the heartbeat is fresh.
    // The agent looks healthy by every connection signal and is mute nonetheless.
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

  it('un stall por ACK explica la edad del ACK aunque la entrega sea más vieja', () => {
    const result = liveState(
      agent({
        work_state: 'stalled', flags: ['ack_stalled'], in_flight: 1,
        oldest_in_flight_seconds: 1_500, seconds_since_last_ack: 840,
      }),
      { nowMs: NOW, thresholds: { stall_after_seconds: 300 } },
    );
    expect(result.reason).toContain('último ACK fue hace 14 min');
    expect(result.reason).not.toContain('25 min');
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

  it('explica no empezó con la edad de esa entrega y no la de otra ejecución', () => {
    const result = liveState(
      agent({
        work_state: 'stalled', flags: ['claimed_not_started'], in_flight: 2, started: 0,
        oldest_in_flight_seconds: 1_800, oldest_claimed_not_started_seconds: 1_800,
        oldest_claimed_not_started_activity_seconds: 900,
      }),
      { nowMs: NOW },
    );
    expect(result.reason).toContain('hace 15 min');
    expect(result.reason).not.toContain('30 min');
  });

  it('distingue nunca ACK propio de ACK propio inactivo', () => {
    const neverAcked = liveState(
      agent({
        work_state: 'stalled', flags: ['claimed_not_started'], in_flight: 1,
        oldest_claimed_not_started_without_ack_seconds: 61,
        oldest_claimed_not_started_activity_seconds: 61,
      }),
      { nowMs: NOW, thresholds: { start_after_seconds: 60 } },
    );
    const staleAck = liveState(
      agent({
        work_state: 'stalled', flags: ['claimed_not_started'], in_flight: 1,
        oldest_claimed_not_started_without_ack_seconds: null,
        oldest_claimed_not_started_activity_seconds: 301,
      }),
      { nowMs: NOW, thresholds: { start_after_seconds: 60, stall_after_seconds: 300 } },
    );
    expect(neverAcked.reason).toContain('nunca registró un ACK propio');
    expect(staleAck.reason).toContain('actividad propia hace 5 min');
  });

  it('prioriza ACK vencido y ACK estancado sobre tomó y no empezó', () => {
    const overdue = liveState(
      agent({
        work_state: 'stalled', flags: ['claimed_not_started', 'ack_stalled', 'overdue_acks'],
        in_flight: 2, seconds_since_last_ack: 900,
        oldest_claimed_not_started_activity_seconds: 800,
      }),
      { nowMs: NOW },
    );
    const ack = liveState(
      agent({
        work_state: 'stalled', flags: ['claimed_not_started', 'ack_stalled'],
        in_flight: 2, seconds_since_last_ack: 900,
        oldest_claimed_not_started_activity_seconds: 800,
      }),
      { nowMs: NOW },
    );
    expect(overdue.reason).toContain('deadline de ACK vencido');
    expect(ack.reason).toContain('último ACK fue hace 15 min');
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

describe('stateTally', () => {
  it('el recuento publica los siete estados aunque estén en cero', () => {
    const { views } = buildLiveViews(snapshot([agent()]), {}, NOW);
    const tally = stateTally(views);
    expect(Object.keys(tally).sort()).toEqual(
      ['blocked', 'delegating', 'down', 'idle', 'receiving', 'settled', 'thinking'],
    );
    expect(tally.idle).toBe(1);
    expect(tally.down).toBe(0);
  });
});

describe('ownerBucket', () => {
  it('reparte los siete estados en las tres respuestas que le importan al dueño', () => {
    expect(ownerBucket('down')).toBe('problema');
    expect(ownerBucket('blocked')).toBe('problema');
    expect(ownerBucket('idle')).toBe('libre');
    // The bucket is called `ocupado` and NOT `trabajando`: "Trabajando" is the label of the
    // `thinking` chip, and using the same word for the bucket that groups four states is what
    // made the verdict say "4 trabajando" above a chip "Trabajando 2".
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
    // This is the non-negotiable rule of the view. The snapshot being shown is of two perfectly
    // idle agents: if the error check were not FIRST, any later branch would return "Todo en
    // orden" over data no one can confirm anymore. It is exactly the lie of a `systemctl
    // is-active` over a process that stopped responding.
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
    // A fetch that never returns produces no `error`: it produces silence. Without this branch,
    // the screen would keep asserting in green something measured three minutes ago.
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
    expect(veredicto.culpables[0].motivo).toBe(
      'trabado según el servidor; entrega en vuelo hace 22 min',
    );
  });

  it('un agente trabado sin una sola señal no se reporta como "hace 0 s"', () => {
    const veredicto = fleetVerdict(
      vistas([agent({
        alias: 'hegel', work_state: 'working', in_flight: 2, flags: ['ack_stalled'],
        oldest_in_flight_seconds: null, seconds_since_last_ack: null,
      })]),
      { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    expect(veredicto.culpables[0].motivo).toBe('trabado: sin ACK reciente');
    expect(veredicto.culpables[0].motivo).not.toContain('0 s');
  });

  it('el veredicto prioriza ACK vencido y luego ACK estancado sobre no empezó', () => {
    const base = {
      work_state: 'stalled' as const, in_flight: 1,
      oldest_in_flight_seconds: 1_200, seconds_since_last_ack: 900,
      oldest_claimed_not_started_activity_seconds: 800,
    };
    const overdue = fleetVerdict(
      vistas([agent({ ...base, flags: ['claimed_not_started', 'ack_stalled', 'overdue_acks'] })]),
      { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    const ack = fleetVerdict(
      vistas([agent({ ...base, flags: ['claimed_not_started', 'ack_stalled'] })]),
      { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    expect(overdue.culpables[0].motivo).toContain('ACK vencido');
    expect(ack.culpables[0].motivo).toContain('último ACK hace 15 min');
  });

  it('distingue servicio vivo ocupado de servicio vivo sin progreso de ACK', () => {
    const veredicto = fleetVerdict(
      vistas([
        agent({
          alias: 'jarvis', work_state: 'working', in_flight: 1,
          oldest_in_flight_seconds: 10_620, seconds_since_last_ack: 20,
          overdue_in_flight: 0, presence: { online: true },
        }),
        agent({
          alias: 'kant', work_state: 'stalled', flags: ['ack_stalled'], in_flight: 1,
          oldest_in_flight_seconds: 1_500, seconds_since_last_ack: 840,
          overdue_in_flight: 0, presence: { online: true },
        }),
      ]),
      { observedAt: RECIEN, nowMs: AHORA, staleAfterMs: 12_000 },
    );
    expect(veredicto.culpables.map((culpable) => culpable.alias)).toEqual(['kant']);
    expect(veredicto.culpables[0].motivo).toBe(
      'trabado: último ACK hace 14 min; entrega en vuelo hace 25 min',
    );
    expect(veredicto.culpables[0].motivo).not.toContain('trabado hace 25 min');
    expect(veredicto.apoyo).toContain('2 conectados');
    expect(veredicto.apoyo).toContain('1 con trabajo entre manos');
  });
});

describe('D2 · el veredicto sobre cero mediciones', () => {
  const RECIEN = '2026-08-22T10:00:00.000Z';
  const AHORA = Date.parse(RECIEN) + 2_000;

  it('sin un solo agente NO dice "Todo en orden": dice que no lo sabe', () => {
    // Achievable in production without any fault: just pick in the selector a client whose
    // aliases do not appear in /activity, or have the server return agents: [].
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
    // What must not come back: the assertion of a correct closure.
    expect(estado.reason).not.toMatch(/cerró una entrega/i);
    expect(estado.reason).not.toMatch(/terminó el turno/i);
    expect(estado.reason).toMatch(/no se puede saber/i);
  });

  it('el estado que produce ese pulso NO es de tono positivo ni dice "respondiendo"', () => {
    // This was the expensive failure: the worst event in the fleet was announced with the same
    // green and the same text as the best.
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
  // The backend computes agent_enabled: COALESCE(ag.enabled, false) and the LEFT JOIN finds no
  // row for a participant that entered via 'work' or connection_leases. That false is the
  // COALESCE default, not a deregistration.
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
