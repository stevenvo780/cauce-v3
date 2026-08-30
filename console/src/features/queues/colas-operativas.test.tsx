import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { mockDlq } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { OperationalDlqPanel } from './OperationalDlqPanel';
import { QueuesPage } from './QueuesPage';

/**
 * The rest of the paths an operator walks on `/queues`: reading again, searching, moving between
 * the two tabs, and what happens when the server does not answer or answers with nothing.
 */

const ENTREGAS = /colas, retries y dead letters/i;

const SNAPSHOT = {
  observed_at: '2026-08-28T16:00:00.000Z',
  pending: 1, retrying: 1, dead: 1,
  totals: { pending: 1, retrying: 1, dead: 1 },
  muestra_recortada: false,
  items: [
    { delivery_id: 'aa000000-0000-4000-8000-000000000001', message_id: 'mm000000-0000-4000-8000-000000000001', tenant_id: 'Steven', recipient_alias: 'zeus', lane: 'interactive', state: 'dead', attempts: 5, max_attempts: 5, available_at: '2026-08-28T02:00:00.000Z', last_error: 'ACK timeout contra el adaptador' },
    { delivery_id: 'bb000000-0000-4000-8000-000000000002', message_id: 'mm000000-0000-4000-8000-000000000002', tenant_id: 'Miguel', recipient_alias: 'kratos', lane: 'batch', state: 'retry', attempts: 2, max_attempts: 5, available_at: '2026-08-28T18:00:00.000Z', last_error: 'connection reset' },
    { delivery_id: 'cc000000-0000-4000-8000-000000000003', message_id: 'mm000000-0000-4000-8000-000000000003', tenant_id: 'Steven', recipient_alias: 'argos', lane: 'interactive', state: 'pending', attempts: 0, max_attempts: 5, available_at: '2026-08-28T16:00:00.000Z', last_error: null },
  ],
};

function tablaDelDlq(): HTMLElement {
  return screen.getByRole('table', { name: /incidentes de dlq/i });
}

function filasDeLaTabla(): HTMLElement[] {
  return within(screen.getByRole('table', { name: ENTREGAS })).getAllByRole('row').slice(1);
}

afterEach(() => { window.history.pushState({}, '', '/'); });

describe('leer la cola', () => {
  it('con la cola vacía lo dice, en vez de dejar una tabla fantasma', async () => {
    server.use(http.get('*/v3/console/queues', () => HttpResponse.json({
      observed_at: SNAPSHOT.observed_at, pending: 0, retrying: 0, dead: 0,
      totals: { pending: 0, retrying: 0, dead: 0 }, muestra_recortada: false, items: [],
    })));
    renderWithApi(<QueuesPage />);

    expect(await screen.findByText('No hay deliveries informadas.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: ENTREGAS })).not.toBeInTheDocument();
    // A read zero is data: the three cards say 0, not UNKNOWN.
    expect(within(screen.getByRole('button', { name: /dead letters/i })).getByText('0')).toBeInTheDocument();
  }, 20_000);

  it('si el servidor falla ofrece reintentar, y el reintento pinta la cola', async () => {
    let intentos = 0;
    server.use(http.get('*/v3/console/queues', () => {
      intentos += 1;
      return intentos === 1
        ? HttpResponse.json({ error: 'unavailable', message: 'el store no respondió' }, { status: 503 })
        : HttpResponse.json(SNAPSHOT);
    }));
    const user = userEvent.setup();
    renderWithApi(<QueuesPage />);

    const reintentar = await screen.findByRole('button', { name: /reintentar/i });
    await user.click(reintentar);

    await screen.findByRole('table', { name: ENTREGAS });
    expect(filasDeLaTabla()).toHaveLength(3);
  }, 20_000);

  it('«Actualizar» vuelve a leer del servidor y el snapshot cambia de hora', async () => {
    let lecturas = 0;
    server.use(http.get('*/v3/console/queues', () => {
      lecturas += 1;
      return HttpResponse.json({ ...SNAPSHOT, observed_at: `2026-08-28T16:0${String(lecturas)}:00.000Z` });
    }));
    const user = userEvent.setup();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: ENTREGAS });

    await user.click(screen.getByRole('button', { name: /actualizar/i }));

    await waitFor(() => { expect(lecturas).toBe(2); });
  }, 20_000);

  it('un estado que la consola no conoce se dice UNKNOWN y no ofrece ninguna acción', async () => {
    // Guessing here is what sends an operator to replay something they cannot identify.
    server.use(http.get('*/v3/console/queues', () => HttpResponse.json({
      ...SNAPSHOT,
      items: [{ ...SNAPSHOT.items[0], state: 'quarantined' }],
    })));
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: ENTREGAS });

    const estado = filasDeLaTabla()[0].querySelector('[data-label="Estado"] .unknown');
    expect(estado).toHaveTextContent('sin dato');
    // And the `title=` repeats what the server DID send, so the operator can look it up.
    expect(estado).toHaveAttribute('title', expect.stringContaining('quarantined'));
    expect(within(filasDeLaTabla()[0]).getByText(/No aplica/)).toBeInTheDocument();
    expect(within(filasDeLaTabla()[0]).queryByRole('button')).toBeNull();
  }, 20_000);
});

