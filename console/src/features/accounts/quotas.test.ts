import { describe, expect, it } from 'vitest';
import type { QuotaGroup, QuotaProviderReport, QuotaWindow } from '../../api/types';
import {
  balanceSeverity, buildQuotaRows, formatPercent, formatResetIn, formatUnits, groupWindowsByFamily,
  isAgeStale, severityMetricTone, severityRank, sortProvidersBySeverity, worstWindow,
} from './quotas';

function window(overrides: Partial<QuotaWindow>): QuotaWindow {
  return { window_key: 'session', label: 'sesión', used_percent: 0, remaining_percent: 100, severity: 'ok', ...overrides };
}

describe('severityRank', () => {
  it('ranks unknown above ok: an unreadable severity must not read as healthy', () => {
    expect(severityRank('unknown')).toBeGreaterThan(severityRank('ok'));
  });

  it('un proveedor que no informa severidad rankea como unknown, nunca como ok', () => {
    expect(severityRank(null)).toBe(severityRank('unknown'));
    expect(severityRank(undefined)).toBe(severityRank('unknown'));
    expect(severityRank(null)).toBeGreaterThan(severityRank('ok'));
  });

  it('ranks exhausted as the worst', () => {
    expect(severityRank('exhausted')).toBeGreaterThan(severityRank('critical'));
    expect(severityRank('critical')).toBeGreaterThan(severityRank('warn'));
  });
});

describe('worstWindow', () => {
  it('picks the higher-severity window over one with merely lower remaining_percent', () => {
    const windows = [
      window({ window_key: 'week', severity: 'warn', remaining_percent: 5 }),
      window({ window_key: 'session', severity: 'exhausted', remaining_percent: 50 }),
    ];
    expect(worstWindow(windows)?.window_key).toBe('session');
  });

  it('at equal severity, picks the lower remaining_percent, nulls last', () => {
    const windows = [
      window({ window_key: 'a', severity: 'ok', remaining_percent: null }),
      window({ window_key: 'b', severity: 'ok', remaining_percent: 40 }),
    ];
    expect(worstWindow(windows)?.window_key).toBe('b');
  });

  it('returns undefined for an empty list rather than throwing', () => {
    expect(worstWindow([])).toBeUndefined();
  });
});

describe('groupWindowsByFamily', () => {
  it('keeps windows without a family as independent single-window groups', () => {
    const windows = [window({ window_key: 'session', family: null }), window({ window_key: 'week_all', family: null })];
    const groups = groupWindowsByFamily(windows);
    expect(groups).toHaveLength(2);
    expect(groups.every((group) => !group.collapsible)).toBe(true);
  });

  it('collapses same-family windows (antigravity: one grant, many models) into one collapsible group', () => {
    const windows = [
      window({ window_key: 'gemini-3.1-pro-preview', family: 'gemini', remaining_percent: 100, severity: 'ok' }),
      window({ window_key: 'gemini-3-flash-preview', family: 'gemini', remaining_percent: 40, severity: 'warn' }),
    ];
    const groups = groupWindowsByFamily(windows);
    expect(groups).toHaveLength(1);
    expect(groups[0].collapsible).toBe(true);
    // The worst window of the collapsed group drives the visible summary by default.
    expect(groups[0].worst.window_key).toBe('gemini-3-flash-preview');
  });
});

describe('buildQuotaRows', () => {
  it('flattens provider groups into one row per account+family, not per raw window', () => {
    const groups: QuotaGroup[] = [
      {
        group_key: 'default',
        windows: [window({ window_key: 'session', family: null }), window({ window_key: 'week_all', family: null })],
      },
      {
        group_key: 'codex_bengalfox',
        account_id: null,
        windows: [window({ window_key: 'codex_bengalfox_primary_10080', family: null })],
      },
    ];
    const rows = buildQuotaRows(groups);
    expect(rows).toHaveLength(3);
    expect(rows.filter((row) => row.group.group_key === 'default')).toHaveLength(2);
  });
});

describe('sortProvidersBySeverity', () => {
  it('places the exhausted provider (codex) above an ok one (opencode)', () => {
    const providers: QuotaProviderReport[] = [
      { host: 'kratos', provider: 'opencode', severity: 'ok' },
      { host: 'kratos', provider: 'codex', severity: 'exhausted' },
    ];
    expect(sortProvidersBySeverity(providers).map((p) => p.provider)).toEqual(['codex', 'opencode']);
  });
});

