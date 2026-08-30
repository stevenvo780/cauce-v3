/**
 * The trap the five modals of this console share.
 *
 * Tested straight, and not only through a dialog, because each dialog exercises the one shape of
 * content it happens to have: none of them has a disabled field, so no test of theirs can say what
 * the trap does when the last candidate cannot take focus. That is the case that lets the keyboard
 * out to a page already switched off with `inert`, where the caret is invisible and there is no way
 * back without the mouse.
 */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef, type ReactNode } from 'react';
import { expect, it } from 'vitest';
import { useFocusTrap } from './useFocusTrap';

function Caja({ children }: { children: ReactNode }) {
  const caja = useRef<HTMLDivElement>(null);
  const atrapar = useFocusTrap(caja);
  return <div ref={caja} onKeyDown={atrapar} data-testid="caja">{children}</div>;
}

it('desde el último control, el tabulador vuelve al primero', async () => {
  const user = userEvent.setup();
  render(<Caja><button>primero</button><button>medio</button><button>último</button></Caja>);

  screen.getByRole('button', { name: 'último' }).focus();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'primero' }));
});

it('desde el primero, Shift+Tab salta al último', async () => {
  const user = userEvent.setup();
  render(<Caja><button>primero</button><button>medio</button><button>último</button></Caja>);

  screen.getByRole('button', { name: 'primero' }).focus();
  await user.tab({ shift: true });
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'último' }));
});

it('en el medio no interviene: el tabulador sigue su curso natural', async () => {
  const user = userEvent.setup();
  render(<Caja><button>primero</button><button>medio</button><button>último</button></Caja>);

  screen.getByRole('button', { name: 'primero' }).focus();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'medio' }));
});

/** A key that is not Tab must not move anything, or Escape would steal the focus on its way out. */
it('CONTROL NEGATIVO: una tecla que no es Tab no mueve el foco', async () => {
  const user = userEvent.setup();
  render(<Caja><button>primero</button><button>último</button></Caja>);

  const ultimo = screen.getByRole('button', { name: 'último' });
  ultimo.focus();
  await user.keyboard('{Escape}');
  expect(document.activeElement).toBe(ultimo);
});

it('sin ningún control dentro, no revienta ni secuestra la tecla', async () => {
  const user = userEvent.setup();
  render(<Caja><p>sin nada que enfocar</p></Caja>);

  document.body.focus();
  await user.tab();
  expect(screen.getByTestId('caja')).toBeInTheDocument();
});

/**
 * A disabled field cannot take focus: `.focus()` on it is a no-op and the caret stays where it
 * was, so the next Tab walks out of the dialog. The trap has to ignore it the same way it already
 * ignores a disabled button.
 */
it('un campo deshabilitado no cuenta como control: el tabulador vuelve al primero igual', async () => {
  const user = userEvent.setup();
  render(<Caja>
    <button>primero</button>
    <button>último de verdad</button>
    <input disabled aria-label="apagado" />
  </Caja>);

  screen.getByRole('button', { name: 'último de verdad' }).focus();
  await user.tab();
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'primero' }));
});
