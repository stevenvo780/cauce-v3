import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiError, CauceApi } from '../../api/client';
import { ConversationDrafts, ConversationDraftStore } from './conversation-drafts';
import { ApiProvider } from '../../api/context';
import type { ComponentProps } from 'react';
import { mockMessages, mockStatus, topology } from '../../mocks/data';
import { server } from '../../mocks/server';
import { declaredPtyTargets } from '../../test/pty-targets';
import { renderWithApi, testApi } from '../../test/render';
import { renderChat } from './chat-test-utils';
import { ConversationPane } from './ConversationPane';
import { construirRosterDeMensajeria } from './roster';

beforeEach(() => { window.history.replaceState({}, '', '/messages'); });

function props(): ComponentProps<typeof ConversationPane> {
  const agent = construirRosterDeMensajeria({ status: mockStatus(), topology }).find((item) => item.alias === 'argos');
  if (!agent) throw new Error('Missing agent fixture');
  return {
    agent, page: mockMessages(), loading: false, canPublish: true, publisherSubject: 'test-operator',
    route: { allowed: true, membership: true, sourceRoomIds: ['grp.steven'], reason: 'Verified' },
    salud: { pendientes: 0, enCurso: 0, reintentos: 0, muertas: 0, muertasTruncadas: false },
    onReload: vi.fn(), onQueueReload: vi.fn(),
  };
}

it('la bienvenida no repite el selector de agentes de la barra lateral', async () => {
  renderChat();
  const welcome = await screen.findByRole('region', { name: 'Sin conversación abierta' });
  expect(within(welcome).queryAllByRole('button')).toHaveLength(0);
  expect(screen.queryByLabelText('Empezar una conversación')).toBeNull();
});

it('el menú de la conversación lleva a perfil y terminal y devuelve el foco con Escape', async () => {
  const user = userEvent.setup();
  server.use(declaredPtyTargets(['Steven', 'argos']));
  renderWithApi(<ConversationPane {...props()} />);
  const more = screen.getByRole('button', { name: 'Opciones de la conversación' });
  expect(screen.queryByRole('menuitem', { name: 'Perfil y contexto' })).toBeNull();
  await user.click(more);
  const menu = await screen.findByRole('menu');
  expect(within(menu).getByRole('menuitem', { name: 'Perfil y contexto' })).toHaveAttribute('href', '/messages/Steven/argos?view=context');
  expect(within(menu).getByRole('menuitem', { name: 'Abrir terminal' })).toHaveAttribute('href', '/terminal/Steven/argos?modo=terminal');
  expect(within(menu).getByRole('menuitemradio', { name: /Interactivo/ })).toHaveAttribute('aria-checked', 'true');
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
  expect(more).toHaveFocus();
});

it('reintentos, muertas y fallos de lectura permanecen visibles sin roster ni Más', async () => {
  const user = userEvent.setup();
  const input = props();
  renderWithApi(<ConversationPane {...input}
    salud={{ pendientes: undefined, enCurso: 0, reintentos: 2, muertas: 3, muertasTruncadas: true }}
    queueError={new Error('cola inaccesible')} />);
  expect(screen.getByText(/2 reintento\(s\).*≥ 3 muerta\(s\)/)).toBeVisible();
  expect(screen.getByRole('alert')).toHaveTextContent('Cola sin verificar');
  await user.click(screen.getByRole('button', { name: /Cola sin verificar/ }));
  expect(screen.getByRole('link', { name: 'Revisar en Colas' })).toHaveAttribute('href', '/queues');
  expect(screen.getByText(/No se pudo actualizar la cola: cola inaccesible/)).toBeVisible();
  await user.click(screen.getByRole('button', { name: 'Reintentar cola' }));
  expect(input.onQueueReload).toHaveBeenCalledOnce();
  expect(screen.queryByRole('region', { name: 'Más opciones de conversación' })).toBeNull();
});

