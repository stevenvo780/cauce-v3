import { describe, expect, it } from 'vitest';
import { configuredDispatcher, DEFAULT_ACK_DEADLINE_MS } from '../src/config.js';

describe('dispatcher delivery deadline configuration', () => {
  it('accepts an ACK timeout equal to or greater than the gateway deadline', () => {
    expect(configuredDispatcher({}).ackDeadlineMs).toBe(DEFAULT_ACK_DEADLINE_MS);
    expect(configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '600000',
      ACK_TIMEOUT_MS: '600000',
    })).toMatchObject({ ackDeadlineMs: 600_000, ackTimeoutMs: 600_000 });
    expect(configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '600000',
      ACK_TIMEOUT_MS: '600001',
    }).ackTimeoutMs).toBe(600_001);
  });

  it('fails closed when dispatcher reaping can precede the claim deadline', () => {
    expect(() => configuredDispatcher({
      CAUCE_ACK_DEADLINE_MS: '600000',
      ACK_TIMEOUT_MS: '120000',
    })).toThrow(/equal to or greater/u);
  });

  it.each([
    { CAUCE_ACK_DEADLINE_MS: '0' },
    { CAUCE_ACK_DEADLINE_MS: 'invalid' },
    { ACK_TIMEOUT_MS: '-1' },
    { ACK_TIMEOUT_MS: '1.5' },
  ])('rejects invalid positive-integer config %#', (environment) => {
    expect(() => configuredDispatcher(environment)).toThrow(/positive integer/u);
  });
});
