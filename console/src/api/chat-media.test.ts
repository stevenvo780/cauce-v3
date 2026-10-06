import { ApiError, CauceApi } from './client';
import { expect, it, vi } from 'vitest';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('lee el adjunto binario por índice con credenciales de sesión y conserva MIME', async () => {
  let observed: { url: string; credentials?: RequestCredentials; accept?: string } | undefined;
  const api = new CauceApi('http://localhost', ((input: RequestInfo | URL, init?: RequestInit) => {
    const request = input instanceof Request ? input : undefined;
    observed = {
      url: request?.url ?? (typeof input === 'string' ? input : input instanceof URL ? input.href : input.url),
      credentials: init?.credentials,
      accept: new Headers(init?.headers).get('accept') ?? undefined,
    };
    return Promise.resolve(new Response('image-bytes', {
      headers: { 'content-type': 'image/png' },
    }));
  }));

  const blob = await api.getMessageAttachment('message /1', 2, { signal: new AbortController().signal });

  expect(observed?.url).toBe('http://localhost/v3/console/messages/message%20%2F1/attachments/2');
  expect(observed?.credentials).toBe('include');
  expect(observed?.accept).toBe('*/*');
  expect(blob.type).toBe('image/png');
  expect(await blob.text()).toBe('image-bytes');
});

it('rechaza índices inválidos antes de la red', async () => {
  const fetcher = vi.fn();
  const api = new CauceApi('http://localhost', fetcher);
  expect(() => api.getMessageAttachment('m', -1)).toThrow(RangeError);
  expect(() => api.getMessageAttachment('m', 1.5)).toThrow(RangeError);
  expect(fetcher).not.toHaveBeenCalled();
});

it('descarga la respuesta por raíz, entrega e intento con sesión autenticada', async () => {
  const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response('reply-bytes', { headers: { 'content-type': 'audio/ogg' } }));
  const api = new CauceApi('http://localhost', fetcher);
  const blob = await api.getMessageReplyAttachment('root /1', 'delivery /2', 3, 1);
  expect(fetcher.mock.calls.at(0)?.[0]).toBe('http://localhost/v3/console/messages/root%20%2F1/replies/delivery%20%2F2/3/attachments/1');
  expect(fetcher.mock.calls.at(0)?.[1]?.credentials).toBe('include');
  expect(blob.type).toBe('audio/ogg');
  expect(await blob.text()).toBe('reply-bytes');
});

it.each([[-1, 0], [1.5, 0], [2_147_483_648, 0], [0, -1], [0, 4], [0, 0.5]])('rechaza referencia de respuesta inválida %s/%s antes de la red', (attempt, index) => {
  const fetcher = vi.fn<typeof fetch>();
  const api = new CauceApi('http://localhost', fetcher);
  expect(() => api.getMessageReplyAttachment('root', 'delivery', attempt, index)).toThrow(RangeError);
  expect(fetcher).not.toHaveBeenCalled();
});

it('decodifica errores JSON de medios como ApiError y notifica 401 sin filtrar el body como Blob', async () => {
  const fetcher = (async () => Response.json({ error: 'message_not_found', message: 'No visible' }, { status: 404 })) as typeof fetch;
  const api = new CauceApi('http://localhost', fetcher);
  await expect(api.getMessageAttachment('m', 0)).rejects.toMatchObject({
    name: 'ApiError', status: 404, code: 'message_not_found', message: 'No visible',
  });

  const unauthorized = new CauceApi('http://localhost', async () => Response.json({ error: 'unauthorized' }, { status: 401 }));
  const announce = vi.fn();
  unauthorized.onUnauthorized(announce);
  await expect(unauthorized.getMessageAttachment('m', 0)).rejects.toBeInstanceOf(ApiError);
  expect(announce).toHaveBeenCalledOnce();
});

it('descarta el blob si la sesión cambia mientras responde el servidor', async () => {
  const pending = deferred<Response>();
  let calls = 0;
  const fetcher = ((input: RequestInfo | URL) => {
    calls += 1;
    const url = input instanceof Request ? input.url : String(input);
    if (url.endsWith('/v3/auth/session')) return Promise.resolve(Response.json({ authenticated: true, subject: 'A', csrf_token: 'a' }));
    if (url.includes('/attachments/')) return pending.promise;
    return Promise.resolve(Response.json({ authenticated: true, subject: 'B', csrf_token: 'b' }));
  }) as typeof fetch;
  const api = new CauceApi('http://localhost', fetcher);
  await api.getAuthSession();
  const attachment = api.getMessageAttachment('m', 0);
  await api.login('b@example.test', 'password');
  pending.resolve(new Response('private-old-account', {
    headers: { 'content-type': 'image/png' },
  }));
  await expect(attachment).rejects.toMatchObject({ status: 409, code: 'session_changed' });
  expect(calls).toBe(3);
});