it('una sala elegida que desaparece no se sustituye ni permite publicar el borrador', async () => {
  const user = userEvent.setup();
  const input = props();
  const route = { ...input.route, sourceRoomIds: ['grp.steven', 'ops.infra'] };
  const { rerender } = renderWithApi(<ConversationPane {...input} route={route} />);
  const select = screen.getByRole('combobox', { name: 'Room de origen' });
  expect(select).toHaveValue('');
  await user.selectOptions(select, 'ops.infra');
  await user.type(screen.getByRole('textbox'), 'Solo para la sala elegida');
  rerender(<ApiProvider api={testApi}><ConversationPane {...input} /></ApiProvider>);
  expect(screen.getByRole('option', { name: 'ops.infra · no disponible' })).toBeDisabled();
  expect(screen.getByRole('combobox', { name: 'Room de origen' })).toHaveValue('ops.infra');
  expect(screen.getByRole('alert')).toHaveTextContent('ya no está disponible');
  expect(screen.getByRole('textbox')).toHaveValue('Solo para la sala elegida');
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  await user.selectOptions(screen.getByRole('combobox', { name: 'Room de origen' }), 'grp.steven');
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
});

it('el inspector devuelve el foco al mensaje y usa Más si el mensaje salió de la ventana', async () => {
  const user = userEvent.setup();
  const input = props();
  const { rerender } = renderWithApi(<ConversationPane {...input} />);
  const trigger = screen.getByRole('button', { name: 'Opciones del mensaje' });
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  expect(screen.getByRole('heading', { name: 'Mensaje que elegiste' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  rerender(<ApiProvider api={testApi}><ConversationPane {...input} page={{ ...input.page, items: [] }} /></ApiProvider>);
  expect(trigger.isConnected).toBe(false);
  expect(screen.getByRole('note')).toHaveTextContent('Mensaje fuera de la ventana actual');
  await user.click(screen.getByRole('button', { name: 'Cerrar detalle' }));
  expect(screen.getByRole('button', { name: 'Opciones de la conversación' })).toHaveFocus();
});

it.each([
  { status: 'done', label: 'HECHA' },
  { status: 'failed', label: 'FALLÓ' },
] as const)('el inspector conserva el resultado $status recibido después de elegir y antes de salir de la ventana', async ({ status, label }) => {
  const user = userEvent.setup();
  const input = props();
  const message = input.page?.items?.find((item) => item.deliveries?.some((delivery) => delivery.recipient_alias === 'argos'));
  const delivery = message?.deliveries?.find((item) => item.recipient_alias === 'argos');
  if (!message || !delivery) throw new Error('Missing message fixture');
  const inProgress = {
    ...delivery, status: 'started' as const,
    timeline: delivery.timeline?.filter((event) => event.status !== 'done' && event.status !== 'failed'),
  };
  const initial = { ...message, deliveries: [inProgress] };
  const terminalAt = '2026-10-02T20:15:00.000Z';
  const updated = { ...message, deliveries: [{
    ...inProgress, status, attempt: 3,
    timeline: [...(inProgress.timeline ?? []), { status, at: terminalAt, attempt: 3 }],
  }] };
  const { rerender } = renderWithApi(<ConversationPane {...input} page={{ items: [initial] }} />);
  await user.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  const detail = screen.getByRole('group', { name: 'Detalle del mensaje seleccionado' });
  expect(within(detail).getByText('HECHA / FALLÓ · UNKNOWN')).toBeVisible();
  const composer = screen.getByRole('textbox');
  await user.click(composer);

  rerender(<ApiProvider api={testApi}><ConversationPane {...input} page={{ items: [updated] }} /></ApiProvider>);
  expect(within(detail).getByText(label)).toBeVisible();
  expect(within(detail).getByText('Intento 3')).toBeVisible();
  expect(composer).toHaveFocus();

  rerender(<ApiProvider api={testApi}><ConversationPane {...input} page={{ items: [] }} /></ApiProvider>);
  expect(within(detail).getByRole('note')).toHaveTextContent('último detalle recibido');
  const terminal = within(detail).getByText(label).closest('li');
  expect(terminal?.querySelector('time')).toHaveAttribute('datetime', terminalAt);
  expect(within(detail).getByText('Intento 3')).toBeVisible();
  expect(within(detail).queryByText('HECHA / FALLÓ · UNKNOWN')).toBeNull();
  expect(composer).toHaveFocus();
});

it('no promete detalles para un mensaje sin identificador', async () => {
  const input = props();
  const items = input.page?.items?.map((item) => ({ ...item, message_id: undefined }));
  await act(async () => { renderWithApi(<ConversationPane {...input} page={{ ...input.page, items }} />); });
  expect(screen.getByRole('button', { name: 'Opciones del mensaje' })).toBeDisabled();
});

it('la respuesta tardía de un cuerpo no reemplaza el mensaje que se está leyendo', async () => {
  const user = userEvent.setup();
  const input = props();
  const first = input.page?.items?.find((item) => item.deliveries?.some((delivery) => delivery.recipient_alias === 'argos'));
  if (!first) throw new Error('Missing message fixture');
  const second = { ...first, message_id: '22222222-2222-4222-8222-222222222222', body_preview: 'Segundo mensaje' };
  let resolveBody: (value: Awaited<ReturnType<typeof testApi.getMessage>>) => void = () => undefined;
  vi.spyOn(testApi, 'getMessage').mockImplementation(() => new Promise((resolve) => { resolveBody = resolve; }));
  renderWithApi(<ConversationPane {...input} page={{ items: [{ ...first, body_preview: 'a'.repeat(240) }, second] }} />);
  const triggers = screen.getAllByRole('button', { name: 'Opciones del mensaje' });
  await user.click(triggers[0]);
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  await user.click(screen.getByRole('button', { name: 'Ver el mensaje completo' }));
  await user.click(triggers[1]);
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  await act(async () => { resolveBody({ message_id: first.message_id, body: { text: 'Cuerpo tardío del primero' } }); });
  const detail = screen.getByRole('group', { name: 'Detalle del mensaje seleccionado' });
  await waitFor(() => { expect(within(detail).getByText('Segundo mensaje')).toBeVisible(); });
  expect(within(detail).queryByText('Cuerpo tardío del primero')).toBeNull();
});

it('lee y presenta la respuesta canónica solo bajo la raíz propia y el delivery destinatario exacto', async () => {
  const input = props();
  const source = input.page?.items?.find((item) => item.deliveries?.some((delivery) => delivery.recipient_alias === 'argos'));
  if (!source) throw new Error('Missing message fixture');
  const delivery = source.deliveries?.find((item) => item.recipient_alias === 'argos');
  if (!delivery?.delivery_id || !source.message_id) throw new Error('Missing root delivery fixture');
  const root = {
    ...source,
    author: { kind: 'human' as const, subject_id: 'test-operator', display_name: 'Operador' },
    deliveries: [{ ...delivery, status: 'done' as const }],
  };
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: root.message_id,
    chain_open: false,
    deliveries: [{
      delivery_id: delivery.delivery_id, tenant_id: delivery.recipient_tenant ?? '',
      alias: delivery.recipient_alias ?? '', status: 'done', reply: '<script>alert("x")</script> resultado',
    }],
  });
  renderWithApi(<ConversationPane {...input} page={{ items: [root] }} />);
  const reply = await screen.findByLabelText(/^Respuesta canónica de /);
  expect(reply).not.toHaveTextContent(/provisional|consolidada|Sin respuesta/);
  expect(reply).toHaveTextContent('<script>alert("x")</script> resultado');
  expect(reply.querySelector('script')).toBeNull();
  expect(reply).toHaveAttribute('data-delivery-id', delivery.delivery_id);
  expect(getMessage).toHaveBeenCalledWith(root.message_id);
});

it('actualiza el recibo sin estado con el terminal del feed y relee una vez en gateway legado', async () => {
  const user = userEvent.setup();
  const input = { ...props(), publisherSubject: 'Steven:operator', publisherHumanSubject: `human:${'a'.repeat(64)}` };
  const agent = input.agent;
  const messageId = '10000000-0000-4000-8000-000000000001';
  const deliveryId = '20000000-0000-4000-8000-000000000002';
  const requestId = '30000000-0000-4000-8000-000000000003';
  const idempotencyKey = 'intent-canonical-reply';
  const hash = 'a'.repeat(64);
  vi.spyOn(testApi, 'preparePublishIntent').mockResolvedValue({
    version: 1, state: 'prepared', idempotency_key: idempotencyKey, receipt: null,
  });
  vi.spyOn(testApi, 'publishMessage').mockResolvedValue({
    message_id: messageId, delivery_ids: [deliveryId], duplicate: false,
    request_id: requestId, trace_id: 'trace-canonical', idempotency_key: idempotencyKey,
    tenant_id: 'Steven', actor_alias: 'operator', request_hash: hash, causal_hash: hash,
  });
  vi.spyOn(testApi, 'confirmPublishIntent').mockResolvedValue({
    version: 1, confirmed: true, idempotency_key: idempotencyKey, message_id: messageId, causal_hash: hash,
  });
  const getMessage = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: messageId,
    deliveries: [{ delivery_id: deliveryId, tenant_id: agent.tenantId, alias: agent.alias, reply: 'respuesta del gateway anterior' }],
  });
  const view = renderWithApi(<ConversationPane {...input} page={{ items: [] }} />);
  await user.type(screen.getByRole('textbox', { name: /Mensaje para/ }), 'consultar respuesta');
  await user.click(screen.getByRole('button', { name: 'Enviar' }));
  await waitFor(() => { expect(getMessage).toHaveBeenCalledTimes(1); });

  view.rerender(<ApiProvider api={testApi}><ConversationPane {...input} page={{ items: [{
    message_id: messageId, tenant_id: 'Steven', actor_alias: 'operator', room_id: 'grp.steven',
    author: { kind: 'human', subject_id: input.publisherHumanSubject, display_name: 'Operador' },
    body_preview: 'consultar respuesta', created_at: '2026-10-03T17:00:00Z',
    deliveries: [{ delivery_id: deliveryId, recipient_tenant: agent.tenantId, recipient_alias: agent.alias, status: 'done' }],
  }] }} /></ApiProvider>);
  await waitFor(() => { expect(getMessage).toHaveBeenCalledTimes(2); });
  expect(screen.queryByLabelText(`Respuesta canónica de ${agent.tenantId}:${agent.alias}`)).toBeNull();
  expect(screen.queryByText('respuesta del gateway anterior')).toBeNull();
  await act(async () => { await new Promise((resolve) => { window.setTimeout(resolve, 2_600); }); });
  expect(getMessage).toHaveBeenCalledTimes(2);
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function pendingPublish() {
  const input = { ...props(), publisherSubject: 'Steven:operator', publisherHumanSubject: `human:${'a'.repeat(64)}` };
  const receipt = {
    message_id: '10000000-0000-4000-8000-000000000001', delivery_ids: ['20000000-0000-4000-8000-000000000002'], duplicate: false,
    request_id: '30000000-0000-4000-8000-000000000003', trace_id: 'trace-confirm', idempotency_key: 'intent-confirm',
    tenant_id: 'Steven', actor_alias: 'operator', request_hash: 'a'.repeat(64), causal_hash: 'b'.repeat(64),
  };
  const confirmation = { version: 1 as const, confirmed: true as const, idempotency_key: receipt.idempotency_key, message_id: receipt.message_id, causal_hash: receipt.causal_hash };
  const pending = deferred<typeof confirmation>();
  const prepare = vi.spyOn(testApi, 'preparePublishIntent').mockResolvedValue({ version: 1, state: 'prepared', idempotency_key: receipt.idempotency_key, receipt: null });
  const publish = vi.spyOn(testApi, 'publishMessage').mockResolvedValue(receipt);
  const confirm = vi.spyOn(testApi, 'confirmPublishIntent').mockReturnValue(pending.promise);
  const read = vi.spyOn(testApi, 'getMessage').mockResolvedValue({
    message_id: receipt.message_id, chain_open: false,
    deliveries: [{ delivery_id: receipt.delivery_ids[0], tenant_id: input.agent.tenantId, alias: input.agent.alias, status: 'done', reply: 'Pong antes de confirm' }],
  });
  const page = { items: [{
    message_id: receipt.message_id, tenant_id: 'Steven', actor_alias: 'operator', room_id: 'grp.steven',
    author: { kind: 'human' as const, subject_id: input.publisherHumanSubject, display_name: 'Steven' },
    body_preview: 'Ping', created_at: '2026-10-03T17:00:00Z',
    deliveries: [{ delivery_id: receipt.delivery_ids[0], recipient_tenant: input.agent.tenantId, recipient_alias: input.agent.alias, status: 'done' as const }],
  }] };
  return { input, receipt, confirmation, pending, prepare, publish, confirm, read, page };
}

it('muestra aceptación y empieza a leer antes de confirm, con doble submit bloqueado y un solo refresh', async () => {
  const f = pendingPublish();
  renderWithApi(<ConversationPane {...f.input} page={{ items: [] }} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ping' } });
  const form = screen.getByRole('textbox').closest('form');
  if (!form) throw new Error('Missing composer');
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  await waitFor(() => { expect(f.read).toHaveBeenCalledWith(f.receipt.message_id); });
  expect(f.prepare).toHaveBeenCalledOnce();
  expect(f.publish).toHaveBeenCalledOnce();
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.input.onReload).toHaveBeenCalledOnce();
  expect(screen.queryByText(/Mensaje aceptado para entrega ·/)).toBeNull();
  expect(screen.queryByText(/ACK llega por polling/i)).toBeNull();
  expect(screen.getByRole('button', { name: 'Confirmando…' })).toBeDisabled();
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('textbox')).toBeEnabled();
  fireEvent.submit(form);
  expect(f.prepare).toHaveBeenCalledOnce();
  await act(async () => { f.pending.resolve(f.confirmation); });
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(f.input.onReload).toHaveBeenCalledOnce();
});