describe('lo que puede llegar roto en una fila', () => {
  it('una entrega sin id se pinta igual y no ofrece una acción imposible', async () => {
    // The server can omit `delivery_id`; hiding the row would hide the incident, and offering
    // replay on it would send a POST to `/deliveries/undefined/replay`.
    server.use(http.get('*/v3/console/queues', () => HttpResponse.json({
      ...SNAPSHOT,
      items: [{ ...SNAPSHOT.items[0], delivery_id: null }],
    })));
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: ENTREGAS });

    const fila = filasDeLaTabla()[0];
    expect(fila).toHaveTextContent('zeus');
    expect(within(fila).queryByRole('button')).toBeNull();
    expect(within(fila).getByText(/No aplica/)).toBeInTheDocument();
  }, 20_000);

  it('el recibo del replay sobrevive a la relectura que borra la fila de la tabla', async () => {
    // What the operator does next depends on this line, and the successful replay MOVES the row
    // to `pending`: if the notice went away with the row, the screen would end up saying nothing.
    const muerta = SNAPSHOT.items[0];
    let lecturas = 0;
    server.use(
      http.get('*/v3/console/queues', () => {
        lecturas += 1;
        return HttpResponse.json(lecturas === 1 ? SNAPSHOT : {
          ...SNAPSHOT, observed_at: '2026-08-28T16:05:00.000Z',
          items: SNAPSHOT.items.filter((item) => item.delivery_id !== muerta.delivery_id),
        });
      }),
      http.post('*/v3/console/deliveries/:deliveryId/replay', ({ params }) => HttpResponse.json({
        delivery_id: '20000000-0000-4000-8000-000000000001',
        replayed_from_delivery_id: String(params.deliveryId), state: 'pending', replayed: true,
      }, { status: 202 })),
    );
    const user = userEvent.setup();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: ENTREGAS });

    await user.click(screen.getByRole('button', { name: new RegExp(`replay delivery ${muerta.delivery_id}`, 'i') }));
    await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^sí,/i }));

    expect(await screen.findByText(/Replay encolado para aa000000…000001/)).toBeInTheDocument();
    await waitFor(() => { expect(filasDeLaTabla()).toHaveLength(2); });
    expect(screen.getByText(/Replay encolado para aa000000…000001/)).toBeInTheDocument();
  }, 20_000);
});

describe('buscar dentro de la página', () => {
  async function abrir() {
    server.use(http.get('*/v3/console/queues', () => HttpResponse.json(SNAPSHOT)));
    const user = userEvent.setup();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: ENTREGAS });
    return user;
  }

  it('encuentra por message id, que es lo que trae un ticket', async () => {
    const user = await abrir();
    await user.type(screen.getByRole('searchbox', { name: /buscar entrega/i }), 'mm000000-0000-4000-8000-000000000002');
    expect(filasDeLaTabla()).toHaveLength(1);
    expect(filasDeLaTabla()[0]).toHaveTextContent('kratos');
  }, 20_000);

  it('encuentra por el texto del error y por el carril', async () => {
    const user = await abrir();
    const busqueda = screen.getByRole('searchbox', { name: /buscar entrega/i });

    await user.type(busqueda, 'ACK timeout');
    expect(filasDeLaTabla()).toHaveLength(1);
    expect(filasDeLaTabla()[0]).toHaveTextContent('zeus');

    await user.clear(busqueda);
    await user.type(busqueda, 'batch');
    expect(filasDeLaTabla()).toHaveLength(1);
    expect(filasDeLaTabla()[0]).toHaveTextContent('kratos');
  }, 20_000);

  it('cruzar tarjeta y texto que no coinciden deja cero filas y explica el cruce', async () => {
    const user = await abrir();
    await user.click(screen.getByRole('button', { name: /dead letters/i }));
    await user.type(screen.getByRole('searchbox', { name: /buscar entrega/i }), 'kratos');

    expect(screen.queryByRole('table', { name: ENTREGAS })).not.toBeInTheDocument();
    expect(screen.getByText(/Ninguna de las 3 entregas de este snapshot es las que requieren revisión/))
      .toHaveTextContent(/dice «kratos»/);

    await user.click(screen.getByRole('button', { name: /quitar el filtro/i }));
    expect(filasDeLaTabla()).toHaveLength(3);
  }, 20_000);
});

