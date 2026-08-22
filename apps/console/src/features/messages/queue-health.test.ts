import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, FleetActivitySnapshot, QueueItem, QueueSnapshot } from '../../api/types';
import type { FleetAgent } from '../terminal/fleet';
import {
  colaNecesitaAtencion,
  LIMITE_COLA,
  ordenarPorSaludDeCola,
  saludDeColaPorAgente,
  textoDeCifra,
} from './queue-health';

function agenteDeActividad(overrides: Partial<FleetActivityAgent> & Pick<FleetActivityAgent, 'tenant_id' | 'alias'>): FleetActivityAgent {
  return { in_flight: 0, queued: 0, retrying: 0, ...overrides };
}

function filaDeCola(overrides: Partial<QueueItem>): QueueItem {
  return { delivery_id: 'd-1', tenant_id: 'Steven', recipient_alias: 'argos', state: 'pending', ...overrides };
}

function actividad(agents: FleetActivityAgent[]): FleetActivitySnapshot {
  return { observed_at: '2026-08-22T10:00:00.000Z', agents };
}

function cola(items: QueueItem[] | null): QueueSnapshot {
  return { observed_at: '2026-08-22T10:00:00.000Z', ...(items === null ? {} : { items }) };
}

function agenteDeFlota(tenantId: string, alias: string): FleetAgent {
  return {
    id: `${tenantId.toLocaleLowerCase()}:${alias.toLocaleLowerCase()}`,
    tenantId, alias, roomIds: [], roomMembership: {}, leaseState: 'online',
  };
}

describe('saludDeColaPorAgente', () => {
  it('funde el trabajo en vuelo de /activity con las entregas muertas de /queues', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Miguel', alias: 'kratos', in_flight: 2, queued: 3, retrying: 1 })]),
      cola([
        filaDeCola({ delivery_id: 'd-1', tenant_id: 'Miguel', recipient_alias: 'kratos', state: 'dead' }),
        filaDeCola({ delivery_id: 'd-2', tenant_id: 'Miguel', recipient_alias: 'kratos', state: 'failed' }),
        filaDeCola({ delivery_id: 'd-3', tenant_id: 'Miguel', recipient_alias: 'kratos', state: 'pending' }),
      ]),
    );

    expect(salud['miguel:kratos']).toEqual({
      pendientes: 3, enCurso: 2, reintentos: 1, muertas: 2, muertasTruncadas: false,
    });
  });

  /**
   * CONTROL NEGATIVO del cero inventado. Una implementación con `?? 0` —que es lo natural de
   * escribir— devolvería aquí 0 pendientes y 0 en curso, y la vista pintaría de sano a un agente
   * cuya cola NO se pudo leer. El caso se comprueba por los dos lados: el campo tiene que ser
   * `undefined` Y explícitamente no puede ser 0.
   */
  it('un alias que /activity NO informa queda UNKNOWN, jamás en cero', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Steven', alias: 'zeus' })]),
      cola([filaDeCola({ tenant_id: 'Steven', recipient_alias: 'argos', state: 'dead' })]),
    );

    expect(salud['steven:argos'].pendientes).toBeUndefined();
    expect(salud['steven:argos'].pendientes).not.toBe(0);
    expect(salud['steven:argos'].enCurso).toBeUndefined();
    expect(salud['steven:argos'].reintentos).toBeUndefined();
    // Lo que SÍ se sabe de él sigue estando: apareció en la cola con una entrega muerta.
    expect(salud['steven:argos'].muertas).toBe(1);
    // Y el control por el otro lado: zeus sí venía en actividad, así que sus ceros son reales.
    expect(salud['steven:zeus'].pendientes).toBe(0);
  });

  it('sin snapshot de /queues las muertas quedan UNKNOWN en vez de cero', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Steven', alias: 'argos', queued: 4 })]),
      undefined,
    );

    expect(salud['steven:argos'].muertas).toBeUndefined();
    expect(salud['steven:argos'].muertas).not.toBe(0);
    expect(salud['steven:argos'].pendientes).toBe(4);
  });

  it('un /queues publicado pero sin filas del alias es un cero CONOCIDO, no UNKNOWN', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Steven', alias: 'argos' })]),
      cola([filaDeCola({ tenant_id: 'Miguel', recipient_alias: 'kratos', state: 'dead' })]),
    );

    expect(salud['steven:argos'].muertas).toBe(0);
    expect(salud['steven:argos'].muertasTruncadas).toBe(false);
  });

  it('un `items` ausente NO es una lista vacía: no fabrica ceros', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Steven', alias: 'argos' })]),
      cola(null),
    );

    expect(salud['steven:argos'].muertas).toBeUndefined();
  });

  /**
   * CONTROL NEGATIVO del truncado. `queueSnapshot()` corta en 200 filas y cuenta SOBRE ellas, así
   * que a partir del techo cualquier recuento es un piso. Con 199 filas la marca tiene que estar
   * apagada: si estuviera siempre encendida, el aviso no distinguiría nada y sería ruido.
   */
  it(`marca truncado exactamente al llegar al techo de ${LIMITE_COLA} filas`, () => {
    const fila = (indice: number, state: QueueItem['state']) => filaDeCola({
      delivery_id: `d-${indice}`, tenant_id: 'Steven', recipient_alias: 'argos', state,
    });
    const alTecho = Array.from({ length: LIMITE_COLA }, (_, indice) => fila(indice, indice === 0 ? 'dead' : 'pending'));
    const debajo = alTecho.slice(0, LIMITE_COLA - 1);

    expect(saludDeColaPorAgente(undefined, cola(alTecho))['steven:argos'].muertasTruncadas).toBe(true);
    expect(saludDeColaPorAgente(undefined, cola(debajo))['steven:argos'].muertasTruncadas).toBe(false);
  });

  it('ignora filas y agentes sin identidad utilizable en vez de crear claves basura', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: '', alias: 'fantasma' })]),
      cola([filaDeCola({ tenant_id: 'Steven', recipient_alias: null, state: 'dead' })]),
    );

    expect(Object.keys(salud)).toEqual([]);
  });

  it('no lee un null del servidor como si fuera un número', () => {
    const salud = saludDeColaPorAgente(
      actividad([{ tenant_id: 'Steven', alias: 'argos', in_flight: null, queued: null, retrying: null }]),
      undefined,
    );

    expect(salud['steven:argos']).toEqual({ muertasTruncadas: false });
  });
});