it('muestra la respuesta preconfirm en otra burbuja con el agente correcto', async () => {
  const f = pendingPublish();
  const view = renderWithApi(<ConversationPane {...f.input} page={{ items: [] }} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ping' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  await waitFor(() => { expect(f.read).toHaveBeenCalledOnce(); });
  view.rerender(<ApiProvider api={testApi}><ConversationPane {...f.input} page={f.page} /></ApiProvider>);
  const human = screen.getByText('Ping').closest('article');
  const response = await screen.findByRole('article', { name: `Mensaje de ${f.input.agent.alias}` });
  expect(human).toHaveAttribute('data-direction', 'input');
  expect(human).toHaveTextContent('Steven');
  expect(human).not.toHaveTextContent('Pong antes de confirm');
  expect(response).toHaveAttribute('data-direction', 'output');
  expect(response).toHaveTextContent('Pong antes de confirm');
  expect(response).not.toHaveTextContent('Ping');
  expect(response.parentElement).toBe(human?.parentElement);
  expect(screen.getByRole('button', { name: 'Confirmando…' })).toBeDisabled();
  await act(async () => { f.pending.resolve(f.confirmation); });
});

it.each([
  { code: 'timeout', status: 0, text: 'Confirmación incierta', calls: 2 },
  { code: undefined, status: 409, text: 'Confirmación rechazada', calls: 1 },
])('conserva el recibo aceptado con $text sin otro publish', async ({ code, status, text, calls }) => {
  const f = pendingPublish();
  f.confirm.mockRejectedValue(new ApiError('confirm unavailable', status, code));
  renderWithApi(<ConversationPane {...f.input} page={{ items: [] }} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ping' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  expect(await screen.findByText(new RegExp(text))).toHaveTextContent('Aceptado por el control plane');
  expect(f.publish).toHaveBeenCalledOnce();
  expect(f.confirm).toHaveBeenCalledTimes(calls);
  expect(f.input.onReload).toHaveBeenCalledOnce();
  expect(f.read).toHaveBeenCalledWith(f.receipt.message_id);
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.queryByRole('alert')).toBeNull();
});

it.each(['identidad', 'conversación'])('cerca el recibo tardío tras cambiar de %s', async (change) => {
  const f = pendingPublish();
  const publish = deferred<typeof f.receipt>();
  f.publish.mockReturnValue(publish.promise);
  const view = renderWithApi(<ConversationPane {...f.input} page={{ items: [] }} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ping' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  await waitFor(() => { expect(f.publish).toHaveBeenCalledOnce(); });
  const next = change === 'identidad'
    ? { ...f.input, publisherSubject: 'Steven:other', publisherHumanSubject: `human:${'b'.repeat(64)}` }
    : { ...f.input, agent: { ...f.input.agent, id: 'other:agent', tenantId: 'other', alias: 'agent' } };
  view.rerender(<ApiProvider api={testApi}><ConversationPane {...next} page={{ items: [] }} /></ApiProvider>);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Nuevo borrador' } });
  await act(async () => { publish.resolve(f.receipt); });
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.input.onReload).not.toHaveBeenCalled();
  expect(screen.queryByText(/Mensaje aceptado para entrega ·/)).toBeNull();
  expect(screen.getByRole('textbox')).toHaveValue('Nuevo borrador');
  await act(async () => { f.pending.resolve(f.confirmation); });
  expect(screen.getByRole('textbox')).toHaveValue('Nuevo borrador');
  expect(screen.queryByText('Mensaje aceptado para entrega. La aceptación no confirma la ejecución.')).toBeNull();
});

it('conserva el bloqueo al cerrar y reabrir mientras confirm está pendiente', async () => {
  const f = pendingPublish();
  const store = new ConversationDraftStore();
  const pane = (open: boolean) => <ApiProvider api={testApi}><ConversationDrafts.Provider value={store}>
    {open ? <ConversationPane {...f.input} page={{ items: [] }} /> : null}
  </ConversationDrafts.Provider></ApiProvider>;
  const view = renderWithApi(pane(true));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ping' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  await waitFor(() => { expect(f.confirm).toHaveBeenCalledOnce(); });
  view.rerender(pane(false));
  view.rerender(pane(true));
  expect(screen.getByRole('button', { name: 'Confirmando…' })).toBeDisabled();
  const form = screen.getByRole('textbox').closest('form');
  if (!form) throw new Error('Missing composer');
  fireEvent.submit(form);
  expect(f.publish).toHaveBeenCalledOnce();
  await act(async () => { f.pending.resolve(f.confirmation); });
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(f.input.onReload).toHaveBeenCalledOnce();
});

it('aísla un cambio de API aunque conserve humano y destinatario', async () => {
  const f = pendingPublish();
  const publish = deferred<typeof f.receipt>();
  f.publish.mockReturnValue(publish.promise);
  const store = new ConversationDraftStore();
  const pane = (api: CauceApi) => <ApiProvider api={api}><ConversationDrafts.Provider value={store}>
    <ConversationPane {...f.input} page={{ items: [] }} />
  </ConversationDrafts.Provider></ApiProvider>;
  const view = renderWithApi(pane(testApi));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ping' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  await waitFor(() => { expect(f.publish).toHaveBeenCalledOnce(); });
  const nextApi = new CauceApi('http://another-api.invalid');
  const nextRead = vi.spyOn(nextApi, 'getMessage');
  view.rerender(pane(nextApi));
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByRole('textbox')).toHaveValue('');
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Borrador de la nueva API' } });
  await act(async () => { publish.resolve(f.receipt); f.pending.resolve(f.confirmation); });
  expect(f.confirm).toHaveBeenCalledOnce();
  expect(nextRead).not.toHaveBeenCalled();
  expect(f.read).not.toHaveBeenCalled();
  expect(f.input.onReload).not.toHaveBeenCalled();
  expect(screen.getByRole('textbox')).toHaveValue('Borrador de la nueva API');
  expect(screen.queryByText(/Mensaje aceptado para entrega/)).toBeNull();
});

