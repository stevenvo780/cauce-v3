import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { QueuesPage } from './QueuesPage';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';

it('requests replay from the API and reports the accepted action', async () => {
  const sourceDeliveryId = '10000000-0000-4000-8000-000000000001';
  let replayed = '';
  server.use(
    http.get('http://localhost/v3/console/queues', () => HttpResponse.json({ dead: 1, items: [{ delivery_id: sourceDeliveryId, state: 'dead', attempts: 5, max_attempts: 5 }] })),
    http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', ({ params }) => {
      replayed = String(params.deliveryId);
      return HttpResponse.json({
        delivery_id: '20000000-0000-4000-8000-000000000001', replayed_from_delivery_id: replayed,
        state: 'pending', replayed: true,
      }, { status: 202 });
    }),
  );
  const user = userEvent.setup();
  renderWithApi(<QueuesPage />);
  await user.click(await screen.findByRole('button', { name: new RegExp(`replay delivery ${sourceDeliveryId}`, 'i') }));
  // .
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^sí,/i }));

  expect(await screen.findByText(/Replay encolado/)).toBeInTheDocument();
  expect(replayed).toBe(sourceDeliveryId);
});

/**
 * **The "View in Queues" link from the fleet drawer must land on the delivery.**
 *
 * Before, it landed on the generic list: `QueuesPage` did not read `location.search` and the
 * only console code touching it was `LiveFleetPage`. These tests measure the landing, not the
 * intent: how many rows remain, which is highlighted, and what is read when the requested
 * delivery is not in the snapshot.
 */
describe('/queues?delivery= — el aterrizaje del enlace profundo', () => {
  const tresEntregas = {
    observed_at: '2026-08-22T12:00:00.000Z', pending: 1, retrying: 1, dead: 1,
    items: [
      { delivery_id: '11111111-1111-4111-8111-111111111111', recipient_alias: 'zeus', state: 'dead', attempts: 5, max_attempts: 5 },
      { delivery_id: '22222222-2222-4222-8222-222222222222', recipient_alias: 'kant', state: 'retry', attempts: 2, max_attempts: 5 },
      { delivery_id: '33333333-3333-4333-8333-333333333333', recipient_alias: 'argos', state: 'pending', attempts: 0, max_attempts: 5 },
    ],
  };

  function abrir(url: string) {
    window.history.pushState({}, '', url);
    server.use(http.get('http://localhost/v3/console/queues', () => HttpResponse.json(tresEntregas)));
    return renderWithApi(<QueuesPage />);
  }

  afterEach(() => { window.history.pushState({}, '', '/'); });

  it('filtra a la entrega pedida, la resalta y escribe su id completo', async () => {
    abrir('/queues?delivery=22222222-2222-4222-8222-222222222222');

    const tabla = await screen.findByRole('table', { name: /colas, retries y dead letters/i });
    const filas = within(tabla).getAllByRole('row').slice(1); // sin la cabecera
    expect(filas).toHaveLength(1);
    expect(filas[0]).toHaveAttribute('aria-current', 'true');
    expect(within(filas[0]).getByText('kant')).toBeInTheDocument();
    // The FULL id, not the compact one: that is what the operator compares against the link that brought them here.
    expect(screen.getByText('22222222-2222-4222-8222-222222222222')).toBeInTheDocument();
    expect(screen.getByText(/Filtrado a la entrega/)).toBeInTheDocument();
  });

  it('dice que la entrega no está en esta página en vez de pintar la lista donde no figura', async () => {
    abrir('/queues?delivery=99999999-9999-4999-8999-999999999999');

    expect(await screen.findByText(/Esa entrega no está en esta página/)).toBeInTheDocument();
    // It cannot assert that it no longer exists: the snapshot is truncated by the server and
    // there is no per-delivery query. It says both possibilities.
    expect(screen.getByText(/puede que ya no exista/)).toBeInTheDocument();
    expect(screen.getByText(/más antigua que las que caben/)).toBeInTheDocument();
    expect(screen.queryByRole('table', { name: /colas, retries y dead letters/i })).not.toBeInTheDocument();
    expect(screen.queryByText('zeus')).not.toBeInTheDocument();
    expect(screen.queryByText('kant')).not.toBeInTheDocument();
  });

  it('sin el parámetro pinta la lista entera y no resalta ninguna fila', async () => {
    abrir('/queues');

    const tabla = await screen.findByRole('table', { name: /colas, retries y dead letters/i });
    expect(within(tabla).getAllByRole('row').slice(1)).toHaveLength(3);
    expect(screen.queryByText(/Filtrado a la entrega/)).not.toBeInTheDocument();
    expect(tabla.querySelector('[aria-current]')).toBeNull();
  });

  it('«Ver todas las entregas» quita el filtro de la URL y devuelve las tres filas', async () => {
    const user = userEvent.setup();
    abrir('/queues?delivery=22222222-2222-4222-8222-222222222222');
    await screen.findByRole('table', { name: /colas, retries y dead letters/i });

    await user.click(screen.getByRole('button', { name: 'Ver todas las entregas' }));

    expect(window.location.search).toBe('');
    expect(within(await screen.findByRole('table', { name: /colas, retries y dead letters/i })).getAllByRole('row').slice(1)).toHaveLength(3);
  });

  it('vuelve a enfocar cuando llega un segundo enlace profundo sin cambiar de pathname', async () => {
    abrir('/queues?delivery=22222222-2222-4222-8222-222222222222');
    await screen.findByText(/kant/);

    act(() => {
      window.history.pushState({}, '', '/queues?delivery=11111111-1111-4111-8111-111111111111');
      window.dispatchEvent(new PopStateEvent('popstate'));
    });

    expect(await screen.findByText(/zeus/)).toBeInTheDocument();
    expect(screen.queryByText('kant')).not.toBeInTheDocument();
  });
});
