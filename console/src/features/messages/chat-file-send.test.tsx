import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { ComponentProps } from 'react';
import { ApiProvider } from '../../api/context';
import type { PreparePublishIntentResult } from '../../api/types';
import { ConversationDrafts, ConversationDraftStore } from './conversation-drafts';
import { ConversationPane } from './ConversationPane';
import { mockMessages, mockStatus, topology } from '../../mocks/data';
import { renderWithApi, testApi } from '../../test/render';
import { construirRosterDeMensajeria } from './roster';

beforeEach(() => { window.history.replaceState({}, '', '/messages'); });

function props(): ComponentProps<typeof ConversationPane> {
  const agent = construirRosterDeMensajeria({ status: mockStatus(), topology }).find((item) => item.alias === 'argos');
  if (!agent) throw new Error('Missing agent fixture');
  return {
    agent, page: mockMessages(), loading: false, canPublish: true, publisherSubject: 'Steven:operator',
    publisherHumanSubject: `human:${'a'.repeat(64)}`,
    route: { allowed: true, membership: true, sourceRoomIds: ['grp.steven'], reason: 'Verified' },
    salud: { pendientes: 0, enCurso: 0, reintentos: 0, muertas: 0, muertasTruncadas: false },
    onReload: vi.fn(), onQueueReload: vi.fn(),
  };
}

function configurePublish() {
  const receipt = {
    message_id: '10000000-0000-4000-8000-000000000001',
    delivery_ids: ['20000000-0000-4000-8000-000000000002'], duplicate: false,
    request_id: '30000000-0000-4000-8000-000000000003', trace_id: 'trace-chat-files',
    idempotency_key: 'intent-chat-files', tenant_id: 'Steven', actor_alias: 'operator',
    request_hash: 'a'.repeat(64), causal_hash: 'b'.repeat(64),
  };
  const confirmation = {
    version: 1 as const, confirmed: true as const, idempotency_key: receipt.idempotency_key,
    message_id: receipt.message_id, causal_hash: receipt.causal_hash,
  };
  const prepare = vi.spyOn(testApi, 'preparePublishIntent').mockResolvedValue({
    version: 1, state: 'prepared', idempotency_key: receipt.idempotency_key, receipt: null,
  });
  const publish = vi.spyOn(testApi, 'publishMessage').mockResolvedValue(receipt);
  const confirm = vi.spyOn(testApi, 'confirmPublishIntent').mockResolvedValue(confirmation);
  vi.spyOn(testApi, 'getMessage').mockResolvedValue({ message_id: receipt.message_id, chain_open: false, deliveries: [] });
  return { receipt, prepare, publish, confirm };
}

function choose(...files: File[]) {
  const input = document.querySelector('input[type="file"]');
  if (!input) throw new Error('Missing file input');
  act(() => { fireEvent.change(input, { target: { files } }); });
}

it('envía sólo un archivo inline con bytes, SHA y body idéntico en prepare y publish; limpia al aceptar', async () => {
  const api = configurePublish();
  const file = new File(['%PDF-1.4\n'], 'informe.pdf', { type: 'application/pdf' });
  renderWithApi(<ConversationPane {...props()} page={{ items: [] }} />);
  choose(file);
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

  await waitFor(() => { expect(api.confirm).toHaveBeenCalledOnce(); });
  const prepareCall = api.prepare.mock.calls[0][0];
  const publishCall = api.publish.mock.calls[0][0];
  expect(prepareCall.body).toEqual(publishCall.body);
  expect(publishCall.body).toEqual({ text: '', attachments_v1: [{
    kind: 'document', name: 'informe.pdf', mime_type: 'application/pdf', file_size: 9,
    sha256: 'e5c62df5dab5c87b6a015ef3d43597074d1eec433b15f51aec63b8582d0e4ab4',
    content_base64: 'JVBERi0xLjQK',
  }] });
  expect(screen.queryByRole('list', { name: 'Archivos adjuntos' })).toBeNull();
  expect(screen.getByRole('textbox')).toHaveValue('');
});

