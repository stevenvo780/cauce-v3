/**
 * The scroll box that becomes keyboard-reachable only while it really overflows.
 *
 * jsdom computes no geometry —every box measures 0— so the widths are stubbed here on purpose:
 * what this file pins down is the DECISION taken from a measurement, not the measurement. That the
 * measurement itself is right was checked in Chrome by `pnpm qa:layout`, whose `recorteSinTeclado`
 * budget went from 738 px stranded at 360 to 0 at all six widths.
 */
import { render, screen } from '@testing-library/react';
import { afterEach, expect, it } from 'vitest';
import { Desplazable } from './Desplazable';

const original = {
  scrollWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollWidth'),
  clientWidth: Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth'),
};

function medidas(scroll: number, cliente: number) {
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => scroll });
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => cliente });
}

afterEach(() => {
  if (original.scrollWidth) Object.defineProperty(HTMLElement.prototype, 'scrollWidth', original.scrollWidth);
  if (original.clientWidth) Object.defineProperty(HTMLElement.prototype, 'clientWidth', original.clientWidth);
});

it('cuando el contenido se sale, la caja entra en el orden de tabulación y dice cómo se llama', () => {
  medidas(1206, 1070);
  render(<Desplazable etiqueta="Actividad en vuelo por agente"><table><tbody><tr><td>x</td></tr></tbody></table></Desplazable>);

  const region = screen.getByRole('group', { name: 'Actividad en vuelo por agente' });
  expect(region).toHaveAttribute('tabindex', '0');
  expect(region).toHaveClass('table-wrap');
});

/* Without this the tab stop would exist at every width, including the ones where the table fits:
   a stop that scrolls nothing is noise for whoever navigates by keyboard. */
it('🔴 CONTROL NEGATIVO: si el contenido entra, no gasta una parada de tabulación', () => {
  medidas(1070, 1070);
  render(<Desplazable etiqueta="Actividad en vuelo por agente"><table><tbody><tr><td>x</td></tr></tbody></table></Desplazable>);

  expect(screen.queryByRole('group')).not.toBeInTheDocument();
  expect(document.querySelector('.table-wrap')).not.toHaveAttribute('tabindex');
});

it('un desborde de un solo píxel no cuenta: es el ruido del redondeo', () => {
  medidas(1071, 1070);
  render(<Desplazable etiqueta="Actividad en vuelo por agente"><p>x</p></Desplazable>);

  expect(screen.queryByRole('group')).not.toBeInTheDocument();
});

it('respeta la clase que le pasan, para las cajas que no son tablas', () => {
  medidas(900, 360);
  render(<Desplazable etiqueta="Mapa de la flota" className="lhg-scroll"><svg /></Desplazable>);

  const region = screen.getByRole('group', { name: 'Mapa de la flota' });
  expect(region).toHaveClass('lhg-scroll');
  expect(region).not.toHaveClass('table-wrap');
});