it.each(['identidad', 'API'])('no conserva la raíz aceptada bajo otra %s mientras termina confirm', async (change) => {
  const f = pendingPublish();
  const view = renderWithApi(<ConversationPane {...f.input} page={{ items: [] }} />);
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Ping' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  await waitFor(() => { expect(f.read).toHaveBeenCalledOnce(); });
  const api = change === 'API' ? new CauceApi('http://another-api.invalid') : testApi;
  const nextRead = api === testApi ? f.read : vi.spyOn(api, 'getMessage');
  nextRead.mockClear();
  const input = change === 'identidad' ? { ...f.input, publisherHumanSubject: `human:${'b'.repeat(64)}` } : f.input;
  view.rerender(<ApiProvider api={api}><ConversationPane {...input} page={{ items: [] }} /></ApiProvider>);
  await act(async () => { f.pending.resolve(f.confirmation); });
  expect(nextRead).not.toHaveBeenCalled();
  expect(screen.queryByText(/Mensaje aceptado para entrega/)).toBeNull();
  expect(screen.queryByLabelText(/^Respuesta canónica/)).toBeNull();
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(f.input.onReload).toHaveBeenCalledOnce();
});

it('descarta la respuesta previa y relee el mismo feed humano poblado al cambiar de API', async () => {
  const f = pendingPublish();
  const view = renderWithApi(<ConversationPane {...f.input} page={f.page} />);
  expect(await screen.findByText('Pong antes de confirm')).toBeVisible();
  expect(f.read).toHaveBeenCalledWith(f.receipt.message_id);
  const nextApi = new CauceApi('http://another-api.invalid');
  const pending = deferred<Awaited<ReturnType<CauceApi['getMessage']>>>();
  const nextRead = vi.spyOn(nextApi, 'getMessage').mockReturnValue(pending.promise);
  view.rerender(<ApiProvider api={nextApi}><ConversationPane {...f.input} page={f.page} /></ApiProvider>);
  await waitFor(() => { expect(nextRead).toHaveBeenCalledExactlyOnceWith(f.receipt.message_id); });
  expect(screen.queryByText('Pong antes de confirm')).toBeNull();
  expect(screen.queryByLabelText(/^Respuesta canónica/)).toBeNull();
  await act(async () => { pending.resolve({
    message_id: f.receipt.message_id, chain_open: false,
    deliveries: [{ delivery_id: f.receipt.delivery_ids[0], tenant_id: f.input.agent.tenantId, alias: f.input.agent.alias, status: 'done', reply: 'Respuesta de la nueva API' }],
  }); });
  expect(await screen.findByText('Respuesta de la nueva API')).toBeVisible();
  expect(screen.queryByText('Pong antes de confirm')).toBeNull();
  expect(f.read).toHaveBeenCalledOnce();
});