it('conserva texto y archivo cuando falla la preparación durable', async () => {
  const api = configurePublish();
  api.prepare.mockRejectedValue(new Error('fallo de preparación'));
  renderWithApi(<ConversationPane {...props()} page={{ items: [] }} />);
  choose(new File(['contenido'], 'nota.txt', { type: 'text/plain' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Revisar adjunto' } });
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));

  expect(await screen.findByRole('alert')).toHaveTextContent('fallo de preparación');
  expect(screen.getByRole('textbox')).toHaveValue('Revisar adjunto');
  expect(screen.getByRole('list', { name: 'Archivos adjuntos' })).toHaveTextContent('nota.txt');
  expect(api.publish).not.toHaveBeenCalled();
});

it('rechaza cantidades excesivas sin alterar la selección previa y permite quitar un archivo', () => {
  renderWithApi(<ConversationPane {...props()} page={{ items: [] }} />);
  const files = Array.from({ length: 5 }, (_, index) => new File(['x'], `f${String(index)}.txt`, { type: 'text/plain' }));
  choose(...files.slice(0, 4));
  expect(screen.getAllByRole('button', { name: /^Quitar f/u })).toHaveLength(4);
  choose(files[4]);
  expect(screen.getByRole('alert')).toHaveTextContent('hasta 4 archivos');
  expect(screen.getAllByRole('button', { name: /^Quitar f/u })).toHaveLength(4);
  fireEvent.click(screen.getByRole('button', { name: 'Quitar f0.txt' }));
  expect(screen.getAllByRole('button', { name: /^Quitar f/u })).toHaveLength(3);
});

it('adjunta archivos pegados y arrastrados sin interferir con el pegado de texto', () => {
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: vi.fn(() => 'blob:composer-preview') });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  renderWithApi(<ConversationPane {...props()} page={{ items: [] }} />);
  const textarea = screen.getByRole('textbox');
  const pasted = new File(['png'], 'pegada.png', { type: 'image/png' });
  const paste = fireEvent.paste(textarea, { clipboardData: { files: [pasted], items: [] } });
  expect(paste).toBe(false);
  expect(screen.getByRole('list', { name: 'Archivos adjuntos' })).toHaveTextContent('pegada.png');

  const composer = textarea.closest('form');
  if (!composer) throw new Error('Missing composer');
  const dragged = new File(['video'], 'clip.mp4', { type: 'video/mp4' });
  fireEvent.dragOver(composer, { dataTransfer: { types: ['Files'], files: [dragged], dropEffect: 'none' } });
  expect(composer).toHaveAttribute('data-dragging-files', 'true');
  fireEvent.drop(composer, { dataTransfer: { types: ['Files'], files: [dragged], dropEffect: 'none' } });
  expect(screen.getByRole('list', { name: 'Archivos adjuntos' })).toHaveTextContent('pegada.png');
  expect(screen.getByRole('list', { name: 'Archivos adjuntos' })).toHaveTextContent('clip.mp4');

  const textPaste = fireEvent.paste(textarea, { clipboardData: { files: [], items: [], getData: () => 'texto pegado' } });
  expect(textPaste).toBe(true);
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(screen.getByRole('list', { name: 'Archivos adjuntos' })).toHaveTextContent('clip.mp4');
});

it.each(['agente', 'subject'] as const)('mantiene los adjuntos aislados por %s en el borrador', (scope) => {
  const input = props();
  const drafts = new ConversationDraftStore();
  const renderPane = (next: ComponentProps<typeof ConversationPane>) => (
    <ApiProvider api={testApi}><ConversationDrafts.Provider value={drafts}>
      <ConversationPane {...next} page={{ items: [] }} />
    </ConversationDrafts.Provider></ApiProvider>
  );
  const view = renderWithApi(renderPane(input));
  choose(new File(['x'], 'scope.txt', { type: 'text/plain' }));
  const other = scope === 'agente'
    ? { ...input, agent: { ...input.agent, id: 'other:agent', tenantId: 'other', alias: 'agent' } }
    : { ...input, publisherSubject: 'Steven:other', publisherHumanSubject: `human:${'b'.repeat(64)}` };
  view.rerender(renderPane(other));
  expect(screen.queryByRole('list', { name: 'Archivos adjuntos' })).toBeNull();
  view.rerender(renderPane(input));
  expect(screen.getByRole('list', { name: 'Archivos adjuntos' })).toHaveTextContent('scope.txt');
});

