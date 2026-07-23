import { describe, expect, it } from 'vitest';
import { configuredAckDeadlineMs, DEFAULT_ACK_DEADLINE_MS } from './config.js';

describe('gateway delivery deadline configuration', () => {
  it('uses the bounded positive delivery deadline from the environment', () => {
    expect(configuredAckDeadlineMs({})).toBe(DEFAULT_ACK_DEADLINE_MS);
    expect(configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: '600000' })).toBe(600_000);
  });

  it.each(['', '0', '-1', '1.5', 'not-a-number'])(
    'fails closed for invalid CAUCE_ACK_DEADLINE_MS=%j',
    (value) => {
      expect(() => configuredAckDeadlineMs({ CAUCE_ACK_DEADLINE_MS: value })).toThrow(
        /CAUCE_ACK_DEADLINE_MS must be a positive integer/u,
      );
    },
  );
});
