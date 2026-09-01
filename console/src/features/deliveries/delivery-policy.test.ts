import { describe, expect, it } from 'vitest';
import type { DeliveryState } from '../../api/types';
import { DELIVERY_POLICY, DELIVERY_STATES, deliveryPolicy } from './delivery-policy';

const EXPECTED: Readonly<Record<DeliveryState, {
  label: string;
  tone: string;
  group: string;
  replayable: boolean;
  cancellable: boolean;
  errorExpectation: string;
}>> = {
  pending: { label: 'PENDIENTE', tone: 'running', group: 'pending', replayable: false, cancellable: true, errorExpectation: 'absent' },
  leased: { label: 'TOMADA', tone: 'running', group: 'pending', replayable: false, cancellable: true, errorExpectation: 'absent' },
  accepted: { label: 'ACEPTADA', tone: 'running', group: 'pending', replayable: false, cancellable: true, errorExpectation: 'absent' },
  started: { label: 'EN CURSO', tone: 'running', group: 'pending', replayable: false, cancellable: true, errorExpectation: 'absent' },
  done: { label: 'HECHA', tone: 'done', group: 'complete', replayable: false, cancellable: false, errorExpectation: 'absent' },
  failed: { label: 'FALLÓ', tone: 'danger', group: 'review', replayable: true, cancellable: false, errorExpectation: 'required' },
  retry: { label: 'EN REINTENTO', tone: 'warning', group: 'retry', replayable: false, cancellable: true, errorExpectation: 'required' },
  dead: { label: 'MUERTA', tone: 'danger', group: 'review', replayable: true, cancellable: false, errorExpectation: 'required' },
};

describe('delivery lifecycle policy', () => {
  it('pins all eight protocol states to one exhaustive policy', () => {
    expect(DELIVERY_STATES).toHaveLength(8);
    expect(new Set(DELIVERY_STATES).size).toBe(8);
    expect(DELIVERY_POLICY).toEqual(EXPECTED);
    for (const state of DELIVERY_STATES) {
      expect(deliveryPolicy(state)).toEqual({ known: true, state, ...EXPECTED[state] });
    }
  });

  it('keeps an unknown state visible and fail-closed', () => {
    expect(deliveryPolicy('invented-by-a-new-gateway')).toEqual({
      known: false,
      state: undefined,
      label: 'UNKNOWN',
      tone: 'unknown',
      group: 'unknown',
      replayable: false,
      cancellable: false,
      errorExpectation: 'unknown',
    });
    expect(deliveryPolicy(null).replayable).toBe(false);
    expect(deliveryPolicy(undefined).cancellable).toBe(false);
  });
});

