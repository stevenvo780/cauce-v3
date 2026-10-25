import { ApiError, CauceApi } from './client';

function json(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function fetcherFor(handler: (path: string, method: string) => Response | Promise<Response>) {
  const calls: { path: string; method: string }[] = [];
  const fetcher = ((input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({ path: url.pathname, method });
    return Promise.resolve(handler(url.pathname, method));
  }) as typeof fetch;
  return { fetcher, calls };
}

it('una lectura ante 502 reintenta con espera y termina leyendo', async () => {
  let intentos = 0;
  const { fetcher, calls } = fetcherFor(() => (++intentos < 3 ? json(502, { message: 'bad gateway' }) : json(200, { ok: true })));
  const api = new CauceApi('http://localhost', fetcher);
  await expect(api.getStatus()).resolves.toMatchObject({ ok: true });
  expect(calls.filter((call) => call.path === '/v3/status')).toHaveLength(3);
});

it('una lectura ante error de red reintenta y avisa que está reconectando', async () => {
  let intentos = 0;
  const { fetcher } = fetcherFor(() => {
    if (++intentos === 1) throw new TypeError('fetch failed');
    return json(200, { ok: true });
  });
  const api = new CauceApi('http://localhost', fetcher);
  const avisos: string[] = [];
  api.onConnectionNotice((notice) => { avisos.push(notice?.kind ?? 'sin-aviso'); });
  await expect(api.getStatus()).resolves.toMatchObject({ ok: true });
  expect(avisos).toContain('reconnecting');
});

it('un 500 de aplicación no se reintenta', async () => {
  const { fetcher, calls } = fetcherFor(() => json(500, { message: 'boom' }));
  const api = new CauceApi('http://localhost', fetcher);
  await expect(api.getStatus()).rejects.toMatchObject({ status: 500 });
  expect(calls).toHaveLength(1);
});

it('una escritura ante 503 no se reintenta sola y el aviso permite reintentarla a mano', async () => {
  let intentos = 0;
  const { fetcher, calls } = fetcherFor((path) => {
    if (path === '/v3/auth/session') return json(200, { authenticated: true, csrf_token: 'tok', subject: 'a:b' });
    return ++intentos === 1 ? json(503, { message: 'unavailable' }) : new Response(null, { status: 204 });
  });
  const api = new CauceApi('http://localhost', fetcher);
  const avisos: string[] = [];
  api.onConnectionNotice((notice) => { avisos.push(notice?.kind ?? 'sin-aviso'); });
  await expect(api.logout()).rejects.toBeInstanceOf(ApiError);
  expect(calls.filter((call) => call.path === '/v3/auth/logout')).toHaveLength(1);
  expect(avisos).toContain('write-failed');
  await expect(api.retryLastFailedWrite()).resolves.toBeUndefined();
  expect(calls.filter((call) => call.path === '/v3/auth/logout')).toHaveLength(2);
});

it('una lectura que agota los reintentos deja el aviso «unreachable» hasta que otra lectura responde', async () => {
  let caido = true;
  const { fetcher } = fetcherFor(() => { if (caido) throw new TypeError('fetch failed'); return json(200, { ok: true }); });
  const api = new CauceApi('http://localhost', fetcher);
  await expect(api.getStatus()).rejects.toBeInstanceOf(TypeError);
  expect(api.connectionNotice).toEqual({ kind: 'unreachable' });
  caido = false;
  await expect(api.getStatus()).resolves.toMatchObject({ ok: true });
  expect(api.connectionNotice).toBeUndefined();
});

it('una lectura que vence el tiempo máximo no se reintenta y avisa que no hay conexión', async () => {
  const { fetcher, calls } = fetcherFor(() => new Promise<Response>(() => undefined));
  const api = new CauceApi('http://localhost', fetcher, undefined, 20);
  await expect(api.getStatus()).rejects.toMatchObject({ status: 504, code: 'timeout' });
  expect(calls).toHaveLength(1);
  expect(api.connectionNotice).toEqual({ kind: 'unreachable' });
});
