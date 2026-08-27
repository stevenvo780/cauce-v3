import { describe, expect, it } from 'vitest';
import {
  AGENT_PROFILE_LIMITS, AgentProfileError, countCodePoints, countUtf16Units,
  measureStrictestUnits, normalizeAgentProfile
} from '@cauce/protocol';

/**
 * Validación de límites de perfil de agente en unidades UTF-16 y puntos de código.
 *
 * El límite evalúa la unidad más estricta para garantizar consistencia entre
 * las restricciones en TypeScript (Zod UTF-16) y PostgreSQL.
 */

/** Un emoji fuera del BMP: 1 punto de código, 2 unidades UTF-16. El caso que rompió todo. */
const ASTRAL = '\u{1F389}';

function perfilBase(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    tenant_id: 'Steven',
    alias: 'zeus',
    purpose: 'Orquestar la flota y reparar Cauce.',
    role_summary: 'Médico de la flota.',
    responsibilities: ['Diagnosticar fallos de entrega.'],
    restrictions: ['Nunca tocar credenciales.'],
    tools: ['cauce'],
    operating_rules: ['Comprobar el efecto, nunca el nombre.'],
    ...overrides
  };
}

describe('medición en las dos unidades', () => {
  it('cuenta puntos de código y unidades UTF-16 por separado, y son distintos fuera del BMP', () => {
    expect(countCodePoints(ASTRAL)).toBe(1);
    expect(countUtf16Units(ASTRAL)).toBe(2);
    expect(countCodePoints('ñ')).toBe(1);
    expect(countUtf16Units('ñ')).toBe(1);
  });

  it('la medida estricta es el máximo de las dos, nunca la más permisiva', () => {
    for (const texto of ['', 'abc', 'ñañ', ASTRAL, `a${ASTRAL}b`, ASTRAL.repeat(500)]) {
      expect(measureStrictestUnits(texto)).toBe(
        Math.max(countCodePoints(texto), countUtf16Units(texto))
      );
    }
  });

  /**
   * CONTROL NEGATIVO de la unidad. Este es exactamente el texto que la medida vieja —puntos de
   * código— habría dejado pasar y la nueva rechaza. Si alguien vuelve a medir con `countCodePoints`,
   * este test se pone rojo.
   */
  it('control negativo: un texto que PASA en puntos de código y FALLA en la medida estricta', () => {
    const texto = ASTRAL.repeat(AGENT_PROFILE_LIMITS.purpose);
    expect(countCodePoints(texto)).toBe(AGENT_PROFILE_LIMITS.purpose);
    expect(countCodePoints(texto)).toBeLessThanOrEqual(AGENT_PROFILE_LIMITS.purpose);
    expect(measureStrictestUnits(texto)).toBe(AGENT_PROFILE_LIMITS.purpose * 2);
    expect(() => normalizeAgentProfile(perfilBase({ purpose: texto }))).toThrow(AgentProfileError);
  });
});

