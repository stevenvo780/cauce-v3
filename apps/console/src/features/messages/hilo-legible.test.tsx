import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mockMessages } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { CARACTERES_DE_PREVISUALIZACION } from '../terminal/cuerpo-del-mensaje';
import { MessagesPage } from './MessagesPage';

/**
 * **LAS TRES COSAS QUE HACÍAN QUE EL HILO NO SE LEYERA COMO UNA CONVERSACIÓN.**
 *
 * Las tres salieron de recorrer la consola de producción el 2026-08-23 con datos reales, y las
 * tres pasaban la suite entera en verde:
 *
 * 1. Al abrir un hilo había DIEZ burbujas con el anillo azul de «seleccionada» sin que nadie
 *    tocara nada, y el panel de detalle se abría solo sobre un mensaje de catorce horas antes.
 *    Causa, leída en el bundle desplegado: `data-selected={m?.delivery_id===i||void 0}` con los
 *    dos `undefined`, y `Z.find(w=>w.delivery?.delivery_id===L)??Z.at(-1)` devolviendo el PRIMER
 *    mensaje sin entrega, con lo que el `?? at(-1)` no se ejecutaba nunca.
 * 2. El hilo abría por el mensaje MÁS VIEJO y no había ningún control para ir al último: cero
 *    coincidencias de `ultimo|reciente|abajo|final|bajar` en todo el DOM.
 * 3. Los mensajes se cortaban a 240 caracteres a mitad de palabra, sin puntos suspensivos y sin
 *    forma de leerlos enteros; el detalle mostraba seis campos de metadatos y ni una línea del
 *    cuerpo.
 *
 * Cada `it` de acá falla con el código anterior. Comprobado por reversión, no por confianza.
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

/** Un cuerpo del largo EXACTO al que el servidor corta, para probar el rótulo del recorte. */
const CUERPO_LARGO = 'a'.repeat(400);
const RECORTADO = CUERPO_LARGO.slice(0, CARACTERES_DE_PREVISUALIZACION);

/**
 * El hilo de argos en el orden y con la forma del defecto: primero una SALIDA del agente (sin
 * entrega para este par, que es lo que engañaba al `find`), después una entrada con entrega, y al
 * final el mensaje más nuevo, también sin entrega. Sin esa forma el defecto no se reproduce: con
 * un hilo donde todo tiene entrega, el código viejo pasaba verde.
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
// 1. LA SELECCIÓN FANTASMA
// ---------------------------------------------------------------------------------------------

it('🔴 sin un solo clic NINGUNA burbuja queda marcada como seleccionada', async () => {
  const user = userEvent.setup();
  feedDeArgos();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  await waitFor(() => expect(burbujas(hilo)).toHaveLength(3));

  // El defecto medido: dos de las tres burbujas —las que no tienen entrega— salían con
  // `data-selected="true"` porque `undefined === undefined`.
  const marcadas = burbujas(hilo).filter((burbuja) => burbuja.getAttribute('data-selected') === 'true');
  expect(marcadas).toHaveLength(0);
}, 25_000);

it('🔴 el detalle abre en el ÚLTIMO mensaje del hilo, no en el primero sin entrega', async () => {
  const user = userEvent.setup();
  feedDeArgos();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });

  // El defecto: abría en `aaaaaaaa…`, la MÁS VIEJA, porque era el primer ítem sin entrega.
  expect(within(detalle).getByText('cccccccc-3333-4333-8333-333333333333')).toBeInTheDocument();
  expect(within(detalle).queryByText('aaaaaaaa-1111-4111-8111-111111111111')).not.toBeInTheDocument();
  // Y se dice que es el último y no una elección del operador, que es la queja textual.
  expect(within(detalle).getByText(/Último mensaje del hilo/i)).toBeInTheDocument();
}, 25_000);

/**
 * El detalle NACE CERRADO, y esto no es sólo cosmética: medido en Chrome a 1280x900 con el panel
 * ya acotado, el detalle desplegado de oficio dejaba 42 px de conversación visible. Arreglar el
 * compositor había creado un defecto del mismo tipo un poco más abajo.
 */
it('🔴 el detalle arranca CERRADO y lo abre el clic del operador', async () => {
  const user = userEvent.setup();
  feedDeArgos();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });
  expect(detalle).not.toHaveAttribute('open');
  // Y aun cerrado dice de qué mensaje habla, para que no haya que abrirlo sólo para saberlo.
  expect(within(detalle).getByText(/Último mensaje del hilo/i)).toBeInTheDocument();

  await user.click(within(burbujas(hilo)[0]).getByRole('button', { name: /ver detalle/i }));
  expect(detalle).toHaveAttribute('open');
}, 25_000);

it('🔴 clicar una burbuja SIN entrega también selecciona: antes no hacía nada', async () => {
  const user = userEvent.setup();
  feedDeArgos();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });

  const vieja = burbujas(hilo)[0];
  expect(within(vieja).getByText(/la mas vieja/)).toBeInTheDocument();
  await user.click(within(vieja).getByRole('button', { name: /ver detalle/i }));

  const detalle = within(hilo).getByRole('group', { name: /detalle del mensaje seleccionado/i });
  expect(within(detalle).getByText('aaaaaaaa-1111-4111-8111-111111111111')).toBeInTheDocument();
  expect(within(detalle).getByText(/Mensaje que elegiste/i)).toBeInTheDocument();
  // Y ahora sí hay exactamente UNA burbuja marcada: la que se clicó.
  const marcadas = burbujas(hilo).filter((burbuja) => burbuja.getAttribute('data-selected') === 'true');
  expect(marcadas).toHaveLength(1);
  expect(marcadas[0]).toBe(vieja);
}, 25_000);

