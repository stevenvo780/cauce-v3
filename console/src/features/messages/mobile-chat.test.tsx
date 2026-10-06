import { act, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useRef } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { useConversationViewport } from './use-conversation-viewport';

function ViewportHarness() {
  const ref = useRef<HTMLDivElement>(null);
  useConversationViewport(ref);
  return <div ref={ref} data-testid="shell"><form data-chat-composer><textarea aria-label="Mensaje" /></form><button>Salir</button></div>;
}

afterEach(() => { vi.unstubAllGlobals(); });

it('ajusta al viewport visual y recupera la navegación después del teclado', async () => {
  const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 844);
  const user = userEvent.setup();
  render(<ViewportHarness />);
  const shell = screen.getByTestId('shell');
  await user.click(screen.getByRole('textbox'));
  act(() => { viewport.height = 444; viewport.dispatchEvent(new Event('resize')); });
  expect(shell).toHaveAttribute('data-keyboard-open', 'true');
  expect(shell.style.getPropertyValue('--messenger-viewport-height')).toBe('444px');
  expect(shell.style.getPropertyValue('--messenger-navigation-height')).toBe('0px');
  act(() => { viewport.height = 844; viewport.dispatchEvent(new Event('resize')); });
  expect(shell).not.toHaveAttribute('data-keyboard-open');
  expect(shell.style.getPropertyValue('--messenger-navigation-height')).toBe('');
});

it('la reducción sin foco no finge teclado y limpia listeners al desmontar', async () => {
  const viewport = Object.assign(new EventTarget(), { height: 400, offsetTop: 12 });
  vi.stubGlobal('visualViewport', viewport);
  vi.stubGlobal('innerHeight', 844);
  const remove = vi.spyOn(viewport, 'removeEventListener');
  const { unmount } = render(<ViewportHarness />);
  const shell = screen.getByTestId('shell');
  expect(shell).not.toHaveAttribute('data-keyboard-open');
  expect(shell.style.getPropertyValue('--messenger-viewport-height')).toBe('412px');
  unmount();
  expect(remove).toHaveBeenCalledWith('resize', expect.any(Function));
  expect(remove).toHaveBeenCalledWith('scroll', expect.any(Function));
});