describe('normalizeAgentProfile', () => {
  it('acepta un perfil bien formado y recorta los espacios de cada texto', () => {
    const perfil = normalizeAgentProfile(perfilBase({
      purpose: '  Orquestar.  ',
      responsibilities: ['  Diagnosticar.  ']
    }));
    expect(perfil.purpose).toBe('Orquestar.');
    expect(perfil.responsibilities).toEqual(['Diagnosticar.']);
    expect(perfil.tenant_id).toBe('Steven');
    expect(perfil.alias).toBe('zeus');
  });

  it('un perfil entero vacío es legítimo: sin propósito, sin rol y sin listas', () => {
    const perfil = normalizeAgentProfile({ tenant_id: 'Steven', alias: 'zeus' });
    expect(perfil.purpose).toBeNull();
    expect(perfil.role_summary).toBeNull();
    expect(perfil.responsibilities).toEqual([]);
    expect(perfil.restrictions).toEqual([]);
    expect(perfil.tools).toEqual([]);
    expect(perfil.operating_rules).toEqual([]);
  });

  it('un texto en blanco vale NULL, nunca la cadena vacía', () => {
    const perfil = normalizeAgentProfile(perfilBase({ purpose: '   ', role_summary: '' }));
    expect(perfil.purpose).toBeNull();
    expect(perfil.role_summary).toBeNull();
  });

  it('descarta los elementos en blanco de una lista en vez de guardarlos', () => {
    const perfil = normalizeAgentProfile(perfilBase({ responsibilities: ['  ', 'Real.', ''] }));
    expect(perfil.responsibilities).toEqual(['Real.']);
  });

  it('rechaza el propósito que pasa el tope, y el error dice el tope Y lo que se mandó', () => {
    const largo = 'a'.repeat(AGENT_PROFILE_LIMITS.purpose + 1);
    try {
      normalizeAgentProfile(perfilBase({ purpose: largo }));
      throw new Error('debía rechazarlo');
    } catch (error) {
      expect(error).toBeInstanceOf(AgentProfileError);
      const fallo = error as AgentProfileError;
      expect(fallo.field).toBe('purpose');
      expect(fallo.message).toContain(String(AGENT_PROFILE_LIMITS.purpose));
      expect(fallo.message).toContain(String(AGENT_PROFILE_LIMITS.purpose + 1));
    }
  });

  /** CONTROL NEGATIVO del tope de `purpose`: justo en el tope pasa. */
  it('control negativo: el propósito EXACTAMENTE en el tope se acepta', () => {
    const justo = 'a'.repeat(AGENT_PROFILE_LIMITS.purpose);
    expect(normalizeAgentProfile(perfilBase({ purpose: justo })).purpose).toBe(justo);
  });

  it('rechaza el rol que pasa el tope', () => {
    const largo = 'a'.repeat(AGENT_PROFILE_LIMITS.role_summary + 1);
    expect(() => normalizeAgentProfile(perfilBase({ role_summary: largo })))
      .toThrow(/role_summary/);
  });

  /** CONTROL NEGATIVO del tope de `role_summary`. */
  it('control negativo: el rol EXACTAMENTE en el tope se acepta', () => {
    const justo = 'a'.repeat(AGENT_PROFILE_LIMITS.role_summary);
    expect(normalizeAgentProfile(perfilBase({ role_summary: justo })).role_summary).toBe(justo);
  });

  it('rechaza un elemento de lista que pasa el tope por elemento', () => {
    const largo = 'a'.repeat(AGENT_PROFILE_LIMITS.item + 1);
    expect(() => normalizeAgentProfile(perfilBase({ restrictions: ['ok', largo] })))
      .toThrow(/restrictions/);
  });

  /** CONTROL NEGATIVO del tope por elemento. */
  it('control negativo: un elemento EXACTAMENTE en el tope se acepta', () => {
    const justo = 'a'.repeat(AGENT_PROFILE_LIMITS.item);
    expect(normalizeAgentProfile(perfilBase({ restrictions: [justo] })).restrictions)
      .toEqual([justo]);
  });

  it('rechaza una lista con más elementos de los admitidos', () => {
    const muchos = Array.from({ length: AGENT_PROFILE_LIMITS.items + 1 }, (_, i) => `r${i}`);
    expect(() => normalizeAgentProfile(perfilBase({ tools: muchos }))).toThrow(/tools/);
  });

  /** CONTROL NEGATIVO de la cardinalidad: el número exacto de elementos entra. */
  it('control negativo: EXACTAMENTE el número de elementos admitido se acepta', () => {
    const justos = Array.from({ length: AGENT_PROFILE_LIMITS.items }, (_, i) => `r${i}`);
    expect(normalizeAgentProfile(perfilBase({ tools: justos })).tools).toHaveLength(
      AGENT_PROFILE_LIMITS.items
    );
  });

  it('rechaza el perfil que pasa el presupuesto TOTAL aunque cada campo entre solo', () => {
    // Cada elemento entra en su tope y cada lista en su cardinalidad; sumados no entran.
    const relleno = Array.from({ length: AGENT_PROFILE_LIMITS.items }, () =>
      'a'.repeat(AGENT_PROFILE_LIMITS.item));
    expect(() => normalizeAgentProfile(perfilBase({
      responsibilities: relleno, restrictions: relleno, tools: relleno, operating_rules: relleno
    }))).toThrow(/total/);
  });

  /** CONTROL NEGATIVO del presupuesto total: EXACTAMENTE en el presupuesto entra. */
  it('control negativo: un perfil que llena el presupuesto total sin pasarlo se acepta', () => {
    const item = 'a'.repeat(AGENT_PROFILE_LIMITS.item);
    const cuantos = AGENT_PROFILE_LIMITS.total / AGENT_PROFILE_LIMITS.item;
    const perfil = normalizeAgentProfile({
      tenant_id: 'Steven', alias: 'zeus',
      responsibilities: Array.from({ length: cuantos }, () => item)
    });
    expect(perfil.responsibilities).toHaveLength(cuantos);
  });

  it('rechaza un campo de texto que no es texto', () => {
    expect(() => normalizeAgentProfile(perfilBase({ purpose: 42 }))).toThrow(/purpose/);
  });

  it('rechaza una lista que no es una lista', () => {
    expect(() => normalizeAgentProfile(perfilBase({ tools: 'cauce' }))).toThrow(/tools/);
  });

  it('rechaza un elemento de lista que no es texto', () => {
    expect(() => normalizeAgentProfile(perfilBase({ tools: ['ok', 7] }))).toThrow(/tools/);
  });

  /**
   * CONTROL NEGATIVO de la unidad EN EL PRESUPUESTO TOTAL, que es donde más barato sale
   * equivocarse: un elemento de 500 emojis mide 500 puntos de código y 1.000 unidades UTF-16.
   * Veinticinco de ellos son 12.500 puntos de código —la mitad del presupuesto— y 25.000
   * unidades UTF-16, que se pasan. Un total contado en puntos de código lo aceptaría.
   */
  it('el presupuesto total se mide en la unidad estricta, no en puntos de código', () => {
    const elemento = ASTRAL.repeat(AGENT_PROFILE_LIMITS.item / 2);
    expect(countCodePoints(elemento)).toBe(AGENT_PROFILE_LIMITS.item / 2);
    expect(measureStrictestUnits(elemento)).toBe(AGENT_PROFILE_LIMITS.item);

    const justos = AGENT_PROFILE_LIMITS.total / AGENT_PROFILE_LIMITS.item;
    const cabe = Array.from({ length: justos }, () => elemento);
    expect(normalizeAgentProfile({
      tenant_id: 'Steven', alias: 'zeus', responsibilities: cabe
    }).responsibilities).toHaveLength(justos);

    const nocabe = Array.from({ length: justos + 1 }, () => elemento);
    // En puntos de código esto está MUY por debajo del presupuesto: ahí está la trampa.
    expect(nocabe.reduce((suma, texto) => suma + countCodePoints(texto), 0))
      .toBeLessThan(AGENT_PROFILE_LIMITS.total);
    expect(() => normalizeAgentProfile({
      tenant_id: 'Steven', alias: 'zeus', responsibilities: nocabe
    })).toThrow(/total/);
  });
});