// ---------------------------------------------------------------------------------------------
// 2. EL HILO EMPIEZA POR EL FINAL
// ---------------------------------------------------------------------------------------------

/**
 * jsdom no tiene layout: `scrollHeight` es 0 y el asignador de `scrollTop` no mueve nada, así que
 * una prueba que mirara `scrollTop` no distinguiría «no se llamó» de «se llamó y no pasó nada».
 * Se espía `scrollTo` —que jsdom no implementa y `irAlFinal` prefiere— y se afirma el EFECTO:
 * sobre qué caja, y con qué destino.
 */
function espiarDesplazamiento(alto = 10_976) {
  const llamadas: Array<{ caja: Element; top: number }> = [];
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return alto; } });
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', { configurable: true, get() { return 477; } });
  Object.defineProperty(HTMLElement.prototype, 'scrollTo', {
    configurable: true, writable: true,
    value(this: Element, opciones: { top?: number }) { llamadas.push({ caja: this, top: opciones?.top ?? -1 }); },
  });
  return llamadas;
}

it('🔴 abre la conversación por el FINAL, no por el mensaje más viejo', async () => {
  const llamadas = espiarDesplazamiento();
  const user = userEvent.setup();
  feedDeArgos();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  const caja = hilo.querySelector('.messenger-thread-scroll');
  expect(caja).not.toBeNull();

  await waitFor(() => expect(llamadas.some((llamada) => llamada.caja === caja)).toBe(true));
  // El destino es el fondo del hilo: los 10.976 px que había que arrastrar a mano.
  expect(llamadas.filter((llamada) => llamada.caja === caja).at(-1)?.top).toBe(10_976);
}, 25_000);

it('🔴 ofrece «Ir al último» cuando el operador se fue hacia arriba, y no antes', async () => {
  espiarDesplazamiento();
  const user = userEvent.setup();
  feedDeArgos();
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  const caja = hilo.querySelector<HTMLElement>('.messenger-thread-scroll')!;

  // Pegado al final no hay botón: sería un control que no lleva a ningún sitio.
  expect(within(hilo).queryByRole('button', { name: /ir al último/i })).toBeNull();

  // El operador sube a leer: la caja deja de estar al final.
  act(() => {
    Object.defineProperty(caja, 'scrollTop', { configurable: true, value: 0, writable: true });
    caja.dispatchEvent(new Event('scroll', { bubbles: false }));
  });

  expect(await within(hilo).findByRole('button', { name: /ir al último/i })).toBeInTheDocument();
}, 25_000);

// ---------------------------------------------------------------------------------------------
// 3. EL CUERPO RECORTADO A 240
// ---------------------------------------------------------------------------------------------

it('🔴 la burbuja recortada lo DICE en vez de parecer un mensaje entero', async () => {
  const user = userEvent.setup();
  feedDeArgos({ recorte: true });
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  const recortada = await waitFor(() => {
    const encontrada = burbujas(hilo).find((burbuja) => burbuja.textContent?.includes(RECORTADO));
    if (!encontrada) throw new Error('todavía no está la burbuja');
    return encontrada;
  });

  expect(recortada).toHaveTextContent(new RegExp(`sólo los primeros ${CARACTERES_DE_PREVISUALIZACION} caracteres`, 'i'));
  // Y el corte se ve en el propio texto: antes terminaba en seco, a mitad de palabra.
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
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });
  await user.click(await within(detalle).findByRole('button', { name: /ver el mensaje completo/i }));

  await waitFor(() => expect(pedido).toBe('cccccccc-3333-4333-8333-333333333333'));
  const cuerpo = within(detalle).getByLabelText('Cuerpo del mensaje');
  await waitFor(() => expect(cuerpo.querySelector('pre')?.textContent).toBe(CUERPO_LARGO));
}, 25_000);

/**
 * CONTROL NEGATIVO del arreglo anterior. La ruta es nueva y el gateway de producción todavía no la
 * publica: si el botón se comiera el 404 en silencio, el operador volvería a quedarse sin saber
 * que hay más texto — el mismo defecto, con un botón encima. Se exige que lo diga y que NO acuse
 * al mensaje de no existir, porque no es eso lo que pasó.
 */
it('🔴 si el gateway no publica la ruta todavía, lo dice con esas palabras', async () => {
  server.use(http.get('*/v3/console/messages/:messageId', () => HttpResponse.json(
    { error: 'not_found', message: 'not found' }, { status: 404 },
  )));
  const user = userEvent.setup();
  feedDeArgos({ recorte: true });
  renderWithApi(<MessagesPage />);

  const hilo = await abrirArgos(user);
  const detalle = await within(hilo).findByRole('group', { name: /detalle del mensaje seleccionado/i });
  await user.click(await within(detalle).findByRole('button', { name: /ver el mensaje completo/i }));

  const aviso = await within(detalle).findByRole('alert');
  expect(aviso).toHaveTextContent(/no publica todavía GET \/v3\/console\/messages/i);
  expect(aviso).not.toHaveTextContent(/no existe/i);
}, 25_000);
