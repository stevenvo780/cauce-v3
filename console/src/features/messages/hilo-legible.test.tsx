import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockMessages } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderRouted } from '../../test/render';
import { CARACTERES_DE_PREVISUALIZACION } from '../terminal/cuerpo-del-mensaje';
import { MessagesPage } from './MessagesPage';

/**
 * **THE THREE THINGS THAT MADE THE THREAD NOT READ LIKE A CONVERSATION.**
 *
 * The three came from walking through the production console with real data, and all three
 * passed the whole suite green:
 *
 * 1. Opening a thread showed TEN bubbles with the blue "selected" ring without anyone touching
 *    anything, and the detail panel opened itself on a message from fourteen hours ago. Cause,
 *    read in the deployed bundle: `data-selected={m?.delivery_id===i||void 0}` with both
 *    undefined, and `Z.find(w=>w.delivery?.delivery_id===L)??Z.at(-1)` returning the FIRST
 *    message without delivery, so the `?? at(-1)` never ran.
 * 2. The thread opened on the OLDEST message and there was no control to go to the latest:
 *    zero matches of `ultimo|reciente|abajo|final|bajar` anywhere in the DOM.
 * 3. Messages were truncated to 240 characters mid-word, without ellipsis and with no way to read
 *    them whole; the detail showed six metadata fields and not a single line of the body.
 *
 * Each `it` here fails with the previous code. Verified by reversion, not by trust.
 */

beforeEach(() => {
  window.history.pushState({}, '', '/messages');
});

afterEach(() => {
  window.history.pushState({}, '', '/');
  vi.restoreAllMocks();
});

function iso(desplazamiento: number): string {
  return new Date(Date.now() + desplazamiento).toISOString();
}

/** A body EXACTLY as long as the server's cut, to test the truncation label. */
const CUERPO_LARGO = 'a'.repeat(400);
const RECORTADO = CUERPO_LARGO.slice(0, CARACTERES_DE_PREVISUALIZACION);

/**
 * Argus' thread in the order and shape of the bug: first an OUTGOING from the agent (no
 * delivery for this pair, which fooled `find`), then one incoming with delivery, and finally
 * the newest message, also without delivery. Without that shape the bug does not reproduce:
 * with a thread where everything has delivery, the old code passed green.
 */
function feedDeArgos({ recorte = false }: { recorte?: boolean } = {}) {
  const items = [
    {
      message_id: 'aaaaaaaa-1111-4111-8111-111111111111', request_id: 'aaaaaaaa-1111-4111-8111-999999999999',
      trace_id: 'trace-salida-vieja', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'argos',
      body_preview: 'la mas vieja: arranco el censo', lane: 'batch' as const, created_at: iso(-900_000),
      deliveries: [],
    },
    {
      message_id: 'bbbbbbbb-2222-4222-8222-222222222222', request_id: 'bbbbbbbb-2222-4222-8222-999999999999',
      trace_id: 'trace-entrada', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'kant',
      body_preview: 'del medio: revisá la cola', lane: 'interactive' as const, created_at: iso(-600_000),
      deliveries: [{
        delivery_id: 'dddddddd-2222-4222-8222-222222222222',
        recipient_tenant: 'Steven', recipient_alias: 'argos', status: 'done' as const, attempt: 1,
        timeline: [{ status: 'published' as const, at: iso(-600_000), attempt: 1 }],
      }],
    },
    {
      message_id: 'cccccccc-3333-4333-8333-333333333333', request_id: 'cccccccc-3333-4333-8333-999999999999',
      trace_id: 'trace-salida-nueva', tenant_id: 'Steven', room_id: 'grp.steven', actor_alias: 'argos',
      body_preview: recorte ? RECORTADO : 'la mas nueva: censo terminado', lane: 'batch' as const, created_at: iso(-30_000),
      deliveries: [],
    },
  ];
  server.use(http.get('*/v3/console/messages', () => HttpResponse.json({ ...mockMessages(), items })));
}

async function abrirArgos(user: ReturnType<typeof userEvent.setup>) {
  const fila = await screen.findByRole('button', { name: /conversación con argos,/i });
  await user.click(fila);
  return screen.findByRole('region', { name: /conversación con argos/i });
}

function burbujas(hilo: HTMLElement): HTMLElement[] {
  return [...hilo.querySelectorAll<HTMLElement>('.transcript-entry')];
}

