/**
 * Test double for the PTY WebSocket. jsdom has no WebSocket server, so tests install this
 * class on `globalThis.WebSocket` and drive the wire by hand: it is the only way to assert the
 * framing contract (attach first, binary = output, text = control, close codes).
 *
 * Not imported by application code; it never reaches the bundle.
 */
export class StubWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  /** Every socket opened since the last install, in order. */
  static instances: StubWebSocket[] = [];

  readonly sent: string[] = [];
  readyState: number = StubWebSocket.CONNECTING;
  binaryType = 'blob';
  closeCode?: number;
  closeReason?: string;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string | ArrayBuffer>) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;

  constructor(readonly url: string) {
    StubWebSocket.instances.push(this);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = StubWebSocket.CLOSED;
    this.closeCode = code;
    this.closeReason = reason;
  }

  /** Every frame the client sent, already parsed. */
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((raw) => JSON.parse(raw) as Record<string, unknown>);
  }

  framesOfType(type: string): Array<Record<string, unknown>> {
    return this.frames().filter((frame) => frame.type === type);
  }

  /** Completes the handshake, as a relay accepting the TCP/TLS connection would. */
  acceptOpen(): void {
    this.readyState = StubWebSocket.OPEN;
    this.onopen?.(new Event('open'));
  }

  /** Control plane: always text JSON. */
  emitControl(payload: Record<string, unknown>): void {
    this.onmessage?.(new MessageEvent('message', { data: JSON.stringify(payload) }));
  }

  emitRawText(raw: string): void {
    this.onmessage?.(new MessageEvent('message', { data: raw }));
  }

  /** PTY output: always binary. */
  emitOutput(text: string): void {
    const bytes = new TextEncoder().encode(text);
    this.emitBytes(bytes);
  }

  emitBytes(bytes: Uint8Array): void {
    // Detach a standalone ArrayBuffer so the manager may transfer it to the worker.
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    this.onmessage?.(new MessageEvent('message', { data: buffer }));
  }

  emitClose(code: number, reason = ''): void {
    this.readyState = StubWebSocket.CLOSED;
    this.onclose?.(new CloseEvent('close', { code, reason }));
  }

  emitError(): void {
    this.onerror?.(new Event('error'));
  }

  static last(): StubWebSocket {
    const socket = StubWebSocket.instances.at(-1);
    if (!socket) throw new Error('No PTY WebSocket was opened');
    return socket;
  }
}

/**
 * Installs the stub and returns the restore function. `WebSocket` is a non-writable accessor
 * once MSW's interceptor is loaded, so it has to be redefined rather than assigned.
 */
export function installStubWebSocket(): () => void {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  StubWebSocket.instances = [];
  Object.defineProperty(globalThis, 'WebSocket', { value: StubWebSocket, configurable: true, writable: true });
  return () => {
    if (original) Object.defineProperty(globalThis, 'WebSocket', original);
    else delete (globalThis as { WebSocket?: unknown }).WebSocket;
    StubWebSocket.instances = [];
  };
}
