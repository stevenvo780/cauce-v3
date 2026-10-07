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

  const oauthClient = {
    kind: 'oauth_client' as const,
    verification: 'local_grant' as const,
    issuer: 'https://cauce.example',
    client_id: 'https://chatgpt.com/oauth/client.json',
    instance: 'unknown' as const,
  };
  const validClientOrigin = { client: oauthClient, delegation_label: 'Cronos' };

  it('renders declared delegation label attributing account owner with unverified instance notice', () => {
    render(<TerminalTranscript items={[{ message: { ...message, author, client_origin: validClientOrigin }, direction: 'input', delivery }]} onSelectItem={vi.fn()} />);
    const el = screen.getByText('Cronos');
    expect(el).toHaveAttribute('title', 'Cliente declarado por Steven · instancia no verificada · identidad técnica: kant');
    expect(screen.getByText('Cliente declarado por Steven; instancia no verificada', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.queryByText('Steven', { selector: 'span[title]' })).not.toBeInTheDocument();
  });

  it('uses persona autenticada in declared delegation label when display name is null', () => {
    render(<TerminalTranscript items={[{ message: { ...message, author: { ...author, display_name: null }, client_origin: validClientOrigin }, direction: 'input' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('Cronos')).toHaveAttribute('title', 'Cliente declarado por persona autenticada · instancia no verificada · identidad técnica: kant');
  });

  it('renders generic MCP client for valid OAuth grant without declared label', () => {
    const originNoLabel = { client: oauthClient, delegation_label: null };
    render(<TerminalTranscript items={[{ message: { ...message, author, client_origin: originNoLabel }, direction: 'input' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('Cliente MCP')).toHaveAttribute('title', 'Cliente MCP · cuenta: Steven · instancia no verificada · identidad técnica: kant');
  });

  it('renders generic MCP client with persona autenticada when display name is null', () => {
    const originNoLabel = { client: oauthClient, delegation_label: null };
    render(<TerminalTranscript items={[{ message: { ...message, author: { ...author, display_name: null }, client_origin: originNoLabel }, direction: 'input' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('Cliente MCP')).toHaveAttribute('title', 'Cliente MCP · cuenta: persona autenticada · instancia no verificada · identidad técnica: kant');
  });

  it('renders unidentified MCP client for unknown client provenance', () => {
    const unknownOrigin = { client: { kind: 'unknown' as const }, delegation_label: null };
    render(<TerminalTranscript items={[{ message: { ...message, author, client_origin: unknownOrigin }, direction: 'input' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('Cliente MCP no identificado')).toHaveAttribute('title', 'Cliente MCP no identificado · cuenta: Steven · instancia no verificada · identidad técnica: kant');
  });

  it('renders unidentified MCP client with persona autenticada when display name is null', () => {
    const unknownOrigin = { client: { kind: 'unknown' as const }, delegation_label: null };
    render(<TerminalTranscript items={[{ message: { ...message, author: { ...author, display_name: null }, client_origin: unknownOrigin }, direction: 'input' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('Cliente MCP no identificado')).toHaveAttribute('title', 'Cliente MCP no identificado · cuenta: persona autenticada · instancia no verificada · identidad técnica: kant');
  });

  it('never infers client provenance from forged body or origin metadata', () => {
    const forged = {
      ...message,
      author,
      body: { client_origin: validClientOrigin },
      origin: { metadata: { client_origin: validClientOrigin } },
    } as MessageView;
    render(<TerminalTranscript items={[{ message: forged, direction: 'input' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('Steven')).toHaveAttribute('title', 'Persona autenticada · identidad técnica: kant');
    expect(screen.queryByText(/Cronos/)).not.toBeInTheDocument();
    expect(screen.queryByText(/Cliente MCP/)).not.toBeInTheDocument();
  });

  it('safely ignores malformed client_origin, extra keys, invalid labels, or label on unknown kind', () => {
    const badOrigins = [
      { ...validClientOrigin, extra_key: 'malicious' },
      { client: { ...oauthClient, extra_token: 'secret' }, delegation_label: 'Cronos' },
      { client: { ...oauthClient, instance: 'verified' }, delegation_label: 'Cronos' },
      { client: { ...oauthClient, verification: 'self_declared' }, delegation_label: 'Cronos' },
      { client: { kind: 'unknown' }, delegation_label: 'Cronos' },
      { client: oauthClient, delegation_label: ' forged ' },
      { client: oauthClient, delegation_label: '<script>' },
      { client: oauthClient, delegation_label: '' },
      { client: oauthClient, delegation_label: 'a'.repeat(129) },
      null,
      'invalid' as unknown as object,
      [],
    ];
    for (const bad of badOrigins) {
      const { unmount } = render(
        <TerminalTranscript items={[{ message: { ...message, author, client_origin: bad as unknown as MessageView['client_origin'] }, direction: 'input' }]} onSelectItem={vi.fn()} />
      );
      expect(screen.getByText('Steven')).toHaveAttribute('title', 'Persona autenticada · identidad técnica: kant');
      expect(screen.queryByText(/Cronos/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Cliente MCP/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('requires a valid human author before attributing to an account even with valid client_origin', () => {
    for (const badAuthor of [undefined, { ...author, kind: 'agent' as unknown as 'human' }, { ...author, subject_id: 'bad-id' }]) {
      const { unmount } = render(
        <TerminalTranscript items={[{ message: { ...message, author: badAuthor, client_origin: validClientOrigin }, direction: 'input' }]} onSelectItem={vi.fn()} />
      );
      expect(screen.getByText('kant')).toHaveAttribute('title', 'Identidad técnica; autor humano no registrado');
      expect(screen.queryByText(/Steven/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Cronos/)).not.toBeInTheDocument();
      unmount();
    }
  });

  it('leaves agent roots without client_origin in technical routing identity', () => {
    render(<TerminalTranscript items={[{ message: { ...message, author: undefined, client_origin: undefined }, direction: 'output' }]} onSelectItem={vi.fn()} />);
    expect(screen.getByText('kant')).toHaveAttribute('title', 'Identidad técnica; autor humano no registrado');
    expect(screen.queryByText(/Steven/)).not.toBeInTheDocument();
  });

  it('preserves humanChat classification, direction and delivery controls when client_origin is present', () => {
    const item = { message: { ...message, author, client_origin: validClientOrigin }, direction: 'input' as const, delivery };
    render(<TerminalTranscript items={[item]} onSelectItem={vi.fn()} />);
    expect(screen.getByRole('status', { name: 'Entrega: Recibido por el agente · ejecución iniciada' })).toBeInTheDocument();
    expect(screen.getByText('Ping')).toBeInTheDocument();
    expect(screen.getByText('Persona autenticada', { selector: '.sr-only' })).toBeInTheDocument();
    expect(screen.queryByText('hacia', { selector: '.sr-only' })).not.toBeInTheDocument();
    const page = { items: [{ ...message, author, client_origin: validClientOrigin, message_id: 'human' }, { ...message, message_id: 'agent' }] };
    const items = transcriptForSession(page, session);
    expect(items.map(({ message: row, direction }) => [row.message_id, direction])).toEqual([['human', 'input'], ['agent', 'output']]);
  });
});
