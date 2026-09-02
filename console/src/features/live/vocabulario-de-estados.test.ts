import { describe, expect, it } from 'vitest';
import type { FleetWorkState } from '../../api/types';
import { FLAG_LABEL, WORK_STATE_LABEL } from './activity';
import { resumenPortada } from '../landing/landing';
import { LIVE_STATES, LIVE_STATE_META } from './agent-state';
import { CAPABILITY_LABEL, DLQ_DISPOSITION_LABEL, LEASE_LABEL } from '../../vocabulario';

/**
 * Consistency of the fleet state vocabulary:
 * ensures that the labels and states shown in verdict, cards and tables match.
 */

/** The server state and the derived state that name THE SAME fact. */
const MISMO_HECHO: { work: FleetWorkState; live: (typeof LIVE_STATES)[number]; porque: string }[] = [
  { work: 'idle', live: 'idle', porque: 'sin nada en vuelo' },
  { work: 'queued', live: 'receiving', porque: 'le entró trabajo y todavía no lo empezó' },
  { work: 'working', live: 'thinking', porque: 'turno en curso' },
  { work: 'stalled', live: 'blocked', porque: 'tomó trabajo y no avanza' },
];

const MISMA_PALABRA: { palabra: string; uniones: string[]; hecho: string }[] = [
  { palabra: 'Caído', uniones: ['FleetActivityFlag', 'LeaseState', 'LiveState'], hecho: 'el lease no está vigente' },
  { palabra: 'Libre', uniones: ['FleetWorkState', 'LiveState'], hecho: 'sin nada en vuelo' },
  { palabra: 'Recibiendo', uniones: ['FleetWorkState', 'LiveState'], hecho: 'le entró trabajo y todavía no lo empezó' },
  { palabra: 'Trabajando', uniones: ['FleetWorkState', 'LiveState'], hecho: 'turno en curso' },
  { palabra: 'Trabado', uniones: ['FleetWorkState', 'LiveState'], hecho: 'tomó trabajo y no avanza' },
];

interface Rotulo {
  union: string;
  clave: string;
  palabra: string;
}

function rotulosDe(union: string, mapa: Readonly<Record<string, string>>): Rotulo[] {
  return Object.entries(mapa).map(([clave, palabra]) => ({ union, clave, palabra }));
}

const VOCABULARIO_VIVO: Rotulo[] = [
  ...rotulosDe('LeaseState', LEASE_LABEL),
  ...rotulosDe('CapabilityState', CAPABILITY_LABEL),
  ...rotulosDe('DlqDisposition', DLQ_DISPOSITION_LABEL),
  ...rotulosDe('LiveState', Object.fromEntries(LIVE_STATES.map((estado) => [estado, LIVE_STATE_META[estado].label]))),
  ...rotulosDe('FleetWorkState', WORK_STATE_LABEL),
  ...rotulosDe('FleetActivityFlag', FLAG_LABEL),
];

function agrupar(
  rotulos: Rotulo[],
  porClave: (rotulo: Rotulo) => string,
  aValor: (rotulo: Rotulo) => string,
): { clave: string; valores: string[] }[] {
  const grupos = new Map<string, Set<string>>();
  for (const rotulo of rotulos) {
    const clave = porClave(rotulo);
    grupos.set(clave, (grupos.get(clave) ?? new Set<string>()).add(aValor(rotulo)));
  }
  return [...grupos]
    .filter(([, valores]) => valores.size > 1)
    .map(([clave, valores]) => ({ clave, valores: [...valores].sort() }))
    .sort((izquierda, derecha) => izquierda.clave.localeCompare(derecha.clave));
}

function homonimos(rotulos: Rotulo[]) {
  return agrupar(rotulos, (rotulo) => rotulo.palabra, (rotulo) => rotulo.union);
}

function sinonimos(rotulos: Rotulo[]) {
  return agrupar(rotulos, (rotulo) => `${rotulo.union}.${rotulo.clave}`, (rotulo) => rotulo.palabra);
}

