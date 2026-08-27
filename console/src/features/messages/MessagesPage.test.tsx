import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mockActivity, mockMessages, mockStatus, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
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

/** Registra cada publish para poder afirmar QUÉ se envió, no sólo que la UI dijo que envió. */
function capturarPublish() {
  const enviados: Array<Record<string, unknown>> = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    enviados.push(input);
    return HttpResponse.json(publishReceipt(input), { status: 202 });
  }));
  return enviados;
}

async function abrirConversacion(user: ReturnType<typeof userEvent.setup>, alias: string) {
  const fila = await screen.findByRole('button', { name: new RegExp(`conversación con ${alias},`, 'i') });
  await user.click(fila);
  return screen.findByRole('region', { name: new RegExp(`conversación con ${alias}`, 'i') });
}

/**
 * Las BURBUJAS, sin el panel de detalle.
 *
 * Hace falta desde que el detalle muestra el cuerpo del mensaje: antes no lo mostraba —seis campos
 * de metadatos y ni una línea del texto— y por eso un `getByText` sobre el hilo entero encontraba
 * una sola coincidencia. Que ahora haya dos es el arreglo, no un defecto, pero una prueba que
 * quiere afirmar «este mensaje NO está en este hilo» tiene que mirar las burbujas.
 */
function historial(hilo: HTMLElement): HTMLElement {
  const caja = hilo.querySelector<HTMLElement>('.terminal-transcript');
  if (!caja) throw new Error('el hilo no tiene transcripción');
  return caja;
}

it('lista a los agentes con el estado de su cola al lado del nombre', async () => {
  renderWithApi(<MessagesPage />);

  const argos = await screen.findByRole('button', { name: /conversación con argos,/i });
  // Del fixture de /v3/console/activity: argos tiene 1 encolada y 1 en vuelo.
  expect(within(argos).getByText('1 en cola')).toBeInTheDocument();
  expect(within(argos).getByText('1 en curso')).toBeInTheDocument();
  // Y de /v3/console/queues: la única entrega muerta es de Miguel:kratos, no suya.
  expect(within(argos).getByText('0 muertas')).toBeInTheDocument();

  const kratos = await screen.findByRole('button', { name: /conversación con kratos,/i });
  expect(within(kratos).getByText('1 muertas')).toBeInTheDocument();
}, 20_000);

/**
 * CONTROL NEGATIVO de la columna de cola. Si la vista rellenara con ceros lo que el servidor no
 * informa, este caso pintaría a argos con «0 en cola / 0 en curso» —o sea, sano— justo cuando su
 * cola es ilegible. La prueba exige la palabra UNKNOWN y prohíbe explícitamente el cero.
 */
it('un agente que /activity no informa sale UNKNOWN en su cola, nunca en cero', async () => {
  const sinArgos = mockActivity();
  server.use(http.get('*/v3/console/activity', () => HttpResponse.json({
    ...sinArgos,
    agents: (sinArgos.agents ?? []).filter((agent) => agent.alias !== 'argos'),
  })));
  renderWithApi(<MessagesPage />);

  const argos = await screen.findByRole('button', { name: /conversación con argos,/i });
  await waitFor(() => expect(within(argos).getByText('UNKNOWN en cola')).toBeInTheDocument());
  expect(within(argos).getByText('UNKNOWN en curso')).toBeInTheDocument();
  expect(within(argos).queryByText('0 en cola')).not.toBeInTheDocument();
  expect(within(argos).queryByText('0 en curso')).not.toBeInTheDocument();
}, 20_000);

it('abre el hilo del agente elegido y NO mezcla los mensajes de los demás', async () => {
  const user = userEvent.setup();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');

  // El mensaje cuya entrega es para argos.
  expect(await within(historial(hilo)).findByText('Verificar estado del adapter Hermes')).toBeInTheDocument();
  // CONTROL NEGATIVO: el otro mensaje del feed va a Miguel:kratos. Si el hilo fuera la lista
  // plana de antes —o si el filtro no filtrara— aparecería acá igual.
  expect(within(hilo).queryByText('Indexar reporte operativo')).not.toBeInTheDocument();

  // Y la dirección refleja la conversación abierta, para que el enlace se pueda pegar.
  expect(window.location.pathname).toBe('/messages/Steven/argos');
}, 20_000);

