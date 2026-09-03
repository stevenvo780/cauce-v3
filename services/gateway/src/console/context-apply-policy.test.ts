import { describe, expect, it } from 'vitest';
import {
  CONTEXT_APPLY_POLICY, type ContextApplyPolicy, type ContextApplyState,
} from './context-apply-policy.js';

/**
 * The vocabulary is the contract. What is tested here is what the words are NOT allowed to say:
 * no state may claim the session reloaded unless the evidence is the session's own ACK.
 */

const ESTADOS = Object.keys(CONTEXT_APPLY_POLICY) as ContextApplyState[];

describe('el vocabulario de aplicación de contexto cubre los dos canales', () => {
  it('cada estado declara canal, evidencia y aviso en español', () => {
    expect(ESTADOS.length).toBeGreaterThan(0);
    for (const state of ESTADOS) {
      const policy = CONTEXT_APPLY_POLICY[state];
      expect(policy.channels.length, state).toBeGreaterThan(0);
      expect(policy.message.length, state).toBeGreaterThan(20);
      expect(policy.message, state).toMatch(/[áéíóúñ]/);
    }
  });

  it('el manual y el perfil comparten el mapa y cada uno tiene su estado propio', () => {
    const canales = (state: ContextApplyState): ContextApplyPolicy['channels'] =>
      (CONTEXT_APPLY_POLICY[state] satisfies ContextApplyPolicy).channels;
    const manual = ESTADOS.filter((state) => canales(state).includes('manual'));
    const perfil = ESTADOS.filter((state) => canales(state).includes('profile'));
    expect(manual).toContain('written_pending_session');
    expect(perfil).toContain('pending_session_refresh');
    expect(manual).not.toContain('applied');
  });
});

describe('sólo el ACK de la sesión autoriza afirmar que el proceso releyó', () => {
  it('applied es el único estado con sessionReloaded', () => {
    const reloaded = ESTADOS.filter((state) => CONTEXT_APPLY_POLICY[state].sessionReloaded);
    expect(reloaded).toEqual(['applied']);
    expect(CONTEXT_APPLY_POLICY.applied.evidence).toBe('session_adoption_ack');
  });

  it('un ACK de escritura en disco nunca acredita la sesión', () => {
    for (const state of ESTADOS) {
      const policy = CONTEXT_APPLY_POLICY[state];
      if (policy.evidence === 'probe_write_ack') expect(policy.sessionReloaded, state).toBe(false);
    }
    expect(CONTEXT_APPLY_POLICY.written_pending_session).toMatchObject({
      evidence: 'probe_write_ack', sessionReloaded: false,
    });
    expect(CONTEXT_APPLY_POLICY.written_pending_session.message).toMatch(/releyera|recargue/);
  });

  it('CONTROL NEGATIVO: un estado de otro vocabulario no está en el mapa', () => {
    expect(Object.hasOwn(CONTEXT_APPLY_POLICY, 'done')).toBe(false);
    expect(ESTADOS).not.toContain('done' as ContextApplyState);
  });
});
