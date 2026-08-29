import { describe, expect, it } from 'vitest';
import {
  MAX_QUOTA_WINDOWS_PER_COLLECTION,
  QuotaAccountIdSchema,
  QuotaGroupKeySchema,
  QuotaHostSchema,
  QuotaProviderNameSchema,
  QuotaProviderReportSchema,
  QuotaSampleRequestSchema,
  QuotaStatusSchema,
  QuotaWindowKeySchema,
  QuotaWindowSampleSchema,
  SUPPORTED_QUOTA_SCHEMA_VERSIONS
} from '../../packages/protocol/src/schemas/quotas.js';

/**
 * Valida el contrato del colector de cuotas (POST /v3/quotas/samples). El colector
 * corre fuera del gateway (en kratos y dentro de los contenedores de los agentes)
 * y se identifica por mTLS, no por cuerpo; por eso este esquema no pide tenant,
 * actor ni sesión.
 */

function ventanaValida(): Record<string, unknown> {
  return {
    group_key: 'grp-1',
    window_key: 'wk-1',
    used_percent: 42.5
  };
}

function proveedorValido(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    provider: 'minimax',
    ok: true,
    windows: [ventanaValida()],
    ...overrides
  };
}

function coleccionValida(providers: unknown[] = [proveedorValido()]): Record<string, unknown> {
  return {
    host: 'kratos-01',
    captured_at: '2026-08-29T12:00:00.000Z',
    schema_version: 2,
    providers
  };
}

describe('QuotaHostSchema', () => {
  it('acepta un host con guion, punto y guion bajo', () => {
    expect(QuotaHostSchema.parse('kratos-01.local')).toBe('kratos-01.local');
  });

  it('acepta el host más largo permitido por la regex (128 caracteres)', () => {
    const host = 'a' + 'b'.repeat(127);
    expect(QuotaHostSchema.parse(host)).toBe(host);
  });

  it('rechaza un host que empieza con guion', () => {
    expect(QuotaHostSchema.safeParse('-kratos').success).toBe(false);
  });

  it('rechaza un host que excede el largo máximo', () => {
    const host = 'a' + 'b'.repeat(128);
    expect(QuotaHostSchema.safeParse(host).success).toBe(false);
  });
});

describe('QuotaProviderNameSchema', () => {
  it('acepta un nombre en minúsculas con dígitos', () => {
    expect(QuotaProviderNameSchema.parse('minimax')).toBe('minimax');
  });

  it('rechaza un nombre con mayúsculas', () => {
    expect(QuotaProviderNameSchema.safeParse('MiniMax').success).toBe(false);
  });

  it('rechaza un nombre que empieza con dígito', () => {
    expect(QuotaProviderNameSchema.safeParse('1provider').success).toBe(false);
  });

  it('rechaza un nombre que excede 64 caracteres', () => {
    const name = 'a' + 'b'.repeat(64);
    expect(QuotaProviderNameSchema.safeParse(name).success).toBe(false);
  });
});

describe('QuotaGroupKeySchema', () => {
  it('acepta una clave con dos puntos y guion', () => {
    expect(QuotaGroupKeySchema.parse('group:alpha-1')).toBe('group:alpha-1');
  });

  it('rechaza una clave que empieza con dos puntos', () => {
    expect(QuotaGroupKeySchema.safeParse(':foo').success).toBe(false);
  });
});

describe('QuotaWindowKeySchema', () => {
  it('acepta una clave con punto y guion', () => {
    expect(QuotaWindowKeySchema.parse('window.alpha-1')).toBe('window.alpha-1');
  });

  it('rechaza una clave que excede 128 caracteres', () => {
    const key = 'a' + 'b'.repeat(128);
    expect(QuotaWindowKeySchema.safeParse(key).success).toBe(false);
  });
});

describe('QuotaStatusSchema', () => {
  it('acepta un estado en minúsculas con guion', () => {
    expect(QuotaStatusSchema.parse('rate_limited')).toBe('rate_limited');
  });

  it('acepta un estado con mayúsculas rechazadas', () => {
    expect(QuotaStatusSchema.safeParse('OK').success).toBe(false);
  });

  it('rechaza un estado que excede 32 caracteres', () => {
    const status = 'a' + 'b'.repeat(32);
    expect(QuotaStatusSchema.safeParse(status).success).toBe(false);
  });
});

