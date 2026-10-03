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
