import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { mockMessages } from '../../mocks/data';
import { deliveryPolicy } from '../deliveries/delivery-policy';
import { TerminalTranscript } from './TerminalTranscript';
import type { CanonicalReply } from '../messages/use-canonical-reply';
import type { TranscriptItem } from './session';

it('adjunta el texto escapado únicamente al message y delivery que coinciden', () => {
  const first = mockMessages().items?.[0];
  if (!first?.message_id || !first.deliveries?.[0]?.delivery_id) throw new Error('Missing transcript fixture');
  const delivery = first.deliveries[0];
  const deliveryId = delivery.delivery_id;
  if (!deliveryId) throw new Error('Missing delivery id');
  const sibling = { ...first, message_id: 'other-root' };
  const canonical: CanonicalReply = {
    messageId: first.message_id, deliveryId,
    tenantId: delivery.recipient_tenant ?? '', alias: delivery.recipient_alias ?? '',
    chainOpen: false, status: 'done', reply: '<img src=x onerror=alert(1)> respuesta',
  };
  render(<TerminalTranscript
    items={[{ message: first, direction: 'input', delivery }, { message: sibling, direction: 'input', delivery }]}
    onSelectItem={vi.fn()} presentation="chat" canonicalReply={canonical}
  />);
  const reply = screen.getByLabelText(`Respuesta canónica de ${canonical.tenantId}:${canonical.alias}`);
  expect(reply).toHaveTextContent(canonical.reply ?? '');
  expect(reply).toHaveTextContent('Respuesta consolidada');
  expect(reply.querySelector('img')).toBeNull();
  const otherRoot = document.querySelector<HTMLElement>('[data-message-id="other-root"]');
  if (otherRoot === null) throw new Error('Falta el artículo del otro mensaje');
  expect(within(otherRoot).queryByLabelText(/^Respuesta canónica/)).toBeNull();
});

function humanChatFixture() {
  const source = mockMessages().items?.[0];
  const delivery = source?.deliveries?.[0];
  if (!source?.message_id || !delivery?.delivery_id) throw new Error('Missing fixture');
  const message = {
    ...source, body_preview: 'Ping humano',
    author: { kind: 'human' as const, subject_id: `human:${'a'.repeat(64)}`, display_name: 'Steven' },
  };
  const canonical: CanonicalReply = {
    messageId: source.message_id, deliveryId: delivery.delivery_id,
    tenantId: delivery.recipient_tenant ?? '', alias: delivery.recipient_alias ?? '',
    chainOpen: false, status: 'done', reply: 'Pong del agente',
  };
  return { message, delivery, canonical };
}

it('separa el humano autenticado y el agente en burbujas hermanas y pliega la identidad técnica', () => {
  const { message, delivery, canonical } = humanChatFixture();
  render(<TerminalTranscript items={[{ message, delivery, direction: 'input' }]} presentation="chat" canonicalReply={canonical} onSelectItem={vi.fn()} />);
  const human = document.querySelector<HTMLElement>(`[data-message-id="${message.message_id ?? ''}"]`);
  const agent = screen.getByRole('article', { name: `Mensaje de ${canonical.alias}` });
  if (!human) throw new Error('Missing human message');
  expect(human).toHaveClass('input');
  expect(agent).toHaveClass('output');
  expect(agent.parentElement).toBe(human.parentElement);
  expect(human).not.toHaveTextContent('Pong del agente');
  expect(within(human).getByRole('status', { name: 'Entrega: El agente terminó; respuesta recibida' })).toBeVisible();
  expect(human.querySelector('[data-checks="2"]')).toBeInTheDocument();
  expect(agent).not.toHaveTextContent('Ping humano');
  expect(agent).toHaveAttribute('data-reply-to', message.message_id);
  expect(agent).toHaveTextContent(canonical.alias);
  expect(agent).not.toHaveTextContent('Respuesta de Steven:');
  const details = human.querySelector('details');
  expect(details).not.toHaveAttribute('open');
  expect(details).toHaveTextContent('Identidad técnica');
});

