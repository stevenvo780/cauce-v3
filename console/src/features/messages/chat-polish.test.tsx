import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryView, MessageAuthor, MessageView } from '../../api/types';
import { settledSince } from '../../shell/reply-alerts';
import { ChatMessage } from './ChatMessage';
import { ChatThread } from './ChatThread';

const me = `human:${'a'.repeat(64)}`;
const author: MessageAuthor = { kind: 'human', subject_id: me, display_name: 'Steven' };
const delivery: DeliveryView = { delivery_id: 'd1', recipient_tenant: 'Steven', recipient_alias: 'argos', status: 'started' };
const message: MessageView = {
  message_id: 'one', tenant_id: 'Steven', actor_alias: 'kant', room_id: 'grp.steven',
  body_preview: 'Verificar el adapter', created_at: '2026-10-08T00:00:00Z', deliveries: [delivery],
};

describe('chat polish', () => {
  it('draws another agent writing to this one on the left, never as the operator', () => {
    render(<ChatMessage item={{ message, direction: 'input', delivery }} startsGroup selected={false} onSelect={vi.fn()} onExpand={vi.fn()} />);
    expect(screen.getByRole('article', { name: 'kant le escribió a argos' })).toBeInTheDocument();
    expect(screen.getByText('le escribió a', { exact: false })).toBeInTheDocument();
  });

  it('puts a failed own message back in the composer and quotes any message', () => {
    const onCompose = vi.fn();
    const failed = { ...delivery, status: 'failed' as const };
    render(<ChatMessage item={{ message: { ...message, author, deliveries: [failed] }, direction: 'input', delivery: failed }}
      ownSubject={me} startsGroup selected={false} onSelect={vi.fn()} onExpand={vi.fn()} onCompose={onCompose} />);
    fireEvent.click(screen.getByRole('button', { name: 'Volver a escribir este mensaje' }));
    expect(onCompose).toHaveBeenLastCalledWith('Verificar el adapter', 'resend');
    fireEvent.click(screen.getByRole('button', { name: 'Citar en la respuesta' }));
    expect(onCompose).toHaveBeenLastCalledWith('Verificar el adapter', 'quote');
  });

  it('counts only own deliveries that settle after the first reading', () => {
    const page = (status: DeliveryView['status']) => ({ items: [{ ...message, author, deliveries: [{ ...delivery, status }] }] });
    const first = settledSince(new Map(), page('started'), me);
    expect(first.settled).toEqual([]);
    expect(settledSince(first.statuses, page('done'), me).settled).toEqual([{ alias: 'argos', ok: true }]);
    expect(settledSince(first.statuses, page('done'), 'human:other').settled).toEqual([]);
  });

  it('history that loads after the first paint enters quiet; a reply to an open root does not', () => {
    const now = new Date().toISOString();
    const root = (id: string, status: DeliveryView['status']) => ({
      message: { ...message, message_id: id, author, actor_alias: 'steven', created_at: now, deliveries: [{ ...delivery, delivery_id: `d-${id}`, status }] },
      direction: 'input' as const, delivery: { ...delivery, delivery_id: `d-${id}`, status },
    });
    const items = [root('old', 'done'), root('open', 'started')];
    const props = { items, ownSubject: me, alias: 'argos', seed: 'Steven/argos', fullBodies: {}, onSelectItem: vi.fn(), onExpand: vi.fn() };
    const { rerender, container } = render(<ChatThread {...props} />);
    const reply = (id: string) => ({ messageId: id, deliveryId: `d-${id}`, tenantId: 'Steven', alias: 'argos', status: 'done' as const, chainOpen: false, reply: `respuesta ${id}` });
    rerender(<ChatThread {...props} canonicalReplies={[reply('old'), reply('open')]} />);
    expect(container.querySelector('[data-reply-to="old"]')).toHaveAttribute('data-quiet');
    expect(container.querySelector('[data-reply-to="open"]')).not.toHaveAttribute('data-quiet');
  });
});