it('emite el mensaje al agente elegido derivando el room, sin pedirlo escrito a mano', async () => {
  const user = userEvent.setup();
  const enviados = capturarPublish();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
  // No hay ningún campo donde escribir el destinatario ni el room: eso es parte del arreglo.
  expect(within(hilo).queryByLabelText(/^room$/i)).not.toBeInTheDocument();
  expect(within(hilo).queryByLabelText(/destinatario/i)).not.toBeInTheDocument();
  expect(within(hilo).getByText(/derivado de tu topología/i)).toBeInTheDocument();

  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'revisá la cola');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  await waitFor(() => expect(enviados).toHaveLength(1));
  expect(enviados[0]).toMatchObject({
    room_id: 'grp.steven',
    recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
    body: { text: 'revisá la cola' },
    lane: 'interactive',
  });
  expect(await within(hilo).findByText(/Aceptado por el control plane/i)).toBeInTheDocument();
}, 25_000);

it('no inventa éxito ni borra el borrador ante un 202 sin recibo durable exacto', async () => {
  const user = userEvent.setup();
  const keys: unknown[] = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    keys.push(input.idempotency_key);
    return HttpResponse.json({ message_id: '10000000-0000-4000-8000-000000000001' }, { status: 202 });
  }));
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
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
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
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
  const enviados: Array<Record<string, unknown>> = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    enviados.push(input);
    if (enviados.length === 1) return HttpResponse.error();
    return HttpResponse.json(publishReceipt(input, true), { status: 202 });
  }));
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
  const campo = within(hilo).getByRole('textbox', { name: /mensaje para argos/i });
  await user.type(campo, 'confirmó pero se perdió el 202');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  expect(await within(hilo).findByText(/reconciliada desde el journal durable/i)).toBeInTheDocument();
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
  renderWithApi(<MessagesPage />);

  let hilo = await abrirConversacion(user, 'argos');
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'retry exacto al reabrir');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));
  expect(await within(hilo).findByText(/Resultado incierto/i)).toBeInTheDocument();

  await abrirConversacion(user, 'kratos');
  hilo = await abrirConversacion(user, 'argos');
  const campoReabierto = within(hilo).getByRole('textbox', { name: /mensaje para argos/i });
  // El body no se persiste en el cliente. El operador lo vuelve a escribir y el servidor prueba
  // que es exactamente la misma semántica antes de recuperar la clave incierta.
  expect(campoReabierto).toHaveValue('');
  await user.type(campoReabierto, 'retry exacto al reabrir');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  expect(await within(hilo).findByText(/reconciliada desde el journal durable/i)).toBeInTheDocument();
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

  const firstView = renderWithApi(<MessagesPage />);
  let hilo = await abrirConversacion(user, 'argos');
  await user.type(
    within(hilo).getByRole('textbox', { name: /mensaje para argos/i }),
    'efecto durable tras recarga',
  );
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));
  expect(await within(hilo).findByText(/Resultado incierto/i)).toBeInTheDocument();
  expect(publishes).toBe(2);

  firstView.unmount();
  renderWithApi(<MessagesPage />);
  hilo = await abrirConversacion(user, 'argos');
  await user.type(
    within(hilo).getByRole('textbox', { name: /mensaje para argos/i }),
    'efecto durable tras recarga',
  );
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  expect(await within(hilo).findByText(/reconciliada desde el journal durable/i)).toBeInTheDocument();
  expect(within(hilo).getByRole('textbox', { name: /mensaje para argos/i })).toHaveValue('');
  expect(publishes).toBe(2);
}, 35_000);

/**
 * CONTROL NEGATIVO del compositor. Steven:kant no tiene arista ACL hacia el tenant Isa (el
 * fixture lo declara a propósito: el cruce que nadie declaró queda denegado por defecto). Si el
 * botón fuera decorativo, este caso publicaría igual y el rechazo aparecería recién como un error
 * del servidor — que es exactamente lo que hacía el formulario anterior con su campo de texto.
 */
it('bloquea el envío a un destino sin ruta y dice el motivo, en vez de dejar publicar', async () => {
  const user = userEvent.setup();
  const enviados = capturarPublish();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'salva');

  const campo = within(hilo).getByRole('textbox', { name: /mensaje para salva/i });
  await waitFor(() => expect(campo).toBeDisabled());
  expect(within(hilo).getByRole('button', { name: /^enviar$/i })).toBeDisabled();
  expect(within(hilo).getByText(/no concede route \+ control|no pertenece a un room de origen|no comparten un room/i)).toBeInTheDocument();
  expect(enviados).toHaveLength(0);
}, 20_000);

