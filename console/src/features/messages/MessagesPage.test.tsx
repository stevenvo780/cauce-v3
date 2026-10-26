import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mockActivity, mockMessages, mockStatus, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import {
  openConversation, openConversationInfo, openConversationMenu, renderChat, thread,
} from './chat-test-utils';

beforeEach(() => {
  window.history.pushState({}, '', '/messages');
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

function publishReceipt(input: Record<string, unknown>, duplicate = false) {
  return {
    message_id: '10000000-0000-4000-8000-000000000001',
    delivery_ids: ['20000000-0000-4000-8000-000000000001'],
    duplicate,
    request_id: '30000000-0000-4000-8000-000000000001',
    trace_id: 'trace-console-test',
    idempotency_key: input.idempotency_key,
    tenant_id: 'Steven',
    actor_alias: 'kant',
    request_hash: 'a'.repeat(64),
    causal_hash: 'b'.repeat(64),
  };
}

/** Records each publish so we can assert WHAT was sent, not just that the UI said it sent. */
function capturarPublish() {
  const enviados: Record<string, unknown>[] = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    enviados.push(input);
    return HttpResponse.json(publishReceipt(input), { status: 202 });
  }));
  return enviados;
}

/** The receipt of the last accepted publish lives in the conversation details, never in the composer. */
async function abrirRecibo(user: ReturnType<typeof userEvent.setup>, hilo: HTMLElement) {
  expect(within(hilo).queryByText('Mensaje aceptado para entrega. La aceptación no confirma la ejecución.'))
    .not.toBeInTheDocument();
  const dialog = await openConversationInfo(user);
  const heading = within(dialog).getByRole('heading', { name: 'Recibo del último envío' });
  const receipt = heading.closest('section');
  if (!receipt) throw new Error('Falta el recibo');
  return receipt;
}

function notaQueDice(hilo: HTMLElement, texto: RegExp): boolean {
  return within(hilo).getAllByRole('note').some((nota) => texto.test(nota.textContent));
}

it('abre el hilo del agente elegido y NO mezcla los mensajes de los demás', async () => {
  renderChat();

  const hilo = await openConversation('argos');

  // The message whose delivery is for argos.
  expect(await within(thread(hilo)).findByText('Verificar estado del adapter Hermes')).toBeInTheDocument();
  // NEGATIVE CONTROL: the other message in the feed goes to Miguel:kratos. If the thread were
  // the old flat list — or if the filter did not filter — it would show up here as well.
  expect(within(hilo).queryByText('Indexar reporte operativo')).not.toBeInTheDocument();

  // And the URL reflects the open conversation, so the link can be pasted.
  expect(window.location.pathname).toBe('/messages/Steven/argos');
}, 20_000);

it('emite el mensaje al agente elegido derivando el room, sin pedirlo escrito a mano', async () => {
  const user = userEvent.setup();
  const enviados = capturarPublish();
  renderChat();

  const hilo = await openConversation('argos');
  // There is no field where to write the recipient or the room: that is part of the fix.
  expect(within(hilo).queryByLabelText(/^room$/i)).not.toBeInTheDocument();
  expect(within(hilo).queryByLabelText(/destinatario/i)).not.toBeInTheDocument();
  expect((await openConversationInfo(user)).querySelector('[data-room-origin]')).toHaveTextContent(/derivado de tu topología/i);
  await user.keyboard('{Escape}');

  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'revisa la cola');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  await waitFor(() => { expect(enviados).toHaveLength(1); });
  expect(enviados[0]).toMatchObject({
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'revisa la cola' },
    lane: 'interactive',
  });
  expect(within(hilo).queryByText(/Aceptado por el servidor/i)).not.toBeInTheDocument();
  expect(within(hilo).queryByText(/ACK llega por polling/i)).not.toBeInTheDocument();
  expect(within(hilo).queryByText(/Mensaje aceptado para entrega/i)).not.toBeInTheDocument();
  const receipt = await abrirRecibo(user, hilo);
  expect(within(receipt).getByText(/Aceptado por el servidor/i)).toBeVisible();
  expect(receipt).toHaveTextContent('Intención confirmada.');
  expect(receipt).toHaveTextContent('no demuestra lectura ni ejecución');
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByText(/Aceptado por el servidor/i)).not.toBeInTheDocument(); });
  expect(screen.getByRole('button', { name: 'Opciones de la conversación' })).toHaveFocus();
  expect(within(hilo).getByRole('textbox', { name: /mensaje para argos/i })).toHaveValue('');
}, 25_000);

