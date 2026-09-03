import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_QUOTA_THRESHOLDS, windowSeverity, worstQuotaSeverity,
  type QuotaSeverity, type QuotaThresholds,
} from '@cauce/store';

const CONSOLE_QUOTAS = fileURLToPath(
  new URL('../../console/src/features/accounts/quotas.ts', import.meta.url)
);

/**
 * Mirror of `balanceSeverity` (console/src/features/accounts/quotas.ts), copied by hand because the
 * root tsconfig cannot compile the console tree (bundler-style relative imports without extension).
 * The copy is worthless on its own, so the test below also pins the three comparisons of the
 * original: if the console ladder is edited, the assertion on the source text fails.
 */
function espejoDeLaConsola(
  remainingPercent: number | null | undefined,
  severity: QuotaSeverity | null | undefined,
  thresholds: QuotaThresholds | null | undefined,
): QuotaSeverity {
  if (severity) return severity;
  if (typeof remainingPercent !== 'number' || !Number.isFinite(remainingPercent)) return 'unknown';
  if (remainingPercent <= 0) return 'exhausted';
  if (remainingPercent < (thresholds?.critical_remaining_percent ?? 10)) return 'critical';
  if (remainingPercent < (thresholds?.warn_remaining_percent ?? 25)) return 'warn';
  return 'ok';
}

describe('windowSeverity', () => {
  it('trata rate-limited como agotado aunque el recolector diga que queda el 100 %', () => {
    expect(windowSeverity(100, 'rate-limited')).toBe('exhausted');
    expect(windowSeverity(63, 'rate-limited')).toBe('exhausted');
  });

  it('sin porcentaje devuelve unknown, pero rate-limited gana sobre la ausencia de dato', () => {
    expect(windowSeverity(null, null)).toBe('unknown');
    expect(windowSeverity(null, 'ok')).toBe('unknown');
    expect(windowSeverity(null, 'rate-limited')).toBe('exhausted');
  });

  it('el cero es agotado, no crítico', () => {
    expect(windowSeverity(0, null)).toBe('exhausted');
    expect(windowSeverity(-1, null)).toBe('exhausted');
    expect(windowSeverity(0.01, null)).toBe('critical');
  });

  it('las fronteras 10 y 25 son estrictas: el umbral exacto ya no es la severidad peor', () => {
    expect(windowSeverity(9.99, null)).toBe('critical');
    expect(windowSeverity(10, null)).toBe('warn');
    expect(windowSeverity(24.99, null)).toBe('warn');
    expect(windowSeverity(25, null)).toBe('ok');
    expect(DEFAULT_QUOTA_THRESHOLDS.critical_remaining_percent).toBe(10);
    expect(DEFAULT_QUOTA_THRESHOLDS.warn_remaining_percent).toBe(25);
  });

  it('los umbrales personalizados pisan a los por defecto', () => {
    const estrictos: QuotaThresholds = { ...DEFAULT_QUOTA_THRESHOLDS,
      critical_remaining_percent: 40, warn_remaining_percent: 80 };
    expect(windowSeverity(39, null, estrictos)).toBe('critical');
    expect(windowSeverity(50, null, estrictos)).toBe('warn');
    expect(windowSeverity(80, null, estrictos)).toBe('ok');
    expect(windowSeverity(50, null)).toBe('ok');
  });
});

describe('worstQuotaSeverity', () => {
  it('una lista vacía es unknown, no ok', () => {
    expect(worstQuotaSeverity([])).toBe('unknown');
  });

  it('un grupo agotado no se esconde detrás de hermanos sanos', () => {
    expect(worstQuotaSeverity(['ok', 'ok', 'exhausted', 'ok'])).toBe('exhausted');
    expect(worstQuotaSeverity(['ok', 'critical', 'warn'])).toBe('critical');
    expect(worstQuotaSeverity(['ok', 'warn'])).toBe('warn');
    expect(worstQuotaSeverity(['unknown', 'ok'])).toBe('ok');
    expect(worstQuotaSeverity(['unknown', 'unknown'])).toBe('unknown');
  });

  it('el rango completo ordena unknown < ok < warn < critical < exhausted', () => {
    const rango: QuotaSeverity[] = ['unknown', 'ok', 'warn', 'critical', 'exhausted'];
    for (let i = 0; i < rango.length; i += 1) {
      for (let j = 0; j < rango.length; j += 1) {
        const esperado = rango[Math.max(i, j)];
        const izquierda = rango[i];
        const derecha = rango[j];
        if (izquierda === undefined || derecha === undefined) throw new Error('rango incompleto');
        expect(worstQuotaSeverity([izquierda, derecha])).toBe(esperado);
      }
    }
  });
});

describe('el espejo de la consola no puede divergir del servidor', () => {
  const escalera = [0, 9.99, 10, 24.99, 25];

  it('coincide con windowSeverity en la escalera 0 / 9,99 / 10 / 24,99 / 25', () => {
    for (const porcentaje of escalera) {
      expect(espejoDeLaConsola(porcentaje, null, DEFAULT_QUOTA_THRESHOLDS))
        .toBe(windowSeverity(porcentaje, null));
      expect(espejoDeLaConsola(porcentaje, null, null)).toBe(windowSeverity(porcentaje, null));
    }
    expect(espejoDeLaConsola(null, null, null)).toBe(windowSeverity(null, null));
  });

  it('la severidad que viaja del servidor gana sobre el cálculo local', () => {
    expect(espejoDeLaConsola(100, 'exhausted', null)).toBe('exhausted');
    expect(espejoDeLaConsola(0, 'ok', null)).toBe('ok');
  });

  it('la consola sigue escribiendo esa misma escalera', () => {
    const fuente = readFileSync(CONSOLE_QUOTAS, 'utf8');
    expect(fuente).toContain('if (remainingPercent <= 0) return \'exhausted\';');
    expect(fuente).toContain(
      'if (remainingPercent < (thresholds?.critical_remaining_percent ?? 10)) return \'critical\';'
    );
    expect(fuente).toContain(
      'if (remainingPercent < (thresholds?.warn_remaining_percent ?? 25)) return \'warn\';'
    );
  });
});
