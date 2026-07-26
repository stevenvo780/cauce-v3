import { describe, expect, it } from 'vitest';
import { timeoutRetryBackoffSeconds } from '../src/repository.js';

/**
 * La espera del reintento por garra vencida. No necesita Postgres: es aritmética pura, y es
 * justamente la pieza que faltaba — antes el reaper reintentaba con `available_at=now()`.
 */
describe('espera antes de reintentar una garra vencida', () => {
  it('nunca reintenta en el mismo instante', () => {
    for (let attempt = 1; attempt <= 12; attempt += 1) {
      expect(timeoutRetryBackoffSeconds(attempt)).toBeGreaterThan(0);
    }
  });

  it('crece al doble en cada intento, empezando en 30 s', () => {
    expect(timeoutRetryBackoffSeconds(1)).toBe(30);
    expect(timeoutRetryBackoffSeconds(2)).toBe(60);
    expect(timeoutRetryBackoffSeconds(3)).toBe(120);
    expect(timeoutRetryBackoffSeconds(4)).toBe(240);
  });

  it('tiene techo de 5 minutos, para que una cola vieja no quede parada un día', () => {
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

  it('tolera un intento 0 o negativo sin devolver una espera absurda', () => {
    expect(timeoutRetryBackoffSeconds(0)).toBe(30);
    expect(timeoutRetryBackoffSeconds(-5)).toBe(30);
  });
});