it.each([
  { status: 'pending', events: ['published'], label: 'Publicado · esperando aceptación del agente' },
  { status: 'accepted', events: ['published', 'accepted'], label: 'El agente aceptó la entrega' },
  { status: 'started', events: ['published', 'accepted', 'started'], label: 'El agente inició la ejecución' },
  { status: 'done', events: ['published', 'accepted', 'started', 'done'], label: 'El agente terminó; respuesta no disponible' },
] as const)('representa $status con checks durables sin afirmar lectura y deja el ACK en los detalles', ({ status, events, label }) => {
  const { message, delivery } = humanChatFixture();
  const durableDelivery = {
    ...delivery,
    status,
    timeline: events.map((status) => ({ status })),
  };
  render(<TerminalTranscript items={[{ message, delivery: durableDelivery, direction: 'input' }]}
    presentation="chat" onSelectItem={vi.fn()} />);

  const human = document.querySelector<HTMLElement>(`[data-message-id="${message.message_id ?? ''}"]`);
  if (!human) throw new Error('Missing human message');
  expect(within(human).getByRole('status', { name: `Entrega: ${label}` })).toBeVisible();
  const check = human.querySelector('.chat-delivery-check');
  expect(check).toHaveTextContent('✓');
  expect(human.querySelector('[data-checks="1"]')).toBeInTheDocument();
  expect(human.querySelector('[data-checks="2"]')).toBeNull();
  expect(check).not.toHaveTextContent(label);
  expect(human).not.toHaveTextContent(/leído|leyó/i);
  expect(human.querySelector('details')).not.toHaveAttribute('open');
  expect(human.querySelector('details')).toHaveTextContent(deliveryPolicy(status).label);
});

