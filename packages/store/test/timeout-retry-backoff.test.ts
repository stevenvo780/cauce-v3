import type { DatabasePool } from '../src/db.js';
import { describe, expect, it } from 'vitest';
import { CauceRepository, timeoutRetryBackoffSeconds } from '../src/repository.js';
import { ackFailureBackoffSeconds } from '../src/repository/observability/policy.js';

/**
 * The retry wait for an expired claim. It does not need Postgres: it is pure arithmetic, and it is
 * precisely the piece that was missing — before, the reaper retried with `available_at=now()`.
 */
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

  it('espera más que un fallo declarado por el agente, que llega a 60 s', () => {
    // A declared failure means the agent answered; an expired claim means it stayed mute for the
    // whole deadline. The second case deserves more patience, not less.
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(timeoutRetryBackoffSeconds(attempt)).toBeGreaterThan(ackFailureBackoffSeconds(attempt));
    }
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