describe('el vocabulario de estados de la consola', () => {
  it.each(MISMO_HECHO)(
    'la tabla y la leyenda llaman IGUAL a «$porque» ($work / $live)',
    ({ work, live }) => {
      expect(WORK_STATE_LABEL[work]).toBe(LIVE_STATE_META[live].label);
    },
  );

  it('"Libre" appears in the table, which was exactly what the legend showed and the table did not say', () => {
    expect(Object.values(WORK_STATE_LABEL)).toContain('Libre');
    expect(Object.values(WORK_STATE_LABEL)).not.toContain('INACTIVO');
  });

  it('ninguna etiqueta se escribe como una constante de base de datos', () => {
    // Labels must not be written as uppercase database constants.
    const constantes = [...Object.values(WORK_STATE_LABEL), ...Object.values(FLAG_LABEL)]
      .filter((etiqueta) => etiqueta === etiqueta.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{2,}/.test(etiqueta));
    expect(constantes).toEqual([]);
  });

  it('"detenido" stopped being a homonym between the landing and the table signals', () => {
    /*
     * `ack_stalled` was called "ACK detenido" and the landing alert "N agentes detenidos". Two
     * different facts — a delivery without ACK and a stalled agent — with the same word, on two
     * screens the operator goes through in a row.
     */
    const resumen = resumenPortada({
      activity: {
        observed_at: '2026-08-23T10:00:00.000Z',
        totals: { by_state: { idle: 0, queued: 0, working: 0, saturated: 0, stalled: 1 } },
        agents: [],
      },
    });
    const aviso = resumen.alertas.find((alerta) => alerta.id === 'agentes-detenidos');
    expect(aviso?.titulo).toBe('1 agente trabado');
    expect(aviso?.titulo).toContain(LIVE_STATE_META.blocked.label.toLowerCase());
    expect(Object.values(FLAG_LABEL).join(' ')).not.toMatch(/detenid/i);
  });

  it('CONTROL NEGATIVO — el guardia marca la divergencia de rótulos', () => {
    /*
     * The checker is fed the EXACT map that produced the bug. A checker that approves it is
     * worse than not having one: it would make the vocabulary look unified when it is not.
     */
    const viejo: Record<FleetWorkState, string> = {
      idle: 'INACTIVO', queued: 'EN COLA', working: 'TRABAJANDO', saturated: 'SATURADO', stalled: 'COLGADO',
    };
    const choques = MISMO_HECHO.filter(({ work, live }) => viejo[work] !== LIVE_STATE_META[live].label);
    expect(choques.map(({ work }) => work)).toEqual(['idle', 'queued', 'working', 'stalled']);
  });

  it('CONTROL NEGATIVO — y marcaría también un rótulo nuevo que se desviara de la leyenda', () => {
    const desviado = { ...WORK_STATE_LABEL, stalled: 'Colgado' };
    expect(desviado.stalled).not.toBe(LIVE_STATE_META.blocked.label);
  });

  it('ninguna palabra nombra dos uniones distintas sin estar declarada en MISMA_PALABRA', () => {
    const declarado = new Map(MISMA_PALABRA.map(({ palabra, uniones }) => [palabra, [...uniones].sort().join(', ')]));
    const sinDeclarar = homonimos(VOCABULARIO_VIVO)
      .filter(({ clave, valores }) => declarado.get(clave) !== valores.join(', '));
    expect(sinDeclarar).toEqual([]);
    expect(sinonimos(VOCABULARIO_VIVO)).toEqual([]);
    expect(MISMA_PALABRA.filter(({ palabra }) => !VOCABULARIO_VIVO.some((rotulo) => rotulo.palabra === palabra))).toEqual([]);
  });

  it('CONTROL NEGATIVO — marca «en línea»/«vencido» como un segundo nombre del mismo lease', () => {
    const viejo = { online: 'en línea', expired: 'vencido', unknown: 'sin dato' };
    const marcados = sinonimos([...VOCABULARIO_VIVO, ...rotulosDe('LeaseState', viejo)]);
    expect(marcados.map(({ clave }) => clave)).toEqual(['LeaseState.expired', 'LeaseState.online', 'LeaseState.unknown']);
    expect(marcados.flatMap(({ valores }) => valores)).toEqual(expect.arrayContaining(['en línea', 'vencido']));
  });
});
