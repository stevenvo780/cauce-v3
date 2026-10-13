import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useState } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ConsoleAccessProvider, useOptionalConsoleAccess } from '../../api/console-access';
import { useApi } from '../../api/context';
import type { ConsoleAccess, MessagePage, TopologySnapshot } from '../../api/types';
import { useResource, type Resource } from '../../api/use-resource';
import { server } from '../../mocks/server';
import { FleetContext, type FleetData } from '../../shell/fleet-context';
import { renderWithApi } from '../../test/render';
import { construirRosterDeMensajeria } from '../messages/roster';
import { OfficeDialog } from './OfficeDialog';
import { SAY_MS, THINK_MS, useOfficeChat } from './use-office-chat';
import type { McpVisitor } from './visitors';

const agentId = 'Steven/argos';
const messageId = '10000000-0000-4000-8000-000000000011';
const access: ConsoleAccess = { subject: 'Steven:kant', human_subject: 'human-one', permissions: ['message.publish'] };
const topology: TopologySnapshot = { tenants: [{ id: 'Steven', rooms: [{ id: 'grp.office', members: [
  { alias: 'kant', enabled: true }, { alias: 'argos', enabled: true }, { alias: 'other', enabled: true },
] }] }] };

function resource<T>(data?: T): Resource<T> {
  return { data, loading: false, reload: () => Promise.resolve(data === undefined ? { error: new Error('No fixture') } : { data }) };
}

function Chat({ initial = agentId, visitors = [] }: { initial?: string | null; visitors?: readonly McpVisitor[] }) {
  const [talkId, setTalkId] = useState(initial);
  const verified = useOptionalConsoleAccess();
  const { dialog, speech } = useOfficeChat(talkId, visitors);
  return <>
    <button onClick={() => { setTalkId(agentId); }}>Talk to argos</button>
    <button onClick={() => { setTalkId('Steven/other'); }}>Talk to other</button>
    <span aria-label="Access">{verified?.loading ? 'loading' : verified?.error ? 'error' : 'loaded'}</span>
    {dialog ? <OfficeDialog model={dialog} state="idle" onClose={() => { setTalkId(null); }} /> : null}
    <pre aria-label="Speech">{JSON.stringify([...speech])}</pre>
  </>;
}

function Boundary({ initial, visitors, map = topology, mapError }: {
  initial?: string | null; visitors?: readonly McpVisitor[]; map?: TopologySnapshot; mapError?: Error;
}) {
  const api = useApi();
  const messages = useResource('office-runtime-feed', () => api.listMessages());
  const fleet: FleetData = {
    agents: construirRosterDeMensajeria({ topology: map }), salud: {}, live: new Map(),
    status: resource(), topology: { ...resource(map), error: mapError }, messages,
    activity: resource(), queues: resource(), activityIntervalMs: 0, setActivityIntervalMs: () => undefined,
    loading: messages.loading, reload: () => { void messages.reload(); },
  };
  return <ConsoleAccessProvider><FleetContext.Provider value={fleet}>
    <button onClick={() => { void messages.reload(); }}>Refresh feed</button>
    <Chat initial={initial} visitors={visitors} />
  </FleetContext.Provider></ConsoleAccessProvider>;
}

function mountChat(props: Parameters<typeof Boundary>[0] = {}) {
  return renderWithApi(<Boundary {...props} />);
}

beforeEach(() => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json(access)),
    http.get('*/v3/console/messages', () => HttpResponse.json({ items: [] })));
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

function publishFixture({ pendingConfirmation = false, delay }: { pendingConfirmation?: boolean; delay?: Promise<void> } = {}) {
  const sent: Record<string, unknown>[] = [];
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    sent.push(input);
    await delay;
    return HttpResponse.json({ message_id: messageId, delivery_ids: ['20000000-0000-4000-8000-000000000011'],
      duplicate: false, request_id: '30000000-0000-4000-8000-000000000011', trace_id: 'office-unit',
      idempotency_key: input.idempotency_key, tenant_id: 'Steven', actor_alias: 'kant', request_hash: 'a'.repeat(64), causal_hash: 'b'.repeat(64),
    }, { status: 202 });
  }));
  if (pendingConfirmation) server.use(http.post('*/v3/console/publish-intents/confirm', () => HttpResponse.json({ error: 'unavailable' }, { status: 503 })));
  return sent;
}

async function composer(name = 'argos') {
  return screen.findByRole<HTMLInputElement>('textbox', { name: `Mensaje para ${name}` });
}
async function send(text = 'Hola') {
  const input = await composer();
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  return input;
}