describe('QuotaAccountIdSchema', () => {
  it('acepta un account id en minúsculas con guion', () => {
    expect(QuotaAccountIdSchema.parse('acct-pro-1')).toBe('acct-pro-1');
  });

  it('rechaza un account id con mayúsculas', () => {
    expect(QuotaAccountIdSchema.safeParse('Acct-1').success).toBe(false);
  });
});

describe('SUPPORTED_QUOTA_SCHEMA_VERSIONS', () => {
  it('contiene 1 y 2, y solo esos', () => {
    expect(SUPPORTED_QUOTA_SCHEMA_VERSIONS).toEqual([1, 2]);
  });
});

describe('MAX_QUOTA_WINDOWS_PER_COLLECTION', () => {
  it('vale 512 (tope duro por colección)', () => {
    expect(MAX_QUOTA_WINDOWS_PER_COLLECTION).toBe(512);
  });
});

describe('QuotaWindowSampleSchema', () => {
  it('acepta una ventana con used_percent y normaliza defaults', () => {
    const parsed = QuotaWindowSampleSchema.parse({
      group_key: 'grp-1',
      window_key: 'wk-1',
      used_percent: 50
    });
    expect(parsed.used_percent).toBe(50);
    expect(parsed.remaining_percent).toBeUndefined();
    expect(parsed.status).toBeUndefined();
  });

  it('acepta una ventana con solo remaining_percent (no necesita used_percent)', () => {
    const parsed = QuotaWindowSampleSchema.parse({
      group_key: 'grp-1',
      window_key: 'wk-1',
      remaining_percent: 25
    });
    expect(parsed.remaining_percent).toBe(25);
  });

  it('acepta una ventana con solo used_units (no necesita used_percent ni remaining)', () => {
    const parsed = QuotaWindowSampleSchema.parse({
      group_key: 'grp-1',
      window_key: 'wk-1',
      used_units: 12345
    });
    expect(parsed.used_units).toBe(12345);
  });

  it('rechaza used_percent fuera de rango (negativo)', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      used_percent: -0.1
    }).success).toBe(false);
  });

  it('rechaza used_percent por encima de 100', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      used_percent: 100.1
    }).success).toBe(false);
  });

  it('rechaza remaining_percent por encima de 100', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      remaining_percent: 200
    }).success).toBe(false);
  });

  it('rechaza used_units negativo (no es integer.nonnegative)', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      used_units: -1
    }).success).toBe(false);
  });

  it('rechaza used_units que no es entero', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      used_units: 1.5
    }).success).toBe(false);
  });

  it('rechaza limit_units cero o negativo', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      limit_units: 0
    }).success).toBe(false);
  });

  it('rechaza window_minutes que no es entero positivo', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      window_minutes: 0
    }).success).toBe(false);
  });

  it('rechaza reset_at que no es fecha ISO con offset', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      reset_at: 'mañana'
    }).success).toBe(false);
  });

  it('acepta reset_at como fecha ISO 8601 con offset', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      reset_at: '2026-09-01T00:00:00.000-03:00'
    }).success).toBe(true);
  });

  it('rechaza label vacío (min 1)', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      label: ''
    }).success).toBe(false);
  });

  it('rechaza label de más de 64 caracteres', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      label: 'a'.repeat(65)
    }).success).toBe(false);
  });

  it('rechaza un campo desconocido por estar en strict mode', () => {
    expect(QuotaWindowSampleSchema.safeParse({
      ...ventanaValida(),
      extra: 'no-va'
    }).success).toBe(false);
  });

  it('refine: rechaza cuando los tres campos opcionales son undefined', () => {
    const result = QuotaWindowSampleSchema.safeParse({
      group_key: 'grp-1',
      window_key: 'wk-1'
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('used_percent'))).toBe(true);
    }
  });

  it('refine: rechaza cuando los tres campos opcionales son null explícitos', () => {
    const result = QuotaWindowSampleSchema.safeParse({
      group_key: 'grp-1',
      window_key: 'wk-1',
      used_percent: null,
      remaining_percent: null,
      used_units: null
    });
    expect(result.success).toBe(false);
  });
});

