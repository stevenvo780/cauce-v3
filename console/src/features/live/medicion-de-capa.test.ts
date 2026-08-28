import { describe, expect, it } from 'vitest';
import { medicionDeCapa } from './directiva';

/*
 * The bug these tests fix.
 *
 * The gateway degrades honestly when it has no measured facts — it returns a payload with
 * `publicado: true`, a `motivo` explaining the unmeasured state, and `files` / `memory` set
 * to null.
 * But the console only showed the warning when `publicado` was FALSE, so that `motivo` was
 * never seen and the column asserted "looked at the container and there is no CLAUDE.md".
 *
 * That is false for 11 of the 12 aliases measured inside their containers. A 404 is seen; a
 * false assertion is not.
 *
 * The correct discriminator is not "does the endpoint publish?" but "did the read happen?":
 *   null  = not looked at   → PROHIBITED to assert the absence
 *   []    = looked and none → allowed to assert
 */

const NO_MEDIDO = {
  publicado: true,
  medido: false,
  motivo: 'contenedor no medido todavía (sin hechos de entorno)',
  files: null,
  memory: null,
} as const;

describe('medicionDeCapa — no se afirma una ausencia que nadie midió', () => {
  it('files:null es «no se miró», aunque el endpoint esté publicado', () => {
    expect(medicionDeCapa({ data: NO_MEDIDO, loading: false }, 'files')).toBe('no-se-miro');
  });

  it('memory:null es «no se miró», aunque el endpoint esté publicado', () => {
    expect(medicionDeCapa({ data: NO_MEDIDO, loading: false }, 'memory')).toBe('no-se-miro');
  });

  it('medido:false manda aunque el gateway rellene los campos', () => {
    // A gateway that degrades badly and returns empty lists cannot make us assert the absence.
    const enganoso = { publicado: true, medido: false, files: [], memory: { total: 0, entries: [] } };
    expect(medicionDeCapa({ data: enganoso, loading: false }, 'files')).toBe('no-se-miro');
    expect(medicionDeCapa({ data: enganoso, loading: false }, 'memory')).toBe('no-se-miro');
  });

  it('publicado:false sigue siendo «no se miró»', () => {
    expect(medicionDeCapa({ data: { publicado: false, motivo: 'ruta no publicada' }, loading: false }, 'files'))
      .toBe('no-se-miro');
  });

  it('un error de red sin datos es «no se miró»', () => {
    expect(medicionDeCapa({ error: new Error('boom'), loading: false }, 'files')).toBe('no-se-miro');
  });

  it('mientras carga y no hay datos, es «cargando»', () => {
    expect(medicionDeCapa({ loading: true }, 'files')).toBe('cargando');
  });

  // ---- NEGATIVE CONTROL: the absence assertion MUST keep appearing when it should ----

  it('files:[] con medición SÍ es «miró y no hay»', () => {
    const medido = { publicado: true, medido: true, files: [], memory: null };
    expect(medicionDeCapa({ data: medido, loading: false }, 'files')).toBe('miro-y-no-hay');
  });

  it('memory con total 0 y medición SÍ es «miró y no hay»', () => {
    const medido = { publicado: true, medido: true, files: [], memory: { total: 0, entries: [] } };
    expect(medicionDeCapa({ data: medido, loading: false }, 'memory')).toBe('miro-y-no-hay');
  });

  it('un fallo discriminado de memoria es «no se miró», nunca vacío', () => {
    const fallido = {
      publicado: true, medido: true, files: [],
      memory: { error: 'timeout' as const, reason: 'el agente no contestó' },
    };
    expect(medicionDeCapa({ data: fallido, loading: false }, 'memory')).toBe('no-se-miro');
  });

  it('un barrido cortado con total desconocido acredita datos como límite inferior', () => {
    const parcial = {
      publicado: true, medido: true, files: [],
      memory: { total: null, observed_at_least: 5_000, truncated: true, entries: [] },
    };
    expect(medicionDeCapa({ data: parcial, loading: false }, 'memory')).toBe('hay-datos');
  });

  it('con ficheros de verdad es «hay-datos»', () => {
    const medido = { publicado: true, medido: true, files: [{ path: '/home/dev/.claude/CLAUDE.md', bytes: 10_733 }] };
    expect(medicionDeCapa({ data: medido, loading: false }, 'files')).toBe('hay-datos');
  });

  it('un fallo de fichero discriminado es visible, nunca «miró y no hay»', () => {
    const medido = {
      publicado: true, medido: true,
      files: [{ path: '/workspace/CLAUDE.md', error: 'timeout', reason: 'sin respuesta' }],
    };
    expect(medicionDeCapa({ data: medido, loading: false }, 'files')).toBe('hay-datos');
  });

  it('con memoria de verdad es «hay-datos»', () => {
    const medido = { publicado: true, medido: true, memory: { total: 18_212, entries: [{ path: 'a' }] } };
    expect(medicionDeCapa({ data: medido, loading: false }, 'memory')).toBe('hay-datos');
  });

  // ---- Compatibility with the OLD gateway, which does not send `medido` ----

  it('sin campo `medido`, files:null sigue siendo «no se miró»', () => {
    const viejo = { publicado: true, files: null, memory: null };
    expect(medicionDeCapa({ data: viejo, loading: false }, 'files')).toBe('no-se-miro');
  });

  it('sin campo `medido`, files:[] se toma como medición hecha', () => {
    const viejo = { publicado: true, files: [], memory: null };
    expect(medicionDeCapa({ data: viejo, loading: false }, 'files')).toBe('miro-y-no-hay');
  });
});
