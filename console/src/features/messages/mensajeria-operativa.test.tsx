import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueueItem } from '../../api/types';
import { mockMessages, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import { openConversation, openConversationInfo, openConversationMenu, renderChat, thread } from './chat-test-utils';

/**
 * The paths of the messenger that the publish tests do not walk: choosing the source room when
 * there is more than one, the keyboard, the queue strip of the open conversation, and the roster
 * as a switch (search and client filter) rather than as a list.
 */

beforeEach(() => { window.history.pushState({}, '', '/messages'); });
afterEach(() => { window.history.pushState({}, '', '/'); });

/** Records every publish so the assertion is about WHAT was sent, not about what the UI said. */
function capturarPublish() {
  const enviados: Record<string, unknown>[] = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    enviados.push(input);
    return HttpResponse.json({
      message_id: '10000000-0000-4000-8000-000000000001',
      delivery_ids: ['20000000-0000-4000-8000-000000000001'],
      duplicate: false,
      request_id: '30000000-0000-4000-8000-000000000001',
      trace_id: 'trace-console-test',
      idempotency_key: input.idempotency_key,
      tenant_id: 'Steven',
      actor_alias: 'kant',
      request_hash: 'a'.repeat(64),
      causal_hash: 'b'.repeat(64),
    }, { status: 202 });
  }));
  return enviados;
}

describe('el room de origen cuando hay más de uno', () => {
  /** Same topology, with the operator (`kant`) also a member of `ops.infra` alongside `argos`. */
  function dosSalasCompartidas() {
    server.use(http.get('*/v3/console/topology', () => HttpResponse.json({
      ...topology,
      tenants: (topology.tenants ?? []).map((tenant) => tenant.id !== 'Steven' ? tenant : {
        ...tenant,
        rooms: (tenant.rooms ?? []).map((room) => room.id !== 'ops.infra' ? room : {
          ...room, members: [...(room.members ?? []), { alias: 'kant', enabled: true }],
        }),
      }),
    })));
  }

  it('ofrece elegir la sala y publica en la que el operador eligió', async () => {
    dosSalasCompartidas();
    const enviados = capturarPublish();
    const user = userEvent.setup();
    renderChat();

    const hilo = await openConversation('argos');
    const selector = await within(hilo).findByRole('combobox', { name: /room de origen/i });
    expect(within(selector).getAllByRole('option').map((opcion) => opcion.textContent))
      .toEqual(['Elegí la sala de origen', 'grp.steven', 'ops.infra']);
    expect(selector).toHaveValue('');
    expect(within(hilo).getByRole('button', { name: 'Enviar' })).toBeDisabled();

    await user.selectOptions(selector, 'ops.infra');
    await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'desde ops.infra');
    await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

    await waitFor(() => { expect(enviados).toHaveLength(1); });
    expect(enviados[0]).toMatchObject({ room_id: 'ops.infra', body: { text: 'desde ops.infra' } });
  }, 25_000);

  it('con una sola sala no hay selector: se dice cuál es y de dónde sale', async () => {
    const user = userEvent.setup();
    renderChat();

    const hilo = await openConversation('argos');
    expect(within(hilo).queryByRole('combobox', { name: /room de origen/i })).toBeNull();
    expect((await openConversationInfo(user)).querySelector('[data-room-origin]')).toHaveTextContent(
      /Room de origen: grp\.steven · derivado de tu topología/,
    );
  }, 25_000);
});

describe('el compositor', () => {
  it('Enter publica y Shift+Enter escribe una línea nueva sin publicar', async () => {
    const enviados = capturarPublish();
    const user = userEvent.setup();
    renderChat();

    const hilo = await openConversation('argos');
    const caja = within(hilo).getByRole('textbox', { name: /mensaje para argos/i });

    await user.type(caja, 'primera línea{Shift>}{Enter}{/Shift}segunda línea');
    expect(caja).toHaveValue('primera línea\nsegunda línea');
    expect(enviados).toHaveLength(0);

    await user.type(caja, '{Enter}');
    await waitFor(() => { expect(enviados).toHaveLength(1); });
    expect(enviados[0]).toMatchObject({ body: { text: 'primera línea\nsegunda línea' } });
    // What was published is cleared: leaving the draft there is what makes someone send it twice.
    await waitFor(() => { expect(caja).toHaveValue(''); });
  }, 25_000);

  it('un borrador de puros espacios no sale a la red', async () => {
    const enviados = capturarPublish();
    const user = userEvent.setup();
    renderChat();

    const hilo = await openConversation('argos');
    const enviar = within(hilo).getByRole('button', { name: /^enviar$/i });
    expect(enviar).toBeDisabled();

    await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), '   ');
    expect(enviar).toBeDisabled();
    await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), '{Enter}');
    expect(enviados).toHaveLength(0);
  }, 25_000);

  it('el aviso de lease vencido sigue leyéndose mientras se escribe', async () => {
    // It used to live in the `placeholder`, so it erased itself at the first keystroke — exactly
    // when it starts to matter. `kratos` is the fixture agent whose lease is already expired.
    const user = userEvent.setup();
    renderChat();

    const hilo = await openConversation('kratos');
    expect(await within(hilo).findByText('Lease vencido · envío en cola')).toBeVisible();

    await user.type(within(hilo).getByRole('textbox', { name: /mensaje para kratos/i }), 'seguís ahí?');
    expect(within(hilo).getAllByRole('note').some((nota) => nota.textContent.includes('envío en cola')))
      .toBe(true);
  }, 25_000);
});

