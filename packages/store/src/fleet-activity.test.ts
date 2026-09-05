import { describe, expect, it } from 'vitest';
import {
  agentWorkState, DEFAULT_FLEET_ACTIVITY_THRESHOLDS, FLEET_ACTIVITY_QUERY,
  type FleetActivityWorkStateInput
} from './fleet-activity.js';

/**
 * The four cases come from the real GET /v3/console/activity contract example (kant, midas,
 * atlas, salva): the regression vector the heuristic was validated against before a line of SQL
 * existed, pinned as-is so a change cannot silently break the diagnosis behind the whole panel.
 */
describe('agentWorkState', () => {
  it('kant: trabajando sano -- en vuelo, ACKs recientes, sin overdue', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 3, queued: 1, overdue_in_flight: 0,
      seconds_since_last_ack: 12, lease_online: true,
      claimed_not_started: 0, oldest_in_flight_seconds: 1,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: null
    };
    expect(agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS)).toEqual({ work_state: 'working', flags: [] });
  });

  it('midas: el caso del incidente -- saturado Y colgado a la vez, las dos flags sobreviven', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 41, queued: 12, overdue_in_flight: 41,
      seconds_since_last_ack: 1268, lease_online: false,
      claimed_not_started: 0, oldest_in_flight_seconds: 1,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: null
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('stalled');
    expect(result.flags.sort()).toEqual(['ack_stalled', 'lease_expired', 'overdue_acks', 'saturated'].sort());
  });

  it('atlas: cola sin nadie consumiendo, lease vencido, cero en vuelo', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 0, queued: 8, overdue_in_flight: 0,
      seconds_since_last_ack: null, lease_online: false,
      claimed_not_started: 0, oldest_in_flight_seconds: 1,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: null
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('queued');
    expect(result.flags.sort()).toEqual(['lease_expired', 'queued_without_consumer'].sort());
  });

  it('salva: idle real -- sin trabajo en vuelo, un ACK viejo no lo marca como colgado', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 0, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 799, lease_online: true,
      claimed_not_started: 0, oldest_in_flight_seconds: 1,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: null
    };
    expect(agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS)).toEqual({ work_state: 'idle', flags: [] });
  });

  it('nunca conectado: sin fila de lease, se distingue de un lease vencido', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 0, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: null, lease_online: null,
      claimed_not_started: 0, oldest_in_flight_seconds: 1,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: null
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('idle');
    expect(result.flags).toEqual(['never_connected']);
  });

  it('no registrado: aparece por deliveries o lease pero no está en el registro de agentes', () => {
    const row: FleetActivityWorkStateInput = {
      registered: false, in_flight: 5, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 5, lease_online: true,
      claimed_not_started: 0, oldest_in_flight_seconds: 1,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: null
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('working');
    expect(result.flags).toEqual(['unregistered']);
  });

  it('saturado exactamente en el umbral configurado', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 8, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 1, lease_online: true,
      claimed_not_started: 0, oldest_in_flight_seconds: 1,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: null
    };
    const result = agentWorkState(row, { ...DEFAULT_FLEET_ACTIVITY_THRESHOLDS, saturation_in_flight: 8 });
    expect(result.work_state).toBe('saturated');
    expect(result.flags).toEqual(['saturated']);
  });
});

/**
 * No-leak contract for GET /v3/console/activity, verifiable WITHOUT Postgres: the SQL text is the
 * single source of truth of which columns travel. No substitute for an integration test, but it
 * stops someone adding "d.result" or "m.body" to this query unnoticed.
 */
describe('FLEET_ACTIVITY_QUERY contract', () => {
  it('nunca selecciona cuerpos de mensajes, resultados de entrega ni el conversation_id de origen', () => {
    expect(FLEET_ACTIVITY_QUERY).not.toMatch(/\bm\.body\b/);
    expect(FLEET_ACTIVITY_QUERY).not.toMatch(/\bd\.result\b/);
    expect(FLEET_ACTIVITY_QUERY).not.toMatch(/\bd\.last_error\b/);
    expect(FLEET_ACTIVITY_QUERY).not.toMatch(/origin->>'conversation_id'/);
    expect(FLEET_ACTIVITY_QUERY).not.toMatch(/body_preview/);
  });

  it('no combina FOR SHARE/FOR UPDATE con funciones de ventana (Postgres lo rechaza al parsear)', () => {
    expect(FLEET_ACTIVITY_QUERY).not.toMatch(/FOR\s+(SHARE|UPDATE)/i);
    expect(FLEET_ACTIVITY_QUERY).not.toMatch(/\bOVER\s*\(/i);
    expect(FLEET_ACTIVITY_QUERY).not.toMatch(/\brow_number\s*\(/i);
  });

  // zeus 01-09 murió tras `hello_ack`: reclamó y nunca corrió; 8h52m se leyeron como `idle`.
  it('zeus: reclamó y nunca empezó -- deja de leerse como libre', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 2, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 30, lease_online: true,
      claimed_not_started: 2, oldest_in_flight_seconds: 3_100,
      oldest_claimed_not_started_without_ack_seconds: 3_100,
      oldest_claimed_not_started_activity_seconds: 3_100
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('stalled');
    expect(result.flags).toContain('claimed_not_started');
  });

  // CONTROL NEGATIVO: sin la antigüedad, esto se dispararía en toda la flota.
  it('una reclamación recién tomada NO es un fallo', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 1, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 5, lease_online: true,
      claimed_not_started: 1, oldest_in_flight_seconds: 1,
      oldest_claimed_not_started_without_ack_seconds: 1,
      oldest_claimed_not_started_activity_seconds: 1
    };
    expect(agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS))
      .toEqual({ work_state: 'working', flags: [] });
  });

  it('trabajo aceptado con actividad propia reciente no se confunde con la ejecución vieja', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 2, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 4, lease_online: true,
      claimed_not_started: 1, oldest_in_flight_seconds: 1_800,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: 4
    };
    expect(agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS))
      .toEqual({ work_state: 'working', flags: [] });
  });

  it('tolera el intervalo normal de renovación y alerta al superar el stall real', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 1, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 10, lease_online: true, claimed_not_started: 1,
      oldest_in_flight_seconds: 900,
      oldest_claimed_not_started_without_ack_seconds: null,
      oldest_claimed_not_started_activity_seconds: 120
    };
    expect(agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS))
      .toEqual({ work_state: 'working', flags: [] });
    expect(agentWorkState({ ...row, oldest_claimed_not_started_activity_seconds: 301 }))
      .toEqual({ work_state: 'stalled', flags: ['claimed_not_started'] });
  });
});
