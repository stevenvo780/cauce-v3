import { useState } from 'react';
import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mockActivity, mockMessages, mockStatus, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import { FleetProvider } from '../../shell/fleet';
import { renderWithApi } from '../../test/render';
import {
  openConversation, openConversationInfo, openConversationMenu, openMessageDetail, renderChat, thread,
} from './chat-test-utils';
import { MessagesPage } from './MessagesPage';

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

/**
 * NEGATIVE CONTROL of the queue column. If the view filled with zeros what the server does
 * not report, this case would paint argos with "0 queued / 0 in flight" — that is, healthy —
 * just when its queue is unreadable. The test requires the word UNKNOWN and explicitly
 * forbids the zero.
 */
it('un agente que /activity no informa sale UNKNOWN en su cola, nunca en cero', async () => {
  const sinArgos = mockActivity();
  server.use(http.get('*/v3/console/activity', () => HttpResponse.json({
    ...sinArgos,
    agents: (sinArgos.agents ?? []).filter((agent) => agent.alias !== 'argos'),
  })));
  const user = userEvent.setup();
  renderChat();

  await openConversation('argos');
  const cola = (await openConversationInfo(user)).querySelector('[data-queue-strip]');
  await waitFor(() => { expect(cola).toHaveTextContent(/En cola\s*UNKNOWN/); });
  expect(cola).toHaveTextContent(/En curso\s*UNKNOWN/);
  expect(cola).not.toHaveTextContent(/En cola\s*0/);
}, 20_000);

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

it('conserva el foco del opener de diálogo expandido al hidratar el agente seleccionado', async () => {
  let releaseTopology: () => void = () => undefined;
  let markTopologyStarted: () => void = () => undefined;
  const topologyStarted = new Promise<void>((resolve) => { markTopologyStarted = resolve; });
  const pendingTopology = new Promise<void>((resolve) => { releaseTopology = resolve; });
  const status = mockStatus();
  const activity = mockActivity();
  server.use(
    http.get('*/v3/status', () => HttpResponse.json({
      ...status, presence: status.presence?.filter((agent) => agent.alias !== 'argos' && agent.alias !== 'kratos'),
    })),
    http.get('*/v3/console/activity', () => HttpResponse.json({
      ...activity, agents: activity.agents?.filter((agent) => agent.alias !== 'argos' && agent.alias !== 'kratos'),
    })),
    http.get('*/v3/console/messages', () => HttpResponse.json({ items: [] })),
    http.get('*/v3/console/topology', async () => {
      markTopologyStarted();
      await pendingTopology;
      return HttpResponse.json(topology);
    }),
  );
  renderWithApi(<>
    <button type="button" aria-controls="external-panel" aria-haspopup="dialog" aria-expanded="true">Abrir panel</button>
    <section id="external-panel" role="dialog" aria-label="Panel externo">Contenido del panel</section>
    <FleetProvider><MessagesPage params={['Steven', 'argos']} /></FleetProvider>
  </>);
  const opener = screen.getByRole('button', { name: 'Abrir panel' });
  try {
    opener.focus();
    await topologyStarted;
    expect(screen.queryByRole('heading', { name: 'argos' })).not.toBeInTheDocument();

    releaseTopology();
    await screen.findByRole('heading', { name: 'argos' });
    expect(opener).toHaveFocus();
  } finally { releaseTopology(); }
}, 20_000);

