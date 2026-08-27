import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { DeliveryTable, type DeliverySnapshotRefresh } from './DeliveryTable';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import type { QueueItem } from '../../api/types';

/**
 * Aprieta el botón y CONFIRMA. 
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

const DEAD_ID = '10000000-0000-4000-8000-000000000001';
const LIVE_ID = '10000000-0000-4000-8000-000000000002';
const FAILED_ID = '10000000-0000-4000-8000-000000000003';
const DEAD: QueueItem = { delivery_id: DEAD_ID, state: 'dead', attempts: 5, max_attempts: 5, recipient_alias: 'kant', tenant_id: 'Steven' };
const LIVE: QueueItem = { delivery_id: LIVE_ID, state: 'pending', attempts: 0, max_attempts: 5, recipient_alias: 'zeus', tenant_id: 'Steven' };
const FAILED: QueueItem = { delivery_id: FAILED_ID, state: 'failed', attempts: 3, max_attempts: 5, recipient_alias: 'socrates', tenant_id: 'Steven' };
const verifiedRefresh = async () => ({ data: {} });

it('la monta cualquier vista con sus propias filas y avisa a su dueño que hay que releer', async () => {
  let replayed = '';
  let recargas = 0;
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', ({ params }) => {
    replayed = String(params.deliveryId);
    return HttpResponse.json({
      delivery_id: '20000000-0000-4000-8000-000000000001', replayed_from_delivery_id: replayed,
      state: 'pending', replayed: true,
    }, { status: 202 });
  }));
  const user = userEvent.setup();
  renderWithApi(
    <DeliveryTable rows={[DEAD, LIVE]} canReplay canCancel onChanged={async () => {
      recargas += 1;
      return { data: {} };
    }} />,
  );

  await confirmar(user, screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') }));

  expect(await screen.findByText(/Replay encolado/)).toBeInTheDocument();
  expect(replayed).toBe(DEAD_ID);
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
  renderWithApi(<DeliveryTable rows={[DEAD]} canReplay={false} canCancel={false} onChanged={verifiedRefresh} />);

  const boton = screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') });
  expect(boton).toBeDisabled();
  await user.click(boton);
  expect(intentos).toBe(0);
  expect(screen.queryByText(/Replay encolado/)).not.toBeInTheDocument();
});

it('dice que el outcome es incierto y relee cuando el replay no obtiene recibo', async () => {
  let recargas = 0;
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', () => HttpResponse.json(
    { error: 'conflict', message: 'la entrega ya fue reencolada' }, { status: 409 },
  )));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable
    rows={[DEAD]}
    canReplay
    canCancel
    onChanged={async () => { recargas += 1; return { data: {} }; }}
  />);

  await confirmar(user, screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') }));
  expect(await screen.findByText(/Resultado incierto del reinyectado/)).toHaveTextContent(/ya fue reencolada/i);
  expect(screen.getByRole('status')).toHaveTextContent(/cola ya se releyó/i);
  expect(recargas).toBe(1);
});

it('no afirma replay aplicado ante un 2xx sin recibo durable exacto', async () => {
  let recargas = 0;
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', () => HttpResponse.json(
    { delivery_id: DEAD_ID, state: 'pending', replayed: true }, { status: 202 },
  )));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable
    rows={[DEAD]}
    canReplay
    canCancel
    onChanged={async () => { recargas += 1; return { data: {} }; }}
  />);

  await confirmar(user, screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') }));
  expect(await screen.findByText(/Resultado incierto del reinyectado/)).toHaveTextContent(/recibo durable exacto/i);
  expect(screen.queryByText(/Replay encolado/)).not.toBeInTheDocument();
  // El efecto remoto pudo aplicarse: se relee la verdad aunque el recibo haya sido ambiguo.
  expect(recargas).toBe(1);
});

it('keeps an uncertain replay locked until its deferred server reread is verified', async () => {
  let replayPosts = 0;
  let finishRefresh!: (result: DeliverySnapshotRefresh) => void;
  const refresh = new Promise<DeliverySnapshotRefresh>((resolve) => { finishRefresh = resolve; });
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', () => {
    replayPosts += 1;
    return HttpResponse.json(
      { delivery_id: DEAD_ID, state: 'pending', replayed: true }, { status: 202 },
    );
  }));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable
    rows={[DEAD]}
    canReplay
    canCancel
    onChanged={() => refresh}
  />);

  const replayButton = screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') });
  await confirmar(user, replayButton);
  expect(await screen.findByText(/acción queda bloqueada durante esa lectura/i)).toBeInTheDocument();
  expect(replayButton).toBeDisabled();
  await user.click(replayButton);
  expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  expect(replayPosts).toBe(1);

  finishRefresh({ data: {} });
  await waitFor(() => expect(replayButton).toBeEnabled());
  expect(screen.getByRole('status')).toHaveTextContent(/cola ya se releyó/i);
  expect(replayPosts).toBe(1);
});

it('trata una cancelación 2xx truncada como incierta y relee sin afirmar que canceló', async () => {
  let recargas = 0;
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/cancel', () => HttpResponse.json(
    { delivery_id: LIVE_ID, state: 'dead', cancelled: true }, { status: 202 },
  )));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable
    rows={[LIVE]}
    canReplay
    canCancel
    onChanged={async () => { recargas += 1; return { data: {} }; }}
  />);

  await confirmar(user, screen.getByRole('button', { name: new RegExp(`cancelar delivery ${LIVE_ID}`, 'i') }));
  expect(await screen.findByText(/Resultado incierto de la cancelación/)).toHaveTextContent(/recibo durable exacto/i);
  expect(screen.queryByText(/^Cancelada /i)).not.toBeInTheDocument();
  expect(recargas).toBe(1);
});

it('con cero filas dice el vacío que le pasa quien la monta, no uno genérico', async () => {
  // Messages la va a montar filtrada por conversación: «no hay deliveries informadas» sería falso
  // ahí, porque las hay — no las hay para ESA conversación.
  renderWithApi(<DeliveryTable rows={[]} canReplay canCancel onChanged={verifiedRefresh} empty="Esta conversación no tiene entregas en cola." />);
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
    return HttpResponse.json({
      delivery_id: '20000000-0000-4000-8000-000000000002', replayed_from_delivery_id: replayed,
      state: 'pending', replayed: true,
    }, { status: 202 });
  }));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable rows={[FAILED]} canReplay canCancel onChanged={verifiedRefresh} />);

  const fila = screen.getByRole('row', { name: /socrates/ });
  await confirmar(user, within(fila).getByRole('button', { name: new RegExp(`replay delivery ${FAILED_ID}`, 'i') }));
  expect(await screen.findByText(/Replay encolado/)).toBeInTheDocument();
  expect(replayed).toBe(FAILED_ID);
  // Y no se le ofrece cancelar: una entrega fallida ya no está viva.
  expect(within(fila).queryByRole('button', { name: /cancelar delivery/i })).toBeNull();
});
