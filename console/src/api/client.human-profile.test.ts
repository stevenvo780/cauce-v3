import { expect, it, vi } from 'vitest';
import { CauceApi } from './client';

const session = { authenticated: true, login_mode: 'password', subject: 'one@example.test', name: 'Old', csrf_token: 'csrf-one' };
const json = (body: unknown) => new Response(JSON.stringify(body), { headers: { 'content-type': 'application/json' } });
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

it('sends a CSRF-protected mutation and confirms the server name again on reload', async () => {
  let persisted = 'Old';
  const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) => {
    if (init?.method === 'PATCH') { persisted = 'Confirmed'; return json({ name: persisted }); }
    return json({ ...session, name: persisted });
  });
  const api = new CauceApi('', fetcher);
  await api.getAuthSession();
  const listener = vi.fn();
  api.onAuthSession(listener);
  await expect(api.updateHumanProfile('Submitted')).resolves.toEqual({ name: 'Confirmed' });
  expect(fetcher.mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ name: 'Submitted' }), headers: { 'X-CSRF-Token': 'csrf-one' } });
  expect(listener).toHaveBeenLastCalledWith({ ...session, name: 'Confirmed' });
  expect(await api.getAuthSession()).toEqual({ ...session, name: 'Confirmed' });
});

it('does not let a read started before saving revert the confirmed name', async () => {
  const old = deferred<Response>();
  const fetcher = vi.fn().mockResolvedValueOnce(json(session)).mockReturnValueOnce(old.promise).mockResolvedValueOnce(json({ name: 'New' }));
  const api = new CauceApi('', fetcher);
  await api.getAuthSession();
  const read = api.getAuthSession();
  await api.updateHumanProfile('New');
  old.resolve(json(session));
  expect(await read).toEqual({ ...session, name: 'New' });
});

it('ignores a late save after a new login, including a login to the same account', async () => {
  const save = deferred<Response>();
  const next = { ...session, csrf_token: 'csrf-new', name: 'Next session' };
  const fetcher = vi.fn().mockResolvedValueOnce(json(session)).mockReturnValueOnce(save.promise).mockResolvedValueOnce(json(next));
  const api = new CauceApi('', fetcher);
  await api.getAuthSession();
  const listener = vi.fn();
  api.onAuthSession(listener);
  const pending = api.updateHumanProfile('Late');
  await Promise.resolve();
  await api.login('one@example.test', 'synthetic');
  save.resolve(json({ name: 'Late' }));
  await expect(pending).rejects.toMatchObject({ code: 'session_changed' });
  expect(listener).toHaveBeenLastCalledWith(next);
  expect(listener).not.toHaveBeenCalledWith(expect.objectContaining({ name: 'Late' }));
});

it('keeps server errors recoverable and blocks duplicate pending saves', async () => {
  const save = deferred<Response>();
  const fetcher = vi.fn().mockResolvedValueOnce(json(session)).mockReturnValueOnce(save.promise).mockResolvedValueOnce(json({ name: 'Retry' }));
  const api = new CauceApi('', fetcher);
  await api.getAuthSession();
  const pending = api.updateHumanProfile('First');
  await expect(api.updateHumanProfile('Second')).rejects.toThrow('guardándose');
  save.resolve(new Response(JSON.stringify({ message: 'Try again' }), { status: 503, headers: { 'content-type': 'application/json' } }));
  await expect(pending).rejects.toThrow('Try again');
  await expect(api.updateHumanProfile('Retry')).resolves.toEqual({ name: 'Retry' });
});

it('waits for a pending save before revalidating and resolves older reads to the confirmed state', async () => {
  const old = deferred<Response>();
  const save = deferred<Response>();
  const fetcher = vi.fn().mockResolvedValueOnce(json(session)).mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(save.promise).mockResolvedValueOnce(json({ ...session, name: 'Confirmed' }));
  const api = new CauceApi('', fetcher);
  await api.getAuthSession();
  const oldRead = api.getAuthSession();
  const pending = api.updateHumanProfile('New');
  const revalidation = api.getAuthSession();
  old.resolve(json(session));
  await Promise.resolve();
  save.resolve(json({ name: 'Confirmed' }));
  await pending;
  expect(await oldRead).toEqual({ ...session, name: 'Confirmed' });
  expect(await revalidation).toEqual({ ...session, name: 'Confirmed' });
  expect(fetcher).toHaveBeenCalledTimes(4);
});
