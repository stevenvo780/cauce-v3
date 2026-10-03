import { expect, it, vi } from 'vitest';
import { CauceApi } from './client';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
const session = (subject: string) => ({ authenticated: true, subject, csrf_token: `csrf-${subject}` });

it('una sesión anterior no sustituye el token de un login nuevo', async () => {
  const old = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(Response.json(session('B')));
  const api = new CauceApi('http://localhost', fetcher);
  const read = api.getAuthSession();
  await api.login('b@example.test', 'fixture');
  old.resolve(Response.json(session('A')));
  await read;
  expect(await api.csrfForMutation()).toBe('csrf-B');
  expect(fetcher).toHaveBeenCalledTimes(2);
});

it.each([404, 501])('una respuesta antigua %s no degrada el login nuevo a modo sin BFF', async (status) => {
  const old = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(Response.json(session('B')));
  const api = new CauceApi('http://localhost', fetcher);
  const read = api.getAuthSession();
  await api.login('b@example.test', 'fixture');
  old.resolve(Response.json({}, { status }));
  await read;
  expect(await api.csrfForMutation()).toBe('csrf-B');
});

it('las consultas simultáneas de sesión y CSRF comparten una sola respuesta del servidor', async () => {
  const pending = deferred<Response>();
  const fetcher = vi.fn().mockReturnValue(pending.promise);
  const api = new CauceApi('http://localhost', fetcher);
  const first = api.getAuthSession();
  const second = api.getAuthSession();
  const csrf = api.csrfForMutation();
  expect(first).toBe(second);
  expect(fetcher).toHaveBeenCalledOnce();
  pending.resolve(Response.json(session('A')));
  expect(await first).toEqual(session('A'));
  expect(await second).toEqual(session('A'));
  expect(await csrf).toBe('csrf-A');
});

it('un 401 de datos de la cuenta anterior no invalida la cuenta nueva', async () => {
  const old = deferred<Response>();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(session('A')))
    .mockReturnValueOnce(old.promise).mockResolvedValueOnce(Response.json(session('B')));
  const api = new CauceApi('http://localhost', fetcher);
  await api.getAuthSession();
  const onUnauthorized = vi.fn();
  api.onUnauthorized(onUnauthorized);
  const data = api.getStatus().catch((error: unknown) => error);
  await api.getAuthSession();
  old.resolve(Response.json({}, { status: 401 }));
  await data;
  expect(onUnauthorized).not.toHaveBeenCalled();
  expect(await api.csrfForMutation()).toBe('csrf-B');
});

it('no envía una operación pendiente con las credenciales de otra cuenta', async () => {
  const old = deferred<Response>();
  const fetcher = vi.fn().mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(Response.json(session('B')));
  const api = new CauceApi('http://localhost', fetcher);
  const logout = api.logout().catch((error: unknown) => error);
  await api.login('b@example.test', 'fixture');
  old.resolve(Response.json(session('A')));
  expect(await logout).toMatchObject({ status: 409, code: 'session_changed' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(await api.csrfForMutation()).toBe('csrf-B');
});

it('una lectura anterior al cierre no restaura el token después de cerrar', async () => {
  const old = deferred<Response>();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(session('A')))
    .mockReturnValueOnce(old.promise).mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockResolvedValueOnce(Response.json({ authenticated: false }));
  const api = new CauceApi('http://localhost', fetcher);
  await api.getAuthSession();
  const read = api.getAuthSession();
  await api.logout();
  old.resolve(Response.json(session('A')));
  await read;
  await expect(api.csrfForMutation()).rejects.toMatchObject({ status: 401 });
});