describe('colaNecesitaAtencion', () => {
  it('sangra por muertas y por reintentos, no por trabajo en curso', () => {
    expect(colaNecesitaAtencion({ muertas: 1, muertasTruncadas: false })).toBe(true);
    expect(colaNecesitaAtencion({ reintentos: 2, muertasTruncadas: false })).toBe(true);
    // Un agente trabajando NO es una alarma: si lo fuera, la cabecera estaría siempre roja.
    expect(colaNecesitaAtencion({ enCurso: 9, pendientes: 20, muertas: 0, muertasTruncadas: false })).toBe(false);
    expect(colaNecesitaAtencion(undefined)).toBe(false);
  });
});

describe('ordenarPorSaludDeCola', () => {
  it('sube lo que sangra y conserva el orden original en el resto', () => {
    const agentes = [agenteDeFlota('Steven', 'zeus'), agenteDeFlota('Steven', 'argos'), agenteDeFlota('Miguel', 'kratos')];
    const ordenados = ordenarPorSaludDeCola(agentes, {
      'miguel:kratos': { muertas: 3, muertasTruncadas: false },
      'steven:argos': { reintentos: 1, muertasTruncadas: false },
      'steven:zeus': { muertas: 0, reintentos: 0, muertasTruncadas: false },
    });

    expect(ordenados.map((agente) => agente.alias)).toEqual(['kratos', 'argos', 'zeus']);
  });

  it('sin datos de cola no reordena nada', () => {
    const agentes = [agenteDeFlota('Steven', 'zeus'), agenteDeFlota('Steven', 'argos')];
    expect(ordenarPorSaludDeCola(agentes, {}).map((agente) => agente.alias)).toEqual(['zeus', 'argos']);
  });
});

describe('textoDeCifra', () => {
  it('dice UNKNOWN con la palabra y no con un cero ni un guión', () => {
    expect(textoDeCifra(undefined)).toBe('UNKNOWN');
    expect(textoDeCifra(0)).toBe('0');
    expect(textoDeCifra(41)).toBe('41');
  });
});
