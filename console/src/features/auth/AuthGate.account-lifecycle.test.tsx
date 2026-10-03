import { act, render, renderHook, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState, type ReactNode } from 'react';
import { expect, it, vi } from 'vitest';
import { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import { ConsoleAccessProvider, useConsoleAccess } from '../../api/console-access';
import type { ConsoleAuthState } from '../../api/types';
import { AuthGate } from './AuthGate';
import { useAuthGate } from './auth-session';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const session = (name: string): ConsoleAuthState => ({
  authenticated: true, login_mode: 'password', subject: `${name}@example.test`, name, csrf_token: `csrf-${name}`,
});
const out: ConsoleAuthState = { authenticated: false, login_mode: 'password' };
function harness(api: CauceApi) {
  return renderHook(() => useAuthGate(), {
    wrapper: ({ children }: { children: ReactNode }) => <ApiProvider api={api}>{children}</ApiProvider>,
  });
}

it('una revalidación vieja no reabre la cuenta después del cierre ni admite clics repetidos', async () => {
  const api = new CauceApi();
  const old = deferred<ConsoleAuthState>();
  const closing = deferred<undefined>();
  const read = vi.spyOn(api, 'getAuthSession').mockResolvedValueOnce(session('A'))
    .mockReturnValueOnce(old.promise).mockResolvedValue(out);
  const logout = vi.spyOn(api, 'logout').mockReturnValue(closing.promise);
  const { result } = harness(api);
  await waitFor(() => { expect(result.current.status).toBe('in'); });
  let pending!: Promise<void>;
  act(() => { void result.current.check(); pending = result.current.logout(); void result.current.logout(); });
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(read).toHaveBeenCalledTimes(2);
  expect(logout).toHaveBeenCalledOnce();
  await act(async () => { closing.resolve(undefined); await pending; });
  expect(result.current.status).toBe('out');
  await act(async () => { old.resolve(session('A')); await old.promise; });
  expect(result.current.state).toEqual(out);
});

it('el error de cierre conserva la cuenta verificada y permite reintentar', async () => {
  const api = new CauceApi();
  vi.spyOn(api, 'getAuthSession').mockResolvedValueOnce(session('A')).mockResolvedValue(out);
  const logout = vi.spyOn(api, 'logout').mockRejectedValueOnce(new Error('Cierre interrumpido')).mockResolvedValue();
  const { result } = harness(api);
  await waitFor(() => { expect(result.current.status).toBe('in'); });
  await act(async () => { await result.current.logout(); });
  expect(result.current.state?.name).toBe('A');
  expect(result.current.error?.message).toBe('Cierre interrumpido');
  expect(result.current.busy).toBe(false);
  await act(async () => { await result.current.logout(); });
  expect(logout).toHaveBeenCalledTimes(2);
  expect(result.current.status).toBe('out');
});

it('el cierre aceptado descarta la cuenta anterior aunque falle la verificación posterior', async () => {
  const api = new CauceApi();
  vi.spyOn(api, 'getAuthSession').mockResolvedValueOnce(session('A')).mockRejectedValue(new Error('Sin conexión'));
  vi.spyOn(api, 'logout').mockResolvedValue();
  const { result } = harness(api);
  await waitFor(() => { expect(result.current.status).toBe('in'); });
  await act(async () => { await result.current.logout(); });
  expect(result.current.status).toBe('error');
  expect(result.current.state).toBeUndefined();
});

it('una consulta anterior no reemplaza la identidad del login nuevo', async () => {
  const api = new CauceApi();
  const old = deferred<ConsoleAuthState>();
  vi.spyOn(api, 'getAuthSession').mockResolvedValueOnce(out)
    .mockReturnValueOnce(old.promise).mockResolvedValue(session('B'));
  const login = vi.spyOn(api, 'login').mockResolvedValue(session('B'));
  const { result } = harness(api);
  await waitFor(() => { expect(result.current.status).toBe('out'); });
  act(() => { void result.current.check(); });
  await act(async () => { await Promise.all([result.current.login('B', 'fixture'), result.current.login('B', 'fixture')]); });
  expect(login).toHaveBeenCalledOnce();
  await act(async () => { old.resolve(session('A')); await old.promise; });
  expect(result.current.state?.name).toBe('B');
});

it('desmontar durante el cierre impide iniciar otra consulta al terminar', async () => {
  const api = new CauceApi();
  const closing = deferred<undefined>();
  const read = vi.spyOn(api, 'getAuthSession').mockResolvedValue(session('A'));
  vi.spyOn(api, 'logout').mockReturnValue(closing.promise);
  const { result, unmount } = harness(api);
  await waitFor(() => { expect(result.current.status).toBe('in'); });
  let pending!: Promise<void>;
  act(() => { pending = result.current.logout(); });
  unmount();
  await act(async () => { closing.resolve(undefined); await pending; });
  expect(read).toHaveBeenCalledOnce();
});

function PrivateView() {
  const access = useConsoleAccess();
  const [draft, setDraft] = useState('');
  return <><input aria-label="Borrador privado" value={draft} onChange={(event) => { setDraft(event.target.value); }} />
    <p>{access.data?.subject ?? 'Identidad pendiente'}</p></>;
}

it('un cambio de sesión externo descarta borradores, access y respuestas pendientes de la cuenta previa', async () => {
  const api = new CauceApi();
  const old = deferred<{ subject: string }>();
  vi.spyOn(api, 'getAuthSession').mockResolvedValueOnce(session('A')).mockResolvedValue(session('B'));
  const access = vi.spyOn(api, 'getConsoleAccess').mockReturnValueOnce(old.promise).mockResolvedValue({ subject: 'tenant:B' });
  render(<ApiProvider api={api}><AuthGate>{(gate) => <ConsoleAccessProvider>
    <strong>{gate.state?.name}</strong><PrivateView />
  </ConsoleAccessProvider>}</AuthGate></ApiProvider>);
  const user = userEvent.setup();
  await user.type(await screen.findByRole('textbox'), 'Privado de A');
  await waitFor(() => { expect(access).toHaveBeenCalledOnce(); });
  act(() => { window.dispatchEvent(new Event('focus')); });
  expect(await screen.findByText('B')).toBeVisible();
  expect(screen.getByRole('textbox')).toHaveValue('');
  expect(await screen.findByText('tenant:B')).toBeVisible();
  await act(async () => { old.resolve({ subject: 'tenant:A' }); await old.promise; });
  expect(screen.queryByText('tenant:A')).toBeNull();
  expect(screen.getByText('tenant:B')).toBeVisible();
  expect(access).toHaveBeenCalledTimes(2);
});

it.each([true, null])('un cierre no confirmado (%s) no reabre la consola ni la degrada a modo sin BFF', async (authenticated) => {
  const api = new CauceApi();
  vi.spyOn(api, 'getAuthSession').mockResolvedValueOnce(session('A')).mockResolvedValue({ authenticated });
  vi.spyOn(api, 'logout').mockResolvedValue();
  const { result } = harness(api);
  await waitFor(() => { expect(result.current.status).toBe('in'); });
  await act(async () => { await result.current.logout(); });
  expect(result.current.status).toBe('error');
  expect(result.current.state).toBeUndefined();
  expect(result.current.error?.message).toBe('El servidor no confirmó el cierre de sesión.');
});

it.each([false, null])('un login no confirmado (%s) falla cerrado después del POST', async (authenticated) => {
  const api = new CauceApi();
  vi.spyOn(api, 'getAuthSession').mockResolvedValueOnce(out).mockResolvedValue({ authenticated });
  vi.spyOn(api, 'login').mockResolvedValue(session('B'));
  const { result } = harness(api);
  await waitFor(() => { expect(result.current.status).toBe('out'); });
  await act(async () => { await result.current.login('B', 'fixture'); });
  expect(result.current.status).toBe('error');
  expect(result.current.state).toBeUndefined();
  expect(result.current.error?.message).toBe('El servidor no confirmó el inicio de sesión.');
});

it('el gate y la recarga CSRF comparten identidad antes de permitir un reintento de escritura', async () => {
  const pendingSession = deferred<Response>();
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(session('A')))
    .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockReturnValueOnce(pendingSession.promise)
    .mockResolvedValueOnce(Response.json({ status: 'cancelled' }));
  const api = new CauceApi('http://localhost', fetcher);
  const { result } = harness(api);
  await waitFor(() => { expect(result.current.state?.name).toBe('A'); });
  await act(async () => { await api.getStatus().catch(() => undefined); });
  let pendingWrite!: Promise<unknown>;
  act(() => { pendingWrite = api.cancelDelivery('synthetic-only').catch((error: unknown) => error); });
  expect(fetcher).toHaveBeenCalledTimes(3);
  await act(async () => {
    pendingSession.resolve(Response.json(session('B')));
    expect(await pendingWrite).toMatchObject({ code: 'session_changed' });
  });
  expect(fetcher).toHaveBeenCalledTimes(3);
  expect(result.current.state?.name).toBe('B');
  expect(await api.csrfForMutation()).toBe('csrf-B');
  await api.cancelDelivery('synthetic-only');
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(fetcher.mock.calls[3]?.[1]).toMatchObject({ headers: { 'X-CSRF-Token': 'csrf-B' } });
});

