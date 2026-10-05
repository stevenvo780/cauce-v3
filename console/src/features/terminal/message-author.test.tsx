import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { DeliveryView, MessageAuthor, MessageView } from '../../api/types';
import { TerminalTranscript } from './TerminalTranscript';
import { transcriptForSession, type OperatorSession } from './session';
import { humanAuthor } from './message-author';

const author: MessageAuthor = { kind: 'human', subject_id: `human:${'a'.repeat(64)}`, display_name: 'Steven' };
const delivery: DeliveryView = { delivery_id: 'delivery', recipient_tenant: 'Steven', recipient_alias: 'kant', status: 'started' };
const message: MessageView = {
  message_id: 'one', tenant_id: 'Steven', actor_alias: 'kant', room_id: 'grp.steven',
  body_preview: 'Ping', created_at: '2026-10-03T00:00:00Z',
  deliveries: [delivery],
};
const session = { agent: { tenantId: 'Steven', alias: 'kant' } } as OperatorSession;

describe('human message provenance', () => {
  it('shows the authenticated profile instead of its technical routing alias', () => {
    render(<TerminalTranscript items={[{ message: { ...message, author }, direction: 'input', delivery }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('Steven')).toHaveAttribute('title', 'Persona autenticada · identidad técnica: kant');
    expect(screen.getByRole('status', { name: 'Entrega: Recibido por el agente · ejecución iniciada' })).toBeInTheDocument();
    expect(screen.getByText('Ping')).toBeInTheDocument();
  });

  it('uses a generic human label without guessing a name from email or tenant', () => {
    render(<TerminalTranscript items={[{ message: { ...message, author: { ...author, display_name: null } }, direction: 'input' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('Persona autenticada', { selector: 'span[title]' })).toBeInTheDocument();
    expect(screen.queryByText('Steven')).not.toBeInTheDocument();
  });

  it('leaves historical technical identity untouched when provenance is unavailable', () => {
    render(<TerminalTranscript items={[{ message, direction: 'output' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('kant')).toHaveAttribute('title', 'Identidad técnica; autor humano no registrado');
    expect(screen.queryByText('Steven')).not.toBeInTheDocument();
  });

  it('distinguishes human input to its own technical alias from true agent output without changing ordering', () => {
    const page = { items: [{ ...message, author, message_id: 'human' }, { ...message, message_id: 'agent' }] };
    const items = transcriptForSession(page, session);
    expect(items.map(({ message: row, direction }) => [row.message_id, direction])).toEqual([['human', 'input'], ['agent', 'output']]);
  });

  it('ignores unproven body/origin metadata and malformed server author projections', () => {
    const unproven = { ...message, body: { author }, origin: { metadata: { author } } };
    expect(humanAuthor(unproven)).toBeUndefined();
    expect(transcriptForSession({ items: [unproven] }, session)[0]?.direction).toBe('output');
    for (const bad of [{ ...author, subject_id: 'Steven' }, { ...author, display_name: '' }, { ...author, kind: 'agent' }]) {
      const row = { ...message, author: bad } as MessageView;
      expect(humanAuthor(row)).toBeUndefined();
      expect(transcriptForSession({ items: [row] }, session)[0]?.direction).toBe('output');
    }
  });
});