it('cierra la selección y descarta el cuerpo completo retenido al cambiar de API', async () => {
  const user = userEvent.setup();
  const f = pendingPublish();
  f.page.items[0].body_preview = 'p'.repeat(240);
  f.read.mockResolvedValue({
    message_id: f.receipt.message_id, body: { text: 'Cuerpo completo de la API anterior' }, chain_open: false,
    deliveries: [{ delivery_id: f.receipt.delivery_ids[0], tenant_id: f.input.agent.tenantId, alias: f.input.agent.alias, status: 'done', reply: 'Respuesta anterior' }],
  });
  const view = renderWithApi(<ConversationPane {...f.input} page={f.page} />);
  await screen.findByText('Respuesta anterior');
  await user.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  await user.click(screen.getByRole('button', { name: 'Ver el mensaje completo' }));
  expect(await within(screen.getByRole('group', { name: 'Detalle del mensaje seleccionado' })).findByText('Cuerpo completo de la API anterior')).toBeVisible();
  const nextApi = new CauceApi('http://another-api.invalid');
  const nextRead = vi.spyOn(nextApi, 'getMessage').mockResolvedValue({
    message_id: f.receipt.message_id, chain_open: false,
    deliveries: [{ delivery_id: f.receipt.delivery_ids[0], tenant_id: f.input.agent.tenantId, alias: f.input.agent.alias, status: 'done', reply: 'Nueva respuesta verificada' }],
  });
  view.rerender(<ApiProvider api={nextApi}><ConversationPane {...f.input} page={f.page} /></ApiProvider>);
  expect(screen.queryByRole('group', { name: 'Detalle del mensaje seleccionado' })).toBeNull();
  expect(screen.queryByText('Cuerpo completo de la API anterior')).toBeNull();
  expect(screen.queryByText('Respuesta anterior')).toBeNull();
  expect(await screen.findByText('Nueva respuesta verificada')).toBeVisible();
  expect(nextRead).toHaveBeenCalledExactlyOnceWith(f.receipt.message_id);
});


it('un solo toque al enviar conserva foco y cerca un segundo submit antes de confirmar', async () => {
  const user = userEvent.setup();
  const f = pendingPublish();
  renderWithApi(<ConversationPane {...f.input} page={{ items: [] }} />);
  const input = screen.getByRole('textbox');
  await user.click(input);
  fireEvent.change(input, { target: { value: 'Ping' } });
  const send = screen.getByRole('button', { name: 'Enviar' });
  const pointer = new MouseEvent('pointerdown', { bubbles: true, cancelable: true, button: 0 });
  fireEvent(send, pointer);
  expect(pointer.defaultPrevented).toBe(true);
  expect(input).toHaveFocus();
  fireEvent.click(send);
  await waitFor(() => { expect(f.publish).toHaveBeenCalledOnce(); });
  expect(input).toHaveFocus();
  expect(input).toBeEnabled();
  const form = input.closest('form');
  if (!form) throw new Error('Missing composer');
  fireEvent.submit(form);
  expect(f.prepare).toHaveBeenCalledOnce();
  await act(async () => { f.pending.resolve(f.confirmation); });
  expect(input).toHaveFocus();
  expect(input).not.toHaveAttribute('readonly');
});
