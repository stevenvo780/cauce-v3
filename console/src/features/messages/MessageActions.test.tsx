import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { MessageActions } from './MessageActions';

it('el menú nace cerrado, Escape devuelve foco y fuera lo descarta', async () => {
  const user = userEvent.setup();
  render(<><MessageActions disabled={false} onDetail={vi.fn()} /><button>Fuera</button></>);
  const trigger = screen.getByRole('button', { name: 'Opciones del mensaje' });
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  expect(screen.getByRole('menuitem', { name: 'Ver detalle' })).toHaveFocus();
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('menu')).toBeNull();
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  fireEvent.pointerDown(screen.getByRole('button', { name: 'Fuera' }));
  expect(screen.queryByRole('menu')).toBeNull();
});

it('la relectura pendiente está detrás del menú y se ejecuta sólo al pedirla', async () => {
  const retry = vi.fn();
  const user = userEvent.setup();
  render(<MessageActions disabled={false} onDetail={vi.fn()} onRetry={retry} />);
  expect(screen.queryByRole('menuitem', { name: 'Releer respuesta' })).toBeNull();
  expect(retry).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
  await user.click(screen.getByRole('menuitem', { name: 'Releer respuesta' }));
  expect(retry).toHaveBeenCalledOnce();
  expect(screen.queryByRole('menu')).toBeNull();
});