// ---------------------------------------------------------------------------------------------
// 1. THE GHOST SELECTION
// ---------------------------------------------------------------------------------------------

it('🔴 sin un solo clic NINGUNA burbuja queda marcada como seleccionada', async () => {
  const user = userEvent.setup();
  feedDeArgos();
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  await waitFor(() => { expect(burbujas(hilo)).toHaveLength(3); });

  // The measured bug: two of the three bubbles — those without delivery — came out with
  // `data-selected="true"` because `undefined === undefined`.
  const marcadas = burbujas(hilo).filter((burbuja) => burbuja.getAttribute('data-selected') === 'true');
  expect(marcadas).toHaveLength(0);
}, 25_000);

it('🔴 el detalle abre en el ÚLTIMO mensaje del hilo, no en el primero sin entrega', async () => {
  const user = userEvent.setup();
  feedDeArgos();
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });

  // The bug: it opened on `aaaaaaaa…`, the OLDEST, because that was the first item without delivery.
  expect(within(detalle).getByText('cccccccc-3333-4333-8333-333333333333')).toBeInTheDocument();
  expect(within(detalle).queryByText('aaaaaaaa-1111-4111-8111-111111111111')).not.toBeInTheDocument();
  // And it is said to be the last and not the operator's choice, which is the textual complaint.
  expect(within(detalle).getByText(/Último mensaje del hilo/i)).toBeInTheDocument();
}, 25_000);

/**
 * The detail IS BORN CLOSED, and this is not just cosmetic: measured in Chrome at 1280x900
 * with the panel already bounded, the detail deployed on its own left 42 px of visible
 * conversation. Fixing the composer had created a bug of the same kind a bit further down.
 */
it('🔴 el detalle arranca CERRADO y lo abre el clic del operador', async () => {
  const user = userEvent.setup();
  feedDeArgos();
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });
  expect(detalle).not.toHaveAttribute('open');
  // And even closed it says which message it is about, so there is no need to open it just to know.
  expect(within(detalle).getByText(/Último mensaje del hilo/i)).toBeInTheDocument();

  await user.click(within(burbujas(hilo)[0]).getByRole('button', { name: /ver detalle/i }));
  expect(detalle).toHaveAttribute('open');
}, 25_000);

it('🔴 clicar una burbuja SIN entrega también selecciona: antes no hacía nada', async () => {
  const user = userEvent.setup();
  feedDeArgos();
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });

  const vieja = burbujas(hilo)[0];
  expect(within(vieja).getByText(/la mas vieja/)).toBeInTheDocument();
  await user.click(within(vieja).getByRole('button', { name: /ver detalle/i }));

  const detalle = within(hilo).getByRole('group', { name: /detalle del mensaje seleccionado/i });
  expect(within(detalle).getByText('aaaaaaaa-1111-4111-8111-111111111111')).toBeInTheDocument();
  expect(within(detalle).getByText(/Mensaje que elegiste/i)).toBeInTheDocument();
  // And now there is exactly ONE marked bubble: the one clicked.
  const marcadas = burbujas(hilo).filter((burbuja) => burbuja.getAttribute('data-selected') === 'true');
  expect(marcadas).toHaveLength(1);
  expect(marcadas[0]).toBe(vieja);
}, 25_000);

// ---------------------------------------------------------------------------------------------
// 2. THE THREAD STARTS AT THE END
// ---------------------------------------------------------------------------------------------

/**
 * jsdom has no layout: `scrollHeight` is 0 and the `scrollTop` setter moves nothing, so a test
 * that looked at `scrollTop` would not distinguish "was not called" from "was called and did
 * nothing". `scrollTo` is spied — jsdom does not implement it and `irAlFinal` prefers it — and
 * the EFFECT is asserted: on which box, and with what destination.
 */
function espiarDesplazamiento(alto = 10_976) {
  const llamadas: { caja: Element; top: number }[] = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return alto; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 477; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true, writable: true,
    value(this: Element, opciones: { top?: number }) { llamadas.push({ caja: this, top: opciones.top ?? -1 }); },
  });
  return llamadas;
}

