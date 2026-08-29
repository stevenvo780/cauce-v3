import { describe, expect, it } from 'vitest';
import type { FleetActivityAgent, FleetActivitySnapshot, QueueItem, QueueSnapshot } from '../../api/types';
import type { FleetAgent } from '../terminal/fleet';
import { cifrasVivas, formaDeLaCola } from './fila-de-agente';
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
    id: `${tenantId}:${alias}`,
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

    expect(salud['Miguel:kratos']).toEqual({
      pendientes: 3, enCurso: 2, reintentos: 1, muertas: 2, muertasTruncadas: false,
    });
  });

  /**
   * NEGATIVE CONTROL of the invented zero. An implementation with `?? 0` — which is the natural
   * thing to write — would return here 0 pending and 0 in flight, and the view would paint a
   * healthy-looking agent whose queue could NOT be read. The case is checked from both sides:
   * the field must be `undefined` AND explicitly cannot be 0.
   */
  it('un alias que /activity NO informa queda UNKNOWN, jamás en cero', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Steven', alias: 'zeus' })]),
      cola([filaDeCola({ tenant_id: 'Steven', recipient_alias: 'argos', state: 'dead' })]),
    );

    expect(salud['Steven:argos'].pendientes).toBeUndefined();
    expect(salud['Steven:argos'].pendientes).not.toBe(0);
    expect(salud['Steven:argos'].enCurso).toBeUndefined();
    expect(salud['Steven:argos'].reintentos).toBeUndefined();
    // What IS known about it is still there: it appeared in the queue with a dead delivery.
    expect(salud['Steven:argos'].muertas).toBe(1);
    // And the other-side control: zeus DID come in activity, so its zeros are real.
    expect(salud['Steven:zeus'].pendientes).toBe(0);
  });

  it('sin snapshot de /queues las muertas quedan UNKNOWN en vez de cero', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Steven', alias: 'argos', queued: 4 })]),
      undefined,
    );

    expect(salud['Steven:argos'].muertas).toBeUndefined();
    expect(salud['Steven:argos'].muertas).not.toBe(0);
    expect(salud['Steven:argos'].pendientes).toBe(4);
  });

  it('un /queues publicado pero sin filas del alias es un cero CONOCIDO, no UNKNOWN', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Steven', alias: 'argos' })]),
      cola([filaDeCola({ tenant_id: 'Miguel', recipient_alias: 'kratos', state: 'dead' })]),
    );

    expect(salud['Steven:argos'].muertas).toBe(0);
    expect(salud['Steven:argos'].muertasTruncadas).toBe(false);
  });

  it('un `items` ausente NO es una lista vacía: no fabrica ceros', () => {
    const salud = saludDeColaPorAgente(
      actividad([agenteDeActividad({ tenant_id: 'Steven', alias: 'argos' })]),
      cola(null),
    );

    expect(salud['Steven:argos'].muertas).toBeUndefined();
  });

  /**
   * NEGATIVE CONTROL of the truncation. `queueSnapshot()` truncates at 200 rows and counts ON
   * them, so above the ceiling any count is a floor. With 199 rows the flag must be off: if it
   * were always on, the warning would distinguish nothing and be noise.
   */
  it(`marca truncado exactamente al llegar al techo de ${String(LIMITE_COLA)} filas`, () => {
    const fila = (indice: number, state: QueueItem['state']) => filaDeCola({
      delivery_id: `d-${String(indice)}`, tenant_id: 'Steven', recipient_alias: 'argos', state,
    });
    const alTecho = Array.from({ length: LIMITE_COLA }, (_, indice) => fila(indice, indice === 0 ? 'dead' : 'pending'));
    const debajo = alTecho.slice(0, LIMITE_COLA - 1);

    expect(saludDeColaPorAgente(undefined, cola(alTecho))['Steven:argos'].muertasTruncadas).toBe(true);
    expect(saludDeColaPorAgente(undefined, cola(debajo))['Steven:argos'].muertasTruncadas).toBe(false);
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

    expect(salud['Steven:argos']).toEqual({ muertasTruncadas: false });
  });
});

describe('colaNecesitaAtencion', () => {
  it('sangra por muertas y por reintentos, no por trabajo en curso', () => {
    expect(colaNecesitaAtencion({ muertas: 1, muertasTruncadas: false })).toBe(true);
    expect(colaNecesitaAtencion({ reintentos: 2, muertasTruncadas: false })).toBe(true);
    // An agent working is NOT an alarm: if it were, the header would always be red.
    expect(colaNecesitaAtencion({ enCurso: 9, pendientes: 20, muertas: 0, muertasTruncadas: false })).toBe(false);
    expect(colaNecesitaAtencion(undefined)).toBe(false);
  });
});

describe('ordenarPorSaludDeCola', () => {
  it('sube lo que sangra y conserva el orden original en el resto', () => {
    const agentes = [agenteDeFlota('Steven', 'zeus'), agenteDeFlota('Steven', 'argos'), agenteDeFlota('Miguel', 'kratos')];
    const ordenados = ordenarPorSaludDeCola(agentes, {
      'Miguel:kratos': { muertas: 3, muertasTruncadas: false },
      'Steven:argos': { reintentos: 1, muertasTruncadas: false },
      'Steven:zeus': { muertas: 0, reintentos: 0, muertasTruncadas: false },
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

describe('formaDeLaCola', () => {
  const leida = { pendientes: 0, enCurso: 0, reintentos: 0, muertas: 0, muertasTruncadas: false };

  it('abrevia la fila leída entera y sin sangre', () => {
    expect(formaDeLaCola(leida)).toBe('breve');
    expect(formaDeLaCola({ ...leida, pendientes: 8, enCurso: 2 })).toBe('breve');
  });

  it('NO abrevia lo que sangra: muertas o reintentos mandan la fila entera', () => {
    expect(formaDeLaCola({ ...leida, muertas: 1 })).toBe('detallada');
    expect(formaDeLaCola({ ...leida, reintentos: 3 })).toBe('detallada');
  });

  it('NO abrevia un UNKNOWN: una cifra que el servidor no informó no se esconde', () => {
    expect(formaDeLaCola(undefined)).toBe('detallada');
    expect(formaDeLaCola({ ...leida, pendientes: undefined })).toBe('detallada');
    expect(formaDeLaCola({ ...leida, enCurso: undefined })).toBe('detallada');
    expect(formaDeLaCola({ ...leida, reintentos: undefined })).toBe('detallada');
    expect(formaDeLaCola({ ...leida, muertas: undefined })).toBe('detallada');
  });

  it('la línea breve sólo escribe lo que no es cero', () => {
    expect(cifrasVivas(leida)).toEqual([]);
    expect(cifrasVivas({ ...leida, pendientes: 3, enCurso: 0 }))
      .toEqual([{ kind: 'pending', texto: '3 en cola' }]);
    expect(cifrasVivas({ ...leida, pendientes: 1, enCurso: 2 }).map((cifra) => cifra.texto))
      .toEqual(['1 en cola', '2 en curso']);
  });
});