describe('QuotaProviderReportSchema', () => {
  it('acepta un reporte mínimo con defaults (available=false, ventanas=[])', () => {
    const parsed = QuotaProviderReportSchema.parse({
      provider: 'minimax',
      ok: true
    });
    expect(parsed.available).toBe(false);
    expect(parsed.available_groups).toEqual([]);
    expect(parsed.limiting_groups).toEqual([]);
    expect(parsed.windows).toEqual([]);
  });

  it('acepta un reporte con available=true y todos los campos opcionales', () => {
    const parsed = QuotaProviderReportSchema.parse({
      provider: 'minimax',
      ok: true,
      available: true,
      kind: 'subscription',
      source: 'collector-cli',
      plan: 'pro',
      note: 'todo bien',
      effective_remaining_percent: 73,
      observed_at: '2026-08-29T12:00:00.000+02:00',
      available_groups: ['grp-1'],
      limiting_groups: ['grp-2'],
      windows: [ventanaValida()]
    });
    expect(parsed.available).toBe(true);
    expect(parsed.windows).toHaveLength(1);
  });

  it('rechaza un campo extra por estar en strict mode', () => {
    expect(QuotaProviderReportSchema.safeParse({
      provider: 'minimax',
      ok: true,
      extra: 'no-va'
    }).success).toBe(false);
  });

  it('rechaza un provider con nombre inválido', () => {
    expect(QuotaProviderReportSchema.safeParse({
      provider: 'MiniMax',
      ok: true
    }).success).toBe(false);
  });

  it('rechaza una entrada de available_groups vacía (min 1)', () => {
    expect(QuotaProviderReportSchema.safeParse({
      provider: 'minimax',
      ok: true,
      available_groups: ['']
    }).success).toBe(false);
  });

  it('rechaza más de 64 elementos en available_groups', () => {
    const groups = Array.from({ length: 65 }, (_, i) => `g${String(i)}`);
    expect(QuotaProviderReportSchema.safeParse({
      provider: 'minimax',
      ok: true,
      available_groups: groups
    }).success).toBe(false);
  });

  it('rechaza más de 64 ventanas', () => {
    const windows = Array.from({ length: 65 }, () => ventanaValida());
    expect(QuotaProviderReportSchema.safeParse({
      provider: 'minimax',
      ok: true,
      windows
    }).success).toBe(false);
  });

  it('rechaza effective_remaining_percent fuera de rango', () => {
    expect(QuotaProviderReportSchema.safeParse({
      provider: 'minimax',
      ok: true,
      effective_remaining_percent: 150
    }).success).toBe(false);
  });

  it('rechaza note de más de 512 caracteres', () => {
    expect(QuotaProviderReportSchema.safeParse({
      provider: 'minimax',
      ok: true,
      note: 'a'.repeat(513)
    }).success).toBe(false);
  });

  it('rechaza observed_at que no es fecha ISO con offset', () => {
    expect(QuotaProviderReportSchema.safeParse({
      provider: 'minimax',
      ok: true,
      observed_at: 'ayer'
    }).success).toBe(false);
  });
});

