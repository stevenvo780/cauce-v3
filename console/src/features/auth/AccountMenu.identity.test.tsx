import { act, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import { App } from '../../App';
import { server } from '../../mocks/server';
import { renderWithApi } from '../../test/render';
import { AccountMenu } from './AccountMenu';
import type { AuthGateState } from './auth-session';

function gate(name = 'Steven'): AuthGateState {
  return {
    state: { authenticated: true, login_mode: 'password', name, subject: 'steven@example.test' },
    status: 'in', busy: false, check: vi.fn(), login: vi.fn(), logout: vi.fn(),
  };
}
async function openAccount() {
  const user = userEvent.setup();
  await user.click(await screen.findByRole('button', { name: /^Cuenta de/ }));
  return user;
}

it('separa el perfil humano de la identidad técnica autenticada y no ofrece elegir actor', async () => {
  render(<AccountMenu gate={gate()} />);
  await openAccount();
  const account = within(screen.getByRole('dialog'));
  expect(account.getByText('Perfil humano actual')).toBeVisible();
  expect(account.getByText('Steven')).toBeVisible();
  expect(account.getByText('Identidad técnica')).toBeVisible();
  expect(await account.findByText('Steven:kant')).toBeVisible();
  expect(account.getByText(/no es el nombre de la persona/i)).toBeVisible();
  expect(account.queryByRole('combobox')).toBeNull();
  expect(account.queryByRole('textbox')).toBeNull();
});

it('un perfil sin nombre no se sustituye por el correo ni por Kant', async () => {
  render(<AccountMenu gate={gate('  ')} />);
  expect(screen.getByRole('button', { name: 'Cuenta de Persona autenticada' })).toBeVisible();
  expect(screen.queryByRole('button', { name: /steven@example|kant/i })).toBeNull();
  await openAccount();
  expect(within(screen.getByRole('dialog')).getByText('steven@example.test')).toBeVisible();
});

it('un error de access no inventa una identidad técnica y permite verificarla de nuevo', async () => {
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({}, { status: 500 })));
  render(<AccountMenu gate={gate()} />);
  const user = await openAccount();
  expect(await screen.findByText('No se pudo verificar la identidad técnica.')).toBeVisible();
  expect(screen.queryByText('Steven:kant')).toBeNull();
  server.use(http.get('*/v3/console/access', () => HttpResponse.json({ subject: 'Pablo:zeus' })));
  await user.click(screen.getByRole('button', { name: 'Reintentar identidad' }));
  expect(await screen.findByText('Pablo:zeus')).toBeVisible();
  expect(within(screen.getByRole('dialog')).getByText('Steven')).toBeVisible();
});

it('cancelar, Escape, cerrar y navegar descartan el cambio pendiente sin cerrar la sesión', async () => {
  const input = gate();
  const { rerender } = render(<AccountMenu gate={input} routeKey="messages" />);
  const user = await openAccount();
  await user.click(screen.getByRole('button', { name: 'Cambiar cuenta' }));
  expect(screen.getByText(/se cerrará esta sesión/i)).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Cancelar cambio' }));
  expect(screen.getByRole('button', { name: 'Cambiar cuenta' })).toHaveFocus();
  expect(screen.queryByRole('button', { name: 'Cerrar sesión y continuar' })).toBeNull();
  for (const dismiss of ['escape', 'close', 'route']) {
    await user.click(screen.getByRole('button', { name: 'Cambiar cuenta' }));
    if (dismiss === 'escape') await user.keyboard('{Escape}');
    if (dismiss === 'close') await user.click(screen.getByRole('button', { name: 'Cerrar cuenta y apariencia' }));
    if (dismiss === 'route') rerender(<AccountMenu gate={input} routeKey="live" />);
    expect(screen.queryByRole('dialog')).toBeNull();
    await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
    expect(screen.queryByRole('button', { name: 'Cerrar sesión y continuar' })).toBeNull();
  }
  expect(input.logout).not.toHaveBeenCalled();
});

it('la confirmación usa sólo logout y mantiene su error visible si el cierre falla', async () => {
  const input = gate();
  const { rerender } = render(<AccountMenu gate={input} />);
  const user = await openAccount();
  await user.click(screen.getByRole('button', { name: 'Cambiar cuenta' }));
  await user.click(screen.getByRole('button', { name: 'Cerrar sesión y continuar' }));
  expect(input.logout).toHaveBeenCalledOnce();
  expect(input.login).not.toHaveBeenCalled();
  rerender(<AccountMenu gate={{ ...input, busy: true }} />);
  expect(screen.getByRole('button', { name: 'Cerrando…' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Cancelar cambio' })).toBeDisabled();
  rerender(<AccountMenu gate={{ ...input, error: new Error('Conexión interrumpida') }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('Conexión interrumpida');
  expect(screen.getByRole('button', { name: 'Cerrar sesión y continuar' })).toBeEnabled();
});

it('el proveedor externo se explica sin prometer una selección de cuentas que no ofrece el contrato', async () => {
  const input = gate();
  render(<AccountMenu gate={{ ...input, state: { ...input.state, authenticated: true, login_mode: 'redirect' } }} />);
  const user = await openAccount();
  await user.click(screen.getByRole('button', { name: 'Cambiar cuenta' }));
  expect(screen.getByText(/el proveedor de acceso puede volver a usar la misma cuenta/i)).toBeVisible();
});

it('atrás y adelante cierran la confirmación sin restaurarla ni ejecutar logout', async () => {
  window.history.replaceState(null, '', '/messages');
  server.use(http.get('*/v3/auth/session', () => HttpResponse.json({ ...gate().state, csrf_token: 'fixture' })));
  const logout = vi.fn();
  server.use(http.post('*/v3/auth/logout', () => { logout(); return new HttpResponse(null, { status: 204 }); }));
  renderWithApi(<App />);
  const user = await openAccount();
  await user.click(screen.getByRole('button', { name: 'Cambiar cuenta' }));
  await user.click(screen.getByRole('link', { name: 'Oficina' }));
  expect(window.location.pathname).toBe('/live');
  expect(screen.queryByRole('dialog')).toBeNull();
  const travel = async (direction: 'back' | 'forward') => {
    const arrived = new Promise<void>((resolve) => { window.addEventListener('popstate', () => { resolve(); }, { once: true }); });
    await act(async () => { window.history[direction](); await arrived; });
    expect(screen.queryByRole('dialog')).toBeNull();
  };
  await travel('back');
  expect(window.location.pathname).toBe('/messages');
  await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  expect(screen.queryByRole('button', { name: 'Cerrar sesión y continuar' })).toBeNull();
  await user.click(screen.getByRole('button', { name: 'Cambiar cuenta' }));
  await travel('forward');
  expect(window.location.pathname).toBe('/live');
  expect(logout).not.toHaveBeenCalled();
});
