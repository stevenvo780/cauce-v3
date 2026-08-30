import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { QueueItem } from '../../api/types';
import { mockMessages, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { MessagesPage } from './MessagesPage';

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

async function abrirConversacion(user: ReturnType<typeof userEvent.setup>, alias: string) {
  await user.click(await screen.findByRole('button', { name: new RegExp(`conversación con ${alias},`, 'i') }));
  return screen.findByRole('region', { name: new RegExp(`conversación con ${alias}`, 'i') });
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
    renderWithApi(<MessagesPage />);

    const hilo = await abrirConversacion(user, 'argos');
    const selector = await within(hilo).findByRole('combobox', { name: /room de origen/i });
    expect(within(selector).getAllByRole('option').map((opcion) => opcion.textContent))
      .toEqual(['grp.steven', 'ops.infra']);

    await user.selectOptions(selector, 'ops.infra');
    await user.type(within(hilo).getByRole('textbox', { name: /mensaje para argos/i }), 'desde ops.infra');
    await user.click(within(hilo).getByRole('button', { name: /^enviar$/i }));

    await waitFor(() => { expect(enviados).toHaveLength(1); });
    expect(enviados[0]).toMatchObject({ room_id: 'ops.infra', body: { text: 'desde ops.infra' } });
  }, 25_000);

  it('con una sola sala no hay selector: se dice cuál es y de dónde sale', async () => {
    const user = userEvent.setup();
    renderWithApi(<MessagesPage />);

    const hilo = await abrirConversacion(user, 'argos');
    expect(within(hilo).queryByRole('combobox', { name: /room de origen/i })).toBeNull();
    expect(hilo.querySelector('.messenger-room-fixed')).toHaveTextContent(
      /Room de origen: grp\.steven · derivado de tu topología/,
    );
  }, 25_000);
});

describe('el compositor', () => {
  it('Enter publica y Shift+Enter escribe una línea nueva sin publicar', async () => {
    const enviados = capturarPublish();
    const user = userEvent.setup();
    renderWithApi(<MessagesPage />);

    const hilo = await abrirConversacion(user, 'argos');
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
    renderWithApi(<MessagesPage />);

    const hilo = await abrirConversacion(user, 'argos');
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
    renderWithApi(<MessagesPage />);

    const hilo = await abrirConversacion(user, 'kratos');
    const aviso = within(hilo).getAllByRole('note').find((nota) => /lease de kratos/i.test(nota.textContent));
    expect(aviso).toBeDefined();

    await user.type(within(hilo).getByRole('textbox', { name: /mensaje para kratos/i }), 'seguís ahí?');
    expect(within(hilo).getAllByRole('note').some((nota) => nota.textContent.includes('Cauce encola el mensaje igual')))
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
    renderWithApi(<MessagesPage />);

    const hilo = await abrirConversacion(user, 'argos');
    // `dl` carries no list role: the strip is read by its own class, which the stylesheet also uses.
    const cola = hilo.querySelector('.messenger-queue-strip');
    await waitFor(() => { expect(cola).toHaveTextContent(/Muertas\s*≥ 200/); });
  }, 25_000);

  it('«Sincronizar» vuelve a pedir el feed durable de mensajes', async () => {
    let lecturas = 0;
    server.use(http.get('*/v3/console/messages', () => {
      lecturas += 1;
      return HttpResponse.json(mockMessages());
    }));
    const user = userEvent.setup();
    renderWithApi(<MessagesPage />);

    const hilo = await abrirConversacion(user, 'argos');
    const antes = lecturas;
    await user.click(within(hilo).getByRole('button', { name: /sincronizar/i }));

    await waitFor(() => { expect(lecturas).toBeGreaterThan(antes); });
  }, 25_000);
});

describe('cambiar de conversación y volver a leer', () => {
  it('el mensaje elegido y su detalle sobreviven a una relectura del feed', async () => {
    // The feed re-reads itself every 2.5 s: if the selection lived in the array's index instead of
    // in the `message_id`, the detail would jump to another message on its own while being read.
    const user = userEvent.setup();
    renderWithApi(<MessagesPage />);

    const hilo = await abrirConversacion(user, 'argos');
    const burbujas = hilo.querySelector<HTMLElement>('.terminal-transcript');
    if (!burbujas) throw new Error('el hilo no tiene transcripción');
    await waitFor(() => { expect(within(burbujas).getByText('Verificar estado del adapter Hermes')).toBeInTheDocument(); });
    // What selects is the delivery row of the bubble, which is what the summary names.
    const entrega = burbujas.querySelector<HTMLElement>('.transcript-delivery');
    if (!entrega) throw new Error('la burbuja no trae su entrega');
    await user.click(entrega);
    const detalle = within(hilo).getByRole('group', { name: /detalle del mensaje seleccionado/i });
    expect(detalle).toHaveTextContent(/Mensaje que elegiste/);

    await user.click(within(hilo).getByRole('button', { name: /sincronizar/i }));

    await waitFor(() => {
      expect(within(hilo).getByRole('group', { name: /detalle del mensaje seleccionado/i }))
        .toHaveTextContent(/Mensaje que elegiste/);
    });
  }, 25_000);

  it('el borrador NO viaja de un agente a otro', async () => {
    // The pane is remounted by its `key`: a draft written for argos appearing in socrates' box is
    // the kind of mistake that gets sent before it is noticed.
    const user = userEvent.setup();
    renderWithApi(<MessagesPage />);

    const argos = await abrirConversacion(user, 'argos');
    await user.type(within(argos).getByRole('textbox', { name: /mensaje para argos/i }), 'esto es para argos');

    const socrates = await abrirConversacion(user, 'socrates');
    expect(within(socrates).getByRole('textbox', { name: /mensaje para socrates/i })).toHaveValue('');

    const devuelta = await abrirConversacion(user, 'argos');
    expect(within(devuelta).getByRole('textbox', { name: /mensaje para argos/i })).toHaveValue('');
  }, 25_000);
});

describe('el roster como conmutador', () => {
  it('la búsqueda deja sólo a quien se busca, y decirlo mal no inventa a nadie', async () => {
    const user = userEvent.setup();
    renderWithApi(<MessagesPage />);
    await screen.findByRole('button', { name: /conversación con argos,/i });

    const busqueda = screen.getByRole('textbox', { name: /buscar agente/i });
    await user.type(busqueda, 'argos');

    const lista = screen.getByRole('generic', { name: /lista de agentes/i });
    expect(within(lista).getAllByRole('button')).toHaveLength(1);
    expect(screen.getByText(/1 visibles/)).toBeInTheDocument();

    await user.clear(busqueda);
    await user.type(busqueda, 'nadie-con-este-nombre');
    expect(screen.getByText('Ningún agente coincide con el filtro.')).toBeInTheDocument();
  }, 25_000);

  it('el filtro por cliente deja sólo los alias de ese tenant', async () => {
    const user = userEvent.setup();
    renderWithApi(<MessagesPage />);
    await screen.findByRole('button', { name: /conversación con argos,/i });

    await user.selectOptions(screen.getByRole('combobox', { name: /cliente/i }), 'Jhon');

    const lista = screen.getByRole('generic', { name: /lista de agentes/i });
    const visibles = within(lista).getAllByRole('button');
    expect(visibles).toHaveLength(1);
    expect(visibles[0]).toHaveAccessibleName(/conversación con hegel, Jhon/i);
  }, 25_000);
});
