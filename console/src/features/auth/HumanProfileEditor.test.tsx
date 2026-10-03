import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import { AccountMenu } from './AccountMenu';
import { authSessionKey } from './account-identity';
import { useAuthGate } from './auth-session';

const session = { authenticated: true, login_mode: 'password', name: 'Alba', subject: 'alba@example.test', csrf_token: 'synthetic-csrf' };
const requestUrl = (url: RequestInfo | URL) => typeof url === 'string' ? url : url instanceof URL ? url.href : url.url;
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
function Shell({ routeKey = '' }: { routeKey?: string }) {
  const gate = useAuthGate();
  return <div key={authSessionKey(gate.state)}><AccountMenu gate={gate} routeKey={routeKey} /><textarea aria-label="Borrador de mensaje" /></div>;
}
function setup() {
  let name = 'Alba';
  let fail = false;
  const fetcher = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (requestUrl(url).endsWith('/profile')) {
      if (fail) return json({ message: 'No se pudo guardar' }, 503);
      name = (JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as { name: string }).name;
      return json({ name });
    }
    if (requestUrl(url).endsWith('/session')) return json({ ...session, name });
    return json({ subject: 'synthetic:operator', roles: [], permissions: [] });
  });
  const api = new CauceApi('', fetcher);
  const view = render(<ApiProvider api={api}><Shell /></ApiProvider>);
  return { api, fetcher, view, fail: (value: boolean) => { fail = value; } };
}
async function edit() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^Cuenta de/ }));
  await user.click(screen.getByRole('button', { name: 'Editar nombre' }));
  return user;
}

it('Cuenta → Editar nombre → Guardar → reload uses the persisted name and keeps the conversational draft', async () => {
  const { api, view } = setup();
  await screen.findByRole('button', { name: 'Cuenta de Alba' });
  const user = userEvent.setup();
  await user.type(screen.getByRole('textbox', { name: 'Borrador de mensaje' }), 'Mensaje sin enviar');
  await edit();
  const input = screen.getByRole('textbox', { name: 'Tu nombre' });
  expect(input).toHaveFocus();
  expect(input).toHaveValue('Alba');
  await user.clear(input);
  await user.type(input, 'Alba nueva');
  await user.click(screen.getByRole('button', { name: 'Guardar nombre' }));
  expect(await screen.findByRole('button', { name: 'Cuenta de Alba nueva' })).toBeVisible();
  expect(screen.getByRole('status')).toHaveTextContent('Nombre guardado');
  expect(screen.getByRole('button', { name: 'Editar nombre' })).toHaveFocus();
  expect(screen.getByRole('textbox', { name: 'Borrador de mensaje' })).toHaveValue('Mensaje sin enviar');
  view.unmount();
  render(<ApiProvider api={api}><Shell /></ApiProvider>);
  expect(await screen.findByRole('button', { name: 'Cuenta de Alba nueva' })).toBeVisible();
});

it('retains a failed edit for retry and cancel discards it without discarding the conversation', async () => {
  const test = setup();
  const user = await edit();
  await user.clear(screen.getByRole('textbox', { name: 'Tu nombre' }));
  await user.type(screen.getByRole('textbox', { name: 'Tu nombre' }), 'Recuperable');
  test.fail(true);
  await user.click(screen.getByRole('button', { name: 'Guardar nombre' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo guardar');
  expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Recuperable');
  expect(screen.getByRole('button', { name: 'Cuenta de Alba' })).toBeVisible();
  test.fail(false);
  await user.click(screen.getByRole('button', { name: 'Guardar nombre' }));
  await screen.findByRole('button', { name: 'Cuenta de Recuperable' });
  await user.click(screen.getByRole('button', { name: 'Editar nombre' }));
  await user.type(screen.getByRole('textbox', { name: 'Tu nombre' }), ' descartado');
  await user.click(screen.getByRole('button', { name: 'Cancelar edición' }));
  await user.click(screen.getByRole('button', { name: 'Editar nombre' }));
  expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Recuperable');
});

it('discards unsaved editing on Escape, popover close and navigation', async () => {
  const { api, view, fetcher } = setup();
  const user = await edit();
  await user.type(screen.getByRole('textbox', { name: 'Tu nombre' }), ' changed');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('textbox', { name: 'Tu nombre' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Editar nombre' }));
  expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Alba');
  await user.click(screen.getByRole('button', { name: 'Cerrar cuenta y apariencia' }));
  await edit();
  expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Alba');
  view.rerender(<ApiProvider api={api}><Shell routeKey="another" /></ApiProvider>);
  expect(screen.queryByRole('dialog')).toBeNull();
  await edit();
  expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Alba');
  expect(fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith('/profile'))).toHaveLength(0);
});

it('does not offer a fictitious editor for external or unmanaged sessions', async () => {
  for (const state of [{ ...session, login_mode: 'redirect' }, { authenticated: null }]) {
    const api = new CauceApi('', vi.fn(async () => json(state)));
    const view = render(<ApiProvider api={api}><Shell /></ApiProvider>);
    await waitFor(() => { expect(screen.getByRole('button', { name: /Cuenta/ })).toBeVisible(); });
    await act(async () => { await api.getAuthSession(); });
    fireEvent.click(screen.getByRole('button', { name: /Cuenta/ }));
    expect(screen.queryByRole('button', { name: 'Editar nombre' })).toBeNull();
    view.unmount();
  }
});

it('sends repeated submissions once and does not report a late save inside a new account', async () => {
  let resolveSave!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => { resolveSave = resolve; });
  let active = session;
  const fetcher = vi.fn(async (url: RequestInfo | URL) => {
    if (requestUrl(url).endsWith('/profile')) return pending;
    if (requestUrl(url).endsWith('/login')) {
      active = { ...session, name: 'Bruno', subject: 'bruno@example.test', csrf_token: 'other-csrf' };
      return json(active);
    }
    if (requestUrl(url).endsWith('/session')) return json(active);
    return json({ subject: 'synthetic:operator', permissions: [] });
  });
  const api = new CauceApi('', fetcher);
  render(<ApiProvider api={api}><Shell /></ApiProvider>);
  const user = await edit();
  const input = screen.getByRole('textbox', { name: 'Tu nombre' });
  await user.type(input, ' nueva');
  const form = input.closest('form');
  if (!form) throw new Error('expected profile form');
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => { expect(fetcher.mock.calls.filter(([url]) => requestUrl(url).endsWith('/profile'))).toHaveLength(1); });
  expect(screen.getByRole('button', { name: 'Guardando…' })).toBeDisabled();
  await user.click(screen.getByRole('button', { name: 'Cancelar edición' }));
  expect(screen.getByRole('button', { name: 'Editar nombre' })).toHaveFocus();
  await act(async () => { await api.login('bruno@example.test', 'synthetic'); });
  await screen.findByRole('button', { name: 'Cuenta de Bruno' });
  await act(async () => { resolveSave(json({ name: 'Alba nueva' })); await pending; });
  expect(screen.getByRole('button', { name: 'Cuenta de Bruno' })).toBeVisible();
  expect(screen.queryByText('Nombre guardado')).toBeNull();
  await edit();
  expect(screen.getByRole('textbox', { name: 'Tu nombre' })).toHaveValue('Bruno');
});