it('no inventa éxito ni borra el borrador ante un 202 sin recibo durable exacto', async () => {
  const user = userEvent.setup();
  const keys: unknown[] = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    keys.push(input.idempotency_key);
    return HttpResponse.json({ message_id: '10000000-0000-4000-8000-000000000001' }, { status: 202 });
  }));
  renderChat();

  const hilo = await openConversation('argos');
  const campo = within(hilo).getByRole('textbox', { name: /mensaje para argos/i });
  await user.type(campo, 'no perder este texto');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  expect(await within(hilo).findByText(/no devolvió un recibo exacto/i)).toBeInTheDocument();
  expect(campo).toHaveValue('no perder este texto');
  expect(within(hilo).queryByText(/Aceptado por el servidor/i)).not.toBeInTheDocument();
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
}, 25_000);

it('conserva el borrador y no reintenta cuando el servidor prueba que la reserva expiró sin efecto', async () => {
  const user = userEvent.setup();
  let publishes = 0;
  let confirmations = 0;
  server.use(
    http.post('*/v3/console/publish-intents', () => HttpResponse.json({
      version: 1, state: 'prepared', idempotency_key: 'server-expired-key', receipt: null,
    })),
    http.post('*/v3/console/messages', () => {
      publishes += 1;
      return HttpResponse.json({
        version: 1,
        error: 'publish_intent_expired',
        state: 'expired',
        idempotency_key: 'server-expired-key',
        safe_to_resubmit: true,
      }, { status: 410 });
    }),
    http.post('*/v3/console/publish-intents/confirm', () => {
      confirmations += 1;
      return HttpResponse.json({});
    }),
  );
  renderChat();

  const hilo = await openConversation('argos');
  const campo = within(hilo).getByRole('textbox', { name: /mensaje para argos/i });
  await user.type(campo, 'reserva vencida sin efecto');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  expect(await within(hilo).findByText(/expiró sin publicar ningún mensaje/i)).toBeInTheDocument();
  expect(campo).toHaveValue('reserva vencida sin efecto');
  expect(publishes).toBe(1);
  expect(confirmations).toBe(0);
  expect(within(hilo).queryByText(/Aceptado por el servidor/i)).not.toBeInTheDocument();
}, 25_000);

it('recupera el journal sin body al cerrar y reabrir la conversación tras dos respuestas inciertas', async () => {
  const user = userEvent.setup();
  const keys: unknown[] = [];
  const key = 'server-journal-reopen-key';
  let committedReceipt: ReturnType<typeof publishReceipt> | undefined;
  server.use(
    http.post('*/v3/console/publish-intents', () => committedReceipt === undefined
      ? HttpResponse.json({ version: 1, state: 'prepared', idempotency_key: key, receipt: null })
      : HttpResponse.json({
        version: 1,
        error: 'publish_intent_reconciliation_required',
        state: 'committed',
        idempotency_key: key,
        receipt: committedReceipt,
      }, { status: 409 })),
    http.post('*/v3/console/messages', async ({ request }) => {
      const input = await request.json() as Record<string, unknown>;
      keys.push(input.idempotency_key);
      committedReceipt ??= publishReceipt(input);
      return HttpResponse.json(
        { message_id: '10000000-0000-4000-8000-000000000001' },
        { status: 202 },
      );
    }),
  );
  renderChat();

  let hilo = await openConversation('argos');
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'retry exacto al reabrir');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));
  expect(await within(hilo).findByText(/Resultado incierto/i)).toBeInTheDocument();

  await openConversation('kratos');
  hilo = await openConversation('argos');
  const campoReabierto = within(hilo).getByRole('textbox', { name: /mensaje para argos/i });
  // The body is not persisted on the client. The operator types it again and the server proves
  // it is exactly the same semantics before recovering the uncertain key.
  expect(campoReabierto).toHaveValue('');
  await user.type(campoReabierto, 'retry exacto al reabrir');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  expect(within(await abrirRecibo(user, hilo)).getByText(/confirmada desde el registro del servidor/i)).toBeVisible();
  expect(keys).toHaveLength(2);
  expect(new Set(keys).size).toBe(1);
}, 30_000);