describe('la cola al lado de la conversación', () => {
  it('marca con «≥» las muertas cuando el snapshot de colas llegó a su techo', async () => {
    // 200 rows is the server's ceiling: from there on every derived count is a floor, and saying
    // it as an exact number is what turns a truncated read into a wrong decision.
    const filas: QueueItem[] = Array.from({ length: 200 }, (_valor, indice) => ({
      delivery_id: `dead-${String(indice)}`, message_id: `msg-${String(indice)}`,
      tenant_id: 'Steven', recipient_alias: 'argos', lane: 'interactive', state: 'dead',
      attempts: 5, max_attempts: 5, last_error: 'max attempts exhausted',
    }));
    server.use(http.get('*/v3/console/queues', () => HttpResponse.json({
      observed_at: '2026-08-28T16:00:00.000Z', pending: 0, retrying: 0, dead: 200,
      totals: { pending: 0, retrying: 0, dead: 4_312 }, muestra_recortada: true, items: filas,
    })));
    const user = userEvent.setup();
    renderChat();

    const hilo = await openConversation('argos');
    expect(hilo).toBeInTheDocument();
    const cola = (await openConversationInfo(user)).querySelector('[data-queue-strip]');
    await waitFor(() => { expect(cola).toHaveTextContent(/Muertas\s*≥ 200/); });
  }, 25_000);

  it('«Sincronizar» vuelve a pedir el feed durable de mensajes', async () => {
    let lecturas = 0;
    server.use(http.get('*/v3/console/messages', () => {
      lecturas += 1;
      return HttpResponse.json(mockMessages());
    }));
    const user = userEvent.setup();
    renderChat();

    const hilo = await openConversation('argos');
    const antes = lecturas;
    expect(hilo).toBeInTheDocument();
    await openConversationMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /sincronizar/i }));

    await waitFor(() => { expect(lecturas).toBeGreaterThan(antes); });
  }, 25_000);
});

describe('cambiar de conversación y volver a leer', () => {
  it('el mensaje elegido y su detalle sobreviven a una relectura del feed', async () => {
    // The feed re-reads itself every 2.5 s: if the selection lived in the array's index instead of
    // in the `message_id`, the detail would jump to another message on its own while being read.
    const user = userEvent.setup();
    renderChat();

    const hilo = await openConversation('argos');
    const burbujas = thread(hilo);
    await waitFor(() => { expect(within(burbujas).getByText('Verificar estado del adapter Hermes')).toBeInTheDocument(); });
    await user.click(within(burbujas).getByRole('button', { name: 'Opciones del mensaje' }));
    await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
    const detalle = within(hilo).getByRole('group', { name: /detalle del mensaje seleccionado/i });
    expect(detalle).toHaveTextContent(/Mensaje que elegiste/);

    await openConversationMenu(user);
    await user.click(screen.getByRole('menuitem', { name: /sincronizar/i }));

    await waitFor(() => {
      expect(within(hilo).getByRole('group', { name: /detalle del mensaje seleccionado/i }))
        .toHaveTextContent(/Mensaje que elegiste/);
    });
  }, 25_000);

  it('el borrador NO viaja de un agente a otro', async () => {
    // The pane is remounted by its `key`: a draft written for argos appearing in socrates' box is
    // the kind of mistake that gets sent before it is noticed.
    const user = userEvent.setup();
    renderChat();

    const argos = await openConversation('argos');
    await user.type(within(argos).getByRole('textbox', { name: /mensaje para argos/i }), 'esto es para argos');

    const socrates = await openConversation('socrates');
    expect(within(socrates).getByRole('textbox', { name: /mensaje para socrates/i })).toHaveValue('');

    const devuelta = await openConversation('argos');
    expect(within(devuelta).getByRole('textbox', { name: /mensaje para argos/i })).toHaveValue('');
  }, 25_000);
});
