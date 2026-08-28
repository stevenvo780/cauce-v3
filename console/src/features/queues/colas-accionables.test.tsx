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
 * Pruebas de integración para la gestión, filtrado y acciones sobre colas de entregas.
 */

/** 38 filas con la misma proporción que producción: 7 en revisión, 31 terminadas bien. */
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
// 1. LAS 7 QUE IMPORTAN
// ---------------------------------------------------------------------------------------------

describe('llegar a las entregas que hay que revisar', () => {
  it('🔴 la tarjeta «Dead letters» LLEVA a sus filas, en vez de sólo nombrarlas', async () => {
    const user = userEvent.setup();
    servidorConLas38();
    renderWithApi(<QueuesPage />);

    await screen.findByRole('table', { name: /colas, retries y dead letters/i });
    expect(filasDeLaTabla()).toHaveLength(38);

    await user.click(screen.getByRole('button', { name: /dead letters/i }));

    // Las 7: seis `dead` y una `failed`, que TAMBIÉN deja fila en dead_letters y es replayable.
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
   * CONTROL NEGATIVO del filtro. Que exista no puede cambiar lo que se ve sin tocarlo: sin tocar
   * nada tienen que seguir estando las 38, que es lo que un operador espera al entrar.
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
   * El enlace profundo GANA. Si se combinaran, llegar con `?delivery=` de una entrega en `done`
   * teniendo el filtro en «revisión» daría cero filas bajo un aviso que dice «filtrado a la
   * entrega»: la consola afirmando a la vez que la encontró y que no está.
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
// 2. EL COLOR EQUIVOCADO
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
    // Y NO con la clase que pinta el ámbar de «el servidor no lo dijo».
    expect(celda.querySelector('.unknown')).toBeNull();
  }, 20_000);

  /**
   * CONTROL NEGATIVO, y es el que importa: apagar el ámbar donde sobra no puede apagarlo donde
   * hace falta. Una entrega MUERTA sin motivo es una entrega que nadie puede diagnosticar, y ese
   * hueco tiene que seguir gritando.
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

    // Y cuando el servidor sí dice el motivo, se lee el motivo.
    const muertaConMotivo = screen.getByRole('row', { name: /muerta-1/ });
    expect(within(muertaConMotivo).getAllByRole('cell').at(-2)).toHaveTextContent('max attempts exhausted');
  }, 20_000);
});

// ---------------------------------------------------------------------------------------------
// 3. REINYECTAR A LA FLOTA SIN PREGUNTAR
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

    // ESTO es el arreglo: el servidor no recibió nada todavía.
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

  it('🔴 la explicación de qué hace Replay está en la página ANTES de apretar nada', async () => {
    servidorConLas38();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    expect(screen.getByText(/vuelve a encolar esta entrega/i)).toBeInTheDocument();
    expect(screen.getByText(/queda en dead letters y se puede replayar/i)).toBeInTheDocument();
  }, 20_000);
});
