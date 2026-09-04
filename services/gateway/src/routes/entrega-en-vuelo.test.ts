import { describe, expect, it, vi } from 'vitest';
import type { DatabasePool } from '@cauce/store';
import { DELIVERY_IN_FLIGHT_LISTED } from '../console/agent-context-reload.routes.js';
import { entregaEnVuelo } from './console.js';

/**
 * The read behind the refusal of a context reload. It is the ONE place that decides both the
 * number the audit row keeps and the bounded list the operator reads, so it is measured on its
 * own: a fake pool answers the query and the assertions are on the SQL it issued and on the shape
 * it returned. Nothing here needs PostgreSQL.
 */

interface FilaEnVuelo {
  delivery_id: string;
  status: string;
  claimed_at: Date | null;
  deadline_at: Date | null;
  total: string;
}

function fila(indice: number, total: string, overrides: Partial<FilaEnVuelo> = {}): FilaEnVuelo {
  return {
    delivery_id: `d-${String(indice)}`,
    status: 'leased',
    claimed_at: new Date('2026-01-01T00:00:00.000Z'),
    deadline_at: new Date('2026-01-01T00:30:00.000Z'),
    total,
    ...overrides,
  };
}

function poolCon(filas: readonly FilaEnVuelo[]) {
  const queries: { text: string; values: unknown[] }[] = [];
  const pool = {
    query: vi.fn(async (text: string, values: unknown[] = []) => {
      queries.push({ text, values });
      return { rows: filas, rowCount: filas.length };
    }),
  };
  return { pool: pool as unknown as DatabasePool, queries };
}

describe('entregaEnVuelo', () => {
  it('cuenta sobre la ventana ENTERA y pide como mucho el tope de la lista', async () => {
    const { pool, queries } = poolCon([fila(1, '97')]);

    const enVuelo = await entregaEnVuelo(pool, 'Steven', 'jarvis');

    expect(enVuelo.count).toBe(97);
    expect(enVuelo.deliveries).toHaveLength(1);
    const consulta = queries[0];
    expect(consulta?.text).toContain('count(*) OVER ()');
    // The window count is computed before the LIMIT: the refusal states the real number.
    expect(consulta?.text.indexOf('count(*) OVER ()'))
      .toBeLessThan(consulta?.text.indexOf('LIMIT') ?? -1);
    expect(consulta?.values).toEqual(['Steven', 'jarvis', DELIVERY_IN_FLIGHT_LISTED]);
    expect(DELIVERY_IN_FLIGHT_LISTED).toBe(20);
  });

  it('lee sólo las entregas en vuelo del alias y las ordena por antigüedad del reclamo', async () => {
    const { pool, queries } = poolCon([]);

    const enVuelo = await entregaEnVuelo(pool, 'Steven', 'jarvis');

    expect(enVuelo).toEqual({ count: 0, deliveries: [] });
    const texto = queries[0]?.text ?? '';
    expect(texto).toContain('recipient_tenant=$1');
    expect(texto).toContain('recipient_alias=$2');
    expect(texto).toContain("status IN ('leased','accepted','started')");
    expect(texto).toContain('ORDER BY claimed_at ASC NULLS LAST, id ASC');
  });

  it('publica CUATRO campos por entrega y ningún cuerpo, asunto ni adjunto', async () => {
    const { pool } = poolCon([fila(1, '1', { status: 'started', deadline_at: null })]);

    const enVuelo = await entregaEnVuelo(pool, 'Steven', 'jarvis');

    expect(enVuelo.deliveries).toEqual([{
      delivery_id: 'd-1',
      status: 'started',
      claimed_at: '2026-01-01T00:00:00.000Z',
      deadline_at: null,
    }]);
    expect(Object.keys(enVuelo.deliveries[0] ?? {})).toEqual(
      ['delivery_id', 'status', 'claimed_at', 'deadline_at'],
    );
  });

  it('un lote de 20 filas con un total mayor deja el cuerpo topado y el número real', async () => {
    const filas = Array.from(
      { length: DELIVERY_IN_FLIGHT_LISTED },
      (_, indice) => fila(indice, '134'),
    );
    const { pool } = poolCon(filas);

    const enVuelo = await entregaEnVuelo(pool, 'Steven', 'jarvis');

    expect(enVuelo.count).toBe(134);
    expect(enVuelo.deliveries).toHaveLength(DELIVERY_IN_FLIGHT_LISTED);
  });

  it('un total ilegible deja el recuento en NaN: por eso el guardia mira también la lista', async () => {
    const { pool } = poolCon([fila(1, 'no-es-un-numero')]);

    const enVuelo = await entregaEnVuelo(pool, 'Steven', 'jarvis');

    expect(Number.isNaN(enVuelo.count)).toBe(true);
    expect(enVuelo.deliveries).toHaveLength(1);
  });
});
