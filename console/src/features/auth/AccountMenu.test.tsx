import { act, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { CLAVE_TEMA } from '../../components/ThemeControl';
import type { AuthGateState } from './auth-session';
import { AccountMenu } from './AccountMenu';
import { CauceApi } from '../../api/client';
import { ApiProvider } from '../../api/context';
import type { ClientConnectionsPage } from '../../api/types/client-delegations';

afterEach(() => {
  document.documentElement.removeAttribute('data-theme');
  window.localStorage.removeItem(CLAVE_TEMA);
});

function gate(): AuthGateState {
  return {
    state: { authenticated: true, name: 'Operador con nombre largo', subject: 'operador@example.test' },
    status: 'in', busy: false, check: vi.fn(), login: vi.fn(), logout: vi.fn(),
  };
}

it('abre por teclado, conserva el tema elegido y devuelve el foco al cerrar', async () => {
  const user = userEvent.setup();
  render(<AccountMenu gate={gate()} />);
  const trigger = screen.getByRole('button', { name: 'Cuenta de Operador con nombre largo' });
  expect(screen.queryByRole('group', { name: 'Tema de la consola' })).toBeNull();
  await user.tab();
  expect(trigger).toHaveFocus();
  await user.keyboard('{Enter}');
  const dialog = screen.getByRole('dialog', { name: 'Cuenta y apariencia' });
  expect(trigger).toHaveAttribute('aria-expanded', 'true');
  expect(within(dialog).getByRole('heading')).toHaveFocus();
  expect(within(dialog).getByText('operador@example.test')).toBeVisible();
  expect(within(dialog).getByText('Vencimiento no informado por el servidor.')).toBeVisible();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Cerrar cuenta y apariencia' })).toHaveFocus();
  await user.tab();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Claro' })).toHaveFocus();
  await user.keyboard(' ');
  expect(document.documentElement).toHaveAttribute('data-theme', 'light');
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.keyboard('{ArrowDown}');
  expect(screen.getByRole('button', { name: 'Claro' })).toHaveAttribute('aria-pressed', 'true');
  await user.click(screen.getByRole('button', { name: 'Cerrar cuenta y apariencia' }));
  expect(trigger).toHaveFocus();
});

it('Tab sale del popover y pulsar el compositor lo cierra sin robar el foco', async () => {
  const user = userEvent.setup();
  render(<><AccountMenu gate={gate()} /><textarea aria-label="Compositor" /></>);
  const trigger = screen.getByRole('button', { name: /^Cuenta de/ });
  await user.click(trigger);
  for (let step = 0; step < 7; step += 1) await user.tab();
  expect(screen.getByRole('textbox', { name: 'Compositor' })).toHaveFocus();
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(trigger);
  await user.click(screen.getByRole('textbox', { name: 'Compositor' }));
  expect(screen.getByRole('textbox', { name: 'Compositor' })).toHaveFocus();
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

it('el cierre usa el gate existente, impide repetir la operación y conserva el error real', async () => {
  const user = userEvent.setup();
  const input = gate();
  const { rerender } = render(<AccountMenu gate={input} />);
  await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  await user.click(screen.getByRole('button', { name: 'Cerrar sesión' }));
  expect(input.logout).toHaveBeenCalledOnce();
  rerender(<AccountMenu gate={{ ...input, busy: true }} />);
  expect(screen.getByRole('button', { name: 'Cerrando…' })).toBeDisabled();
  rerender(<AccountMenu gate={{ ...input, error: new Error('No se pudo cerrar la sesión') }} />);
  expect(screen.getByRole('alert')).toHaveTextContent('No se pudo cerrar la sesión');
  expect(screen.getByRole('button', { name: 'Cerrar sesión' })).toBeEnabled();
});

it('mantiene el tema dentro de la pestaña si el almacenamiento falla y cambia la ruta', async () => {
  const user = userEvent.setup();
  const failure = () => { throw new DOMException('acceso denegado', 'SecurityError'); };
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(failure);
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(failure);
  const input = gate();
  const { rerender } = render(<AccountMenu gate={input} routeKey="messages/Steven/kant" />);
  const trigger = screen.getByRole('button', { name: /^Cuenta de/ });
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Oscuro' }));
  await user.keyboard('{Escape}');
  await user.click(trigger);
  expect(screen.getByRole('button', { name: 'Oscuro' })).toHaveAttribute('aria-pressed', 'true');
  expect(document.documentElement).toHaveAttribute('data-theme', 'dark');
  rerender(<AccountMenu gate={input} routeKey="live" />);
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(trigger);
  expect(screen.getByRole('button', { name: 'Oscuro' })).toHaveAttribute('aria-pressed', 'true');
  await user.click(screen.getByRole('button', { name: 'Sistema' }));
  await user.keyboard('{Escape}');
  await user.click(trigger);
  expect(screen.getByRole('button', { name: 'Sistema' })).toHaveAttribute('aria-pressed', 'true');
  expect(document.documentElement).not.toHaveAttribute('data-theme');
});

function passwordGate(subject = 'owner-a'): AuthGateState {
  return { ...gate(), state: { authenticated: true, name: 'Owner', subject, login_mode: 'password', csrf_token: `csrf-${subject}` } };
}

function connections(reference = 'a'.repeat(64)): ClientConnectionsPage {
  return { items: [{ connection_ref: reference, client_id: 'same-client', created_at: '2026-01-01T00:00:00Z',
    expires_at: '2099-01-01T00:00:00Z', revoked: false, binding_id: null, label: null, display_label: null,
    basis: 'owner_declared_grant', instance: 'unknown', last_publication_at: null, last_use_at: null, last_use_observed: false }], truncated: false };
}

it('opens MCP declarations only for password sessions, keeps them lazy and returns focus through both Escape levels', async () => {
  const user = userEvent.setup(); const api = new CauceApi();
  const list = vi.spyOn(api, 'listClientConnections').mockResolvedValue(connections());
  const mount = (input: AuthGateState) => <ApiProvider api={api}><AccountMenu gate={input} /></ApiProvider>;
  const view = render(mount(gate()));
  await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  expect(screen.queryByRole('button', { name: 'Conexiones MCP' })).toBeNull();
  view.rerender(mount(passwordGate()));
  await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  expect(list).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Conexiones MCP' }));
  await screen.findByRole('radio');
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Conexiones MCP' })).toHaveFocus();
  expect(screen.getByRole('dialog')).toBeVisible();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByRole('button', { name: /^Cuenta de/ })).toHaveFocus();
});

it('invalidates late MCP reads when AccountMenu changes the account instead of showing the old grants', async () => {
  const api = new CauceApi(); const user = userEvent.setup();
  let resolve!: (page: ClientConnectionsPage) => void;
  const response = new Promise<ClientConnectionsPage>(done => { resolve = done; });
  vi.spyOn(api, 'listClientConnections').mockReturnValueOnce(response).mockResolvedValue(connections('b'.repeat(64)));
  const mount = (subject: string) => <ApiProvider api={api}><AccountMenu gate={passwordGate(subject)} /></ApiProvider>;
  const view = render(mount('owner-a'));
  await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  await user.click(screen.getByRole('button', { name: 'Conexiones MCP' }));
  view.rerender(mount('owner-b'));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  await user.click(screen.getByRole('button', { name: 'Conexiones MCP' }));
  await screen.findByText('b'.repeat(64));
  await act(async () => { resolve(connections()); await response; });
  expect(screen.queryByText('a'.repeat(64))).toBeNull();
});

it('retains the exact uncertain command across closing AccountMenu and navigating within the same account', async () => {
  const api = new CauceApi(); const input = passwordGate(); const user = userEvent.setup();
  vi.spyOn(api, 'listClientConnections').mockResolvedValue(connections());
  const create = vi.spyOn(api, 'createClientDeclaration').mockRejectedValue(new TypeError('Lost response'));
  const mount = (route: string) => <ApiProvider api={api}><AccountMenu gate={input} routeKey={route} /></ApiProvider>;
  const view = render(mount('messages'));
  await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  await user.click(screen.getByRole('button', { name: 'Conexiones MCP' }));
  await user.click(await screen.findByRole('radio'));
  await user.click(screen.getByRole('button', { name: 'Guardar declaración' }));
  await screen.findByRole('alert');
  const original = create.mock.calls[0][0];
  view.rerender(mount('live'));
  expect(screen.queryByRole('dialog')).toBeNull();
  await user.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  await user.click(screen.getByRole('button', { name: 'Conexiones MCP' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Reintentar mismo intento' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Reintentar mismo intento' }));
  await waitFor(() => { expect(create).toHaveBeenCalledTimes(2); });
  expect(create.mock.calls[1][0]).toBe(original);
});
