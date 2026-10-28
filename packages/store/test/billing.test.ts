import { describe, expect, it } from 'vitest';
import {
  allowanceAdmitsAgent, localAmount, mapProviderStatus, planQuote, StoreError, type BillingPlan,
} from '../src/index.js';

describe('planQuote', () => {
  it('prices the managed plan at 100 USD per agent with one agent each', () => {
    for (const quantity of [1, 3, 7, 50]) {
      expect(planQuote('gestionado', quantity)).toEqual({ amount_usd: 100 * quantity, agent_limit: quantity });
    }
    expect(planQuote('gestionado', 3)).toEqual({ amount_usd: 300, agent_limit: 3 });
  });

  it('prices the hotel plans flat', () => {
    expect(planQuote('hotel_20', 1)).toEqual({ amount_usd: 150, agent_limit: 20 });
    expect(planQuote('hotel_50', 1)).toEqual({ amount_usd: 300, agent_limit: 50 });
  });

  it('prices the space plan at 40 USD and 5 agents per space', () => {
    for (const quantity of [1, 2, 10]) {
      expect(planQuote('espacio', quantity)).toEqual({ amount_usd: 40 * quantity, agent_limit: 5 * quantity });
    }
  });

  it.each<[BillingPlan, number]>([
    ['gestionado', 0], ['gestionado', 51], ['gestionado', -1], ['gestionado', 1.5], ['gestionado', Number.NaN],
    ['hotel_20', 0], ['hotel_20', 2], ['hotel_50', 2], ['espacio', 0], ['espacio', 11], ['espacio', Number.POSITIVE_INFINITY],
  ])('rejects %s with quantity %s', (plan, quantity) => {
    expect(() => planQuote(plan, quantity)).toThrow(StoreError);
  });

  it('rejects an unknown plan', () => {
    expect(() => planQuote('gratis' as BillingPlan, 1)).toThrow(StoreError);
  });
});

describe('localAmount', () => {
  it('rounds usd times rate', () => {
    expect(localAmount(300, 4000)).toBe(1_200_000);
    expect(localAmount(40, 3921.456)).toBe(156_858);
    expect(localAmount(100, 1)).toBe(100);
  });
  it('rejects non-positive inputs', () => {
    for (const [usd, rate] of [[0, 1], [-1, 1], [1, 0], [1, Number.NaN]] as const) {
      expect(() => localAmount(usd, rate)).toThrow(StoreError);
    }
  });
});

describe('mapProviderStatus', () => {
  it('maps the provider vocabulary and ignores the unknown', () => {
    expect(mapProviderStatus('authorized')).toBe('authorized');
    expect(mapProviderStatus('pending')).toBe('pending');
    expect(mapProviderStatus('paused')).toBe('paused');
    expect(mapProviderStatus('cancelled')).toBe('cancelled');
    expect(mapProviderStatus('finished')).toBe('cancelled');
    expect(mapProviderStatus('weird')).toBeNull();
  });
});

describe('allowanceAdmitsAgent', () => {
  it('admits exempt companies and those under their limit only', () => {
    expect(allowanceAdmitsAgent({ exempt: true, limit: null, used: 99 })).toBe(true);
    expect(allowanceAdmitsAgent({ exempt: false, limit: 3, used: 2 })).toBe(true);
    expect(allowanceAdmitsAgent({ exempt: false, limit: 3, used: 3 })).toBe(false);
    expect(allowanceAdmitsAgent({ exempt: false, limit: 0, used: 0 })).toBe(false);
  });
});
