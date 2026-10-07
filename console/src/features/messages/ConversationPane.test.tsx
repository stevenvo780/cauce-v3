import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CauceApi, ApiError } from '../../api/client';
import { ApiProvider } from '../../api/context';
import type { MessagePage, PublishResult } from '../../api/types';
import { ConversationPane } from './ConversationPane';
import type { AgenteDeMensajeria } from './roster';

const agent: AgenteDeMensajeria = {
  id: 'Empresa:agente', tenantId: 'Empresa', alias: 'agente', roomIds: ['sala'],
  roomMembership: { sala: true }, membershipEnabled: true, leaseState: 'online',
  origenes: ['topologia'], mensajesVisibles: 0,
};
const receipt = {
  message_id: 'a0000000-0000-4000-8000-000000000001',
  delivery_ids: ['b0000000-0000-4000-8000-000000000001'], duplicate: false,
  request_id: 'c0000000-0000-4000-8000-000000000001', trace_id: 'trace',
  idempotency_key: 'intent', tenant_id: 'Empresa', actor_alias: 'operador',
  request_hash: 'a'.repeat(64), causal_hash: 'b'.repeat(64),
};
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error('not initialized'); };
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  const api = new CauceApi('http://localhost');
  const publish = deferred<PublishResult>();
  const preparePublishIntent = vi.spyOn(api, 'preparePublishIntent').mockResolvedValue({ version: 1, state: 'prepared', idempotency_key: 'intent', receipt: null });
  const publishMessage = vi.spyOn(api, 'publishMessage').mockReturnValue(publish.promise);
  vi.spyOn(api, 'confirmPublishIntent').mockResolvedValue({ version: 1, confirmed: true, idempotency_key: 'intent', message_id: receipt.message_id, causal_hash: receipt.causal_hash });
  const getMessage = vi.spyOn(api, 'getMessage').mockReturnValue(new Promise(() => {}));
  const props = {
    agent, page: { items: [] } as MessagePage, loading: false, canPublish: true,
    publisherSubject: 'Empresa:operador', publisherHumanSubject: `human:${'a'.repeat(64)}`,
    route: { allowed: true, sourceRoomIds: ['sala'], membership: true, reason: '' },
    onReload: vi.fn(), onQueueReload: vi.fn(),
  };
  const view = (next = props, nextApi = api) => <ApiProvider api={nextApi}><ConversationPane {...next} /></ApiProvider>;
  const rendered = render(view());
  const input = screen.getByRole('textbox', { name: /mensaje para agente/i });
  const submit = (text = 'mensaje inmediato') => {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole('button', { name: /^enviar$/i }));
  };
  return { api, publish, preparePublishIntent, publishMessage, getMessage, input, props, view, rendered, submit };
}

