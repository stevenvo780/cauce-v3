import { act, fireEvent, render, screen } from '@testing-library/react';
import type { ComponentProps, SyntheticEvent } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ChatAttachmentsComposer } from './chat-attachments-composer';

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
