import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { DeliveryTable } from './DeliveryTable';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { QueueItem } from '../../api/types';

/**
 * Aprieta el botón y CONFIRMA. Desde el 2026-08-23 ninguna de las dos acciones sale al servidor
 * con un solo clic: es producción viva y un replay reinyecta trabajo en la cola de un agente que
 * está corriendo. La confirmación se prueba de frente más abajo («un solo clic NO reinyecta»);
 * este ayudante existe para que las pruebas de la ACCIÓN sigan hablando de la acción.
 */
async function confirmar(user: ReturnType<typeof userEvent.setup>, boton: HTMLElement) {
  await user.click(boton);
  const dialogo = await screen.findByRole('alertdialog');
  await user.click(within(dialogo).getByRole('button', { name: /^sí,/i }));
}

/**
 * `DeliveryTable` se extrajo de `QueuesPage` el 2026-08-22 para que la vista de mensajes pueda
 * montar la MISMA tabla —con las mismas acciones— en vez de una copia. Estas pruebas fijan el
 * contrato de esa reutilización: quien la monta pasa las filas y los permisos, y recibe el aviso de
 * que hay que releer.
 */

const DEAD: QueueItem = { delivery_id: 'delivery-dead-1', state: 'dead', attempts: 5, max_attempts: 5, recipient_alias: 'kant', tenant_id: 'Steven' };
const LIVE: QueueItem = { delivery_id: 'delivery-pending-1', state: 'pending', attempts: 0, max_attempts: 5, recipient_alias: 'zeus', tenant_id: 'Steven' };
const FAILED: QueueItem = { delivery_id: 'delivery-failed-1', state: 'failed', attempts: 3, max_attempts: 5, recipient_alias: 'socrates', tenant_id: 'Steven' };

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

  await confirmar(user, screen.getByRole('button', { name: /replay delivery delivery-dead-1/i }));

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

  await confirmar(user, screen.getByRole('button', { name: /replay delivery delivery-dead-1/i }));
  expect(await screen.findByText(/Replay falló/)).toHaveTextContent(/ya fue reencolada/i);
});

it('con cero filas dice el vacío que le pasa quien la monta, no uno genérico', async () => {
  // Messages la va a montar filtrada por conversación: «no hay deliveries informadas» sería falso
  // ahí, porque las hay — no las hay para ESA conversación.
  renderWithApi(<DeliveryTable rows={[]} canReplay canCancel onChanged={() => undefined} empty="Esta conversación no tiene entregas en cola." />);
  expect(screen.getByText('Esta conversación no tiene entregas en cola.')).toBeInTheDocument();
});

it('🔴 ofrece replay en «failed», no sólo en «dead»: la extracción no puede perder ese estado', async () => {
  // Por qué existe: `replayableStates` era una constante DENTRO de QueuesPage y ninguna prueba la
  // fijaba. Se comprobó por mutación el 2026-08-22 — quitar 'failed' del conjunto dejaba la suite
  // ENTERA en verde (460/460). O sea que la copia que Messages iba a montar podía nacer sin ese
  // estado y nadie se enteraba hasta necesitar rescatar una entrega fallida desde la pantalla
  // equivocada. Ahora el conjunto tiene quien lo guarde.
  let replayed = '';
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', ({ params }) => {
    replayed = String(params.deliveryId);
    return HttpResponse.json({ delivery_id: replayed, state: 'pending', replayed: true }, { status: 202 });
  }));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable rows={[FAILED]} canReplay canCancel onChanged={() => undefined} />);

  const fila = screen.getByRole('row', { name: /socrates/ });
  await confirmar(user, within(fila).getByRole('button', { name: /replay delivery delivery-failed-1/i }));
  expect(await screen.findByText(/Replay encolado/)).toBeInTheDocument();
  expect(replayed).toBe('delivery-failed-1');
  // Y no se le ofrece cancelar: una entrega fallida ya no está viva.
  expect(within(fila).queryByRole('button', { name: /cancelar delivery/i })).toBeNull();
});
