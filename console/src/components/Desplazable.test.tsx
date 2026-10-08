import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { Desplazable } from './Desplazable';

afterEach(() => { vi.restoreAllMocks(); });

it('moves a focused overflowing table with horizontal keys and returns with Home', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(280);
  const user = userEvent.setup();
  render(<Desplazable etiqueta="Matriz de cuentas"><table><tbody><tr><td>fixture</td></tr></tbody></table></Desplazable>);
  const scroll = screen.getByRole('group', { name: 'Matriz de cuentas' });
  expect(scroll).toHaveAttribute('tabindex', '0');
  expect(scroll).toHaveClass('overflow-x-auto');

  await user.click(scroll);
  await user.keyboard('{End}');
  expect(scroll.scrollLeft).toBeGreaterThan(0);
  await user.keyboard('{Home}');
  expect(scroll.scrollLeft).toBe(0);
});

it('pans a focused map vertically and horizontally without losing access to its far edge', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(860);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(256);
  const user = userEvent.setup();
  render(<Desplazable etiqueta="Mapa de la flota" className="lhg-scroll"><svg /></Desplazable>);
  const scroll = screen.getByRole('group', { name: 'Mapa de la flota' });

  await user.click(scroll);
  await user.keyboard('{ArrowDown}');
  expect(scroll.scrollTop).toBeGreaterThan(0);
  await user.keyboard('{PageDown}');
  expect(scroll.scrollTop).toBeGreaterThan(48);
  await user.keyboard('{End}');
  expect(scroll.scrollLeft).toBeGreaterThan(0);
});

it('makes a vertical-only scroller keyboard reachable and moves it with PageDown', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(256);
  const user = userEvent.setup();
  render(<Desplazable etiqueta="Lista vertical"><p>fixture</p></Desplazable>);
  const scroll = screen.getByRole('group', { name: 'Lista vertical' });

  await user.click(scroll);
  const horizontalKey = new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true, cancelable: true });
  scroll.dispatchEvent(horizontalKey);
  expect(horizontalKey.defaultPrevented).toBe(false);
  const pageDown = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });
  scroll.dispatchEvent(pageDown);
  expect(pageDown.defaultPrevented).toBe(true);
  expect(scroll.scrollTop).toBeGreaterThan(0);
});

it('leaves vertical page keys alone when only a table’s horizontal axis overflows', async () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(640);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(280);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(256);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(256);
  const user = userEvent.setup();
  render(<Desplazable etiqueta="Tabla horizontal"><table><tbody><tr><td>fixture</td></tr></tbody></table></Desplazable>);
  const scroll = screen.getByRole('group', { name: 'Tabla horizontal' });
  await user.click(scroll);

  const arrowDown = new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true });
  fireEvent(scroll, arrowDown);
  const pageDown = new KeyboardEvent('keydown', { key: 'PageDown', bubbles: true, cancelable: true });
  fireEvent(scroll, pageDown);
  expect(arrowDown.defaultPrevented).toBe(false);
  expect(pageDown.defaultPrevented).toBe(false);
});

it.each([1070, 1071])('does not add a tab stop for content width %i with a 1070px viewport', (width) => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(width);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(1070);
  render(<Desplazable etiqueta="Actividad en vuelo por agente"><p>fixture</p></Desplazable>);

  expect(screen.queryByRole('group')).not.toBeInTheDocument();
  expect(document.querySelector('.overflow-x-auto')).not.toHaveAttribute('tabindex');
});

it.each([256, 257])('does not add a tab stop for content height %i with a 256px viewport', (height) => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(320);
  vi.spyOn(HTMLElement.prototype, 'scrollHeight', 'get').mockReturnValue(height);
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(256);
  render(<Desplazable etiqueta="Lista vertical"><p>fixture</p></Desplazable>);

  expect(screen.queryByRole('group')).not.toBeInTheDocument();
  expect(document.querySelector('.overflow-x-auto')).not.toHaveAttribute('tabindex');
});

it('preserves the custom class for overflowing content outside a table', () => {
  vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(900);
  vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(360);
  render(<Desplazable etiqueta="Mapa de la flota" className="lhg-scroll"><svg /></Desplazable>);

  const scroll = screen.getByRole('group', { name: 'Mapa de la flota' });
  expect(scroll).toHaveClass('lhg-scroll');
  expect(scroll).not.toHaveClass('overflow-x-auto');
});
