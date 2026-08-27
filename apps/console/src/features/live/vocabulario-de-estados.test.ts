import { describe, expect, it } from 'vitest';
import type { FleetWorkState } from '../../api/types';
import { FLAG_LABEL, WORK_STATE_LABEL } from '../activity/activity';
import { resumenPortada } from '../landing/landing';
import { LIVE_STATES, LIVE_STATE_META } from './agent-state';

/**
 * **LA MISMA SITUACIÓN, LLAMADA DE TRES MANERAS EN LA MISMA PANTALLA.**
 *
 *  Convivían dos vocabularios de estado en
 * el mismo scroll, y el subtítulo de la tabla metía un tercero:
 *
 *   - Arriba: veredicto, chips, muñecos y la leyenda del pie → Caído · Bloqueado · Delegando ·
 *     Salió de vuelo · Recibiendo · Trabajando · Libre.
 *   - Abajo, la tabla «Agentes» → INACTIVO · EN COLA · TRABAJANDO · SATURADO · COLGADO.
 *   - Y el subtítulo de esa tabla → «colgado > saturado > trabajando > en cola > inactivo».
 *
 * El caso más caro: la leyenda dedica un párrafo entero a enseñar la palabra —«Libre no es caído
 * ni es sin reportar»— y la tabla, tres centímetros más abajo, no decía «Libre» ni una sola vez:
 * decía INACTIVO. Con 18 alias, la columna ESTADO sólo emitía dos valores (TRABAJANDO ×2,
 * INACTIVO ×16) e incluía en ese INACTIVO a los 5 que el veredicto llamaba «caídos» y a los 2 que
 * el chip llamaba «Delegando».
 *
 * Este fichero no comprueba estética: comprueba que **cada hecho tenga UN nombre en toda la
 * consola**, y que ese nombre sea el que la leyenda explica. Es barato y es lo que atrapa el
 * fallo, porque el fallo es literalmente una cadena distinta en dos ficheros.
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
    /*
     * `INACTIVO`, `EN COLA`, `COLGADO`: se escribían en mayúsculas sostenidas, como el `enum` del
     * que salen, y así ni siquiera se parecían a las palabras que la leyenda explicaba.
     *
     * ⚠️ Lo que esto NO acredita: que en pantalla no se lean en mayúsculas. `.badge` de
     * `styles.css` lleva `text-transform: uppercase` para TODAS las insignias de la consola, así
     * que «Trabado» se pinta «TRABADO» en la fila y «Trabado» en el chip de la cinta. Es la misma
     * palabra con otra caja, no otra palabra —el defecto medido eran palabras distintas— y
     * cambiar esa regla global excede a este arreglo. 
     */
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

  it('CONTROL NEGATIVO — el guardia marca la vuelta a los rótulos medidos el 23-08', () => {
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