it('permite que la selección y navegación enfoquen el hilo con el opener de diálogo cerrado', async () => {
  function MessagesWithNavigation() {
    const [params, setParams] = useState<readonly string[]>(['Steven', 'argos']);
    return <>
      <button type="button" onClick={() => { setParams(['Miguel', 'kratos']); }}>Elegir kratos</button>
      <button type="button" aria-controls="external-panel" aria-haspopup="dialog" aria-expanded="false">Abrir panel</button>
      <section id="external-panel" role="dialog" aria-label="Panel externo">Contenido del panel</section>
      <FleetProvider><MessagesPage params={params} /></FleetProvider>
    </>;
  }
  const user = userEvent.setup();
  renderWithApi(<MessagesWithNavigation />);
  const opener = screen.getByRole('button', { name: 'Abrir panel' });
  opener.focus();

  const argos = await screen.findByRole('heading', { name: 'argos' });
  expect(argos).toHaveFocus();

  await user.click(screen.getByRole('button', { name: 'Elegir kratos' }));
  const kratos = await screen.findByRole('heading', { name: 'kratos' });
  expect(kratos).toHaveFocus();
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

  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'revisá la cola');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  await waitFor(() => { expect(enviados).toHaveLength(1); });
  expect(enviados[0]).toMatchObject({
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'revisá la cola' },
    lane: 'interactive',
  });
  expect(within(hilo).queryByText(/Aceptado por el control plane/i)).not.toBeInTheDocument();
  expect(within(hilo).queryByText(/ACK llega por polling/i)).not.toBeInTheDocument();
  expect(within(hilo).queryByText(/Mensaje aceptado para entrega/i)).not.toBeInTheDocument();
  const receipt = await abrirRecibo(user, hilo);
  expect(within(receipt).getByText(/Aceptado por el control plane/i)).toBeVisible();
  expect(receipt).toHaveTextContent('Intención confirmada.');
  expect(receipt).toHaveTextContent('no demuestra lectura ni ejecución');
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByText(/Aceptado por el control plane/i)).not.toBeInTheDocument(); });
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

  expect(await within(hilo).findByText(/no devolvió un recibo durable exacto/i)).toBeInTheDocument();
  expect(campo).toHaveValue('no perder este texto');
  expect(within(hilo).queryByText(/Aceptado por el control plane/i)).not.toBeInTheDocument();
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
  expect(within(hilo).queryByText(/Aceptado por el control plane/i)).not.toBeInTheDocument();
}, 25_000);

it('reconcilia un lost-202 reintentando una sola vez con la misma clave y sin duplicar intención', async () => {
  const user = userEvent.setup();
  const enviados: Record<string, unknown>[] = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    enviados.push(input);
    if (enviados.length === 1) return HttpResponse.error();
    return HttpResponse.json(publishReceipt(input, true), { status: 202 });
  }));
  renderChat();

  const hilo = await openConversation('argos');
  const campo = within(hilo).getByRole('textbox', { name: /mensaje para argos/i });
  await user.type(campo, 'confirmó pero se perdió el 202');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  expect(within(await abrirRecibo(user, hilo)).getByText(/reconciliada desde el journal durable/i)).toBeVisible();
  expect(campo).toHaveValue('');
  expect(enviados).toHaveLength(2);
  expect(enviados[0]?.idempotency_key).toBe(enviados[1]?.idempotency_key);
  expect(enviados[0]).toEqual(enviados[1]);
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

  expect(within(await abrirRecibo(user, hilo)).getByText(/reconciliada desde el journal durable/i)).toBeVisible();
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

  expect(within(await abrirRecibo(user, hilo)).getByText(/reconciliada desde el journal durable/i)).toBeVisible();
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
  expect(within(hilo).getByText(/no concede route \+ control|no pertenece a un room de origen|no comparten un room/i)).toBeInTheDocument();
  expect(enviados).toHaveLength(0);
}, 20_000);

it('ofrece el salto a la terminal del agente, apuntando a su detalle real', async () => {
  const user = userEvent.setup();
  renderChat();

  const hilo = await openConversation('argos');
  expect(hilo).toBeInTheDocument();
  const menu = await openConversationMenu(user);
  expect(within(menu).getByRole('menuitem', { name: /abrir terminal/i })).toHaveAttribute('href', '/terminal/Steven/argos');
  expect(within(menu).getByRole('menuitem', { name: /perfil y contexto/i })).toHaveAttribute('href', '/messages/Steven/argos?view=context');
}, 20_000);

it('un enlace profundo a un alias que el servidor no observa lo dice, en vez de inventar el agente', async () => {
  renderChat('/messages/Steven/fantasma');

  expect(await screen.findByText(/no observa a/i)).toBeInTheDocument();
  expect(screen.getByText('Steven:fantasma')).toBeInTheDocument();
}, 20_000);