it('presenta la sonda estructurada como comprobación legible y conserva el JSON expandible', async () => {
  const user = userEvent.setup();
  const { message, delivery } = humanChatFixture();
  const body = { type: 'system.gate.probe', nonce: 'a'.repeat(32), timeout_ms: 90_000 };
  render(<TerminalTranscript items={[{
    message: { ...message, body_preview: JSON.stringify(body) }, delivery, direction: 'input',
  }]} presentation="chat" onSelectItem={vi.fn()} />);

  const human = document.querySelector<HTMLElement>(`[data-message-id="${message.message_id ?? ''}"]`);
  if (!human) throw new Error('Missing human message');
  expect(within(human).getByRole('group', { name: 'Comprobación de conexión' })).toBeVisible();
  expect(within(human).getByText('Plazo')).toBeVisible();
  expect(within(human).getByText('90 segundos')).toBeVisible();
  expect(within(human).queryByText(JSON.stringify(body))).toBeNull();
  const technical = within(human).getByText('Detalle técnico');
  await user.click(technical);
  expect(within(human).getByText(/"nonce": "aaaaaaaa/)).toBeVisible();
});

it.each([
  { reply: null, availability: 'Respuesta vacía' },
  { reply: undefined, availability: 'Respuesta no disponible' },
  { reply: '', availability: 'Respuesta vacía' },
  { reply: '   ', availability: 'Respuesta vacía' },
])('no crea una burbuja ni un doble check sin texto de respuesta real (%o)', async ({ reply, availability }) => {
  const user = userEvent.setup();
  const { message, delivery, canonical } = humanChatFixture();
  const emptyReply = { ...canonical, reply };
  const input = { items: [{ message, delivery, direction: 'input' as const }] as TranscriptItem[], presentation: 'chat' as const, onSelectItem: vi.fn() };
  const { rerender } = render(<TerminalTranscript {...input} canonicalReply={emptyReply} />);

  const human = document.querySelector<HTMLElement>(`[data-message-id="${message.message_id ?? ''}"]`);
  if (!human) throw new Error('Missing human message');
  expect(within(human).getByRole('status', { name: 'Entrega: El agente terminó; respuesta no disponible' })).toBeVisible();
  expect(human.querySelector('[data-checks="1"]')).toBeInTheDocument();
  expect(human.querySelector('[data-checks="2"]')).toBeNull();
  expect(human.querySelector('.canonical-reply')).toBeNull();
  expect(document.querySelectorAll('.transcript-entry')).toHaveLength(1);
  expect(screen.queryByText(/Sin respuesta canónica disponible|Respuesta canónica no disponible/iu)).toBeNull();

  await user.click(within(human).getByText(/Detalles del mensaje/iu));
  expect(within(human).getByText(availability)).toBeVisible();
  expect(within(human).getByText(/Cadena cerrada/iu)).toBeVisible();

  rerender(<TerminalTranscript {...input} canonicalReply={{ ...canonical, reply: 'Pong real' }} />);
  expect(document.querySelectorAll('.transcript-entry')).toHaveLength(2);
  expect(screen.getByText('Pong real')).toBeVisible();
  expect(human.querySelector('[data-checks="2"]')).toBeInTheDocument();
});

it.each(['__proto__', 'constructor', 'toString'])('mantiene el tipo desconocido %s como texto sin fallar el render', (type) => {
  const { message, delivery } = humanChatFixture();
  render(<TerminalTranscript items={[{
    message: { ...message, body_preview: JSON.stringify({ type }) }, delivery, direction: 'input',
  }]} presentation="chat" onSelectItem={vi.fn()} />);

  expect(screen.getByRole('group', { name: 'Mensaje estructurado' })).toBeVisible();
  expect(screen.getByText(`Tipo: ${type}`)).toBeVisible();
});

it.each(['chat', 'terminal'] as const)('mantiene el formato técnico %s para mensajes sin autor humano verificado', (presentation) => {
  const { message, delivery, canonical } = humanChatFixture();
  render(<TerminalTranscript items={[{ message: { ...message, author: undefined }, delivery, direction: 'input' }]} presentation={presentation} canonicalReply={canonical} onSelectItem={vi.fn()} />);
  const input = screen.getByText('Ping humano').closest('article');
  expect(input).toHaveTextContent('Pong del agente');
  expect(input).toHaveTextContent(`Respuesta de ${canonical.tenantId}:${canonical.alias}`);
  expect(document.querySelectorAll('.transcript-entry')).toHaveLength(1);
  expect(input?.querySelector('details')).toBeNull();
});

it('mantiene la respuesta anidada en terminal incluso con autor humano verificado', () => {
  const { message, delivery, canonical } = humanChatFixture();
  render(<TerminalTranscript items={[{ message, delivery, direction: 'input' }]} canonicalReply={canonical} onSelectItem={vi.fn()} />);
  expect(screen.getByText('Ping humano').closest('article')).toHaveTextContent('Pong del agente');
  expect(document.querySelectorAll('.transcript-entry')).toHaveLength(1);
});

it.each([
  { deliveryId: 'other-delivery' }, { messageId: 'other-root' }, { tenantId: 'other-tenant' }, { alias: 'other-agent' },
])('no presenta como respuesta del agente un resultado fuera de scope: %o', (mismatch) => {
  const { message, delivery, canonical } = humanChatFixture();
  render(<TerminalTranscript items={[{ message, delivery, direction: 'input' }]} presentation="chat" canonicalReply={{ ...canonical, ...mismatch }} onSelectItem={vi.fn()} />);
  expect(screen.queryByText('Pong del agente')).toBeNull();
  const human = document.querySelector<HTMLElement>(`[data-message-id="${message.message_id ?? ''}"]`);
  if (!human) throw new Error('Missing human message');
  expect(human.querySelector('[data-checks="1"]')).toBeInTheDocument();
  expect(human.querySelector('[data-checks="2"]')).toBeNull();
  expect(human.querySelector('.canonical-reply')).toBeNull();
  expect(document.querySelectorAll('.transcript-entry')).toHaveLength(1);
});