it('ofrece el salto a la terminal del agente, apuntando a su detalle real', async () => {
  const user = userEvent.setup();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
  expect(within(hilo).getByRole('link', { name: /abrir tui/i })).toHaveAttribute('href', '/fleet/Steven/argos');
}, 20_000);

it('un enlace profundo a un alias que el servidor no observa lo dice, en vez de inventar el agente', async () => {
  window.history.pushState({}, '', '/messages/Steven/fantasma');
  renderWithApi(<MessagesPage />);

  expect(await screen.findByText(/no observa a/i)).toBeInTheDocument();
  expect(screen.getByText('Steven:fantasma')).toBeInTheDocument();
}, 20_000);

it('declara el techo de 100 mensajes del servidor en vez de presentar el hilo como completo', async () => {
  const user = userEvent.setup();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
  expect(within(hilo).getByText(/sin filtro por par/i)).toBeInTheDocument();
}, 20_000);

// ---------------------------------------------------------------------------------------------
// PÉRDIDAS DEL REDISEÑO, REPUESTAS. Las tres salieron de una verificación adversarial: la vista
// funcionaba y aun así había dejado de mostrar cosas que la lista plana anterior sí mostraba.
// ---------------------------------------------------------------------------------------------

/**
 * Deja el servidor en el estado exacto del defecto: `Steven:gaia` recibe un mensaje y NO está en
 * ninguna sala ni tiene lease. Cuánto la conoce el registro se elige con `enElRegistro`.
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
    // La topología NO la declara: es una membresía que nadie creó (o que alguien deshabilitó).
    http.get('*/v3/console/topology', () => HttpResponse.json(topology)),
    // Tampoco tiene lease: no aparece en `presence`.
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
  renderWithApi(<MessagesPage />);

  // 1) Tiene fila en el roster, rotulada como lo que es: registrada y sin sala.
  const fila = await screen.findByRole('button', { name: /conversación con gaia,.*sin sala declarada/i });
  expect(within(fila).getByText('sin sala')).toBeInTheDocument();

  // 2) Y el hilo se abre con su mensaje dentro. Esto es lo que antes NO existía en ningún sitio.
  await user.click(fila);
  const hilo = await screen.findByRole('region', { name: /conversación con gaia/i });
  expect(await within(historial(hilo)).findByText('gaia, tomá el encargo del censo')).toBeInTheDocument();
  expect(within(hilo).getByRole('note')).toHaveTextContent(/registro de agentes y en NINGUNA sala/i);
}, 25_000);

it('con el registro caído, el hilo sigue existiendo porque el propio feed lo sostiene', async () => {
  const user = userEvent.setup();
  servidorConGaia({ enElRegistro: false });
  renderWithApi(<MessagesPage />);

  const fila = await screen.findByRole('button', { name: /conversación con gaia,/i });
  await user.click(fila);
  const hilo = await screen.findByRole('region', { name: /conversación con gaia/i });
  expect(await within(historial(hilo)).findByText('gaia, tomá el encargo del censo')).toBeInTheDocument();
  expect(within(hilo).getByRole('note')).toHaveTextContent(/sólo porque el servidor publicó mensajes suyos/i);
}, 25_000);

/**
 * CONTROL NEGATIVO del universo ampliado. El arreglo consiste en dibujar a más gente, y por eso
 * hay que probar que NO dibuja a cualquiera: un alias que ninguna de las cuatro fuentes menciona
 * tiene que seguir sin existir, y la pantalla tiene que decirlo con todas las fuentes nombradas.
 */
it('un alias que ninguna fuente menciona sigue sin existir, y se dice por qué', async () => {
  servidorConGaia({ enElRegistro: true });
  window.history.pushState({}, '', '/messages/Steven/fantasma');
  renderWithApi(<MessagesPage />);

  expect(await screen.findByText(/ni en el registro de agentes/i)).toBeInTheDocument();
  expect(screen.getByText('Steven:fantasma')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /conversación con fantasma,/i })).not.toBeInTheDocument();
  // Y gaia, que sí está, aparece: la negativa es del alias inexistente, no del arreglo entero.
  expect(await screen.findByRole('button', { name: /conversación con gaia,/i })).toBeInTheDocument();
}, 25_000);

/** El mismo mensaje del hilo de argos, pero con una entrega HERMANA para Steven:jarvis. */
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
      ],
    });
  server.use(http.get('*/v3/console/messages', () => HttpResponse.json({ ...feed, items })));
}

