import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import type { QueueItem } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { DeliveryTable } from './DeliveryTable';
import { QueuesPage } from './QueuesPage';

/**
 * Integration tests for management, filtering and actions on delivery queues.
 */

/** 38 rows in the same proportion as production: 7 under review, 31 completed cleanly. */
function snapshotComoProduccion(): { observed_at: string; pending: number; retrying: number; dead: number; items: QueueItem[] } {
  const items: QueueItem[] = [];
  for (let indice = 0; indice < 31; indice += 1) {
    items.push({
      delivery_id: `bien-${String(indice)}`, message_id: `msg-bien-${String(indice)}`, tenant_id: 'Steven',
      recipient_alias: indice % 2 === 0 ? 'kant' : 'argos', lane: 'interactive', state: 'done',
      attempts: 1, max_attempts: 5, available_at: '2026-08-23T02:00:00.000Z', last_error: null,
    });
  }
  for (let indice = 0; indice < 7; indice += 1) {
    items.push({
      delivery_id: `muerta-${String(indice)}`, message_id: `msg-muerta-${String(indice)}`, tenant_id: 'Steven',
      recipient_alias: 'zeus', lane: 'interactive', state: indice === 6 ? 'failed' : 'dead',
      attempts: 5, max_attempts: 5, available_at: '2026-08-23T02:00:00.000Z',
      last_error: indice === 0 ? null : 'max attempts exhausted',
    });
  }
  return { observed_at: '2026-08-23T16:00:00.000Z', pending: 0, retrying: 0, dead: 7, items };
}

function servidorConLas38() {
  server.use(http.get('*/v3/console/queues', () => HttpResponse.json(snapshotComoProduccion())));
}

function filasDeLaTabla(): HTMLElement[] {
  const tabla = screen.getByRole('table', { name: /colas, retries y dead letters/i });
  return within(tabla).getAllByRole('row').slice(1);
}

afterEach(() => { window.history.pushState({}, '', '/'); });

// ---------------------------------------------------------------------------------------------
// 1. THE 7 THAT MATTER
// ---------------------------------------------------------------------------------------------

