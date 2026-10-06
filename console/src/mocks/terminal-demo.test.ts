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

const AUTHORITY_PROOF = 'ac2.prueba.firma';

function conectar(): { socket: WebSocket; controles: Record<string, unknown>[] } {
  instalarPtyDeMentira();
  const socket = new WebSocket('ws://localhost/v3/console/terminal/stream');
  const controles: Record<string, unknown>[] = [];
  socket.onmessage = (event) => {
    if (typeof event.data === 'string') {
      controles.push(JSON.parse(event.data) as Record<string, unknown>);
    }
  };
  return { socket, controles };
}

it('el demo calla hasta que el cliente se anuncia y entonces emite ready fenced', () => {
  const { socket, controles } = conectar();

  vi.advanceTimersByTime(60);
  expect(controles).toHaveLength(0);

  socket.send(JSON.stringify({ type: 'attach', session_id: 'demo-1', authority_proof: AUTHORITY_PROOF, cols: 80, rows: 24 }));
  vi.advanceTimersByTime(25);

  expect(controles).toHaveLength(1);
  expect(controles[0]).toMatchObject({
    type: 'ready',
    claim_token: expect.stringMatching(/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/) as unknown,
    claim_epoch: '1',
    claim_lease_ms: 45_000,
  });
  expect(typeof controles[0].claim_epoch).toBe('string');
  socket.close();
});

it('el ready lleva un resume_token r2 atado a la sesión y a la prueba de autoridad del cliente', () => {
  const { socket, controles } = conectar();
  vi.advanceTimersByTime(15);
  socket.send(JSON.stringify({ type: 'attach', session_id: 'demo-1', authority_proof: AUTHORITY_PROOF }));
  vi.advanceTimersByTime(15);

  const token = String(controles[0].resume_token);
  expect(token).toMatch(/^r2\.[A-Za-z0-9_-]+$/);
  const sobre = JSON.parse(atob(token.slice(3).replaceAll('-', '+').replaceAll('_', '/'))) as [string, string];
  expect(sobre[1]).toBe(AUTHORITY_PROOF);
  const legado = sobre[0].split('.');
  expect(legado[0]).toBe('r1');
  expect(JSON.parse(atob(legado[1].replaceAll('-', '+').replaceAll('_', '/')))).toMatchObject({ v: 1, sid: 'demo-1' });
  socket.close();
});

it('reanudar una sesión también obtiene su ready con token propio', () => {
  const { socket, controles } = conectar();
  vi.advanceTimersByTime(15);
  socket.send(JSON.stringify({ type: 'resume', session_id: 'demo-2', authority_proof: AUTHORITY_PROOF, cols: 100, rows: 30 }));
  vi.advanceTimersByTime(15);

  expect(controles).toHaveLength(1);
  expect(controles[0].type).toBe('ready');
  expect(String(controles[0].resume_token)).toMatch(/^r2\./);
  socket.close();
});