describe('office chat and real dialog with unit HTTP fixtures', () => {
  it('publishes the trimmed draft through the durable path and keeps drafts per agent', async () => {
    const sent = publishFixture();
    mountChat();
    const input = await composer();
    await waitFor(() => { expect(input).toHaveFocus(); });
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeDisabled();
    fireEvent.change(input, { target: { value: '  hola oficina  ' } });
    fireEvent.click(screen.getByRole('button', { name: 'Talk to other' }));
    const other = await composer('other');
    expect(other).toHaveValue('');
    fireEvent.change(other, { target: { value: 'Borrador distinto' } });
    fireEvent.click(screen.getByRole('button', { name: 'Talk to argos' }));
    expect(await composer()).toHaveValue('  hola oficina  ');
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Enviado'); });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ room_id: 'grp.office', recipients: [{ tenant_id: 'Steven', alias: 'argos' }],
      body: { text: 'hola oficina' }, lane: 'interactive', priority: 10 });
    expect(sent[0].idempotency_key).toEqual(expect.any(String));
    expect(await composer()).toHaveValue('');
    expect(screen.getByLabelText('Speech')).toHaveTextContent('thinking');
    fireEvent.click(screen.getByRole('button', { name: 'Talk to other' }));
    expect(await composer('other')).toHaveValue('Borrador distinto');
    expect(screen.getByRole('status')).not.toHaveTextContent('Enviado');
  });

  it('prevents duplicate submit while sending and preserves a draft edited during the request', async () => {
    let release: (() => void) | undefined;
    const delay = new Promise<void>(resolve => { release = resolve; });
    const sent = publishFixture({ delay });
    mountChat();
    const input = await send('Primer mensaje');
    expect(screen.getByRole('button', { name: 'Enviando…' })).toBeDisabled();
    fireEvent.submit(input.closest('form') ?? input);
    fireEvent.change(input, { target: { value: 'Segundo borrador' } });
    await waitFor(() => { expect(sent).toHaveLength(1); });
    await act(async () => { release?.(); await delay; });
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Enviado'); });
    expect(sent).toHaveLength(1);
    expect(sent[0].body).toEqual({ text: 'Primer mensaje' });
    expect(input).toHaveValue('Segundo borrador');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it.each([
    { label: 'permission denied', verified: { ...access, permissions: [] }, map: topology, initial: agentId, reason: /message.publish/u },
    { label: 'unknown agent', verified: access, map: topology, initial: 'Steven/missing', reason: /no conoce a este agente/u },
    { label: 'unverified membership', verified: access, map: { tenants: [{ id: 'Steven', rooms: [{ id: 'grp.office', members: [{ alias: 'kant' }, { alias: 'argos', enabled: true }] }] }] }, initial: agentId, reason: /no se pudo comprobar la membresía/iu },
    { label: 'ambiguous room', verified: access, map: { tenants: [{ id: 'Steven', rooms: [...(topology.tenants?.[0].rooms ?? []), { id: 'grp.second', members: [{ alias: 'kant', enabled: true }, { alias: 'argos', enabled: true }] }] }] }, initial: agentId, reason: /varias salas/u },
  ])('shows the blocked route for $label and offers the matching chat link', async ({ verified, map, initial, reason }) => {
    const sent = publishFixture();
    server.use(http.get('*/v3/console/access', () => HttpResponse.json(verified)));
    mountChat({ map, initial });
    await waitFor(() => { expect(screen.getByLabelText('Access')).toHaveTextContent('loaded'); });
    await waitFor(() => { expect(screen.getByRole('note')).toHaveTextContent(reason); });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Abrir chat' })).toHaveAttribute('href', `/messages/Steven/${initial.split('/')[1]}`);
    expect(sent).toEqual([]);
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar la charla' }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('fails closed when access or topology is unreadable, even if a stale topology exists', async () => {
    server.use(http.get('*/v3/console/access', () => HttpResponse.json({ error: 'unavailable' }, { status: 503 })));
    const { unmount } = mountChat();
    await waitFor(() => { expect(screen.getByLabelText('Access')).toHaveTextContent('error'); });
    await waitFor(() => { expect(screen.getByRole('note')).toHaveTextContent('message.publish'); });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    unmount();
    server.use(http.get('*/v3/console/access', () => HttpResponse.json(access)));
    mountChat({ mapError: new Error('Unreadable topology') });
    await waitFor(() => { expect(screen.getByRole('note')).toHaveTextContent(/No se pudo leer la topología/u); });
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('keeps the failed draft and clears thinking when the gateway rejects publication', async () => {
    server.use(http.post('*/v3/console/messages', () => HttpResponse.json({ error: 'forbidden', message: 'Publicación denegada' }, { status: 403 })));
    mountChat();
    const input = await send('Conservar este texto');
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Publicación denegada'); });
    expect(input).toHaveValue('Conservar este texto');
    expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
    expect(screen.getByLabelText('Speech')).toHaveTextContent('[]');
    expect(within(screen.getByRole('list', { name: 'Últimos mensajes' })).queryByText(/está pensando/u)).not.toBeInTheDocument();
  });

  it('marks confirmation pending without pretending that the accepted effect failed', async () => {
    publishFixture({ pendingConfirmation: true });
    mountChat();
    const input = await send();
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Enviado'); });
    expect(screen.getByRole('status')).toHaveTextContent('confirmación pendiente');
    expect(input).toHaveValue('');
  });

  it('turns a fresh reply into a temporary speech bubble and ignores an old reply', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    let page: MessagePage = { items: [{ message_id: 'old', tenant_id: 'Steven', actor_alias: 'argos', body_preview: 'Vieja respuesta' }] };
    server.use(http.get('*/v3/console/messages', () => HttpResponse.json(page)));
    publishFixture();
    mountChat();
    await screen.findByText('Vieja respuesta');
    await send();
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Enviado'); });
    expect(screen.getByLabelText('Speech')).toHaveTextContent('thinking');
    page = { items: [...(page.items ?? []), { message_id: 'fresh', tenant_id: 'Steven', actor_alias: 'argos', body_preview: '  Respuesta nueva  ' }] };
    fireEvent.click(screen.getByRole('button', { name: 'Refresh feed' }));
    await waitFor(() => { expect(screen.getByLabelText('Speech')).toHaveTextContent('Respuesta nueva'); });
    expect(screen.getByLabelText('Speech')).not.toHaveTextContent('thinking');
    act(() => { vi.advanceTimersByTime(SAY_MS + 1000); });
    expect(screen.getByLabelText('Speech')).toHaveTextContent('[]');
  });

  it('stops waiting when delivery settles without a reply, and times out a silent agent', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setInterval', 'clearInterval'] });
    publishFixture();
    const { unmount } = mountChat();
    await send();
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Enviado'); });
    server.use(http.get('*/v3/console/messages', () => HttpResponse.json({ items: [{ message_id: messageId, tenant_id: 'Steven', actor_alias: 'kant',
      author: { kind: 'human', subject_id: 'human-one', display_name: 'Operator' }, body_preview: 'Hola',
      deliveries: [{ recipient_tenant: 'Steven', recipient_alias: 'argos', status: 'failed' }],
    }] })));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh feed' }));
    await waitFor(() => { expect(screen.getByLabelText('Speech')).toHaveTextContent('[]'); });
    expect(screen.getByRole('list', { name: 'Últimos mensajes' })).toHaveTextContent('Vos:');
    unmount();
    server.use(http.get('*/v3/console/messages', () => HttpResponse.json({ items: [] })));
    const silent = mountChat();
    await send();
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Enviado'); });
    act(() => { vi.advanceTimersByTime(THINK_MS + 1000); });
    expect(screen.getByLabelText('Speech')).toHaveTextContent('[]');
    silent.unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves a mailbox note with the read-receipt caveat and never displays thinking', async () => {
    const visitor: McpVisitor = { id: 'Steven/mbx-client', tenantId: 'Steven', alias: 'mbx-client', label: 'Cliente GPT', lastPublicationAt: null };
    const sent = publishFixture();
    mountChat({ initial: visitor.id, visitors: [visitor] });
    const input = await composer(visitor.label);
    expect(screen.getByRole('dialog')).toHaveTextContent('Cauce no sabe si está conectado ahora');
    fireEvent.change(input, { target: { value: 'Nota para el cliente' } });
    fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => { expect(screen.getByRole('status')).toHaveTextContent('Guardado en el buzón de Cliente GPT · no acredita lectura'); });
    expect(sent[0]).toMatchObject({ recipients: [{ tenant_id: 'Steven', alias: 'mbx-client' }], room_id: 'grp.office' });
    expect(screen.getByLabelText('Speech')).toHaveTextContent('[]');
  });

  it('moves the mobile dialog above the keyboard and removes viewport listeners on close', async () => {
    const viewport = new EventTarget();
    Object.defineProperties(viewport, { height: { configurable: true, value: 400 }, offsetTop: { configurable: true, value: 10 } });
    vi.stubGlobal('visualViewport', viewport);
    vi.spyOn(window, 'matchMedia').mockImplementation(query => ({ matches: true, media: query, onchange: null,
      addEventListener: () => undefined, removeEventListener: () => undefined, addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false }));
    const remove = vi.spyOn(viewport, 'removeEventListener');
    mountChat();
    await composer();
    const dialog = screen.getByRole('dialog');
    expect(dialog).toHaveStyle({ bottom: `${String(window.innerHeight - 410)}px` });
    Object.defineProperty(viewport, 'height', { configurable: true, value: window.innerHeight });
    act(() => { viewport.dispatchEvent(new Event('resize')); });
    expect(dialog.style.bottom).toContain('safe-area-inset-bottom');
    fireEvent.click(screen.getByRole('button', { name: 'Cerrar la charla' }));
    expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
    expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
  });
});
