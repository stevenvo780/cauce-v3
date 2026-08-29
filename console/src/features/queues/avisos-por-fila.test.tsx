import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import type { QueueItem } from '../../api/types';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { DeliveryTable } from './DeliveryTable';

/**
 * **The outcome of an action belongs to its row.**
 *
 * The notice was ONE shared string for the whole table: rescuing two dead letters in a row erased
 * the outcome of the first with the outcome of the second, and what got erased was, in the worst
 * case, "the result is uncertain, reread before deciding" — the one line that must survive
 * someone touching another row. Now each notice is indexed by delivery and names it.
 */

const PRIMERA = '10000000-0000-4000-8000-00000000aaaa';
const SEGUNDA = '10000000-0000-4000-8000-00000000bbbb';
const VIVA = '10000000-0000-4000-8000-00000000cccc';

const muerta = (id: string, alias: string): QueueItem => ({
  delivery_id: id, message_id: `msg-${alias}`, tenant_id: 'Steven', recipient_alias: alias,
  lane: 'interactive', state: 'dead', attempts: 5, max_attempts: 5, last_error: 'max attempts exhausted',
});
const viva: QueueItem = {
  delivery_id: VIVA, message_id: 'msg-viva', tenant_id: 'Steven', recipient_alias: 'argos',
  lane: 'interactive', state: 'pending', attempts: 0, max_attempts: 5, last_error: null,
};

function recibeElReplay(deliveryId: string) {
  return HttpResponse.json({
    delivery_id: `20000000-0000-4000-8000-${deliveryId.slice(-12)}`,
    replayed_from_delivery_id: deliveryId, state: 'pending', replayed: true,
  }, { status: 202 });
}

async function confirmar(user: ReturnType<typeof userEvent.setup>, boton: HTMLElement) {
  await user.click(boton);
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: /^sí,/i }));
}

function avisos(): string[] {
  return screen.queryAllByRole('status').map((nodo) => nodo.textContent ?? '');
}

describe('el aviso de cada entrega es suyo', () => {
  it('🔴 el segundo replay NO borra el recibo del primero', async () => {
    server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', ({ params }) => (
      recibeElReplay(String(params.deliveryId))
    )));
    const user = userEvent.setup();
    renderWithApi(<DeliveryTable
      rows={[muerta(PRIMERA, 'kant'), muerta(SEGUNDA, 'socrates')]}
      canReplay
      canCancel
      onChanged={async () => ({ data: {} })}
    />);

    await confirmar(user, screen.getByRole('button', { name: new RegExp(`replay delivery ${PRIMERA}`, 'i') }));
    await screen.findByText(/Replay encolado para 10000000…00aaaa/);
    await confirmar(user, screen.getByRole('button', { name: new RegExp(`replay delivery ${SEGUNDA}`, 'i') }));

    expect(await screen.findByText(/Replay encolado para 10000000…00bbbb/)).toBeInTheDocument();
    expect(screen.getByText(/Replay encolado para 10000000…00aaaa/)).toBeInTheDocument();
    expect(avisos()).toHaveLength(2);
  }, 20_000);

  it('🔴 un replay incierto sobrevive a que el operador cancele otra entrega', async () => {
    // The order that used to lose the important half: the uncertain outcome is announced FIRST and
    // the operator then moves on to another row, which is exactly what an operator does.
    server.use(
      http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', () => HttpResponse.json(
        { error: 'conflict', message: 'la entrega ya fue reencolada' }, { status: 409 },
      )),
      http.post('http://localhost/v3/console/deliveries/:deliveryId/cancel', ({ params }) => HttpResponse.json({
        delivery_id: String(params.deliveryId), state: 'dead', cancelled: true,
        cancelled_from_state: 'pending', parent_notice: 'not_child', origin_relayed: false, replayable: true,
      }, { status: 202 })),
    );
    const user = userEvent.setup();
    renderWithApi(<DeliveryTable
      rows={[muerta(PRIMERA, 'kant'), viva]}
      canReplay
      canCancel
      onChanged={async () => ({ data: {} })}
    />);

    await confirmar(user, screen.getByRole('button', { name: new RegExp(`replay delivery ${PRIMERA}`, 'i') }));
    await screen.findByText(/Resultado incierto del reinyectado de 10000000…00aaaa/);
    await confirmar(user, screen.getByRole('button', { name: new RegExp(`cancelar delivery ${VIVA}`, 'i') }));

    expect(await screen.findByText(/Cancelada 10000000…00cccc/)).toBeInTheDocument();
    // The uncertain one is still on screen, naming its own delivery and keeping the verdict of its
    // reread: that verdict is what the operator needs before deciding whether to replay again.
    expect(screen.getByText(/Resultado incierto del reinyectado de 10000000…00aaaa/))
      .toHaveTextContent(/La cola ya se releyó/);
  }, 20_000);

  it('reintentar la MISMA entrega reemplaza su aviso en vez de acumular dos', async () => {
    let intentos = 0;
    server.use(http.post('http://localhost/v3/console/deliveries/:deliveryId/replay', ({ params }) => {
      intentos += 1;
      return intentos === 1
        ? HttpResponse.json({ error: 'unavailable', message: 'el store no respondió' }, { status: 503 })
        : recibeElReplay(String(params.deliveryId));
    }));
    const user = userEvent.setup();
    renderWithApi(<DeliveryTable
      rows={[muerta(PRIMERA, 'kant')]}
      canReplay
      canCancel
      snapshotVersion="2026-08-28T16:00:00.000Z"
      onChanged={async () => ({ data: {} })}
    />);

    const boton = screen.getByRole('button', { name: new RegExp(`replay delivery ${PRIMERA}`, 'i') });
    await confirmar(user, boton);
    expect(await screen.findByText(/Resultado incierto del reinyectado de 10000000…00aaaa/)).toBeInTheDocument();

    // A verified reread released the row: the operator retries and the row keeps ONE reading.
    await confirmar(user, boton);
    expect(await screen.findByText(/Replay encolado para 10000000…00aaaa/)).toBeInTheDocument();
    expect(screen.queryByText(/Resultado incierto/)).not.toBeInTheDocument();
    expect(avisos()).toHaveLength(1);
  }, 20_000);
});
