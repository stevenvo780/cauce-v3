import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { DeliveryTable } from './DeliveryTable';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { QueueItem } from '../../api/types';

/**
 * `DeliveryTable` se extrajo de `QueuesPage` el 2026-08-22 para que la vista de mensajes pueda
 * montar la MISMA tabla —con las mismas acciones— en vez de una copia. Estas pruebas fijan el
 * contrato de esa reutilización: quien la monta pasa las filas y los permisos, y recibe el aviso de
 * que hay que releer.
 */

const DEAD: QueueItem = { delivery_id: 'delivery-dead-1', state: 'dead', attempts: 5, max_attempts: 5, recipient_alias: 'kant', tenant_id: 'Steven' };
const LIVE: QueueItem = { delivery_id: 'delivery-pending-1', state: 'pending', attempts: 0, max_attempts: 5, recipient_alias: 'zeus', tenant_id: 'Steven' };

it('la monta cualquier vista con sus propias filas y avisa a su dueño que hay que releer', async () => {
  let replayed = '';
  let recargas = 0;
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', ({ params }) => {
    replayed = String(params.deliveryId);
    return HttpResponse.json({ delivery_id: replayed, state: 'pending', replayed: true }, { status: 202 });
  }));
  const user = userEvent.setup();
  renderWithApi(
    <DeliveryTable rows={[DEAD, LIVE]} canReplay canCancel onChanged={() => { recargas += 1; }} />,
  );

  await user.click(screen.getByRole('button', { name: /replay delivery delivery-dead-1/i }));

  expect(await screen.findByText(/Replay encolado/)).toBeInTheDocument();
  expect(replayed).toBe('delivery-dead-1');
  // El dueño del snapshot es quien relee: la tabla no muta estado local para simular el efecto.
  expect(recargas).toBe(1);

  // Cada estado ofrece la acción que le corresponde, y sólo esa.
  const viva = screen.getByRole('row', { name: /zeus/ });
  expect(within(viva).getByRole('button', { name: /cancelar delivery/i })).toBeInTheDocument();
  expect(within(viva).queryByRole('button', { name: /replay delivery/i })).toBeNull();
});

it('🔴 CONTROL NEGATIVO: sin permiso el botón queda inerte y no sale ni una petición', async () => {
  // Si `canReplay` se ignorara —por ejemplo montando la tabla en Messages sin pasar el permiso—,
  // la consola ofrecería una acción que el servidor va a rechazar, y peor: la intentaría. Esta
  // prueba es la que detecta ese fallo; la de arriba pasaría igual.
  let intentos = 0;
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', () => {
    intentos += 1;
    return HttpResponse.json({ replayed: true }, { status: 202 });
  }));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable rows={[DEAD]} canReplay={false} canCancel={false} onChanged={() => undefined} />);

  const boton = screen.getByRole('button', { name: /replay delivery delivery-dead-1/i });
  expect(boton).toBeDisabled();
  await user.click(boton);
  expect(intentos).toBe(0);
  expect(screen.queryByText(/Replay encolado/)).not.toBeInTheDocument();
});

it('dice qué pasó cuando el servidor rechaza el replay, en vez de callarse', async () => {
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', () => HttpResponse.json(
    { error: 'conflict', message: 'la entrega ya fue reencolada' }, { status: 409 },
  )));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable rows={[DEAD]} canReplay canCancel onChanged={() => undefined} />);

  await user.click(screen.getByRole('button', { name: /replay delivery delivery-dead-1/i }));
  expect(await screen.findByText(/Replay falló/)).toHaveTextContent(/ya fue reencolada/i);
});

it('con cero filas dice el vacío que le pasa quien la monta, no uno genérico', async () => {
  // Messages la va a montar filtrada por conversación: «no hay deliveries informadas» sería falso
  // ahí, porque las hay — no las hay para ESA conversación.
  renderWithApi(<DeliveryTable rows={[]} canReplay canCancel onChanged={() => undefined} empty="Esta conversación no tiene entregas en cola." />);
  expect(screen.getByText('Esta conversación no tiene entregas en cola.')).toBeInTheDocument();
});
