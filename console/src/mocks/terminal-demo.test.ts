import { afterEach, beforeEach, vi } from 'vitest';
import { instalarPtyDeMentira } from './terminal-demo';

let websocketOriginal: PropertyDescriptor | undefined;

beforeEach(() => {
  websocketOriginal = Object.getOwnPropertyDescriptor(globalThis, 'WebSocket');
  vi.useFakeTimers();
});

afterEach(() => {
  if (websocketOriginal) Object.defineProperty(globalThis, 'WebSocket', websocketOriginal);
  else delete (globalThis as { WebSocket?: unknown }).WebSocket;
  delete (globalThis as Record<string, unknown>).__ptyFalsa;
  vi.useRealTimers();
});

it('el demo emite ready fenced y nunca la trama legacy que la consola debe rechazar', () => {
  instalarPtyDeMentira();
  const socket = new WebSocket('ws://localhost/v3/console/terminal/stream');
  const controles: Record<string, unknown>[] = [];
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      controles.push(JSON.parse(event.data) as Record<string, unknown>);
    }
  };

  vi.advanceTimersByTime(25);

  expect(controles).toHaveLength(1);
  expect(controles[0]).toMatchObject({
    type: 'ready',
    claim_token: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) as unknown,
    claim_epoch: '1',
    claim_lease_ms: 45_000,
  });
  expect(typeof controles[0].claim_epoch).toBe('string');
  expect(controles[0]).not.toEqual({ type: 'ready' });
  socket.close();
});
