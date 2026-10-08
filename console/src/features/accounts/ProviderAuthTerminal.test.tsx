import { render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ProviderAuthTerminal } from './ProviderAuthTerminal';
import type { ProviderAuthClient, ProviderAuthSnapshot } from '../../api/client/provider-auth-client';

const terminal = vi.hoisted(() => ({ writes: [] as Uint8Array[], input: undefined as ((value: string) => void) | undefined,
  resetCount: 0, disposed: false, options: { disableStdin: true, scrollback: 0 } }));
vi.mock('@xterm/xterm', () => ({ Terminal: class {
  cols = 80; rows = 24; options = terminal.options;
  constructor(options: { scrollback: number }) { terminal.options.scrollback = options.scrollback; }
  loadAddon() { return undefined; } open() { return undefined; } focus() { return undefined; }
  write(value: Uint8Array) { terminal.writes.push(value); }
  clear() { terminal.writes = []; }
  reset() { terminal.resetCount += 1; terminal.writes = []; }
  dispose() { terminal.disposed = true; }
  onData(listener: (value: string) => void) { terminal.input = listener; return { dispose: () => { terminal.input = undefined; } }; }
} }));
vi.mock('@xterm/addon-fit', () => ({ FitAddon: class { fit() { return undefined; } } }));
class Socket {
  static OPEN = 1; static sockets: Socket[] = [];
  readyState = 1; bufferedAmount = 0; binaryType = ''; sent: unknown[] = [];
  onopen: (() => void) | null = null; onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  constructor(readonly url: string) { Socket.sockets.push(this); }
  send(value: unknown) { this.sent.push(value); }
  close() { this.readyState = 3; this.onclose?.(); }
}
const snapshot: ProviderAuthSnapshot = { session_id: '00000000-0000-4000-8000-000000000051', operation_id: '00000000-0000-4000-8000-000000000050',
  provider_id: 'codex', account_id: 'main', harness_id: 'codex', host_id: 'isolated', runtime_user: 'dev', profile_id: 'main', method: 'device',
  status: 'awaiting_login', expires_at: new Date(Date.now() + 60_000).toISOString(), cleanup_pending: false, error: null };
function client(): ProviderAuthClient { return { resolveProviderAuthOperation: async () => { throw new Error('unused scope resolver'); },
  start: async () => snapshot, get: async () => snapshot, verify: async () => snapshot, cancel: async () => snapshot,
  ticket: async () => ({ ticket: '00000000-0000-4000-8000-000000000052', expires_at: new Date(Date.now() + 5000).toISOString() }) }; }
beforeEach(() => {
  terminal.writes = []; terminal.input = undefined; terminal.resetCount = 0; terminal.disposed = false; Socket.sockets = [];
  vi.stubGlobal('WebSocket', Socket);
  vi.stubGlobal('ResizeObserver', class { observe() { return undefined; } disconnect() { return undefined; } });
});
afterEach(() => { vi.unstubAllGlobals(); });
describe('sensitive provider terminal lifecycle', () => {
  it('keeps tickets out of URLs and disables binary input until the authenticated ready signal', async () => {
    const view = render(<ProviderAuthTerminal session={snapshot} client={client()} onDisconnect={() => undefined} />);
    await waitFor(() => { expect(Socket.sockets).toHaveLength(1); });
    const socket = Socket.sockets[0]; expect(socket.url).not.toContain('?');
    terminal.input?.('PRIVATE_PASSWORD'); expect(socket.sent).toEqual([]);
    socket.onopen?.(); expect(socket.sent[0]).toEqual(JSON.stringify({ type: 'auth', ticket: '00000000-0000-4000-8000-000000000052' }));
    socket.onmessage?.({ data: JSON.stringify({ type: 'ready' }) }); terminal.input?.('PRIVATE_PASSWORD');
    expect(socket.sent.some(value => ArrayBuffer.isView(value) && new TextDecoder().decode(value) === 'PRIVATE_PASSWORD')).toBe(true);
    expect(terminal.options.scrollback).toBe(0); view.unmount(); expect(terminal.disposed).toBe(true);
  });
  it('clears private live bytes on closure and unmount and never replays them into another mount', async () => {
    const disconnected = vi.fn(); const api = client();
    const view = render(<ProviderAuthTerminal session={snapshot} client={api} onDisconnect={disconnected} />);
    await waitFor(() => { expect(Socket.sockets).toHaveLength(1); });
    const bytes = new TextEncoder().encode('PRIVATE_TOKEN'); const output = new ArrayBuffer(bytes.byteLength);
    new Uint8Array(output).set(bytes); Socket.sockets[0].onmessage?.({ data: output });
    expect(terminal.writes).toHaveLength(1);
    Socket.sockets[0].close(); expect(terminal.writes).toEqual([]); expect(disconnected).toHaveBeenCalledOnce();
    view.unmount(); expect(terminal.input).toBeUndefined(); expect(terminal.disposed).toBe(true);
    const second = render(<ProviderAuthTerminal session={snapshot} client={api} onDisconnect={disconnected} />);
    await waitFor(() => { expect(Socket.sockets).toHaveLength(2); }); expect(terminal.writes).toEqual([]); second.unmount();
  });
});