it('una recarga CSRF posterior a un fallo de revalidación actualiza el gate antes del reintento', async () => {
  const fetcher = vi.fn().mockResolvedValueOnce(Response.json(session('A')))
    .mockResolvedValueOnce(Response.json({}, { status: 401 }))
    .mockResolvedValueOnce(Response.json({}, { status: 500 }))
    .mockResolvedValueOnce(Response.json(session('B')))
    .mockResolvedValueOnce(Response.json({ status: 'cancelled' }));
  const api = new CauceApi('http://localhost', fetcher);
  const { result } = harness(api);
  await waitFor(() => { expect(result.current.state?.name).toBe('A'); });
  await act(async () => { await api.getStatus().catch(() => undefined); });
  await waitFor(() => { expect(result.current.error).toBeDefined(); });
  expect(result.current.state?.name).toBe('A');
  await act(async () => {
    await expect(api.cancelDelivery('synthetic-only')).rejects.toMatchObject({ code: 'session_changed' });
  });
  expect(fetcher).toHaveBeenCalledTimes(4);
  expect(result.current.state?.name).toBe('B');
  expect(result.current.error).toBeUndefined();
  expect(await api.csrfForMutation()).toBe('csrf-B');
  await api.cancelDelivery('synthetic-only');
  expect(fetcher.mock.calls[4]?.[1]).toMatchObject({ headers: { 'X-CSRF-Token': 'csrf-B' } });
});