it('🔴 abre la conversación por el FINAL, no por el mensaje más viejo', async () => {
  const llamadas = espiarDesplazamiento();
  const user = userEvent.setup();
  feedDeArgos();
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  const caja = hilo.querySelector('.messenger-thread-scroll');
  expect(caja).not.toBeNull();

  await waitFor(() => { expect(llamadas.some((llamada) => llamada.caja === caja)).toBe(true); });
  // The destination is the bottom of the thread: the 10,976 px that had to be dragged by hand.
  expect(llamadas.filter((llamada) => llamada.caja === caja).at(-1)?.top).toBe(10_976);
}, 25_000);

it('🔴 ofrece «Ir al último» cuando el operador se fue hacia arriba, y no antes', async () => {
  espiarDesplazamiento();
  const user = userEvent.setup();
  feedDeArgos();
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  const caja = hilo.querySelector<HTMLElement>('.messenger-thread-scroll');
  if (!caja) throw new Error('Missing .messenger-thread-scroll');

  // At the bottom there is no button: it would be a control that leads nowhere.
  expect(within(hilo).queryByRole('button', { name: /ir al último/i })).toBeNull();

  // The operator scrolls up to read: the box is no longer at the end.
  act(() => {
    Object.defineProperty(caja, 'scrollTop', { configurable: true, value: 0, writable: true });
    caja.dispatchEvent(new Event('scroll', { bubbles: false }));
  });

  expect(await within(hilo).findByRole('button', { name: /ir al último/i })).toBeInTheDocument();
}, 25_000);

// ---------------------------------------------------------------------------------------------
// 3. THE BODY TRUNCATED TO 240
// ---------------------------------------------------------------------------------------------

it('🔴 la burbuja recortada lo DICE en vez de parecer un mensaje entero', async () => {
  const user = userEvent.setup();
  feedDeArgos({ recorte: true });
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  const recortada = await waitFor(() => {
    const encontrada = burbujas(hilo).find((burbuja) => burbuja.textContent.includes(RECORTADO));
    if (!encontrada) throw new Error('todavía no está la burbuja');
    return encontrada;
  });

  expect(recortada).toHaveTextContent(new RegExp(`sólo los primeros ${String(CARACTERES_DE_PREVISUALIZACION)} caracteres`, 'i'));
  // And the cut is visible in the text itself: before it ended abruptly, mid-word.
  expect(recortada.querySelector('p')?.textContent).toBe(`${RECORTADO}…`);
}, 25_000);

it('🔴 «Ver el mensaje completo» pide el cuerpo al servidor y lo pinta entero', async () => {
  let pedido = '';
  server.use(http.get('*/v3/console/messages/:messageId', ({ params }) => {
    pedido = String(params.messageId);
    return HttpResponse.json({ message_id: pedido, body: { text: CUERPO_LARGO } });
  }));
  const user = userEvent.setup();
  feedDeArgos({ recorte: true });
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });
  await user.click(await within(detalle).findByRole('button', { name: /ver el mensaje completo/i }));

  await waitFor(() => { expect(pedido).toBe('cccccccc-3333-4333-8333-333333333333'); });
  const cuerpo = within(detalle).getByLabelText('Cuerpo del mensaje');
  await waitFor(() => { expect(cuerpo.querySelector('pre')?.textContent).toBe(CUERPO_LARGO); });
}, 25_000);

/**
 * NEGATIVE CONTROL of the previous fix. The route is new and the production gateway does not
 * yet publish it: if the button swallowed the 404 silently, the operator would again be left
 * without knowing there is more text — the same bug, with a button on top. It must say so
 * and must NOT accuse the message of not existing, because that is not what happened.
 */
it('🔴 si el gateway no publica la ruta todavía, lo dice con esas palabras', async () => {
  server.use(http.get('*/v3/console/messages/:messageId', () => HttpResponse.json(
    { error: 'not_found', message: 'not found' }, { status: 404 },
  )));
  const user = userEvent.setup();
  feedDeArgos({ recorte: true });
  renderRouted(MessagesPage);

  const hilo = await abrirArgos(user);
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });
  await user.click(await within(detalle).findByRole('button', { name: /ver el mensaje completo/i }));

  const aviso = await within(detalle).findByRole('alert');
  expect(aviso).toHaveTextContent(/no publica todavía GET \/v3\/console\/messages/i);
  expect(aviso).not.toHaveTextContent(/no existe/i);
}, 25_000);