it('el detalle repone room, lane, actor, tenant, trace ENTERO y el fan-out del publish', async () => {
  const user = userEvent.setup();
  feedConFanOut();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });

  const campo = (etiqueta: string) => within(detalle).getByText(etiqueta).closest('div')!;
  expect(within(campo('Room')).getByText('grp.steven')).toBeInTheDocument();
  expect(within(campo('Lane')).getByText('interactive')).toBeInTheDocument();
  expect(within(campo('Actor verificado')).getByText('kant')).toBeInTheDocument();
  expect(within(campo('Tenant de origen')).getByText('Steven')).toBeInTheDocument();
  expect(within(campo('Tenant destino')).getByText('Steven')).toBeInTheDocument();
  // El trace ENTERO, no el compacto: es lo que se pega en /chains/:traceId.
  expect(within(campo('Trace')).getByText('trace-fleet-00042')).toBeInTheDocument();
  expect(within(campo('Message id')).getByText('8eac0520-6e1e-47e8-b7da-554e4bf850b4')).toBeInTheDocument();

  // Y la entrega hermana del fan-out, con su destinatario y su estado.
  const fanout = within(hilo).getByRole('region', { name: /entregas hermanas/i });
  expect(within(fanout).getByText('Steven:jarvis')).toBeInTheDocument();
  expect(within(fanout).getByText('failed')).toBeInTheDocument();
}, 25_000);

/**
 * CONTROL NEGATIVO del fan-out. Reponer las entregas hermanas no puede volver a mezclar los
 * hilos: la hermana se LISTA en el detalle, pero el mensaje sigue apareciendo UNA sola vez en la
 * conversación de argos y el hilo de jarvis es otro.
 */
it('la entrega hermana se lista en el detalle pero NO se convierte en una burbuja del hilo', async () => {
  const user = userEvent.setup();
  feedConFanOut();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
  await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });
  const burbujas = within(historial(hilo)).getAllByText('Verificar estado del adapter Hermes');
  expect(burbujas).toHaveLength(1);
  // El otro mensaje del feed, que va a Miguel:kratos, sigue fuera de este hilo.
  expect(within(hilo).queryByText('Indexar reporte operativo')).not.toBeInTheDocument();
}, 25_000);

it('vuelve a poder publicar en el lane batch, con la prioridad de ese carril', async () => {
  const user = userEvent.setup();
  const enviados = capturarPublish();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
  await user.selectOptions(within(hilo).getByLabelText(/^lane$/i), 'batch');
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'indexá el informe');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  await waitFor(() => expect(enviados).toHaveLength(1));
  expect(enviados[0]).toMatchObject({ lane: 'batch', priority: 0 });
}, 25_000);

/**
 * CONTROL NEGATIVO del selector de lane. Que exista el control no puede cambiar lo que se publica
 * cuando nadie lo toca: sin tocarlo tiene que seguir saliendo `interactive` con prioridad 10, que
 * es lo que publicaba el formulario anterior.
 */
it('sin tocar el selector sigue publicando interactive con prioridad 10', async () => {
  const user = userEvent.setup();
  const enviados = capturarPublish();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirConversacion(user, 'argos');
  await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'revisá la cola');
  await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

  await waitFor(() => expect(enviados).toHaveLength(1));
  expect(enviados[0]).toMatchObject({ lane: 'interactive', priority: 10 });
}, 25_000);

/**
 * EL GANCHO DEL ARREGLO DE PANTALLA ESTRECHA, comprobado en el DOM.
 *
 * La regla que encoge el roster a conmutador vive en `messages.css` y sólo se activa con este
 * atributo. La hoja se comprueba aparte (`composer-anclado.test.ts`); lo que se comprueba acá es
 * lo único que jsdom sí puede ver: que el atributo se pone cuando hay conversación abierta y NO
 * antes —si se pusiera siempre, el roster nacería recortado a dos filas siendo el contenido
 * principal de la pantalla, que es el defecto contrario—.
 */
it('marca la envoltura con data-conversacion sólo cuando hay un hilo abierto', async () => {
  const user = userEvent.setup();
  const { container } = renderWithApi(<MessagesPage />);

  const envoltura = container.querySelector('.messenger-shell');
  await screen.findByRole('button', { name: /conversación con argos,/i });
  expect(envoltura).not.toHaveAttribute('data-conversacion');

  await abrirConversacion(user, 'argos');
  expect(envoltura).toHaveAttribute('data-conversacion', 'abierta');
}, 20_000);
