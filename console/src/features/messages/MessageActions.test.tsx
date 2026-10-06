import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { MessageActions } from './MessageActions';

it('el menú nace cerrado, Escape devuelve el foco y fuera lo descarta', async () => {
  const user = userEvent.setup();
  render(<><MessageActions disabled={false} onDetail={vi.fn()} /><button>Fuera</button></>);
  const trigger = screen.getByRole('button', { name: 'Opciones del mensaje' });
  expect(screen.queryByRole('menu')).toBeNull();
  await user.click(trigger);
  expect(await screen.findByRole('menuitem', { name: 'Ver detalle' })).toBeVisible();
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
  expect(trigger).toHaveFocus();
  await user.click(trigger);
  await screen.findByRole('menu');
  await user.click(screen.getByRole('button', { name: 'Fuera', hidden: true }));
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
});

it('«Ver detalle» entrega el disparador para que el detalle devuelva el foco ahí', async () => {
  const user = userEvent.setup();
  const onDetail = vi.fn();
  render(<MessageActions disabled={false} onDetail={onDetail} />);
  const trigger = screen.getByRole('button', { name: 'Opciones del mensaje' });
  await user.click(trigger);
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  await waitFor(() => { expect(onDetail).toHaveBeenCalledExactlyOnceWith(trigger); });
});

it('la relectura pendiente está detrás del menú y se ejecuta sólo al pedirla', async () => {
  const retry = vi.fn();
  const user = userEvent.setup();
  render(<MessageActions disabled={false} onDetail={vi.fn()} onRetry={retry} />);
  expect(screen.queryByRole('menuitem', { name: 'Releer respuesta' })).toBeNull();
  expect(retry).not.toHaveBeenCalled();
  await user.click(screen.getByRole('button', { name: 'Opciones del mensaje' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Releer respuesta' }));
  expect(retry).toHaveBeenCalledOnce();
  await waitFor(() => { expect(screen.queryByRole('menu')).toBeNull(); });
});
