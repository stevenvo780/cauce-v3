import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { MessagesPage } from './MessagesPage';

beforeEach(() => {
  window.history.pushState({}, '', '/messages');
});

afterEach(() => {
  window.history.pushState({}, '', '/');
});

/** Registra cada publish para poder afirmar QUÉ se envió, no sólo que la UI dijo que envió. */
function capturarPublish() {
  const enviados: Array<Record<string, unknown>> = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    enviados.push(await request.json() as Record<string, unknown>);
    return HttpResponse.json({ message_id: 'msg-nuevo', delivery_ids: ['del-nuevo'], duplicate: false }, { status: 202 });
  }));
  return enviados;
}

async function abrirConversacion(user: ReturnType<typeof userEvent.setup>, alias: string) {
  const fila = await screen.findByRole('button', { name: new RegExp(`conversación con ${alias},`, 'i') });
  await user.click(fila);
  return screen.findByRole('region', { name: new RegExp(`conversación con ${alias}`, 'i') });
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
  expect(await within(hilo).findByText('Verificar estado del adapter Hermes')).toBeInTheDocument();
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
