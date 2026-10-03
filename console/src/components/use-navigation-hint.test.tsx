import { act, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useNavigationHint } from './use-navigation-hint';

function Harness({ enabled = true, route = 'messages', activate = vi.fn() }) {
  const hint = useNavigationHint(enabled, route);
  return <aside {...hint.bindings}>
    <button aria-label="Conversaciones" data-navigation-label="Conversaciones" onClick={activate}><svg /></button>
    <button aria-label="Herramientas" data-navigation-label="Herramientas" onClick={activate}><svg /></button>
    {hint.hint}
  </aside>;
}
function pointer(type: string, target: Element, extra: Record<string, unknown> = {}) {
  fireEvent(target, Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
    pointerType: 'touch', isPrimary: true, clientX: 20, clientY: 20, ...extra,
  }));
}
function advance(ms: number) { act(() => { vi.advanceTimersByTime(ms); }); }
beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

it('enseña nombres con teclado, admite Escape y no añade paradas de Tab', async () => {
  vi.useRealTimers();
  const user = userEvent.setup();
  render(<Harness />);
  await user.tab();
  expect(screen.getByRole('button', { name: 'Conversaciones' })).toHaveFocus();
  expect(screen.getByRole('tooltip')).toHaveTextContent('Conversaciones');
  await user.keyboard('{Escape}');
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  await user.tab();
  expect(screen.getByRole('button', { name: 'Herramientas' })).toHaveFocus();
  expect(screen.getByRole('tooltip')).toHaveTextContent('Herramientas');
});
it('mantener pulsado descubre el nombre sin navegar; el siguiente toque sí activa', () => {
  const activate = vi.fn();
  render(<Harness activate={activate} />);
  const button = screen.getByRole('button', { name: 'Conversaciones' });
  const icon = button.querySelector('svg');
  if (!icon) throw new Error('Falta el icono del control');
  pointer('pointerdown', icon);
  advance(499);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  advance(1);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Conversaciones');
  pointer('pointerup', button);
  pointer('pointerout', button);
  fireEvent.click(button, { detail: 1 });
  expect(activate).not.toHaveBeenCalled();
  expect(screen.getByRole('tooltip')).toBeInTheDocument();
  pointer('pointerdown', button);
  pointer('pointerup', button);
  fireEvent.click(button, { detail: 1 });
  expect(activate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});
it('un toque corto no espera el temporizador ni muestra una etiqueta tarde', () => {
  const activate = vi.fn();
  render(<Harness activate={activate} />);
  const button = screen.getByRole('button', { name: 'Conversaciones' });
  pointer('pointerdown', button);
  advance(100);
  pointer('pointerup', button);
  fireEvent.click(button, { detail: 1 });
  advance(600);
  expect(activate).toHaveBeenCalledOnce();
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});
it.each(['pointercancel', 'pointerout', 'pointermove'])('cancela %s sin dejar etiqueta o supresión', (type) => {
  const activate = vi.fn();
  render(<Harness activate={activate} />);
  const button = screen.getByRole('button', { name: 'Conversaciones' });
  pointer('pointerdown', button);
  pointer(type, button, { clientX: 40 });
  advance(600);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.click(button, { detail: 1 });
  expect(activate).toHaveBeenCalledOnce();
});
it('retira el nombre tras soltar y nunca bloquea una activación de teclado', () => {
  const activate = vi.fn();
  render(<Harness activate={activate} />);
  const button = screen.getByRole('button', { name: 'Conversaciones' });
  pointer('pointerdown', button);
  advance(500);
  pointer('pointerup', button);
  fireEvent.click(button, { detail: 0 });
  expect(activate).toHaveBeenCalledOnce();
  pointer('pointerdown', button);
  advance(500);
  pointer('pointerup', button);
  advance(1500);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});
it('un cambio de ruta, perder la ventana o salir de móvil limpian la etiqueta', () => {
  const view = render(<Harness />);
  const button = screen.getByRole('button', { name: 'Conversaciones' });
  fireEvent.focus(button);
  expect(screen.getByRole('tooltip')).toBeInTheDocument();
  view.rerender(<Harness route="live" />);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.focus(button);
  fireEvent.blur(window);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  pointer('pointerdown', button);
  view.rerender(<Harness enabled={false} />);
  advance(1000);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
  fireEvent.focus(button);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});


it.each(['during', 'after'])('el foco que cambia %s de mantener pulsado no activa el segundo control', (when) => {
  const activate = vi.fn();
  render(<Harness activate={activate} />);
  const first = screen.getByRole('button', { name: 'Conversaciones' });
  const second = screen.getByRole('button', { name: 'Herramientas' });
  act(() => { first.focus(); });
  pointer('pointerdown', second);
  if (when === 'during') act(() => { second.focus(); });
  advance(520);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Herramientas');
  pointer('pointerup', second);
  if (when === 'after') act(() => { second.focus(); });
  pointer('pointerout', second);
  fireEvent.click(second, { detail: 1 });
  expect(activate).not.toHaveBeenCalled();
  pointer('pointerdown', second);
  pointer('pointerup', second);
  fireEvent.click(second, { detail: 1 });
  expect(activate).toHaveBeenCalledOnce();
});


it('el menú nativo no compite con la pulsación táctil ni con su clic tardío', () => {
  render(<Harness />);
  const button = screen.getByRole('button', { name: 'Conversaciones' });
  expect(fireEvent.contextMenu(button)).toBe(true);
  pointer('pointerdown', button);
  advance(499);
  expect(fireEvent.contextMenu(button)).toBe(false);
  advance(1);
  expect(screen.getByRole('tooltip')).toHaveTextContent('Conversaciones');
  expect(fireEvent.contextMenu(button)).toBe(false);
  pointer('pointerup', button);
  expect(fireEvent.contextMenu(button)).toBe(false);
  advance(1500);
  expect(fireEvent.contextMenu(button)).toBe(true);
});

it.each([false, true])('desmontar limpia el temporizador antes y después de revelar: %s', (revealed) => {
  const view = render(<Harness />);
  pointer('pointerdown', screen.getByRole('button', { name: 'Conversaciones' }));
  if (revealed) {
    advance(500);
    pointer('pointerup', screen.getByRole('button', { name: 'Conversaciones' }));
  }
  view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  advance(2000);
  expect(screen.queryByRole('tooltip')).not.toBeInTheDocument();
});
