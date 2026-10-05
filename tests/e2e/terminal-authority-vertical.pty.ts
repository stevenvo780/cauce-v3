import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { WebSocket } from 'ws';
import type { RealPtyFixture } from './real-pty-agent.fixtures.js';

export interface TerminalWireClient {
  readonly socket: WebSocket;
  readonly outputBytes: () => number;
  readonly waitControl: (predicate: (frame: Record<string, unknown>) => boolean, timeoutMs?: number) => Promise<Record<string, unknown>>;
  readonly waitOutput: (predicate: (output: string) => boolean, timeoutMs?: number) => Promise<string>;
  readonly waitForClose: (timeoutMs?: number) => Promise<number>;
  readonly sendInput: (data: string) => void;
  readonly close: () => Promise<number>;
  readonly dropTransport: () => Promise<number>;
}

function waitFor<T>(read: () => T | undefined, timeoutMs: number, label: string): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  return new Promise<T>((resolve, reject) => {
    const poll = () => {
      const value = read();
      if (value !== undefined) { resolve(value); return; }
      if (Date.now() >= deadline) { reject(new Error(`terminal WebSocket timed out waiting for ${label}`)); return; }
      setTimeout(poll, 20);
    };
    poll();
  });
}

export async function connectTerminalWire(
  fixture: RealPtyFixture,
  firstFrame: Record<string, unknown>,
): Promise<TerminalWireClient> {
  const certificate = await readFile(join(fixture.directory, 'console.crt'));
  const privateKey = await readFile(join(fixture.directory, 'console.key'));
  const authority = await readFile(join(fixture.directory, 'ca.crt'));
  const origin = `https://127.0.0.1:${String(fixture.relayPorts.browser)}`;
  const socket = new WebSocket(
    `wss://127.0.0.1:${String(fixture.relayPorts.browser)}/v3/console/terminal/relays/${fixture.relayInstanceId}/ws`,
    [],
    { cert: certificate, key: privateKey, ca: authority, origin, rejectUnauthorized: true, handshakeTimeout: 10_000 },
  );
  const controls: Record<string, unknown>[] = [];
  const output: string[] = [];
  let receivedBytes = 0;
  let binaryMessages = 0;
  let closeCode: number | undefined;
  let socketError: Error | undefined;
  socket.on('error', (error) => { socketError = error; });
  socket.on('message', (data, binary) => {
    if (binary) {
      const chunk = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data);
      binaryMessages += 1;
      receivedBytes += chunk.byteLength;
      output.push(chunk.toString('utf8'));
      return;
    }
    try {
      const frame: unknown = JSON.parse(Buffer.from(data as Buffer).toString('utf8'));
      if (typeof frame === 'object' && frame !== null && !Array.isArray(frame)) controls.push(frame as Record<string, unknown>);
    } catch {
      controls.push({ type: 'invalid-json' });
    }
  });
  socket.once('close', (code) => { closeCode = code; });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => { reject(new Error('terminal WebSocket handshake deadline')); }, 10_000);
    socket.once('open', () => { clearTimeout(timer); resolve(); });
    socket.once('error', (error) => { clearTimeout(timer); reject(new Error('terminal WebSocket handshake failed', { cause: error })); });
  });
  socket.send(JSON.stringify(firstFrame));
  return {
    socket,
    outputBytes: () => receivedBytes,
    waitControl: (predicate, timeoutMs = 15_000) => waitFor(
      () => controls.find(predicate), timeoutMs, 'control frame',
    ).catch((error: unknown) => {
      if (socketError !== undefined) throw new Error('terminal WebSocket failed while awaiting control', { cause: socketError });
      throw new Error(`control frame was not observed; close_code=${String(closeCode)} controls=${controls.map((frame) => String(frame.type)).join(',')}`,
        { cause: error });
    }),
    waitOutput: (predicate, timeoutMs = 15_000) => waitFor(
      () => { const value = output.join(''); return predicate(value) ? value : undefined; }, timeoutMs, 'PTY output',
    ).catch((error: unknown) => {
      if (socketError !== undefined) throw new Error('terminal WebSocket failed while awaiting PTY output', { cause: socketError });
      throw new Error(`PTY output was not observed; bytes=${String(receivedBytes)} binary_frames=${String(binaryMessages)} controls=${controls.map((frame) => String(frame.type)).join(',')}`
        + ` tail=${JSON.stringify(output.join('').slice(-160))}`, { cause: error });
    }),
    waitForClose: (timeoutMs = 15_000) => waitFor(() => closeCode, timeoutMs, 'socket close'),
    sendInput: (data) => {
      if (socket.readyState !== 1) throw new Error('terminal WebSocket is not open');
      socket.send(JSON.stringify({ type: 'input', data }));
    },
    close: async () => {
      if (closeCode !== undefined) return closeCode;
      const closed = waitFor(() => closeCode, 5_000, 'client detach');
      socket.close(1000, 'client detach');
      return await closed;
    },
    dropTransport: async () => {
      if (closeCode !== undefined) return closeCode;
      const closed = waitFor(() => closeCode, 5_000, 'abnormal transport close');
      socket.terminate();
      return await closed;
    },
  };
}
