import { CauceApi } from './client';
import { connectionEvents, resetConnectionEventsForTests } from './connection-diagnostics';

function json(status: number): Response {
  return new Response('{}', { status, headers: { 'content-type': 'application/json' } });
}

beforeEach(() => { vi.useFakeTimers(); resetConnectionEventsForTests(); });
afterEach(() => { vi.useRealTimers(); });

function apiWith(handler: (signal: AbortSignal | undefined) => Promise<Response>) {
  const fetcher = ((_input: RequestInfo | URL, init?: RequestInit) => handler(init?.signal ?? undefined)) as typeof fetch;
  return new CauceApi('http://localhost', fetcher);
}

it('un servidor colgado avisa en 10 s o menos y no antes del segundo fallo', async () => {
  const api = apiWith((signal) => new Promise<Response>((_resolve, reject) => {
    signal?.addEventListener('abort', () => { reject(new DOMException('abort', 'AbortError')); });
  }));
  const stop = api.startHeartbeat();
  await vi.advanceTimersByTimeAsync(3_000 + 2_500 + 100);
  expect(api.connectionNotice).toBeUndefined(); // un solo fallo no basta
  await vi.advanceTimersByTimeAsync(10_000 - 5_600);
  expect(api.connectionNotice).toEqual({ kind: 'unreachable' });
  stop();
});

it('un fallo aislado no avisa y el siguiente latido correcto reinicia la cuenta', async () => {
  let n = 0;
  const api = apiWith(() => (++n === 1 ? Promise.reject(new TypeError('fetch failed')) : Promise.resolve(json(401))));
  const stop = api.startHeartbeat();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.connectionNotice).toBeUndefined();
  stop();
});

it('un 401 también demuestra que el servidor responde', async () => {
  const api = apiWith(() => Promise.resolve(json(401)));
  const stop = api.startHeartbeat();
  await vi.advanceTimersByTimeAsync(20_000);
  expect(api.connectionNotice).toBeUndefined();
  stop();
});

it('retira el aviso en cuanto el servidor contesta, sin que ninguna vista sondee', async () => {
  let caido = true;
  const api = apiWith(() => (caido ? Promise.resolve(json(503)) : Promise.resolve(json(200))));
  const stop = api.startHeartbeat();
  await vi.advanceTimersByTimeAsync(9_000);
  expect(api.connectionNotice).toEqual({ kind: 'unreachable' });
  caido = false;
  await vi.advanceTimersByTimeAsync(3_100);
  expect(api.connectionNotice).toBeUndefined();
  expect(connectionEvents().map((e) => e.event)).toContain('latido-recuperado');
  stop();
});

it('con la pestaña oculta los fallos no cuentan', async () => {
  const api = apiWith(() => Promise.reject(new TypeError('fetch failed')));
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
  const stop = api.startHeartbeat();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(api.connectionNotice).toBeUndefined();
  Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
  stop();
});

it('el registro de diagnóstico no guarda rutas ni datos del usuario', async () => {
  const api = apiWith(() => Promise.reject(new TypeError('fetch failed https://x/y?token=abc')));
  const stop = api.startHeartbeat();
  await vi.advanceTimersByTimeAsync(10_000);
  stop();
  const text = JSON.stringify(connectionEvents());
  expect(text).not.toMatch(/token|https?:|\/v3/);
  expect(text).toContain('latido-fallo');
});
