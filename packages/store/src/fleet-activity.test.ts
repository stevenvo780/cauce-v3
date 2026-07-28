import { describe, expect, it } from 'vitest';
import {
  agentWorkState, DEFAULT_FLEET_ACTIVITY_THRESHOLDS, FLEET_ACTIVITY_QUERY,
  type FleetActivityWorkStateInput
} from './fleet-activity.js';

/**
 * Los cuatro casos vienen del ejemplo real del contrato de GET /v3/console/activity (kant,
 * midas, atlas, salva): son el vector de regresión contra el que se validó la heurística antes
 * de escribir una sola línea de SQL, así que se fijan acá tal cual para que un cambio futuro no
 * pueda romper silenciosamente el diagnóstico que motivó todo el panel.
 */
describe('agentWorkState', () => {
  it('kant: trabajando sano -- en vuelo, ACKs recientes, sin overdue', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 3, queued: 1, overdue_in_flight: 0,
      seconds_since_last_ack: 12, lease_online: true
    };
    expect(agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS)).toEqual({ work_state: 'working', flags: [] });
  });

  it('midas: el caso del incidente -- saturado Y colgado a la vez, las dos flags sobreviven', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 41, queued: 12, overdue_in_flight: 41,
      seconds_since_last_ack: 1268, lease_online: false
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('stalled');
    expect(result.flags.sort()).toEqual(['ack_stalled', 'lease_expired', 'overdue_acks', 'saturated'].sort());
  });

  it('atlas: cola sin nadie consumiendo, lease vencido, cero en vuelo', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 0, queued: 8, overdue_in_flight: 0,
      seconds_since_last_ack: null, lease_online: false
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('queued');
    expect(result.flags.sort()).toEqual(['lease_expired', 'queued_without_consumer'].sort());
  });

  it('salva: idle real -- sin trabajo en vuelo, un ACK viejo no lo marca como colgado', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 0, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 799, lease_online: true
    };
    expect(agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS)).toEqual({ work_state: 'idle', flags: [] });
  });

  it('nunca conectado: sin fila de lease, se distingue de un lease vencido', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 0, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: null, lease_online: null
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('idle');
    expect(result.flags).toEqual(['never_connected']);
  });

  it('no registrado: aparece por deliveries o lease pero no está en el registro de agentes', () => {
    const row: FleetActivityWorkStateInput = {
      registered: false, in_flight: 5, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 5, lease_online: true
    };
    const result = agentWorkState(row, DEFAULT_FLEET_ACTIVITY_THRESHOLDS);
    expect(result.work_state).toBe('working');
    expect(result.flags).toEqual(['unregistered']);
  });

  it('saturado exactamente en el umbral configurado', () => {
    const row: FleetActivityWorkStateInput = {
      registered: true, in_flight: 8, queued: 0, overdue_in_flight: 0,
      seconds_since_last_ack: 1, lease_online: true
    };
    const result = agentWorkState(row, { ...DEFAULT_FLEET_ACTIVITY_THRESHOLDS, saturation_in_flight: 8 });
    expect(result.work_state).toBe('saturated');
    expect(result.flags).toEqual(['saturated']);
  });
});

/**
 * Contrato de no-fuga para GET /v3/console/activity, verificable SIN Postgres: el texto del SQL
 * es la única fuente de verdad de qué columnas viajan, así que basta con inspeccionarlo. No
 * reemplaza un test de integración (que en esta máquina no puede correr), pero sí impide que
 * alguien agregue "d.result" o "m.body" a esta consulta sin que un test se dé cuenta.
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
});
