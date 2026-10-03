import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { CLAVE_TEMA } from '../../components/ThemeControl';
import type { AuthGateState } from './auth-session';
import { AccountMenu } from './AccountMenu';

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
  for (let step = 0; step < 6; step += 1) await user.tab();
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