describe('llegar a las entregas que hay que revisar', () => {
  it('🔴 la tarjeta «Dead letters» LLEVA a sus filas, en vez de sólo nombrarlas', async () => {
    const user = userEvent.setup();
    servidorConLas38();
    renderWithApi(<QueuesPage />);

    await screen.findByRole('table', { name: /colas, retries y dead letters/i });
    expect(filasDeLaTabla()).toHaveLength(38);

    await user.click(screen.getByRole('button', { name: /dead letters/i }));

    // The seven: six `dead` and one `failed`, which ALSO leaves a row in dead_letters and is replayable.
    const filas = filasDeLaTabla();
    expect(filas).toHaveLength(7);
    for (const fila of filas) expect(fila).toHaveTextContent(/zeus/);
    expect(screen.getByRole('status')).toHaveTextContent(/7 de 38 entregas/);
  }, 20_000);

  it('🔴 el filtro se puede quitar, y la tarjeta queda anunciada como apretada', async () => {
    const user = userEvent.setup();
    servidorConLas38();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    const tarjeta = screen.getByRole('button', { name: /dead letters/i });
    expect(tarjeta).toHaveAttribute('aria-pressed', 'false');
    await user.click(tarjeta);
    expect(tarjeta).toHaveAttribute('aria-pressed', 'true');

    await user.click(screen.getByRole('button', { name: /quitar el filtro/i }));
    expect(filasDeLaTabla()).toHaveLength(38);
    expect(tarjeta).toHaveAttribute('aria-pressed', 'false');
  }, 20_000);

  it('🔴 se puede buscar por alias sin tener que leer 38 filas', async () => {
    const user = userEvent.setup();
    servidorConLas38();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    await user.type(screen.getByRole('searchbox', { name: /buscar entrega/i }), 'zeus');
    expect(filasDeLaTabla()).toHaveLength(7);
  }, 20_000);

  /**
   * NEGATIVE CONTROL of the filter. Its mere presence cannot change what is seen untouched:
   * untouched, the 38 must remain, which is what an operator expects on entry.
   */
  it('sin tocar nada siguen estando las 38 filas y ninguna tarjeta apretada', async () => {
    servidorConLas38();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    expect(filasDeLaTabla()).toHaveLength(38);
    for (const nombre of [/pendientes/i, /en retry/i, /dead letters/i]) {
      expect(screen.getByRole('button', { name: nombre })).toHaveAttribute('aria-pressed', 'false');
    }
  }, 20_000);

  /**
   * The deep link WINS. If they were combined, landing with `?delivery=` of a `done` delivery
   * with the "review" filter on would yield zero rows under a notice that says "filtered to the
   * delivery": the console asserting both that it found it and that it is not there.
   */
  it('con un enlace profundo abierto, las tarjetas no filtran y lo dicen', async () => {
    servidorConLas38();
    window.history.pushState({}, '', '/queues?delivery=bien-3');
    renderWithApi(<QueuesPage />);

    await screen.findByRole('table', { name: /colas, retries y dead letters/i });
    expect(filasDeLaTabla()).toHaveLength(1);
    expect(screen.getByRole('button', { name: /dead letters/i })).toBeDisabled();
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// 2. THE WRONG COLOR
// ---------------------------------------------------------------------------------------------

describe('la columna «Último error»', () => {
  it('🔴 una entrega que salió BIEN no grita UNKNOWN en ámbar', async () => {
    servidorConLas38();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    const terminadaBien = screen.getByRole('row', { name: /bien-0/ });
    const celdas = within(terminadaBien).getAllByRole('cell');
    const celda = celdas[celdas.length - 2];
    expect(celda).toBeDefined();
    expect(celda).toHaveTextContent('sin error');
    // And NOT with the class that paints the amber of "the server did not say".
    expect(celda.querySelector('.unknown')).toBeNull();
  }, 20_000);

  /**
   * NEGATIVE CONTROL, and the one that matters: turning the amber off where it is excess must
   * not turn it off where it is needed. A DEAD delivery without a reason is one nobody can
   * diagnose, and that gap must keep yelling.
   */
  it('🔴 una entrega MUERTA sin motivo sigue marcada como UNKNOWN', async () => {
    servidorConLas38();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    const muertaSinMotivo = screen.getByRole('row', { name: /muerta-0/ });
    const celdas = within(muertaSinMotivo).getAllByRole('cell');
    const celda = celdas[celdas.length - 2];
    expect(celda).toBeDefined();
    expect(celda.querySelector('.unknown')).not.toBeNull();
    expect(celda).not.toHaveTextContent('sin error');

    // And when the server does say the reason, the reason is read.
    const muertaConMotivo = screen.getByRole('row', { name: /muerta-1/ });
    expect(within(muertaConMotivo).getAllByRole('cell').at(-2)).toHaveTextContent('max attempts exhausted');
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// 3. REINJECTING INTO THE FLEET WITHOUT ASKING
// ---------------------------------------------------------------------------------------------

const MUERTA: QueueItem = {
  delivery_id: 'delivery-dead-1', state: 'dead', attempts: 5, max_attempts: 5,
  recipient_alias: 'zeus', tenant_id: 'Steven',
};

describe('la confirmación antes de mover trabajo de la flota', () => {
  it('🔴 un solo clic NO reinyecta: pregunta primero y explica qué hace', async () => {
    let intentos = 0;
    server.use(http.post('*/v3/console/deliveries/:deliveryId/replay', () => {
      intentos += 1;
      return HttpResponse.json({ replayed: true }, { status: 202 });
    }));
    const user = userEvent.setup();
    renderWithApi(<DeliveryTable rows={[MUERTA]} canReplay canCancel onChanged={async () => ({ data: {} })} />);

    await user.click(screen.getByRole('button', { name: /replay delivery delivery-dead-1/i }));

    // THIS is the fix: the server has not received anything yet.
    expect(intentos).toBe(0);
    const dialogo = await screen.findByRole('alertdialog');
    expect(dialogo).toHaveTextContent(/vuelve a encolar esta entrega/i);
    expect(dialogo).toHaveTextContent(/zeus/);
  }, 20_000);

  it('🔴 «No hacer nada» deja la flota como estaba', async () => {
    let intentos = 0;
    server.use(http.post('*/v3/console/deliveries/:deliveryId/replay', () => {
      intentos += 1;
      return HttpResponse.json({ replayed: true }, { status: 202 });
    }));
    const user = userEvent.setup();
    renderWithApi(<DeliveryTable rows={[MUERTA]} canReplay canCancel onChanged={async () => ({ data: {} })} />);

    await user.click(screen.getByRole('button', { name: /replay delivery delivery-dead-1/i }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /no hacer nada/i }));

    expect(intentos).toBe(0);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(screen.queryByText(/Replay encolado/)).not.toBeInTheDocument();
  }, 20_000);

  it('🔴 la explicación de qué hace Replay se puede leer sin apretar nada', async () => {
    const user = userEvent.setup();
    servidorConLas38();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    await user.click(screen.getByRole('button', { name: /Qué es «Colas y DLQ operativo»/ }));
    const ayuda = await screen.findByRole('dialog');

    expect(within(ayuda).getByText(/vuelve a encolar esta entrega/i)).toBeInTheDocument();
    expect(within(ayuda).getByText(/queda en dead letters y se puede replayar/i)).toBeInTheDocument();
  }, 20_000);
});
