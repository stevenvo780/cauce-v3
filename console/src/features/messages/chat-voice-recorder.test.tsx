import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ChatVoiceRecorder } from './chat-voice-recorder';

class FakeTrack {
  stop = vi.fn();
}

class FakeStream {
  track = new FakeTrack();
  getTracks() { return [this.track]; }
}

class FakeRecorder {
  static isTypeSupported = vi.fn((type: string) => type.startsWith('audio/webm'));
  static startError = false;
  state: RecordingState = 'inactive';
  mimeType = 'audio/webm;codecs=opus';
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;
  start = vi.fn(() => {
    if (FakeRecorder.startError) throw new Error('unsupported');
    this.state = 'recording';
  });
  stop = vi.fn(() => {
    this.state = 'inactive';
    this.onstop?.();
  });
  emit(bytes: number[]) {
    const data = new Blob([new Uint8Array(bytes)], { type: this.mimeType });
    this.ondataavailable?.({ data } as BlobEvent);
  }
}

const recorderInstances: FakeRecorder[] = [];
let stream: FakeStream;
let getUserMedia: ReturnType<typeof vi.fn>;

function renderRecorder(availableBytes = 10_000) {
  const onFile = vi.fn();
  const onRecordingChange = vi.fn();
  const view = render(<ChatVoiceRecorder disabled={false} availableBytes={availableBytes} onFile={onFile} onRecordingChange={onRecordingChange} />);
  return { ...view, onFile, onRecordingChange };
}

beforeEach(() => {
  recorderInstances.length = 0;
  FakeRecorder.startError = false;
  FakeRecorder.isTypeSupported.mockReset().mockImplementation((type: string) => type.startsWith('audio/webm'));
  stream = new FakeStream();
  getUserMedia = vi.fn().mockResolvedValue(stream);
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: true });
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia } });
  class Recorder extends FakeRecorder {
    constructor() {
      super();
      recorderInstances.push(this);
    }
  }
  Object.defineProperty(globalThis, 'MediaRecorder', { configurable: true, value: Recorder });
});

afterEach(() => { vi.restoreAllMocks(); });

it('graba solo tras el gesto, elimina parámetros MIME y entrega un archivo de audio al finalizar', async () => {
  const { onFile, onRecordingChange } = renderRecorder();
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  await act(async () => { await Promise.resolve(); });

  expect(getUserMedia).toHaveBeenCalledOnce();
  expect(recorderInstances[0]?.start).toHaveBeenCalledWith(1_000);
  expect(onRecordingChange).toHaveBeenLastCalledWith(true);
  act(() => { recorderInstances[0]?.emit([1, 2, 3]); });
  fireEvent.click(screen.getByRole('button', { name: 'Finalizar nota de voz' }));

  expect(onFile).toHaveBeenCalledOnce();
  expect(onFile.mock.calls[0]?.[0]).toMatchObject({ type: 'audio/webm', size: 3, name: 'nota-de-voz.webm' });
  expect(stream.track.stop).toHaveBeenCalledOnce();
  expect(onRecordingChange).toHaveBeenLastCalledWith(false);
});

it('explica una denegación breve y no produce archivo', async () => {
  getUserMedia.mockRejectedValue(new DOMException('denied', 'NotAllowedError'));
  const { onFile } = renderRecorder();
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Revisá el permiso del navegador');
  expect(onFile).not.toHaveBeenCalled();
});

it('desactiva el micrófono cuando el navegador no expone un formato compatible', () => {
  FakeRecorder.isTypeSupported.mockReturnValue(false);
  renderRecorder();
  expect(screen.getByRole('button', { name: 'Grabar nota de voz' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Grabar nota de voz' })).toHaveAttribute('title', 'Este navegador no ofrece un formato de audio compatible.');
  expect(getUserMedia).not.toHaveBeenCalled();
});

it('desactiva el micrófono fuera de un contexto seguro con una explicación concreta', () => {
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
  renderRecorder();
  expect(screen.getByRole('button', { name: 'Grabar nota de voz' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Grabar nota de voz' })).toHaveAttribute('title', 'La grabación requiere HTTPS o localhost.');
  expect(getUserMedia).not.toHaveBeenCalled();
});

it('limpia el stream si MediaRecorder no logra iniciar', async () => {
  FakeRecorder.startError = true;
  const { onFile } = renderRecorder();
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo acceder al micrófono');
  expect(stream.track.stop).toHaveBeenCalledOnce();
  expect(onFile).not.toHaveBeenCalled();
});

it('cancela chunks sin archivo y detiene tracks', async () => {
  const { onFile } = renderRecorder();
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  await act(async () => { await Promise.resolve(); });
  act(() => { recorderInstances[0]?.emit([1, 2, 3]); });
  fireEvent.click(screen.getByRole('button', { name: 'Cancelar grabación' }));
  expect(onFile).not.toHaveBeenCalled();
  expect(stream.track.stop).toHaveBeenCalledOnce();
  expect(recorderInstances[0]?.ondataavailable).toBeNull();
  expect(recorderInstances[0]?.onstop).toBeNull();
});

it('detiene tracks, handler y timer al desmontar', async () => {
  const view = renderRecorder();
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  await act(async () => { await Promise.resolve(); });
  const recorder = recorderInstances[0];
  view.unmount();
  expect(stream.track.stop).toHaveBeenCalledOnce();
  expect(recorder.ondataavailable).toBeNull();
  expect(recorder.onstop).toBeNull();
  expect(recorder.stop).toHaveBeenCalledOnce();
});

it('evita getUserMedia concurrente y descarta una respuesta tardía tras deshabilitar', async () => {
  let resolveStream!: (value: FakeStream) => void;
  getUserMedia.mockReturnValue(new Promise<FakeStream>((resolve) => { resolveStream = resolve; }));
  const onRecordingChange = vi.fn();
  const view = render(<ChatVoiceRecorder disabled={false} availableBytes={10_000} onFile={vi.fn()} onRecordingChange={onRecordingChange} />);
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  expect(getUserMedia).toHaveBeenCalledOnce();
  view.rerender(<ChatVoiceRecorder disabled onFile={vi.fn()} availableBytes={10_000} onRecordingChange={onRecordingChange} />);
  await act(async () => { resolveStream(stream); await Promise.resolve(); });
  expect(stream.track.stop).toHaveBeenCalledOnce();
  expect(recorderInstances).toHaveLength(0);
});

it('cancela si un chunk excede los bytes disponibles', async () => {
  const { onFile } = renderRecorder(2);
  fireEvent.click(screen.getByRole('button', { name: 'Grabar nota de voz' }));
  await act(async () => { await Promise.resolve(); });
  act(() => { recorderInstances[0]?.emit([1, 2, 3]); });
  expect(await screen.findByRole('alert')).toHaveTextContent('alcanzó el espacio disponible');
  expect(onFile).not.toHaveBeenCalled();
  expect(stream.track.stop).toHaveBeenCalledOnce();
});
