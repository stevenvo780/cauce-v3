import type { DatabasePool } from '../src/db.js';
import { describe, expect, it } from 'vitest';
import { CauceRepository, timeoutRetryBackoffSeconds } from '../src/repository.js';

/**
 * La espera del reintento por garra vencida. No necesita Postgres: es aritmética pura, y es
 * justamente la pieza que faltaba — antes el reaper reintentaba con `available_at=now()`.
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
    // Un fallo declarado significa que el agente contestó; una garra vencida significa que
    // estuvo mudo todo el plazo. El segundo caso merece más paciencia, no menos.
    const falloDeclarado = (attempt: number): number => Math.min(60, 2 ** Math.max(0, attempt - 1));
    for (let attempt = 1; attempt <= 6; attempt += 1) {
      expect(timeoutRetryBackoffSeconds(attempt)).toBeGreaterThan(falloDeclarado(attempt));
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
