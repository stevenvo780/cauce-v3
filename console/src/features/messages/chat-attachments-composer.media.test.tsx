import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps, SyntheticEvent } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatAttachmentsComposer } from './chat-attachments-composer';
import { ConversationPane } from './ConversationPane';
import { mockStatus, topology } from '../../mocks/data';
import { renderWithApi, testApi } from '../../test/render';
import { construirRosterDeMensajeria } from './roster';

class Recorder {
  static isTypeSupported = (type: string) => type.startsWith('audio/webm');
  static current: Recorder | undefined;
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() { Recorder.current = this; }
  start() { this.state = 'recording'; }
  stop() { this.state = 'inactive'; this.onstop?.(); }
  emit() { this.ondataavailable?.({ data: new Blob(['audio'], { type: this.mimeType }) } as BlobEvent); }
}

beforeEach(() => {
  Recorder.current = undefined;
  vi.stubGlobal('MediaRecorder', Recorder);
  vi.stubGlobal('isSecureContext', true);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: vi.fn().mockResolvedValue({ getTracks: () => [{ stop: vi.fn() }] }) } });
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });
function fixture(overrides: Partial<ComponentProps<typeof ChatAttachmentsComposer>> = {}) {
  const props: ComponentProps<typeof ChatAttachmentsComposer> = {
    agentId: 'Steven:argos', agentAlias: 'argos', canPublish: true,
    route: { allowed: true, reason: 'verified', sourceRoomIds: ['grp.steven'] },
    roomChoiceRequired: false, roomId: 'grp.steven', roomUnavailable: false,
    lane: 'interactive', text: 'Draft', files: [], sending: false, confirming: false,
    onSubmit: vi.fn((event: SyntheticEvent<HTMLFormElement>) => { event.preventDefault(); }),
    onTextChange: vi.fn(), onRoomChange: vi.fn(), onFilesChange: vi.fn(), ...overrides,
  };
  const view = render(<ChatAttachmentsComposer {...props} />);
  const form = screen.getByRole('textbox').closest('form');
  if (!form) throw new Error('Missing composer form');
  return { props, form, ...view };
}
async function startRecording() {
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  await act(async () => { await Promise.resolve(); });
  expect(screen.getByRole('button', { name: 'Finalizar nota de voz' })).toBeVisible();
}
function drop(form: HTMLFormElement) {
  const file = new File(['image'], 'image.png', { type: 'image/png' });
  const transfer = { types: ['Files'], files: [file], dropEffect: 'none' };
  fireEvent.dragOver(form, { dataTransfer: transfer });
  fireEvent.drop(form, { dataTransfer: transfer });
  return { transfer, file };
}
it.each(['Enter', 'submit'] as const)('does not submit via %s during recording', async (method) => {
  const { props, form } = fixture(); await startRecording();
  if (method === 'Enter') fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  else expect(fireEvent.submit(form)).toBe(false);
  expect(props.onSubmit).not.toHaveBeenCalled();
});
it('does not append files by drop, paste or forced file input during recording', async () => {
  const { props, form, container } = fixture(); await startRecording();
  drop(form);
  const file = new File(['image'], 'image.png', { type: 'image/png' });
  fireEvent.paste(screen.getByRole('textbox'), { clipboardData: { files: [file], items: [] } });
  const input = container.querySelector('input[type=file]');
  if (!input) throw new Error('Missing file input');
  fireEvent.change(input, { target: { files: [file] } });
  expect(props.onFilesChange).not.toHaveBeenCalled();
  expect(input).toBeDisabled();
});
it.each([
  { canPublish: false }, { route: { allowed: false, reason: 'blocked', sourceRoomIds: ['grp.steven'] } },
  { roomId: '' }, { roomUnavailable: true }, { sending: true, confirming: false },
])('blocks drop and direct submit when editing is unavailable: %j', (overrides) => {
  const { props, form } = fixture(overrides); const { transfer } = drop(form);
  expect(props.onFilesChange).not.toHaveBeenCalled(); expect(fireEvent.submit(form)).toBe(false);
  expect(props.onSubmit).not.toHaveBeenCalled(); expect(transfer.dropEffect).toBe('none');
  expect(form).not.toHaveAttribute('data-dragging-files');
});
it('accepts the completed voice file after the recorder clears recording in the same callback', async () => {
  const { props } = fixture(); await startRecording();
  act(() => { Recorder.current?.emit(); });
  fireEvent.click(screen.getByRole('button', { name: 'Finalizar nota de voz' }));
  expect(props.onFilesChange).toHaveBeenCalledOnce();
  expect(props.onFilesChange).toHaveBeenCalledWith([expect.objectContaining({ name: 'nota-de-voz.webm', type: 'audio/webm', size: 5 })]);
  expect(props.onSubmit).not.toHaveBeenCalled();
});
it('allows one direct submit and Enter when ready, preserving Shift+Enter and IME', () => {
  const { props, form } = fixture();
  expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', shiftKey: true })).toBe(true);
  expect(fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter', isComposing: true })).toBe(true);
  expect(props.onSubmit).not.toHaveBeenCalled();
  fireEvent.submit(form); fireEvent.keyDown(screen.getByRole('textbox'), { key: 'Enter' });
  expect(props.onSubmit).toHaveBeenCalledTimes(2);
});
it('keeps draft editing available during confirmation while preventing another submit', () => {
  const { props, form } = fixture({ sending: true, confirming: true }); const { file } = drop(form);
  expect(props.onFilesChange).toHaveBeenCalledWith([file]);
  fireEvent.submit(form); expect(props.onSubmit).not.toHaveBeenCalled();
});
it('allows an eligible drop and refuses direct submission of an empty draft', () => {
  const { props, form } = fixture({ text: '' }); const { file } = drop(form);
  expect(props.onFilesChange).toHaveBeenCalledWith([file]);
  fireEvent.submit(form); expect(props.onSubmit).not.toHaveBeenCalled();
});

it('keeps the focused editor enabled on sending rerender but blocks another submit and file mutation', () => {
  const { props, form, rerender } = fixture();
  const textbox = screen.getByRole('textbox');
  textbox.focus();
  fireEvent.submit(form);
  expect(props.onSubmit).toHaveBeenCalledOnce();
  rerender(<ChatAttachmentsComposer {...props} sending />);
  expect(textbox).toBeEnabled();
  expect(textbox).toHaveFocus();
  expect(screen.getByRole('button', { name: 'Enviando…' })).toBeDisabled();
  fireEvent.keyDown(textbox, { key: 'Enter' });
  fireEvent.submit(form);
  drop(form);
  expect(props.onSubmit).toHaveBeenCalledOnce();
  expect(props.onFilesChange).not.toHaveBeenCalled();
});
it('captures the original payload once and preserves the next draft while the real controller awaits publication', async () => {
  window.history.replaceState({}, '', '/messages');
  const agent = construirRosterDeMensajeria({ status: mockStatus(), topology }).find((item) => item.alias === 'argos');
  if (!agent) throw new Error('Missing agent fixture');
  const receipt = {
    message_id: '10000000-0000-4000-8000-000000000001',
    delivery_ids: ['20000000-0000-4000-8000-000000000002'], duplicate: false,
    request_id: '30000000-0000-4000-8000-000000000003', trace_id: 'trace-focused-send',
    idempotency_key: 'intent-focused-send', tenant_id: 'Steven', actor_alias: 'operator',
    request_hash: 'a'.repeat(64), causal_hash: 'b'.repeat(64),
  };
  vi.spyOn(testApi, 'preparePublishIntent').mockResolvedValue({
    version: 1, state: 'prepared', idempotency_key: receipt.idempotency_key, receipt: null,
  });
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const publish = vi.spyOn(testApi, 'publishMessage').mockImplementation(async () => { await pending; return receipt; });
  const confirm = vi.spyOn(testApi, 'confirmPublishIntent').mockResolvedValue({
    version: 1, confirmed: true, idempotency_key: receipt.idempotency_key,
    message_id: receipt.message_id, causal_hash: receipt.causal_hash,
  });
  vi.spyOn(testApi, 'getMessage').mockResolvedValue({ message_id: receipt.message_id, chain_open: false, deliveries: [] });
  renderWithApi(<ConversationPane agent={agent} loading={false} canPublish publisherSubject="Steven:operator"
    publisherHumanSubject={`human:${'a'.repeat(64)}`} page={{ items: [] }}
    route={{ allowed: true, membership: true, sourceRoomIds: ['grp.steven'], reason: 'Verified' }}
    onReload={vi.fn()} onQueueReload={vi.fn()} />);
  const textbox = screen.getByRole('textbox');
  textbox.focus();
  fireEvent.change(textbox, { target: { value: 'Captured message' } });
  const form = textbox.closest('form');
  if (!form) throw new Error('Missing composer form');
  try {
    fireEvent.submit(form);
    await waitFor(() => { expect(publish).toHaveBeenCalledOnce(); });
    expect(textbox).toBeEnabled();
    expect(textbox).toHaveFocus();
    fireEvent.change(textbox, { target: { value: 'Next unsent draft' } });
    fireEvent.keyDown(textbox, { key: 'Enter' });
    fireEvent.submit(form);
    expect(publish).toHaveBeenCalledOnce();
    expect(publish.mock.calls[0][0].body).toEqual({ text: 'Captured message' });
    expect(textbox).toHaveValue('Next unsent draft');
    await act(async () => { release(); await pending; });
    await waitFor(() => { expect(confirm).toHaveBeenCalledOnce(); });
    expect(textbox).toHaveFocus();
    expect(textbox).toHaveValue('Next unsent draft');
    expect(publish).toHaveBeenCalledOnce();
  } finally { release(); }
});
