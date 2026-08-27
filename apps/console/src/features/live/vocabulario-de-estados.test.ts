import { describe, expect, it } from 'vitest';
import type { FleetWorkState } from '../../api/types';
import { FLAG_LABEL, WORK_STATE_LABEL } from './activity';
import { resumenPortada } from '../landing/landing';
import { LIVE_STATES, LIVE_STATE_META } from './agent-state';

/**
 * Coherencia del vocabulario de estados de la flota:
 * asegura que las etiquetas y estados mostrados en veredicto, tarjetas y tablas coincidan.
 */

/** El estado del servidor y el estado derivado que nombran EL MISMO hecho. */
const MISMO_HECHO: Array<{ work: FleetWorkState; live: (typeof LIVE_STATES)[number]; porque: string }> = [
  { work: 'idle', live: 'idle', porque: 'sin nada en vuelo' },
  { work: 'queued', live: 'receiving', porque: 'le entró trabajo y todavía no lo empezó' },
  { work: 'working', live: 'thinking', porque: 'turno en curso' },
  { work: 'stalled', live: 'blocked', porque: 'tomó trabajo y no avanza' },
];

describe('el vocabulario de estados de la consola', () => {
  it.each(MISMO_HECHO)(
    'la tabla y la leyenda llaman IGUAL a «$porque» ($work / $live)',
    ({ work, live }) => {
      expect(WORK_STATE_LABEL[work]).toBe(LIVE_STATE_META[live].label);
    },
  );

  it('«Libre» aparece en la tabla, que era justo lo que la leyenda enseñaba y la tabla no decía', () => {
    expect(Object.values(WORK_STATE_LABEL)).toContain('Libre');
    expect(Object.values(WORK_STATE_LABEL)).not.toContain('INACTIVO');
  });

  it('ninguna etiqueta se escribe como una constante de base de datos', () => {
    // Las etiquetas no deben escribirse como constantes en mayúsculas sostenidas.
    const constantes = [...Object.values(WORK_STATE_LABEL), ...Object.values(FLAG_LABEL)]
      .filter((etiqueta) => etiqueta === etiqueta.toUpperCase() && /[A-ZÁÉÍÓÚÑ]{2,}/.test(etiqueta));
    expect(constantes).toEqual([]);
  });

  it('«detenido» dejó de ser un homónimo entre la portada y las señales de la tabla', () => {
    /*
     * `ack_stalled` se llamaba «ACK detenido» y el aviso de la portada «N agentes detenidos». Dos
     * hechos distintos —una entrega sin acuse y un agente trabado— con la misma palabra, en dos
     * pantallas que el operador recorre seguidas.
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
     * Se le da de comer el mapa EXACTO que producía el defecto. Un comprobador que lo apruebe es
     * peor que no tenerlo: haría creer que el vocabulario está unificado cuando no lo está.
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
});
