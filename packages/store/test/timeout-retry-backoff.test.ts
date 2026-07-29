import type { DatabasePool } from '../src/db.js';
import { describe, expect, it } from 'vitest';
import { CauceRepository, timeoutRetryBackoffSeconds } from '../src/repository.js';

describe('ACK-timeout retry backoff', () => {
  it('never schedules a real timeout retry in the same instant', () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect(timeoutRetryBackoffSeconds(attempt)).toBeGreaterThan(0);
    }
  });

  it('doubles from 30 seconds and caps at five minutes', () => {
    expect(timeoutRetryBackoffSeconds(1)).toBe(30);
    expect(timeoutRetryBackoffSeconds(2)).toBe(60);
    expect(timeoutRetryBackoffSeconds(3)).toBe(120);
    expect(timeoutRetryBackoffSeconds(4)).toBe(240);
    expect(timeoutRetryBackoffSeconds(5)).toBe(300);
    expect(timeoutRetryBackoffSeconds(40)).toBe(300);
  });

  it('keeps defensive behavior for a non-positive attempt', () => {
    expect(timeoutRetryBackoffSeconds(0)).toBe(30);
    expect(timeoutRetryBackoffSeconds(-5)).toBe(30);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'rejects an invalid public stale timeout before touching PostgreSQL: %s',
    async (staleMs) => {
      const repository = new CauceRepository({} as DatabasePool);
      await expect(repository.retryStaleDeliveries(staleMs)).rejects.toMatchObject({
        code: 'conflict',
      });
    },
  );
});
