import { describe, expect, it } from 'vitest';
import { DelegationRejectionSchema, MAX_DELEGATION_REJECTION_TARGET_CHARS } from '@cauce/protocol';
import {
  boundedRejectionTarget, DEFAULT_DELEGATION_CAPS, DISABLED_DELEGATION_CAPS,
  describeDelegationRejection, fanoutCapForTurn, HUMAN_GATE_TARGET, rejectionText,
  sanitizedDelegationCaps
} from '../src/delegation-guard.js';

/**
 * This suite runs WITHOUT Postgres on purpose. The rule that cuts off random-walk delegation is
 * the part that will be discussed and tweaked the most, and must be testable in any environment,
 * not only where there is a database container. The durable path (reservations, gates, resumption)
 * is tested separately in delegation-discipline-postgres.test.ts.
 */
describe('fanoutCapForTurn', () => {
  it('no acota el turno raíz, que es el único donde @all puede expandirse', () => {
    // 7-day prod measurement: the 11 turns with a fanout of 11-14 are ALL `@all` at hop_count=1.
    // Capping there would break the broadcast to the fleet without touching any of the
    // delegations that caused the avalanche.
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
    // hop_count comes from a correlation; safeHopCount already clamps it, but this guard exists
    // so that an absurd value NEVER becomes a zero cap that kills every delegation.
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
    // A zero or a negative value hand-written into agent_chain_policies would reject EVERY
    // delegation. That is worse than the problem this patch fixes, so it is not obeyed.
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
      // Guidance is what prevents blind retries: without it the rejection is just a "no".
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
    // aliasPattern in repository.ts is /^[a-z][a-z0-9_-]{0,63}$/u: the @ excludes it, so the
    // directive can never collide with a real alias nor become routable by accident.
    expect(HUMAN_GATE_TARGET.startsWith('@')).toBe(true);
    expect(/^[a-z][a-z0-9_-]{0,63}$/u.test(HUMAN_GATE_TARGET)).toBe(false);
  });
});

describe('boundedRejectionTarget', () => {
  it('deja intacto un destino que ya cabe', () => {
    expect(boundedRejectionTarget(undefined)).toBeUndefined();
    expect(boundedRejectionTarget('Steven/socrates')).toBe('Steven/socrates');
    const exact = 't'.repeat(MAX_DELEGATION_REJECTION_TARGET_CHARS);
    expect(boundedRejectionTarget(exact)).toBe(exact);
  });

  it('recorta el primer destino que se pasa, contando la elipsis', () => {
    const oversized = 't'.repeat(MAX_DELEGATION_REJECTION_TARGET_CHARS + 1);
    const bounded = boundedRejectionTarget(oversized);
    expect(bounded).not.toBe(oversized);
    expect(bounded?.length).toBe(MAX_DELEGATION_REJECTION_TARGET_CHARS);
    expect(bounded?.endsWith('…')).toBe(true);
  });

  it('lo recortado sobrevive al safeParse de policy.ts, que descarta en silencio lo que no cabe', () => {
    for (const length of [
      MAX_DELEGATION_REJECTION_TARGET_CHARS,
      MAX_DELEGATION_REJECTION_TARGET_CHARS + 1,
      MAX_DELEGATION_REJECTION_TARGET_CHARS * 4
    ]) {
      const target = boundedRejectionTarget('t'.repeat(length)) ?? '';
      const notice = describeDelegationRejection('unroutable_alias', { target });
      const parsed = DelegationRejectionSchema.safeParse({
        output_index: 0,
        code: notice.code,
        reason: notice.reason,
        guidance: notice.guidance,
        target
      });
      expect(parsed.success).toBe(true);
    }
  });
});