it('bloquea doble envío y cambios de archivos mientras conserva el siguiente borrador', async () => {
  const api = configurePublish();
  let resolvePrepare!: (value: PreparePublishIntentResult) => void;
  const pendingPrepare = new Promise<PreparePublishIntentResult>((resolve) => { resolvePrepare = resolve; });
  api.prepare.mockReturnValue(pendingPrepare);
  renderWithApi(<ConversationPane {...props()} page={{ items: [] }} />);
  choose(new File(['x'], 'one.txt', { type: 'text/plain' }));
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Una vez' } });
  const form = screen.getByRole('textbox').closest('form');
  if (!form) throw new Error('Missing composer');
  screen.getByRole('textbox').focus();
  act(() => { fireEvent.submit(form); fireEvent.submit(form); });
  expect(screen.getByRole('textbox')).toBeEnabled();
  expect(screen.getByRole('textbox')).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Adjuntar archivos' })).toBeDisabled();
  await waitFor(() => { expect(api.prepare).toHaveBeenCalledOnce(); });
  fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Siguiente borrador' } });
  fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  fireEvent.submit(form);
  expect(api.prepare).toHaveBeenCalledOnce();
  expect(api.prepare.mock.calls[0][0].body).toMatchObject({ text: 'Una vez' });
  await act(async () => { resolvePrepare({
    version: 1, state: 'prepared', idempotency_key: 'intent-chat-files', receipt: null,
  }); });
  await waitFor(() => { expect(api.confirm).toHaveBeenCalledOnce(); });
  expect(api.publish).toHaveBeenCalledOnce();
  expect(api.publish.mock.calls[0][0].body).toEqual(api.prepare.mock.calls[0][0].body);
  expect(screen.getByRole('textbox')).toHaveValue('Siguiente borrador');
  expect(screen.getByRole('textbox')).toHaveFocus();
});

it('no publica un archivo si cambia la cuenta durante su lectura', async () => {
  const api = configurePublish();
  const input = props();
  const drafts = new ConversationDraftStore();
  const file = new File(['x'], 'private.txt', { type: 'text/plain' });
  let finishRead!: (bytes: ArrayBuffer) => void;
  Object.defineProperty(file, 'arrayBuffer', { value: () => new Promise<ArrayBuffer>((resolve) => { finishRead = resolve; }) });
  const renderPane = (next: ComponentProps<typeof ConversationPane>) => (
    <ApiProvider api={testApi}><ConversationDrafts.Provider value={drafts}>
      <ConversationPane {...next} page={{ items: [] }} />
    </ConversationDrafts.Provider></ApiProvider>
  );
  const view = render(renderPane(input));
  choose(file);
  fireEvent.click(screen.getByRole('button', { name: 'Enviar' }));
  view.rerender(renderPane({ ...input, publisherHumanSubject: `human:${'b'.repeat(64)}` }));
  expect(screen.queryByRole('list', { name: 'Archivos adjuntos' })).toBeNull();
  await act(async () => { finishRead(new Uint8Array([120]).buffer); });
  expect(api.prepare).not.toHaveBeenCalled();
  expect(api.publish).not.toHaveBeenCalled();
  view.rerender(renderPane(input));
  expect(screen.getByRole('list', { name: 'Archivos adjuntos' })).toHaveTextContent('private.txt');
  expect(screen.getByRole('button', { name: 'Enviar' })).toBeEnabled();
});