describe('formatResetIn', () => {
  it('never claims a healthy countdown for an already-expired reset', () => {
    expect(formatResetIn(-10)).toBe('vencido');
  });

  it('dice que no hay dato cuando el servidor no manda cuenta atrás de reset', () => {
    expect(formatResetIn(null)).toBe('sin dato');
  });

  it('renders a coarse human duration for a real countdown', () => {
    expect(formatResetIn(3469)).toBe('en 57m');
    expect(formatResetIn(447_970)).toBe('en 5d 4h');
  });
});

describe('isAgeStale', () => {
  it('stays undefined (unknown) rather than assuming freshness when a threshold is missing', () => {
    expect(isAgeStale(1000, null)).toBeUndefined();
    expect(isAgeStale(null, 900)).toBeUndefined();
  });

  it('compares age against the threshold when both are known', () => {
    expect(isAgeStale(1000, 900)).toBe(true);
    expect(isAgeStale(500, 900)).toBe(false);
  });
});

describe('formatUnits', () => {
  it('omits the units pair entirely when the provider never reports a limit', () => {
    expect(formatUnits(null, null)).toBeUndefined();
  });

  it('renders used/limit when the provider reports real units (opencode)', () => {
    expect(formatUnits(0, 12)).toBe('0 / 12');
  });
});

describe('balanceSeverity', () => {
  const thresholds = { warn_remaining_percent: 25, critical_remaining_percent: 10 };

  it('respeta la severidad del servidor: una ventana rate-limited informa 100 % libre y AGOTADO a la vez', () => {
    expect(balanceSeverity(100, 'exhausted', thresholds)).toBe('exhausted');
  });

  it('usa el mismo `<` que el servidor en los bordes exactos: con `<=` la misma cuenta cambiaba de color entre pestañas', () => {
    expect(balanceSeverity(25, null, thresholds)).toBe('ok');
    expect(balanceSeverity(24.9, null, thresholds)).toBe('warn');
    expect(balanceSeverity(10, null, thresholds)).toBe('warn');
    expect(balanceSeverity(9.9, null, thresholds)).toBe('critical');
  });

  it('sin umbrales del servidor cae a 10/25, los mismos que usa el servidor', () => {
    expect(balanceSeverity(25, null, null)).toBe('ok');
    expect(balanceSeverity(24.9, null, null)).toBe('warn');
    expect(balanceSeverity(10, null, undefined)).toBe('warn');
    expect(balanceSeverity(9.9, null, undefined)).toBe('critical');
  });

  it('0 % es agotado, no meramente crítico', () => {
    expect(balanceSeverity(0, null, thresholds)).toBe('exhausted');
  });

  it('sin porcentaje no supone salud: queda en SIN DATO', () => {
    expect(balanceSeverity(null, null, thresholds)).toBe('unknown');
    expect(balanceSeverity(Number.NaN, null, thresholds)).toBe('unknown');
  });

  it('sin umbrales del servidor cae en los mismos que trae la migración', () => {
    expect(balanceSeverity(25, null, null)).toBe('ok');
    expect(balanceSeverity(9.9, null, null)).toBe('critical');
  });
});

describe('severityMetricTone', () => {
  it('agotado y crítico gritan en rojo; sin dato no se pinta de verde', () => {
    expect(severityMetricTone('exhausted')).toBe('danger');
    expect(severityMetricTone('critical')).toBe('danger');
    expect(severityMetricTone('warn')).toBe('warning');
    expect(severityMetricTone('ok')).toBe('positive');
    expect(severityMetricTone('unknown')).toBe('neutral');
  });
});

describe('formatPercent', () => {
  it('corta en un decimal el 33.333333333333336 que publican los recolectores', () => {
    expect(formatPercent(100 / 3)).toBe('33.3%');
    expect(formatPercent(66.66666666666667)).toBe('66.7%');
  });

  it('no le agrega decimales a un entero', () => {
    expect(formatPercent(42)).toBe('42%');
    expect(formatPercent(0)).toBe('0%');
  });
});
