import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueItem, QueueSnapshot } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { muestraRecortada, totalDelGrupo } from './filtro-de-colas';
import { QueuesPage } from './QueuesPage';

/**
 * **The three cards used to count the PAGE, and the page has a ceiling of 200 rows.**
 *
 * On a queue with 1,847 dead letters the "Dead letters" card said 3 —the ones that fit in the
 * snapshot after the newest deliveries— and an operator reading it concluded there was almost
 * nothing to rescue. The store already returns `totals` (a `COUNT` with no `LIMIT` and with the
 * same visibility filters as the listing) and `muestra_recortada`; the client type ignored both.
 */

function filas(cantidad: number, estado: QueueItem['state'], prefijo: string): QueueItem[] {
  return Array.from({ length: cantidad }, (_valor, indice) => ({
    delivery_id: `${prefijo}-${String(indice)}`, message_id: `msg-${prefijo}-${String(indice)}`,
    tenant_id: 'Steven', recipient_alias: 'zeus', lane: 'interactive', state: estado,
    attempts: 5, max_attempts: 5, available_at: '2026-08-28T02:00:00.000Z',
    last_error: estado === 'dead' ? 'max attempts exhausted' : null,
  }));
}

/** A page of 8 rows out of a queue the server counts in the thousands. */
const PAGINA_RECORTADA: QueueSnapshot = {
  observed_at: '2026-08-28T16:00:00.000Z',
  pending: 4, retrying: 1, dead: 3,
  totals: { pending: 812, retrying: 47, dead: 1_847 },
  muestra_recortada: true,
  items: [...filas(3, 'dead', 'muerta'), ...filas(1, 'retry', 'retry'), ...filas(4, 'pending', 'viva')],
};

function servidorConLaPagina(snapshot: QueueSnapshot) {
  server.use(http.get('*/v3/console/queues', () => HttpResponse.json(snapshot)));
}

function tarjeta(nombre: RegExp): HTMLElement {
  return screen.getByRole('button', { name: nombre });
}

function filasDeLaTabla(): HTMLElement[] {
  const tabla = screen.getByRole('table', { name: /colas, retries y dead letters/i });
  return within(tabla).getAllByRole('row').slice(1);
}

afterEach(() => { window.history.pushState({}, '', '/'); });

describe('las tarjetas de /queues cuentan la cola, no la página', () => {
  it('🔴 «Dead letters» dice las 1847 del servidor, no las 3 que caben en el snapshot', async () => {
    servidorConLaPagina(PAGINA_RECORTADA);
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    const muertas = tarjeta(/dead letters/i);
    expect(within(muertas).getByText('1847')).toBeInTheDocument();
    // The page figure is no longer the headline: as a headline it was the number that said
    // "there is nothing to rescue here" on a queue with 1,847 dead letters.
    expect(within(muertas).queryByText('3')).toBeNull();
    expect(within(tarjeta(/pendientes/i)).getByText('812')).toBeInTheDocument();
    expect(within(tarjeta(/en retry/i)).getByText('47')).toBeInTheDocument();
  }, 20_000);

  it('🔴 el conteo de la página queda como el detalle que delata el recorte', async () => {
    servidorConLaPagina(PAGINA_RECORTADA);
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    expect(tarjeta(/dead letters/i)).toHaveTextContent('3 en esta página · total 1847');
    expect(tarjeta(/pendientes/i)).toHaveTextContent('4 en esta página · total 812');
    // And the read line says it with the server's own flag, not by guessing from `items.length`.
    expect(screen.getByText(/Página recortada/)).toBeInTheDocument();
  }, 20_000);

  it('sin recorte no hay ni detalle ni aviso: los dos números son el mismo', async () => {
    servidorConLaPagina({
      observed_at: '2026-08-28T16:00:00.000Z',
      pending: 0, retrying: 0, dead: 2,
      totals: { pending: 0, retrying: 0, dead: 2 },
      muestra_recortada: false,
      items: filas(2, 'dead', 'muerta'),
    });
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    expect(within(tarjeta(/dead letters/i)).getByText('2')).toBeInTheDocument();
    expect(tarjeta(/dead letters/i)).not.toHaveTextContent(/en esta página/);
    expect(screen.queryByText(/Página recortada/)).not.toBeInTheDocument();
  }, 20_000);

  it('un gateway que todavía no publica `totals` conserva sus cifras de página', async () => {
    // The deployed gateway is not upgraded at the same instant as the console: without a fallback
    // the three cards would go UNKNOWN the moment this ships, which is worse than a low count.
    servidorConLaPagina({
      observed_at: '2026-08-28T16:00:00.000Z', pending: 4, retrying: 1, dead: 3,
      items: PAGINA_RECORTADA.items,
    });
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    expect(within(tarjeta(/dead letters/i)).getByText('3')).toBeInTheDocument();
    expect(tarjeta(/dead letters/i)).not.toHaveTextContent(/en esta página/);
  }, 20_000);

  it('la tarjeta sigue filtrando la tabla a las filas que SÍ están en la página', async () => {
    // The card counts the whole queue and the table can only show the page: pressing it must
    // still take the operator to the rows that are there, saying how many of how many.
    const user = userEvent.setup();
    servidorConLaPagina(PAGINA_RECORTADA);
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    await user.click(tarjeta(/dead letters/i));

    expect(filasDeLaTabla()).toHaveLength(3);
    expect(screen.getByText(/3 de 8 entregas/)).toBeInTheDocument();
    expect(tarjeta(/dead letters/i)).toHaveAttribute('aria-pressed', 'true');
  }, 20_000);
});

describe('totalDelGrupo', () => {
  it('prefiere el COUNT global del servidor sobre el conteo de la página', () => {
    expect(totalDelGrupo(PAGINA_RECORTADA, 'revision')).toBe(1_847);
    expect(totalDelGrupo(PAGINA_RECORTADA, 'retry')).toBe(47);
    expect(totalDelGrupo(PAGINA_RECORTADA, 'pendientes')).toBe(812);
  });

  it('cae al conteo de página cuando `totals` no viene o no es un número', () => {
    expect(totalDelGrupo({ dead: 3 }, 'revision')).toBe(3);
    expect(totalDelGrupo({ dead: 3, totals: null }, 'revision')).toBe(3);
    expect(totalDelGrupo({ dead: 3, totals: { dead: null } }, 'revision')).toBe(3);
    expect(totalDelGrupo({ dead: 3, totals: { dead: Number.NaN } }, 'revision')).toBe(3);
  });

  it('sin ninguna cifra devuelve UNKNOWN, jamás un cero inventado', () => {
    expect(totalDelGrupo(undefined, 'revision')).toBeUndefined();
    expect(totalDelGrupo({ items: [] }, 'revision')).toBeUndefined();
  });

  it('un cero declarado por el servidor es un dato, no un hueco', () => {
    expect(totalDelGrupo({ dead: 7, totals: { dead: 0 } }, 'revision')).toBe(0);
  });
});

describe('muestraRecortada', () => {
  it('sólo cuando el servidor lo afirma', () => {
    expect(muestraRecortada({ muestra_recortada: true })).toBe(true);
    expect(muestraRecortada({ muestra_recortada: false })).toBe(false);
    expect(muestraRecortada({})).toBe(false);
    expect(muestraRecortada(undefined)).toBe(false);
  });
});
