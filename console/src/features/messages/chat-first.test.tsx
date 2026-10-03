import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { ApiProvider } from '../../api/context';
import type { ComponentProps } from 'react';
import { mockMessages, mockStatus, topology } from '../../mocks/data';
import { renderRouted, renderWithApi, testApi } from '../../test/render';
import { ConversationPane } from './ConversationPane';
import { MessagesPage } from './MessagesPage';
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

it('la bienvenida tiene un único selector de agentes', async () => {
  renderRouted(MessagesPage);
  const roster = await screen.findByRole('complementary', { name: 'Agentes' });
  const agents = await within(roster).findAllByRole('button', { name: /Conversación con/ });
  expect(agents.length).toBeGreaterThan(0);
  expect(screen.getAllByRole('button', { name: /Conversación con/ })).toHaveLength(agents.length);
  expect(screen.queryByLabelText('Empezar una conversación')).toBeNull();
  expect(within(screen.getByRole('region', { name: 'Sin conversación abierta' })).queryAllByRole('button')).toHaveLength(0);
});

it('Más contiene los controles técnicos y se cierra con Escape o al salir con Tab', async () => {
  const user = userEvent.setup();
  renderWithApi(<ConversationPane {...props()} />);
  const more = screen.getByRole('button', { name: 'Más' });
  expect(screen.queryByRole('link', { name: 'Configurar agente' })).toBeNull();
  expect(screen.queryByLabelText('Carril')).toBeNull();
  await user.click(more);
  expect(more).toHaveAttribute('aria-expanded', 'true');
  await user.tab();
  expect(screen.getByRole('link', { name: 'Configurar agente' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(more).toHaveFocus();
  expect(screen.queryByLabelText('Carril')).toBeNull();
  await user.click(more);
  for (let steps = 0; steps < 15 && more.getAttribute('aria-expanded') === 'true'; steps += 1) await user.tab();
  expect(more).toHaveAttribute('aria-expanded', 'false');
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
  const trigger = screen.getByRole('button', { name: /Ver detalle$/ });
  await user.click(trigger);
  expect(screen.getByRole('heading', { name: 'Mensaje que elegiste' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  rerender(<ApiProvider api={testApi}><ConversationPane {...input} page={{ ...input.page, items: [] }} /></ApiProvider>);
  expect(trigger.isConnected).toBe(false);
  expect(screen.getByRole('note')).toHaveTextContent('Mensaje fuera de la ventana actual');
  await user.click(screen.getByRole('button', { name: 'Cerrar detalle' }));
  expect(screen.getByRole('button', { name: 'Más' })).toHaveFocus();
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
  await user.click(screen.getByRole('button', { name: /Ver detalle$/ }));
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

it('no promete detalles para un mensaje sin identificador', () => {
  const input = props();
  const items = input.page?.items?.map((item) => ({ ...item, message_id: undefined }));
  renderWithApi(<ConversationPane {...input} page={{ ...input.page, items }} />);
  expect(screen.getByRole('button', { name: /Detalle no disponible: mensaje sin identificador/ })).toBeDisabled();
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
  const triggers = screen.getAllByRole('button', { name: /Ver detalle$/ });
  await user.click(triggers[0]);
  await user.click(screen.getByRole('button', { name: 'Ver el mensaje completo' }));
  await user.click(triggers[1]);
  await act(async () => { resolveBody({ message_id: first.message_id, body: { text: 'Cuerpo tardío del primero' } }); });
  const detail = screen.getByRole('group', { name: 'Detalle del mensaje seleccionado' });
  await waitFor(() => { expect(within(detail).getByText('Segundo mensaje')).toBeVisible(); });
  expect(within(detail).queryByText('Cuerpo tardío del primero')).toBeNull();
});