it('recupera del servidor un publish confirmado tras recargar sin repetir el POST', async () => {
  const user = userEvent.setup();
  const key = 'server-journal-reload-key';
  let committed = false;
  let publishes = 0;
  const receipt = publishReceipt({ idempotency_key: key }, true);
  server.use(
    http.post('*/v3/console/publish-intents', () => committed
      ? HttpResponse.json({
        version: 1,
        error: 'publish_intent_reconciliation_required',
        state: 'committed',
        idempotency_key: key,
        receipt,
      }, { status: 409 })
      : HttpResponse.json({ version: 1, state: 'prepared', idempotency_key: key, receipt: null })),
    http.post('*/v3/console/messages', () => {
      publishes += 1;
      committed = true;
      return HttpResponse.error();
    }),
    http.post('*/v3/console/publish-intents/confirm', async ({ request }) => {
      const input = await request.json() as Record<string, unknown>;
      return HttpResponse.json({ version: 1, confirmed: true, ...input });
    }),
  );

  const firstView = renderChat();
  let hilo = await openConversation('argos');
  await user.type(
    within(hilo).getByRole('textbox', { name: /mensaje para argos/i }),
    'efecto durable tras recarga',
  );
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));
  expect(await within(hilo).findByText(/Resultado incierto/i)).toBeInTheDocument();
  expect(publishes).toBe(2);

  firstView.unmount();
  renderChat();
  hilo = await openConversation('argos');
  await user.type(
    within(hilo).getByRole('textbox', { name: /mensaje para argos/i }),
    'efecto durable tras recarga',
  );
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  expect(within(await abrirRecibo(user, hilo)).getByText(/confirmada desde el registro del servidor/i)).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(within(hilo).getByRole('textbox', { name: /mensaje para argos/i })).toHaveValue(''); });
  expect(publishes).toBe(2);
}, 35_000);

/**
 * NEGATIVE CONTROL of the composer. Steven:kant has no ACL edge towards the Isa tenant (the
 * fixture declares it on purpose: the cross nobody declared stays denied by default). If the
 * button were decorative, this case would still publish and the rejection would only appear as
 * a server error — which is exactly what the old form with its text field used to do.
 */
it('bloquea el envío a un destino sin ruta y dice el motivo, en vez de dejar publicar', async () => {
  const enviados = capturarPublish();
  renderChat();

  const hilo = await openConversation('salva');

  const campo = within(hilo).getByRole('textbox', { name: /mensaje para salva/i });
  await waitFor(() => { expect(campo).toBeDisabled(); });
  expect(within(hilo).getByRole('button', { name: /^enviar$/i })).toBeDisabled();
  expect(within(hilo).getByText(/no concede ruta|no pertenece a un room de origen|no comparten un room/i)).toBeInTheDocument();
  expect(enviados).toHaveLength(0);
}, 20_000);

// ---------------------------------------------------------------------------------------------
// LOSSES OF THE REDESIGN, RESTORED. The three came from an adversarial check: the view worked
// and still had stopped showing things the previous flat list did show.
// ---------------------------------------------------------------------------------------------

/**
 * Leave the server in the exact state of the bug: `Steven:gaia` receives a message and is NOT
 * in any room and has no lease. How much the registry knows about it is chosen via `enElRegistro`.
 */
function servidorConGaia({ enElRegistro }: { enElRegistro: boolean }) {
  const actividad = mockActivity();
  const feed = mockMessages();
  const mensajeAGaia = {
    message_id: 'c0ffee00-1111-4222-8333-444444444444',
    request_id: 'c0ffee00-1111-4222-8333-555555555555',
    trace_id: 'trace-gaia-000777',
    tenant_id: 'Steven', room_id: 'ops.infra', actor_alias: 'kant',
    body_preview: 'gaia, toma el encargo del censo', lane: 'batch' as const,
    created_at: new Date(Date.now() - 30_000).toISOString(),
    deliveries: [{
      delivery_id: 'dddddddd-1111-4222-8333-666666666666',
      recipient_tenant: 'Steven', recipient_alias: 'gaia', status: 'pending' as const, attempt: 1,
      timeline: [{ status: 'published' as const, at: new Date(Date.now() - 30_000).toISOString(), attempt: 1 }],
    }],
  };

  server.use(
    // The topology does NOT declare it: a membership nobody created (or someone disabled).
    http.get('*/v3/console/topology', () => HttpResponse.json(topology)),
    // It has no lease either: it does not appear in `presence`.
    http.get('*/v3/console/status', () => HttpResponse.json(mockStatus())),
    http.get('*/v3/status', () => HttpResponse.json(mockStatus())),
    http.get('*/v3/console/activity', () => HttpResponse.json(enElRegistro
      ? { ...actividad, agents: [...(actividad.agents ?? []), { tenant_id: 'Steven', alias: 'gaia', registered: true, agent_enabled: true }] }
      : actividad)),
    http.get('*/v3/console/messages', () => HttpResponse.json({ ...feed, items: [mensajeAGaia, ...(feed.items ?? [])] })),
  );
}

