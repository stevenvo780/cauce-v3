import { describe, expect, it } from 'vitest';
import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import {
  guidedProgressLine, guidedReduce, guidedStepStatus, initialGuidedState, isGuidedDrift,
} from './guided-recreate';

const base: FleetOperation = {
  id: '11111111-1111-4111-8111-111111111111', kind: 'update',
  target: { resource: 'agent', tenant_id: 'A', alias: 'zz-canary-worker' },
  status: 'failed', version: 2, request_sha256: 'a'.repeat(64),
  actor: { tenant_id: 'A', alias: 'operator' }, expected_revision: 4, desired_revision: 5,
  applied_revision: null, steps: [{ name: 'authenticate', status: 'waiting' }],
  error: { code: 'RUNTIME_DRIFT', step: 'authenticate', retryable: false },
  created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z',
};

describe('guided recreate state machine', () => {
  it('detects only an unresolved drifted operation', () => {
    expect(isGuidedDrift(base)).toBe(true);
    expect(isGuidedDrift({ ...base, status: 'cancelled' })).toBe(false);
    expect(isGuidedDrift({ ...base, status: 'succeeded' })).toBe(false);
    expect(isGuidedDrift({ ...base, error: null })).toBe(false);
    expect(isGuidedDrift(undefined)).toBe(false);
    // Signing in recreates the container, so a drifted login wait just needs the login.
    expect(isGuidedDrift({ ...base, status: 'awaiting_auth' })).toBe(false);
  });

  it('starts on cancel and advances in order to awaiting_auth', () => {
    let state = guidedReduce(initialGuidedState, { type: 'start' });
    expect(state).toMatchObject({ status: 'running', step: 'cancel' });
    expect(guidedProgressLine(state)).toContain('Cancelando la operación desfasada');
    state = guidedReduce(state, { type: 'step', step: 'preview' });
    expect(guidedStepStatus(state, 'cancel')).toBe('done');
    expect(guidedStepStatus(state, 'preview')).toBe('current');
    expect(guidedStepStatus(state, 'enqueue')).toBe('pending');
    state = guidedReduce(state, { type: 'step', step: 'enqueue' });
    state = guidedReduce(state, { type: 'step', step: 'follow' });
    state = guidedReduce(state, { type: 'awaiting_auth', operation: { ...base, id: '22222222-2222-4222-8222-222222222222', error: null } });
    expect(state.status).toBe('awaiting_auth');
    expect(guidedStepStatus(state, 'follow')).toBe('done');
    expect(guidedStepStatus(state, 'auth')).toBe('current');
    expect(guidedProgressLine(state)).toContain('Se abrió el inicio de sesión');
  });

  it('keeps the failed step and retries from that same step', () => {
    let state = guidedReduce(initialGuidedState, { type: 'start' });
    state = guidedReduce(state, { type: 'step', step: 'enqueue' });
    state = guidedReduce(state, { type: 'failed', step: 'enqueue', message: 'No se pudo encolar la recreación.' });
    expect(state).toMatchObject({ status: 'failed', failedStep: 'enqueue' });
    expect(guidedStepStatus(state, 'cancel')).toBe('done');
    expect(guidedStepStatus(state, 'preview')).toBe('done');
    expect(guidedStepStatus(state, 'enqueue')).toBe('failed');
    expect(guidedProgressLine(state)).toContain('Se detuvo en');
    state = guidedReduce(state, { type: 'retry' });
    expect(state).toMatchObject({ status: 'running', step: 'enqueue', failedStep: null, message: null });
  });

  it('marks every step done when the recreated operation succeeds without auth', () => {
    let state = guidedReduce(initialGuidedState, { type: 'start' });
    state = guidedReduce(state, { type: 'step', step: 'follow' });
    state = guidedReduce(state, { type: 'done', operation: { ...base, status: 'succeeded', error: null } });
    expect(state.status).toBe('done');
    for (const step of ['cancel', 'preview', 'enqueue', 'follow', 'auth'] as const) {
      expect(guidedStepStatus(state, step)).toBe('done');
    }
    expect(guidedProgressLine(state)).toContain('la operación terminó');
  });

  it('resets to the idle single action', () => {
    const failed = guidedReduce(initialGuidedState, { type: 'failed', step: 'preview', message: 'Sin preparación.' });
    expect(guidedReduce(failed, { type: 'reset' })).toEqual(initialGuidedState);
    expect(guidedProgressLine(initialGuidedState)).toContain('Recrear contenedor e iniciar sesión');
  });
});
