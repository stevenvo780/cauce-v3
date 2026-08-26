import { describe, expect, it } from 'vitest';
import { medicionDeCapa } from './directiva';

/*
 * El defecto que estas pruebas fijan, medido el 2026-08-24 contra producción:
 *
 * El gateway degrada honestamente cuando no tiene hechos medidos — devuelve
 * `{publicado: true, motivo: 'contenedor no medido todavía', files: null, memory: null}`.
 * Pero la consola sólo enseñaba el aviso cuando `publicado` era FALSO, así que ese `motivo`
 * no se veía nunca y la columna afirmaba «miró el contenedor y no hay ningún CLAUDE.md».
 *
 * Eso es falso en 11 de los 12 alias que medí dentro de sus contenedores (zeus 10.733 B,
 * jarvis 23.762, janus 19.463, iza 18.775…). Un 404 se ve; una afirmación falsa no.
 *
 * El discriminante correcto no es «¿publica el endpoint?» sino «¿ocurrió la lectura?»:
 *   null  = no se miró   → PROHIBIDO afirmar la ausencia
 *   []    = se miró y no hay → se puede afirmar
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
    // Un gateway que degrade mal y devuelva listas vacías no puede hacernos afirmar la ausencia.
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

  // ---- CONTROL NEGATIVO: la afirmación de ausencia TIENE que seguir apareciendo cuando toca ----

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

  // ---- Compatibilidad con el gateway VIEJO, que no manda `medido` ----

  it('sin campo `medido`, files:null sigue siendo «no se miró»', () => {
    const viejo = { publicado: true, files: null, memory: null };
    expect(medicionDeCapa({ data: viejo, loading: false }, 'files')).toBe('no-se-miro');
  });

  it('sin campo `medido`, files:[] se toma como medición hecha', () => {
    const viejo = { publicado: true, files: [], memory: null };
    expect(medicionDeCapa({ data: viejo, loading: false }, 'files')).toBe('miro-y-no-hay');
  });
});
