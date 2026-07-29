import { describe, expect, it } from 'vitest';
import {
  DEFAULT_DELEGATION_CAPS, DISABLED_DELEGATION_CAPS, describeDelegationRejection,
  fanoutCapForTurn, HUMAN_GATE_TARGET, rejectionText, sanitizedDelegationCaps
} from '../src/delegation-guard.js';

/**
 * Esta suite corre SIN Postgres a propósito. La regla que corta el paseo aleatorio es la parte
 * que más se va a discutir y a retocar, y tiene que poder probarse en cualquier entorno, no sólo
 * donde haya un contenedor de base. El camino durable (reservas, gates, reanudación) se prueba
 * aparte en delegation-discipline-postgres.test.ts.
 */
describe('fanoutCapForTurn', () => {
  it('no acota el turno raíz, que es el único donde @all puede expandirse', () => {
    // Medición prod 7 días: los 11 turnos con abanico 11-14 son TODOS `@all` en hop_count=1.
    // Acotar ahí rompería el broadcast a la flota sin tocar ni una de las delegaciones que
    // causaron la avalancha.
    expect(fanoutCapForTurn(DEFAULT_DELEGATION_CAPS, 1)).toBeUndefined();
  });

  it('acota todo turno interno', () => {
    expect(fanoutCapForTurn(DEFAULT_DELEGATION_CAPS, 2)).toBe(6);
    expect(fanoutCapForTurn(DEFAULT_DELEGATION_CAPS, 9)).toBe(6);
  });

  it('no acota nada con el interruptor maestro apagado', () => {
    expect(fanoutCapForTurn(DISABLED_DELEGATION_CAPS, 9)).toBeUndefined();
  });

  it('no acota con un hop_count que no es un entero seguro', () => {
    // hop_count llega de una correlación; safeHopCount ya lo satura, pero este guarda existe
    // para que un valor absurdo NUNCA se convierta en un tope de cero que mate toda delegación.
    for (const hop of [Number.NaN, 1.5, -3, Number.MAX_SAFE_INTEGER + 10]) {
      expect(fanoutCapForTurn(DEFAULT_DELEGATION_CAPS, hop)).toBeUndefined();
    }
  });
});

describe('sanitizedDelegationCaps', () => {
  it('conserva valores válidos', () => {
    expect(sanitizedDelegationCaps({
      enabled: true, maxFanoutPerTurn: 4, maxEdgeRepeatsPerRoot: 2, maxDelegationsPerRoot: 32
    })).toEqual({
      enabled: true, maxFanoutPerTurn: 4, maxEdgeRepeatsPerRoot: 2, maxDelegationsPerRoot: 32
    });
  });

  it('cae al default ante un valor que apagaría la delegación entera', () => {
    // Un cero o un negativo escrito a mano en agent_chain_policies rechazaría TODA delegación.
    // Eso es peor que el problema que este parche arregla, así que no se obedece.
    const caps = sanitizedDelegationCaps({
      enabled: true, maxFanoutPerTurn: 0, maxEdgeRepeatsPerRoot: -1, maxDelegationsPerRoot: 1.5
    });
    expect(caps).toEqual({ ...DEFAULT_DELEGATION_CAPS, enabled: true });
  });

  it('satura un techo inflado en vez de propagarlo', () => {
    const caps = sanitizedDelegationCaps({
      enabled: true,
      maxFanoutPerTurn: 10_000,
      maxEdgeRepeatsPerRoot: 10_000_000,
      maxDelegationsPerRoot: 10_000_000
    });
    expect(caps.maxFanoutPerTurn).toBe(100);
    expect(caps.maxEdgeRepeatsPerRoot).toBe(1_000);
    expect(caps.maxDelegationsPerRoot).toBe(10_000);
  });

  it('trata cualquier cosa que no sea `true` como apagado', () => {
    expect(sanitizedDelegationCaps({ enabled: 'yes' }).enabled).toBe(false);
    expect(sanitizedDelegationCaps({}).enabled).toBe(false);
  });
});

describe('describeDelegationRejection', () => {
  it('da motivo y qué hacer para cada código del dominio durable', () => {
    const codes = [
      'invalid_output', 'unroutable_alias', 'ambiguous_alias', 'hop_budget_exhausted',
      'cycle_detected', 'fanout_exceeded', 'edge_repeat_exceeded', 'root_budget_exhausted',
      'chain_gated', 'human_gate_opened'
    ] as const;
    for (const code of codes) {
      const notice = describeDelegationRejection(code, { target: 'Steven/socrates', cap: 3 });
      expect(notice.code).toBe(code);
      expect(notice.reason.length).toBeGreaterThan(20);
      // La guía es la parte que evita el reintento ciego: sin ella el rechazo es sólo un "no".
      expect(notice.guidance.length).toBeGreaterThan(20);
      expect(rejectionText(notice)).toContain(notice.guidance);
    }
  });

  it('nombra el destino y el tope en el rechazo por arista repetida', () => {
    const notice = describeDelegationRejection('edge_repeat_exceeded', {
      target: 'Steven/socrates', cap: 3
    });
    expect(notice.reason).toContain('Steven/socrates');
    expect(notice.reason).toContain('3');
    expect(notice.guidance).toMatch(/devolvé|resolvelo/iu);
  });

  it('el rechazo por gate dice qué se está esperando y que NO hay que reintentar', () => {
    const notice = describeDelegationRejection('chain_gated', {
      question: '¿aprobás el gasto?', gateId: 'gate-1'
    });
    expect(notice.reason).toContain('¿aprobás el gasto?');
    expect(notice.reason).toContain('gate-1');
    expect(notice.guidance).toContain('No delegues');
  });

  it('un código desconocido degrada a invalid_output en vez de romper', () => {
    const notice = describeDelegationRejection('lo_que_sea' as never);
    expect(notice.code).toBe('invalid_output');
  });
});

describe('HUMAN_GATE_TARGET', () => {
  it('no puede confundirse con un alias', () => {
    // aliasPattern en repository.ts es /^[a-z][a-z0-9_-]{0,63}$/u: la arroba lo excluye, así que
    // la directiva jamás puede colisionar con un alias real ni volverse ruteable por accidente.
    expect(HUMAN_GATE_TARGET.startsWith('@')).toBe(true);
    expect(/^[a-z][a-z0-9_-]{0,63}$/u.test(HUMAN_GATE_TARGET)).toBe(false);
  });
});