describe('publicación visible antes de la respuesta de red', () => {
  it('muestra la fila y reloj al submit; el recibo pone enviado aun sin feed', async () => {
    const test = setup();
    test.submit();
    const log = screen.getByRole('log');
    expect(within(log).getByText('mensaje inmediato')).toBeInTheDocument();
    expect(within(log).getByRole('status', { name: 'Publicación: Enviando' })).toHaveTextContent('◷');
    expect(test.getMessage).not.toHaveBeenCalled();
    expect(test.input).toHaveValue('mensaje inmediato');
    await act(async () => { test.publish.resolve(receipt); });
    expect(within(log).getByRole('status', { name: /Entrega: Enviado/ })).toHaveTextContent('✓');
    expect(test.input).toHaveValue('');
    expect(test.getMessage).toHaveBeenCalledWith(receipt.message_id);
    test.rendered.rerender(test.view({ ...test.props, page: { items: [] } }));
    expect(within(screen.getByRole('log')).getAllByText('mensaje inmediato')).toHaveLength(1);
  });

  it('reconcilia el feed por ID y destinatario sin duplicar ni perder el texto completo', async () => {
    const test = setup();
    const text = 'texto completo '.repeat(30);
    test.submit(text);
    await act(async () => { test.publish.resolve(receipt); });
    const delivery = { delivery_id: receipt.delivery_ids[0], recipient_tenant: 'Empresa', recipient_alias: 'agente', status: 'accepted' as const };
    test.rendered.rerender(test.view({ ...test.props, page: { items: [{ message_id: receipt.message_id, created_at: new Date().toISOString(), body_preview: text.slice(0, 240), deliveries: [delivery] }] } }));
    const log = screen.getByRole('log');
    expect(log.querySelectorAll('article[data-message-id]')).toHaveLength(1);
    expect(within(log).getByText(text.trim())).toBeInTheDocument();
    expect(within(log).getByRole('status', { name: /Recibido por el agente/ }).querySelector('[data-checks="2"]')).toBeInTheDocument();
  });

  it('un rechazo conserva borrador y muestra fallo sin un check falso', async () => {
    const test = setup();
    test.preparePublishIntent.mockRejectedValue(new ApiError('rechazado', 403));
    test.submit();
    const failure = await screen.findByRole('status', { name: 'Publicación: Sin confirmar' });
    expect(failure.querySelector('[data-checks]')).toBeNull();
    expect(test.input).toHaveValue('mensaje inmediato');
    expect(test.publishMessage).not.toHaveBeenCalled();
  });

  it('un recibo tardío no cruza al scope de otro humano', async () => {
    const test = setup();
    test.submit();
    test.rendered.rerender(test.view({ ...test.props, publisherHumanSubject: `human:${'b'.repeat(64)}` }));
    await act(async () => { test.publish.resolve(receipt); });
    expect(screen.queryByText('mensaje inmediato')).toBeNull();
    expect(test.getMessage).not.toHaveBeenCalled();
  });

  it.each(['tenant', 'alias', 'actor', 'api'] as const)('un envío pendiente no cruza al cambiar %s', async (scope) => {
    const test = setup();
    test.submit();
    const next = { ...test.props,
      agent: scope === 'tenant' ? { ...agent, tenantId: 'Otra' }
        : scope === 'alias' ? { ...agent, alias: 'otro' } : agent,
      publisherSubject: scope === 'actor' ? 'Otra:operador' : test.props.publisherSubject,
    };
    test.rendered.rerender(test.view(next, scope === 'api' ? new CauceApi('http://localhost') : test.api));
    await act(async () => { test.publish.resolve(receipt); });
    expect(screen.queryByText('mensaje inmediato')).toBeNull();
    expect(test.getMessage).not.toHaveBeenCalled();
  });

  it('una ruta denegada no crea fila ni inicia publicación', async () => {
    const test = setup();
    test.rendered.rerender(test.view({ ...test.props, route: { ...test.props.route, allowed: false } }));
    await act(async () => { test.submit(); });
    expect(screen.queryByRole('log')).toBeNull();
    expect(test.preparePublishIntent).not.toHaveBeenCalled();
  });

  it('el detalle recibido actualiza los checks aunque el polling del feed todavía no lo incluya', async () => {
    const test = setup();
    test.getMessage.mockResolvedValue({ message_id: receipt.message_id, chain_open: true,
      deliveries: [{ delivery_id: receipt.delivery_ids[0], tenant_id: 'Empresa', alias: 'agente', status: 'accepted' }] });
    test.submit();
    await act(async () => { test.publish.resolve(receipt); });
    const delivery = await within(screen.getByRole('log')).findByRole('status', { name: /Recibido por el agente/ });
    expect(delivery.querySelector('[data-checks="2"]')).toBeInTheDocument();
    expect(delivery).toHaveAttribute('title', expect.stringContaining('Lectura sin comprobar'));
  });

  it('un error al leer adjuntos mantiene el archivo y borrador y nunca publica', async () => {
    const test = setup();
    const file = new File(['contenido'], 'documento.txt', { type: 'text/plain' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => Promise.reject(new Error('archivo no legible')) });
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error('missing file input');
    fireEvent.change(input, { target: { files: [file] } });
    test.submit('texto y adjunto');
    expect(within(screen.getByRole('log')).getByText('documento.txt')).toBeInTheDocument();
    await screen.findByRole('status', { name: 'Publicación: Sin confirmar' });
    expect(test.input).toHaveValue('texto y adjunto');
    expect(screen.getByRole('button', { name: /quitar.*documento/i })).toBeInTheDocument();
    expect(test.preparePublishIntent).not.toHaveBeenCalled();
    expect(test.getMessage).not.toHaveBeenCalled();
  });

  it('mantiene la imagen local visible mientras se leen sus bytes y libera su URL al cambiar de humano', async () => {
    const create = vi.fn(() => 'blob:local-image');
    const revoke = vi.fn();
    vi.stubGlobal('URL', class extends URL {
      static createObjectURL = create;
      static revokeObjectURL = revoke;
    });
    const test = setup();
    const file = new File(['image'], 'foto.png', { type: 'image/png' });
    Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise(() => {}) });
    const input = document.querySelector('input[type="file"]');
    if (!input) throw new Error('missing file input');
    fireEvent.change(input, { target: { files: [file] } });
    await act(async () => { test.submit('foto local'); });
    expect(within(screen.getByRole('log')).getByRole('img', { name: 'Adjunto local: foto.png' })).toHaveAttribute('src', 'blob:local-image');
    expect(create).toHaveBeenCalledWith(file);
    await act(async () => { test.rendered.rerender(test.view({ ...test.props, publisherHumanSubject: `human:${'b'.repeat(64)}` })); });
    expect(revoke).toHaveBeenCalledWith('blob:local-image');
    expect(test.preparePublishIntent).not.toHaveBeenCalled();
  });
});