it('un mensaje a un alias SIN membresía ni conexión sigue teniendo hilo: el caso gaia', async () => {
  const user = userEvent.setup();
  servidorConGaia({ enElRegistro: true });
  renderChat();

  // The thread opens with its message inside although no room or lease declares the alias.
  const hilo = await openConversation('gaia');
  expect(await within(thread(hilo)).findByText('gaia, toma el encargo del censo')).toBeInTheDocument();
  expect(within(hilo).getByText('Fuera de la topología')).toBeVisible();
  expect(within(hilo).getByText('Conexión sin dato · envío en cola')).toBeVisible();
  await user.click(within(hilo).getByRole('button', { name: /^Ver detalles:/ }));
  expect(notaQueDice(hilo, /registro de agentes y en NINGUNA sala/i)).toBe(true);
  expect(notaQueDice(hilo, /El servidor no informa la conexión de gaia/i)).toBe(true);
}, 25_000);

it('con el registro caído, el hilo sigue existiendo porque el propio feed lo sostiene', async () => {
  const user = userEvent.setup();
  servidorConGaia({ enElRegistro: false });
  renderChat();

  const hilo = await openConversation('gaia');
  expect(await within(thread(hilo)).findByText('gaia, toma el encargo del censo')).toBeInTheDocument();
  expect(within(hilo).getByText('Fuera de la topología')).toBeVisible();
  expect(within(hilo).getByText('Conexión sin dato · envío en cola')).toBeVisible();
  await user.click(within(hilo).getByRole('button', { name: /^Ver detalles:/ }));
  expect(notaQueDice(hilo, /solo aparece en el historial de mensajes/i)).toBe(true);
}, 25_000);

/**
 * NEGATIVE CONTROL of the enlarged universe. The fix consists of drawing more people, and that
 * is why we must prove that it does NOT draw anyone: an alias that none of the four sources
 * mentions must still not exist, and the screen must say so with all the sources named.
 */
it('un alias que ninguna fuente menciona sigue sin existir, y se dice por qué', async () => {
  servidorConGaia({ enElRegistro: true });
  renderChat('/messages/Steven/fantasma');

  expect(await screen.findByText(/ni en el registro de agentes/i)).toBeInTheDocument();
  expect(screen.getByText('Steven:fantasma')).toBeInTheDocument();
  expect(screen.queryByRole('region', { name: /conversación con fantasma/i })).not.toBeInTheDocument();
  // And gaia, which is there, opens: the negative is about the non-existent alias, not the whole fix.
  expect(await openConversation('gaia')).toBeInTheDocument();
}, 25_000);

it('vuelve a poder publicar en el lane batch, con la prioridad de ese carril', async () => {
  const user = userEvent.setup();
  const enviados = capturarPublish();
  renderChat();

  const hilo = await openConversation('argos');
  await openConversationMenu(user);
  await user.click(screen.getByRole('menuitemradio', { name: /batch · prioridad 0/i }));
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'indexa el informe');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  await waitFor(() => { expect(enviados).toHaveLength(1); });
  expect(enviados[0]).toMatchObject({ lane: 'batch', priority: 0 });
}, 25_000);

/**
 * NEGATIVE CONTROL of the lane selector. That the control exists cannot change what is
 * published when nobody touches it: untouched, it must keep producing `interactive` with
 * priority 10, which is what the old form published.
 */
it('sin tocar el selector sigue publicando interactive con prioridad 10', async () => {
  const user = userEvent.setup();
  const enviados = capturarPublish();
  renderChat();

  const hilo = await openConversation('argos');
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'revisa la cola');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  await waitFor(() => { expect(enviados).toHaveLength(1); });
  expect(enviados[0]).toMatchObject({ lane: 'interactive', priority: 10 });
}, 25_000);
