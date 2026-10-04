import { render, screen, within } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { mockMessages } from '../../mocks/data';
import { TerminalTranscript } from './TerminalTranscript';
import type { CanonicalReply } from '../messages/use-canonical-reply';

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
  const human = screen.getByText('Ping humano').closest('article');
  const agent = screen.getByRole('article', { name: `Mensaje de ${canonical.alias}` });
  expect(human).toHaveClass('input');
  expect(agent).toHaveClass('output');
  expect(agent.parentElement).toBe(human?.parentElement);
  expect(human).not.toHaveTextContent('Pong del agente');
  expect(agent).not.toHaveTextContent('Ping humano');
  expect(agent).toHaveAttribute('data-reply-to', message.message_id);
  expect(agent).toHaveTextContent(canonical.alias);
  expect(agent).not.toHaveTextContent('Respuesta de Steven:');
  expect(human?.querySelector('details')).not.toHaveAttribute('open');
  expect(human?.querySelector('details')).toHaveTextContent('Identidad técnica');
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
  expect(document.querySelectorAll('.transcript-entry')).toHaveLength(1);
});