describe('QuotaSampleRequestSchema', () => {
  it('acepta una colección válida con un solo proveedor', () => {
    const parsed = QuotaSampleRequestSchema.parse(coleccionValida());
    expect(parsed.providers).toHaveLength(1);
    expect(parsed.providers[0]?.provider).toBe('minimax');
  });

  it('acepta una colección sin proveedores (array vacío)', () => {
    const parsed = QuotaSampleRequestSchema.parse(coleccionValida([]));
    expect(parsed.providers).toEqual([]);
  });

  it('rechaza un campo extra por estar en strict mode', () => {
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      extra: 'no-va'
    }).success).toBe(false);
  });

  it('rechaza host inválido', () => {
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      host: '-malo'
    }).success).toBe(false);
  });

  it('rechaza captured_at que no es fecha ISO con offset', () => {
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      captured_at: 'hoy'
    }).success).toBe(false);
  });

  it('rechaza schema_version fuera del rango [1, 999]', () => {
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      schema_version: 0
    }).success).toBe(false);
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      schema_version: 1000
    }).success).toBe(false);
  });

  it('rechaza schema_version no entero', () => {
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      schema_version: 1.5
    }).success).toBe(false);
  });

  it('rechaza app_version vacío (min 1)', () => {
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      app_version: ''
    }).success).toBe(false);
  });

  it('rechaza app_version de más de 64 caracteres', () => {
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      app_version: 'a'.repeat(65)
    }).success).toBe(false);
  });

  it('rechaza más de 32 proveedores', () => {
    const providers = Array.from({ length: 33 }, (_, i) => proveedorValido({ provider: `prov${String(i)}` }));
    expect(QuotaSampleRequestSchema.safeParse(coleccionValida(providers)).success).toBe(false);
  });

  it('acepta 32 proveedores (el tope) con nombres distintos', () => {
    const providers = Array.from({ length: 32 }, (_, i) => proveedorValido({ provider: `prov${String(i)}` }));
    expect(QuotaSampleRequestSchema.safeParse(coleccionValida(providers)).success).toBe(true);
  });

  it('superRefine: acepta exactamente MAX_QUOTA_WINDOWS_PER_COLLECTION ventanas', () => {
    const porProveedor = MAX_QUOTA_WINDOWS_PER_COLLECTION / 32;
    const providers = Array.from({ length: 32 }, (_, i) =>
      proveedorValido({
        provider: `prov${String(i)}`,
        windows: Array.from({ length: porProveedor }, (_, j) =>
          ({ group_key: `grp-${String(j)}`, window_key: `wk-${String(j)}`, used_percent: 10 })
        )
      })
    );
    expect(QuotaSampleRequestSchema.safeParse(coleccionValida(providers)).success).toBe(true);
  });

  it('superRefine: rechaza cuando totalWindows > MAX_QUOTA_WINDOWS_PER_COLLECTION', () => {
    const sobrepaso = MAX_QUOTA_WINDOWS_PER_COLLECTION + 1;
    const mitad = Math.ceil(sobrepaso / 2);
    const resto = sobrepaso - mitad;
    const providers = [
      proveedorValido({
        provider: 'prov-a',
        windows: Array.from({ length: mitad }, () => ventanaValida())
      }),
      proveedorValido({
        provider: 'prov-b',
        windows: Array.from({ length: resto }, () => ventanaValida())
      })
    ];
    const result = QuotaSampleRequestSchema.safeParse(coleccionValida(providers));
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('windows in total'))).toBe(true);
    }
  });

  it('superRefine: rechaza cuando hay 2 proveedores con el mismo nombre', () => {
    const result = QuotaSampleRequestSchema.safeParse(coleccionValida([
      proveedorValido({ provider: 'minimax' }),
      proveedorValido({ provider: 'minimax' })
    ]));
    expect(result.success).toBe(false);
    if (!result.success) {
      const messages = result.error.issues.map((issue) => issue.message);
      expect(messages.some((m) => m.includes('duplicate provider'))).toBe(true);
    }
  });

  it('superRefine: acepta 3 proveedores distintos, cada uno con varias ventanas', () => {
    const providers = [
      proveedorValido({
        provider: 'prov-a',
        windows: [
          ventanaValida(),
          { ...ventanaValida(), window_key: 'wk-2', used_percent: 30 }
        ]
      }),
      proveedorValido({
        provider: 'prov-b',
        windows: [ventanaValida()]
      }),
      proveedorValido({
        provider: 'prov-c',
        ok: false,
        windows: []
      })
    ];
    expect(QuotaSampleRequestSchema.safeParse(coleccionValida(providers)).success).toBe(true);
  });

  it('acepta app_version null explícito', () => {
    expect(QuotaSampleRequestSchema.safeParse({
      ...coleccionValida(),
      app_version: null
    }).success).toBe(true);
  });
});
