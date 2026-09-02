import { describe, expect, it } from 'vitest';
import { booleanEnv, exponentialBackoff, integerEnv, portEnv, requiredEnv } from '../src/index.js';

describe('environment parsing', () => {
  it('falls back only when the variable is absent', () => {
    expect(integerEnv({}, 'CAUCE_ACK_DEADLINE_MS', { fallback: 30_000 })).toBe(30_000);
    expect(integerEnv({ CAUCE_ACK_DEADLINE_MS: '250' }, 'CAUCE_ACK_DEADLINE_MS', { fallback: 30_000 }))
      .toBe(250);
  });

  it('rejects an empty string instead of reading it as zero', () => {
    expect(() => integerEnv({ CAUCE_ACK_DEADLINE_MS: '' }, 'CAUCE_ACK_DEADLINE_MS', { fallback: 30_000 }))
      .toThrow('CAUCE_ACK_DEADLINE_MS must be a positive integer');
  });

  it.each(['1.5', 'no-es-numero', String(Number.MAX_SAFE_INTEGER + 1), '-1'])(
    'rejects %j as a positive integer',
    (raw) => {
      expect(() => integerEnv({ X: raw }, 'X', { fallback: 1 })).toThrow('X must be a positive integer');
    },
  );

  it('names the non-negative rule when zero is admissible', () => {
    expect(integerEnv({ X: '0' }, 'X', { fallback: 1, min: 0 })).toBe(0);
    expect(() => integerEnv({ X: '-1' }, 'X', { fallback: 1, min: 0 }))
      .toThrow('X must be a non-negative integer');
  });

  it('reports the closed range when a maximum is given', () => {
    expect(integerEnv({ X: '32' }, 'X', { fallback: 1, max: 32 })).toBe(32);
    expect(() => integerEnv({ X: '33' }, 'X', { fallback: 1, max: 32 }))
      .toThrow('X must be an integer between 1 and 32');
  });

  it('caps a port at the TCP range', () => {
    expect(portEnv({}, 'PORT', 8443)).toBe(8443);
    expect(portEnv({ PORT: '65535' }, 'PORT', 8443)).toBe(65_535);
    expect(() => portEnv({ PORT: '65536' }, 'PORT', 8443)).toThrow('PORT must be a valid TCP port');
    expect(() => portEnv({ PORT: '0' }, 'PORT', 8443)).toThrow('PORT must be a positive integer');
  });

  it.each([['1', true], ['0', false], ['true', false], ['', false]] as const)(
    'reads %j as the boolean %j',
    (raw, expected) => {
      expect(booleanEnv({ FLAG: raw }, 'FLAG')).toBe(expected);
    },
  );

  it('uses the boolean fallback only when absent', () => {
    expect(booleanEnv({}, 'FLAG')).toBe(false);
    expect(booleanEnv({}, 'FLAG', true)).toBe(true);
    expect(booleanEnv({ FLAG: '' }, 'FLAG', true)).toBe(false);
  });

  it('demands a non-empty required variable', () => {
    expect(requiredEnv({ X: 'value' }, 'X')).toBe('value');
    expect(() => requiredEnv({ X: '' }, 'X')).toThrow('X is required');
    expect(() => requiredEnv({}, 'X')).toThrow('X is required');
  });
});

describe('exponential backoff schedules', () => {
  it.each([[0, 30], [1, 30], [2, 60], [3, 120], [4, 240], [5, 300], [9, 300]])(
    'timeout retry attempt %i waits %i seconds',
    (attempt, expected) => {
      expect(exponentialBackoff(attempt, { baseSeconds: 30, capSeconds: 300 })).toBe(expected);
    },
  );

  it.each([[1, 1], [2, 2], [3, 4], [7, 60], [12, 60]])(
    'ack retry attempt %i waits %i seconds',
    (attempt, expected) => {
      expect(exponentialBackoff(attempt, { baseSeconds: 1, capSeconds: 60 })).toBe(expected);
    },
  );

  it.each([[1, 1], [5, 16], [9, 256], [10, 300], [40, 300]])(
    'job retry attempt %i waits %i seconds',
    (attempt, expected) => {
      expect(exponentialBackoff(attempt, { baseSeconds: 1, capSeconds: 300 })).toBe(expected);
    },
  );
});

describe('integerEnv bounds', () => {
  it('an empty string is zero, which a non-negative bound admits as the documented off switch', () => {
    expect(integerEnv({ X: '' }, 'X', { fallback: 7, min: 0 })).toBe(0);
  });

  it('an empty string is rejected by a positive bound', () => {
    expect(() => integerEnv({ X: '' }, 'X', { fallback: 7 })).toThrow('X must be a positive integer');
  });

  it('a bound above one is named in the error', () => {
    expect(() => integerEnv({ X: '5' }, 'X', { fallback: 30_000, min: 30_000 }))
      .toThrow('X must be a safe integer of at least 30000');
  });
});
