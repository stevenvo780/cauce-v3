import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cancelPendingInput, queueInput } from './pty-input';
import { StubWebSocket, installStubWebSocket } from './pty-socket-stub';
import { MAX_INPUT_FRAME_BYTES, MAX_PENDING_INPUT_BYTES } from './pty-types';
import type { PtyEntry } from './pty-types';

function makeEntry(overrides: Partial<PtyEntry> = {}): PtyEntry {
  return {
    inputChunks: [],
    inputBytes: 0,
    readOnly: false,
    ...overrides,
  } as unknown as PtyEntry;
}

function makeSocket(state: number = StubWebSocket.OPEN): StubWebSocket {
  const socket = new StubWebSocket('ws://test/pty');
  socket.readyState = state;
  return socket;
}

function attachSocket(entry: PtyEntry, socket: StubWebSocket): void {
  (entry as { socket?: StubWebSocket }).socket = socket;
}

let restoreWebSocket: () => void;

beforeEach(() => {
  restoreWebSocket = installStubWebSocket();
});

afterEach(() => {
  vi.useRealTimers();
  restoreWebSocket();
});

describe('cancelPendingInput', () => {
  it('descarta el batch pendiente y libera el temporizador', () => {
    const socket = makeSocket();
    const entry = makeEntry();
    attachSocket(entry, socket);
    vi.useFakeTimers();
    queueInput(entry, 'hola', () => undefined);
    expect(entry.inputChunks).toEqual(['hola']);
    expect(entry.inputTimer).toBeDefined();

    cancelPendingInput(entry);

    expect(entry.inputTimer).toBeUndefined();
    expect(entry.inputChunks).toEqual([]);
    expect(entry.inputBytes).toBe(0);
  });

  it('si no hay nada pendiente, deja la entrada en estado vacío sin llamar a clearTimeout', () => {
    const entry = makeEntry();
    const clearSpy = vi.spyOn(window, 'clearTimeout');

    cancelPendingInput(entry);

    expect(clearSpy).not.toHaveBeenCalled();
    expect(entry.inputTimer).toBeUndefined();
    expect(entry.inputChunks).toEqual([]);
    expect(entry.inputBytes).toBe(0);
  });
});

describe('queueInput — coalescing de 8 ms', () => {
  it('varias pulsaciones seguidas salen como UN solo frame tras el temporizador', () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    const entry = makeEntry();
    attachSocket(entry, socket);

    queueInput(entry, 'h', () => undefined);
    queueInput(entry, 'o', () => undefined);
    queueInput(entry, 'la', () => undefined);
    expect(socket.frames()).toEqual([]);

    vi.advanceTimersByTime(8);

    expect(socket.framesOfType('input')).toEqual([{ type: 'input', data: 'hola' }]);
    expect(entry.inputChunks).toEqual([]);
    expect(entry.inputBytes).toBe(0);
    expect(entry.inputTimer).toBeUndefined();
  });

  it('si la ráfaga siguiente llega DESPUÉS de los 8 ms, sale en dos frames y no se mezclan', () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    const entry = makeEntry();
    attachSocket(entry, socket);

    queueInput(entry, 'primera', () => undefined);
    vi.advanceTimersByTime(8);
    queueInput(entry, 'segunda', () => undefined);
    vi.advanceTimersByTime(8);

    expect(socket.framesOfType('input')).toEqual([
      { type: 'input', data: 'primera' },
      { type: 'input', data: 'segunda' },
    ]);
  });

  it('una ráfaga que cabe al inicio pero suma más de MAX_INPUT_FRAME_BYTES corta el frame en dos', () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    const entry = makeEntry();
    attachSocket(entry, socket);
    const chunkSize = Math.floor(MAX_INPUT_FRAME_BYTES / 2);
    const chunk = 'a'.repeat(chunkSize);

    queueInput(entry, chunk, () => undefined);
    queueInput(entry, chunk, () => undefined);
    queueInput(entry, chunk, () => undefined);
    vi.advanceTimersByTime(8);

    const frames = socket.framesOfType('input');
    expect(frames).toHaveLength(2);
    const totales = frames.map((f) => (f.data as string).length);
    expect(totales).toEqual([chunkSize * 2, chunkSize]);
    expect(totales[0]).toBeLessThanOrEqual(MAX_INPUT_FRAME_BYTES);
  });
});

describe('queueInput — protección contra flood', () => {
  it('un solo chunk mayor que MAX_INPUT_FRAME_BYTES cierra el canal con 4414 y llama onFlood', () => {
    const socket = makeSocket();
    const entry = makeEntry();
    attachSocket(entry, socket);
    const floods: { message: string; code: number }[] = [];
    const onFlood = (message: string, code: number) => {
      floods.push({ message, code });
    };

    queueInput(entry, 'a'.repeat(MAX_INPUT_FRAME_BYTES + 1), onFlood);

    expect(floods).toEqual([{ code: 4414, message: expect.stringMatching(/exceso de entrada/iu) as unknown }]);
    expect(socket.closeCode).toBe(4414);
    expect(socket.closeReason).toBe('input_flood');
    expect(entry.inputChunks).toEqual([]);
    expect(entry.inputBytes).toBe(0);
    expect(entry.inputTimer).toBeUndefined();
  });

  it('la suma de pulsaciones que supera MAX_PENDING_INPUT_BYTES también dispara flood aunque cada una entre sola', () => {
    vi.useFakeTimers();
    const socket = makeSocket();
    const entry = makeEntry();
    attachSocket(entry, socket);
    const floods: number[] = [];
    const chunkBytes = Math.floor(MAX_PENDING_INPUT_BYTES / 7);

    for (let index = 0; index < 6; index += 1) {
      queueInput(entry, 'a'.repeat(chunkBytes), () => undefined);
    }
    queueInput(entry, 'a'.repeat(MAX_PENDING_INPUT_BYTES - chunkBytes * 6 + 1), (_message, code) => {
      floods.push(code);
    });

    expect(floods).toEqual([4414]);
    expect(socket.closeCode).toBe(4414);
  });
});

describe('queueInput — modo readOnly', () => {
  it('una pulsación normal NI se envía NI dispara flood: el canal es de solo lectura', () => {
    const socket = makeSocket();
    const entry = makeEntry({ readOnly: true });
    attachSocket(entry, socket);
    const floods: number[] = [];

    queueInput(entry, 'q', (_message, code) => { floods.push(code); });

    expect(socket.frames()).toEqual([]);
    expect(floods).toEqual([]);
  });

  it('una respuesta técnica del terminal (DA primaria) SÍ se reenvía como terminal_response', () => {
    const socket = makeSocket();
    const entry = makeEntry({ readOnly: true });
    attachSocket(entry, socket);

    queueInput(entry, '\x1b[?1;2c', () => undefined);

    expect(socket.frames()).toEqual([{ type: 'terminal_response', data: '\x1b[?1;2c' }]);
  });

  it('si el canal no está abierto, las respuestas técnicas se descartan sin error', () => {
    const socket = makeSocket(StubWebSocket.CLOSED);
    const entry = makeEntry({ readOnly: true });
    attachSocket(entry, socket);

    queueInput(entry, '\x1b[?1;2c', () => undefined);

    expect(socket.frames()).toEqual([]);
  });
});