it('declara el techo de 100 mensajes del servidor en vez de presentar el hilo como completo', async () => {
  const user = userEvent.setup();
  renderChat();

  const hilo = await openConversation('argos');
  expect(await openConversationInfo(user)).toHaveTextContent(/sin filtro por par/i);
  await user.keyboard('{Escape}');
  const page = mockMessages();
  server.use(http.get('*/v3/console/messages', () => HttpResponse.json({ ...page,
    items: Array.from({ length: 100 }, (_, index) => ({ ...page.items?.[0], message_id: `window-${String(index)}` })),
  })));
  await openConversationMenu(user);
  await user.click(screen.getByRole('menuitem', { name: 'Sincronizar' }));
  const warning = await within(hilo).findByText(/Ventana llena/);
  expect(warning).toBeVisible();
  expect(warning.closest('[data-thread-scroll]')).not.toBeNull();
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
    body_preview: 'gaia, tomá el encargo del censo', lane: 'batch' as const,
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

it('un mensaje a un alias SIN membresía ni lease sigue teniendo hilo: el caso gaia', async () => {
  const user = userEvent.setup();
  servidorConGaia({ enElRegistro: true });
  renderChat();

  // The thread opens with its message inside although no room or lease declares the alias.
  const hilo = await openConversation('gaia');
  expect(await within(thread(hilo)).findByText('gaia, tomá el encargo del censo')).toBeInTheDocument();
  expect(within(hilo).getByText('Fuera de la topología')).toBeVisible();
  expect(within(hilo).getByText('Lease sin dato · envío en cola')).toBeVisible();
  await user.click(within(hilo).getByRole('button', { name: /^Ver detalles:/ }));
  expect(notaQueDice(hilo, /registro de agentes y en NINGUNA sala/i)).toBe(true);
  expect(notaQueDice(hilo, /El servidor no informa el lease de gaia/i)).toBe(true);
}, 25_000);

it('con el registro caído, el hilo sigue existiendo porque el propio feed lo sostiene', async () => {
  const user = userEvent.setup();
  servidorConGaia({ enElRegistro: false });
  renderChat();

  const hilo = await openConversation('gaia');
  expect(await within(thread(hilo)).findByText('gaia, tomá el encargo del censo')).toBeInTheDocument();
  expect(within(hilo).getByText('Fuera de la topología')).toBeVisible();
  expect(within(hilo).getByText('Lease sin dato · envío en cola')).toBeVisible();
  await user.click(within(hilo).getByRole('button', { name: /^Ver detalles:/ }));
  expect(notaQueDice(hilo, /sólo porque el servidor publicó mensajes suyos/i)).toBe(true);
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

/** The same message from argos' thread, but with a SIBLING delivery for Steven:jarvis. */
function feedConFanOut() {
  const feed = mockMessages();
  const items = (feed.items ?? []).map((mensaje) => mensaje.message_id !== '8eac0520-6e1e-47e8-b7da-554e4bf850b4'
    ? mensaje
    : {
      ...mensaje,
      deliveries: [
        ...(mensaje.deliveries ?? []),
        {
          delivery_id: 'ffffffff-2222-4333-8444-555555555555',
          recipient_tenant: 'Steven', recipient_alias: 'jarvis', status: 'failed' as const, attempt: 2,
          timeline: [{ status: 'published' as const, at: new Date(Date.now() - 95_000).toISOString(), attempt: 1 }],
        },
        {
          delivery_id: 'eeeeeeee-3333-4444-8555-666666666666',
          recipient_tenant: 'Steven', recipient_alias: 'socrates', status: 'retry' as const, attempt: 3,
          timeline: [{ status: 'published' as const, at: new Date(Date.now() - 95_000).toISOString(), attempt: 1 }],
        },
      ],
    });
  server.use(http.get('*/v3/console/messages', () => HttpResponse.json({ ...feed, items })));
}

it('el detalle repone room, lane, actor, tenant, trace ENTERO y el fan-out del publish', async () => {
  const user = userEvent.setup();
  feedConFanOut();
  renderChat();

  const hilo = await openConversation('argos');
  const detalle = await openMessageDetail(user, hilo, 'Verificar estado del adapter Hermes');

  const campo = (etiqueta: string) => {
    const el = within(detalle).getByText(etiqueta).closest('div');
    if (!el) throw new Error(`Missing container for ${etiqueta}`);
    return el;
  };
  expect(within(campo('Room')).getByText('grp.steven')).toBeInTheDocument();
  expect(within(campo('Carril')).getByText('interactive')).toBeInTheDocument();
  expect(within(campo('Actor verificado')).getByText('kant')).toBeInTheDocument();
  expect(within(campo('Tenant de origen')).getByText('Steven')).toBeInTheDocument();
  expect(within(campo('Tenant destino')).getByText('Steven')).toBeInTheDocument();
  // El trace ENTERO, no el compacto: es lo que se pega en /chains/:traceId.
  expect(within(campo('Trace')).getByText('trace-fleet-00042')).toBeInTheDocument();
  expect(within(campo('Message id')).getByText('8eac0520-6e1e-47e8-b7da-554e4bf850b4')).toBeInTheDocument();

  // And the sibling delivery of the fan-out, with its recipient and its status.
  const fanout = within(hilo).getByRole('region', { name: /entregas hermanas/i });
  expect(within(fanout).getByText('Steven:jarvis')).toBeInTheDocument();
  expect(within(fanout).getByText('FALLÓ')).toBeInTheDocument();
  expect(within(fanout).getByText('Steven:socrates')).toBeInTheDocument();
  expect(within(fanout).getByText('EN REINTENTO').closest('[data-tone]')).toHaveAttribute('data-tone', 'warning');

  const gestionarPrincipal = within(detalle).getByRole('link', {
    name: /gestionar delivery 4b981ddd-f311-494e-887c-83fd5e11be90 en colas/i,
  });
  expect(gestionarPrincipal).toHaveAttribute(
    'href', '/queues?delivery=4b981ddd-f311-494e-887c-83fd5e11be90',
  );
  const gestionarHermana = within(fanout).getByRole('link', {
    name: /gestionar delivery ffffffff-2222-4333-8444-555555555555 en colas/i,
  });
  expect(gestionarHermana).toHaveAttribute(
    'href', '/queues?delivery=ffffffff-2222-4333-8444-555555555555',
  );

  expect(within(detalle).queryByRole('button', { name: /replay delivery/i })).not.toBeInTheDocument();
  expect(within(detalle).queryByRole('button', { name: /cancelar delivery/i })).not.toBeInTheDocument();
}, 25_000);

/**
 * NEGATIVE CONTROL of the fan-out. Restoring sibling deliveries must not mix threads again:
 * the sibling is LISTED in the detail, but the message still appears only ONCE in argos'
 * conversation and jarvis' thread is another.
 */
it('la entrega hermana se lista en el detalle pero NO se convierte en una burbuja del hilo', async () => {
  const user = userEvent.setup();
  feedConFanOut();
  renderChat();

  const hilo = await openConversation('argos');
  await openMessageDetail(user, hilo, 'Verificar estado del adapter Hermes');
  const burbujas = within(thread(hilo)).getAllByText('Verificar estado del adapter Hermes');
  expect(burbujas).toHaveLength(1);
  // El otro mensaje del feed, que va a Miguel:kratos, sigue fuera de este hilo.
  expect(within(hilo).queryByText('Indexar reporte operativo')).not.toBeInTheDocument();
}, 25_000);

it('vuelve a poder publicar en el lane batch, con la prioridad de ese carril', async () => {
  const user = userEvent.setup();
  const enviados = capturarPublish();
  renderChat();

  const hilo = await openConversation('argos');
  await openConversationMenu(user);
  await user.click(screen.getByRole('menuitemradio', { name: /batch · prioridad 0/i }));
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'indexá el informe');
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
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'revisá la cola');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  await waitFor(() => { expect(enviados).toHaveLength(1); });
  expect(enviados[0]).toMatchObject({ lane: 'interactive', priority: 10 });
}, 25_000);

it('marca la envoltura con data-conversacion sólo cuando hay un hilo abierto', async () => {
  const { container } = renderChat();

  const envoltura = container.firstElementChild;
  await screen.findByRole('heading', { name: '¿Con quién trabajamos hoy?' });
  expect(envoltura).not.toHaveAttribute('data-conversacion');

  await openConversation('argos');
  expect(envoltura).toHaveAttribute('data-conversacion', 'abierta');
}, 20_000);

it.each(['pending', 'rejected'])('mantiene visible la confirmación %s sin esconderla en el recibo', async (status) => {
  const user = userEvent.setup();
  capturarPublish();
  server.use(http.post('*/v3/console/publish-intents/confirm', () => status === 'pending'
    ? HttpResponse.error()
    : HttpResponse.json({ error: 'confirmation_rejected' }, { status: 400 })));
  renderChat();
  const hilo = await openConversation('argos');
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'Confirmar estado');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));
  const warning = await within(hilo).findByText(status === 'pending' ? /Confirmación incierta/ : /Confirmación rechazada/);
  expect(warning).toBeVisible();
  expect(warning).toHaveAttribute('role', 'status');
  expect(warning.closest('[data-chat-composer]')).not.toBeNull();
  expect(await openConversationInfo(user)).not.toHaveTextContent('Recibo del último envío');
}, 25_000);
