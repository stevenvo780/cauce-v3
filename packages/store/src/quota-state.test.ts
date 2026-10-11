import { describe, expect, it } from 'vitest';
import { quotaObservationStatus, quotaRemaining } from './quota-state.js';

const now = new Date('2026-10-11T12:00:00Z');
const observation = { now, receivedAt: now, resetAt: null, status: null, providerOk: true, hasValue: true };
describe('quota observation state', () => {
  it('keeps missing, errors, stale and expired windows distinct from exhaustion', () => {
    expect(quotaObservationStatus({ ...observation, receivedAt: null })).toBe('unknown');
    expect(quotaObservationStatus({ ...observation, providerOk: false })).toBe('error');
    expect(quotaObservationStatus({ ...observation, receivedAt: new Date(now.getTime() - 901_000) })).toBe('stale');
    expect(quotaObservationStatus({ ...observation, capturedAt: new Date(now.getTime() - 901_000) })).toBe('stale');
    expect(quotaObservationStatus({ ...observation, capturedAt: new Date(now.getTime() + 61_000) })).toBe('unknown');
    expect(quotaObservationStatus({ ...observation, resetAt: now })).toBe('unknown');
    expect(quotaObservationStatus({ ...observation, status: 'rate-limited' })).toBe('ok');
    expect(quotaObservationStatus({ ...observation, hasValue: false })).toBe('unknown');
  });
  it('uses remaining when reported, otherwise the bounded complement of usage', () => {
    expect(quotaRemaining(null, null)).toBeNull();
    expect(quotaRemaining(null, 100)).toBe(0);
    expect(quotaRemaining(73, 10)).toBe(73);
    expect(quotaRemaining(null, 8)).toBe(92);
  });
});
