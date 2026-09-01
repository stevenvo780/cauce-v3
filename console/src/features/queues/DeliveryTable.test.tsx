import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { DeliveryTable, type DeliverySnapshotRefresh } from './DeliveryTable';
import { ApiProvider } from '../../api/context';
import { server } from '../../mocks/server';
import { renderWithApi, testApi } from '../../test/render';
import type { QueueItem } from '../../api/types';

/**
 * Click the button and CONFIRM. The conflation with a single click is the risk: it is live
 * production, and a replay re-injects work into the queue of an agent that is running. The
 * confirmation is tested head-on below ("a single click does NOT replay"); this helper exists
 * so the action tests stay focused on the action.
 */
async function confirmar(user: ReturnType<typeof userEvent.setup>, boton: HTMLElement) {
  await user.click(boton);
  const dialogo = await screen.findByRole('alertdialog');
  await user.click(within(dialogo).getByRole('button', { name: /^sí,/i }));
}

/**
 * `DeliveryTable` was extracted from `QueuesPage` so that the messages view can mount the SAME
 * table — with the same actions — instead of a copy. These tests fix the contract of that
 * reuse: whoever mounts it passes the rows and permissions, and gets the read-back notice.
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
  // The snapshot owner is the one who re-reads: the table does not mutate local state to simulate the effect.
  expect(recargas).toBe(1);

  // Each state offers its own action, and only that one.
  const viva = screen.getByRole('row', { name: /zeus/ });
  expect(within(viva).getByRole('button', { name: /cancelar delivery/i })).toBeInTheDocument();
  expect(within(viva).queryByRole('button', { name: /replay delivery/i })).toBeNull();
});

it('🔴 CONTROL NEGATIVO: sin permiso el botón queda inerte y no sale ni una petición', async () => {
  // If `canReplay` were ignored — for example by mounting the table in Messages without passing
  // the permission — the console would offer an action the server will reject, and worse: would
  // attempt it. This test is what catches that failure; the one above would pass the same.
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
  const replayButton = screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') });
  await waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent(/snapshot no demuestra el efecto/i);
  });
  expect(screen.getByRole('status')).toHaveTextContent(/ya fue reencolada/i);
  expect(replayButton).toBeDisabled();
  await user.click(replayButton);
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
  // The remote effect may have happened: re-read the truth even if the receipt was ambiguous.
  expect(recargas).toBe(1);
  expect(screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') })).toBeDisabled();
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
  await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent(/snapshot no demuestra el efecto/i); });
  expect(replayButton).toBeDisabled();
  await user.click(replayButton);
  expect(replayPosts).toBe(1);
});

it('desbloquea un replay ambiguo sólo cuando la relectura trae su clon con lineage', async () => {
  let replayPosts = 0;
  const replayedId = '20000000-0000-4000-8000-000000000010';
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', () => {
    replayPosts += 1;
    return HttpResponse.json({
      delivery_id: replayedId,
      replayed_from_delivery_id: DEAD_ID,
      state: 'pending',
      replayed: true,
      extra: 'receipt is not exact',
    }, { status: 202 });
  }));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable
    rows={[DEAD]}
    canReplay
    canCancel
    onChanged={async () => ({ data: { items: [{
      delivery_id: replayedId,
      replayed_from_delivery_id: DEAD_ID,
      state: 'accepted',
    }] } })}
  />);

  const replayButton = screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') });
  await confirmar(user, replayButton);
  await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent(/demostró el efecto durable/i); });
  expect(replayButton).toBeEnabled();
  expect(replayPosts).toBe(1);
});

it('un snapshot posterior sólo libera el lock cuando agrega evidencia autoritativa', async () => {
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', () => HttpResponse.json(
    { error: 'conflict', message: 'resultado perdido' }, { status: 409 },
  )));
  const user = userEvent.setup();
  const props = {
    canReplay: true,
    canCancel: true,
    onChanged: async () => ({ data: {} }),
  };
  const view = renderWithApi(<DeliveryTable
    {...props}
    rows={[DEAD]}
    snapshotVersion="snapshot-1"
  />);
  const replayButton = screen.getByRole('button', { name: new RegExp(`replay delivery ${DEAD_ID}`, 'i') });
  await confirmar(user, replayButton);
  await waitFor(() => { expect(replayButton).toBeDisabled(); });

  view.rerender(<ApiProvider api={testApi}><DeliveryTable
    {...props}
    rows={[DEAD]}
    snapshotVersion="snapshot-2"
  /></ApiProvider>);
  expect(replayButton).toBeDisabled();

  const clone: QueueItem & { replayed_from_delivery_id: string } = {
    delivery_id: '20000000-0000-4000-8000-000000000011',
    replayed_from_delivery_id: DEAD_ID,
    state: 'started',
  };
  view.rerender(<ApiProvider api={testApi}><DeliveryTable
    {...props}
    rows={[DEAD, clone]}
    snapshotVersion="snapshot-3"
  /></ApiProvider>);
  await waitFor(() => { expect(replayButton).toBeEnabled(); });
  expect(screen.getByRole('status')).toHaveTextContent(/relectura posterior demostró el replay/i);
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
  expect(screen.getByRole('button', { name: new RegExp(`cancelar delivery ${LIVE_ID}`, 'i') })).toBeDisabled();
});

it('desbloquea una cancelación ambigua sólo con dead y el motivo durable de operador', async () => {
  server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/cancel', () => HttpResponse.json(
    { delivery_id: LIVE_ID, state: 'dead', cancelled: true }, { status: 202 },
  )));
  const user = userEvent.setup();
  renderWithApi(<DeliveryTable
    rows={[LIVE]}
    canReplay
    canCancel
    onChanged={async () => ({ data: { items: [{
      delivery_id: LIVE_ID,
      state: 'dead',
      last_error: 'Cancelled by operator Steven:kant',
    }] } })}
  />);

  const cancelButton = screen.getByRole('button', { name: new RegExp(`cancelar delivery ${LIVE_ID}`, 'i') });
  await confirmar(user, cancelButton);
  await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent(/demostró el efecto durable/i); });
  expect(cancelButton).toBeEnabled();
});

it('con cero filas dice el vacío que le pasa quien la monta, no uno genérico', async () => {
  // Messages will mount it filtered by conversation: "no deliveries reported" would be a lie there,
  // because there are some — there are none for THAT conversation.
  renderWithApi(<DeliveryTable rows={[]} canReplay canCancel onChanged={verifiedRefresh} empty="Esta conversación no tiene entregas en cola." />);
  expect(screen.getByText('Esta conversación no tiene entregas en cola.')).toBeInTheDocument();
});

it('🔴 ofrece replay en «failed», no sólo en «dead»: la extracción no puede perder ese estado', async () => {
  // Why this exists: `replayableStates` was a constant INSIDE QueuesPage and no test pinned it.
  // Verified by mutation: removing 'failed' from the set left the WHOLE suite green. That is,
  // the copy Messages was going to mount could be born without that state and nobody would find
  // out until they needed to rescue a failed delivery from the wrong screen. Now the set has
  // someone to guard it.
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
  // And no cancel is offered: a failed delivery is no longer alive.
  expect(within(fila).queryByRole('button', { name: /cancelar delivery/i })).toBeNull();
});