describe('las dos pestañas', () => {
  it('el DLQ operativo se abre sin perder la tabla de entregas, y la tarjeta vuelve a ella', async () => {
    server.use(http.get('*/v3/console/queues', () => HttpResponse.json(SNAPSHOT)));
    const user = userEvent.setup();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: ENTREGAS });

    await user.click(screen.getByRole('tab', { name: /DLQ operativo/i }));
    expect(await screen.findByRole('table', { name: /incidentes de dlq/i })).toBeVisible();
    expect(screen.getByRole('tab', { name: /DLQ operativo/i })).toHaveAttribute('aria-selected', 'true');

    // Pressing a card from the other tab would filter something invisible: it comes back.
    await user.click(screen.getByRole('button', { name: /dead letters/i }));
    expect(screen.getByRole('tab', { name: /^Entregas$/i })).toHaveAttribute('aria-selected', 'true');
    expect(filasDeLaTabla()).toHaveLength(1);
  }, 20_000);

  it('sin el permiso dlq.resolve no se presume acceso ni se pide el endpoint', async () => {
    let pedidos = 0;
    server.use(
      http.get('*/v3/console/queues', () => HttpResponse.json(SNAPSHOT)),
      http.get('*/v3/console/access', () => HttpResponse.json({
        subject: 'Steven:kant', roles: ['operator'], permissions: ['message.publish', 'delivery.replay'],
      })),
      http.get('*/v3/console/dlq', () => { pedidos += 1; return HttpResponse.json(mockDlq()); }),
    );
    const user = userEvent.setup();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: ENTREGAS });

    await user.click(screen.getByRole('tab', { name: /DLQ operativo/i }));

    expect(await screen.findByText(/no tiene control operativo/i)).toBeInTheDocument();
    expect(pedidos).toBe(0);
  }, 20_000);

  it('sin el permiso delivery.cancel el botón de una entrega viva queda inerte', async () => {
    let intentos = 0;
    server.use(
      http.get('*/v3/console/queues', () => HttpResponse.json(SNAPSHOT)),
      http.get('*/v3/console/access', () => HttpResponse.json({
        subject: 'Steven:kant', roles: ['operator'], permissions: ['delivery.replay'],
      })),
      http.post('*/v3/console/deliveries/:deliveryId/cancel', () => {
        intentos += 1;
        return HttpResponse.json({ cancelled: true }, { status: 202 });
      }),
    );
    const user = userEvent.setup();
    renderWithApi(<QueuesPage />);
    await screen.findByRole('table', { name: ENTREGAS });

    const boton = await screen.findByRole('button', { name: /cancelar delivery cc000000-0000-4000-8000-000000000003/i });
    expect(boton).toBeDisabled();
    await user.click(boton);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    expect(intentos).toBe(0);
    // The replay button of the dead one, which IS allowed, stays live: the denial is per action.
    expect(screen.getByRole('button', { name: /replay delivery aa000000-0000-4000-8000-000000000001/i })).toBeEnabled();
  }, 20_000);
});

describe('los filtros del DLQ operativo', () => {
  it('«Sólo abiertos» esconde el incidente ya cerrado y se puede volver a mostrar', async () => {
    const user = userEvent.setup();
    renderWithApi(<OperationalDlqPanel />);
    await screen.findByRole('table', { name: /incidentes de dlq/i });

    // The fixture carries two open incidents and one already resolved.
    expect(screen.getByText(/2 visibles · 3 cargados de/)).toBeInTheDocument();

    await user.click(screen.getByRole('checkbox', { name: /sólo abiertos/i }));

    expect(screen.getByText(/3 visibles · 3 cargados de/)).toBeInTheDocument();
    expect(within(tablaDelDlq()).getByText('OFFLINE ESPERADO')).toBeInTheDocument();
  }, 20_000);

  it('la disposición filtra a su clase, y «Todas» las devuelve', async () => {
    const user = userEvent.setup();
    renderWithApi(<OperationalDlqPanel />);
    await screen.findByRole('table', { name: /incidentes de dlq/i });

    await user.selectOptions(screen.getByRole('combobox', { name: /disposición/i }), 'ambiguous');

    expect(screen.getByText(/^1 visible · 3 cargados de/)).toBeInTheDocument();
    expect(within(tablaDelDlq()).getByText('EFECTO INCIERTO')).toBeInTheDocument();
    expect(within(tablaDelDlq()).queryByText('SIN CLASIFICAR')).toBeNull();

    await user.selectOptions(screen.getByRole('combobox', { name: /disposición/i }), 'all');
    expect(screen.getByText(/2 visibles · 3 cargados de/)).toBeInTheDocument();
  }, 20_000);

  it('un filtro sin coincidencias lo dice y no deja una tabla vacía', async () => {
    const user = userEvent.setup();
    renderWithApi(<OperationalDlqPanel />);
    await screen.findByRole('table', { name: /incidentes de dlq/i });

    await user.selectOptions(screen.getByRole('combobox', { name: /disposición/i }), 'auth');

    expect(screen.getByText('No hay incidentes que coincidan con el filtro.')).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /incidentes de dlq/i })).not.toBeInTheDocument();
  }, 20_000);
});
