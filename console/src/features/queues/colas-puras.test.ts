import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../../api/types';
import { contarPorGrupo, ESTADOS_DEL_GRUPO, filtrarEntregas } from './filtro-de-colas';
import { leerUltimoError } from './ultimo-error';

function entrega(parcial: Partial<QueueItem>): QueueItem {
  return { delivery_id: 'd-1', message_id: 'm-1', tenant_id: 'Steven', recipient_alias: 'zeus', lane: 'interactive', state: 'done', attempts: 1, max_attempts: 5, ...parcial };
}

describe('qué se lee en «Último error»', () => {
  it('el motivo, cuando el servidor lo dice', () => {
    expect(leerUltimoError('dead', 'max attempts exhausted')).toEqual({ clase: 'texto', texto: 'max attempts exhausted' });
  });

  it('«sin error» en los estados donde no haberlo es la respuesta', () => {
    for (const estado of ['done', 'pending', 'leased', 'accepted', 'started'] as const) {
      expect(leerUltimoError(estado, null)).toEqual({ clase: 'sin-error' });
    }
  });

  /**
   * What MUST NOT happen: turning the amber off for a dead delivery without a reason. There
   * the gap matters — a dead delivery nobody can diagnose — and it remains UNKNOWN.
   */
  it('UNKNOWN en los estados de error, que es donde el hueco duele', () => {
    for (const estado of ['dead', 'failed', 'retry'] as const) {
      expect(leerUltimoError(estado, null)).toEqual({ clase: 'desconocido' });
    }
  });

  it('sin estado NO se afirma «sin error»: sería inventar la mitad tranquilizadora', () => {
    expect(leerUltimoError(undefined, null)).toEqual({ clase: 'desconocido' });
  });

  it('una cadena vacía o de espacios no es un motivo', () => {
    expect(leerUltimoError('dead', '   ')).toEqual({ clase: 'desconocido' });
    expect(leerUltimoError('done', '')).toEqual({ clase: 'sin-error' });
  });
});

describe('el filtro de la tabla', () => {
  const filas = [
    entrega({ delivery_id: 'a', state: 'done' }),
    entrega({ delivery_id: 'b', state: 'dead', recipient_alias: 'kant', last_error: 'adapter timeout' }),
    entrega({ delivery_id: 'c', state: 'failed' }),
    entrega({ delivery_id: 'd', state: 'retry' }),
    entrega({ delivery_id: 'e', state: 'pending' }),
    entrega({ delivery_id: 'f', state: 'leased' }),
  ];

  /**
   * The case that has to be guarded: `failed` counts as "needs review". It also leaves a row
   * in `dead_letters` and `replayDelivery` accepts it. A group that only looked at `dead` would
   * again hide the same deliveries the `replayableStates` fix brought to light.
   */
  it('«revisión» incluye dead Y failed', () => {
    expect(ESTADOS_DEL_GRUPO.revision.has('failed')).toBe(true);
    expect(filtrarEntregas(filas, { grupo: 'revision', texto: '' }).map((fila) => fila.delivery_id)).toEqual(['b', 'c']);
  });

  it('«pendientes» son las que siguen vivas, incluida la que ya tomó un adaptador', () => {
    expect(filtrarEntregas(filas, { grupo: 'pendientes', texto: '' }).map((fila) => fila.delivery_id)).toEqual(['e', 'f']);
  });

  it('busca por alias, por id y por el texto del error', () => {
    expect(filtrarEntregas(filas, { grupo: 'todas', texto: 'kant' })).toHaveLength(1);
    expect(filtrarEntregas(filas, { grupo: 'todas', texto: 'TIMEOUT' })).toHaveLength(1);
    expect(filtrarEntregas(filas, { grupo: 'todas', texto: '  ' })).toHaveLength(filas.length);
  });

  /**
   * A state the console does not recognize does NOT enter any group. Guessing here would send
   * an operator to replay something whose state nobody can read.
   */
  it('un estado desconocido no entra en ningún grupo, pero sigue estando en «todas»', () => {
    const raras = [...filas, entrega({ delivery_id: 'z', state: 'inventado' as never })];
    expect(filtrarEntregas(raras, { grupo: 'todas', texto: '' })).toHaveLength(7);
    for (const grupo of ['revision', 'retry', 'pendientes'] as const) {
      expect(filtrarEntregas(raras, { grupo, texto: '' }).some((fila) => fila.delivery_id === 'z')).toBe(false);
    }
  });

  it('cuenta cada grupo sobre las filas que la tabla puede mostrar', () => {
    expect(contarPorGrupo(filas)).toEqual({ todas: 6, revision: 2, retry: 1, pendientes: 2 });
  });
});
