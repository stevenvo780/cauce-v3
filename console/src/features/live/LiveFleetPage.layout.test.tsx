import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { App } from '../../App';
import { renderWithApi } from '../../test/render';
import { renderLive } from './render-live';

it('ocupa toda el área principal: la columna mide una pantalla y la oficina la llena, sin tarjeta alrededor', async () => {
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const oficina = await screen.findByRole('region', { name: 'Oficina' }, { timeout: 10_000 });
  const main = screen.getByRole('main');
  expect(main.parentElement).toHaveClass('h-dvh', 'overflow-hidden');
  expect(main).toHaveClass('flex', 'flex-1', 'min-h-0');
  expect(oficina).toHaveClass('flex-1', 'min-h-0');
  expect(oficina.className).not.toMatch(/rounded|shadow|border/);
  const juego = oficina.querySelector('[data-nivel]');
  expect(juego).toHaveClass('h-full', 'w-full');
  expect(within(oficina).getByRole('heading', { level: 1, name: 'Oficina' })).toBeInTheDocument();
});

it('la barra de edificios y las teclas 1 a 9 cambian de edificio, y Escape vuelve al campus', async () => {
  window.history.replaceState({}, '', '/live');
  const user = userEvent.setup();
  renderLive();

  const barra = await screen.findByRole('toolbar', { name: 'Edificios del campus' });
  const juego = document.querySelector('[data-nivel]');
  const lista = screen.getByRole('listbox', { name: /oficina con \d+ agentes/i });
  lista.focus();
  await user.keyboard('1');
  await waitFor(() => { expect(juego).toHaveAttribute('data-nivel', 'campus'); });
  const botones = within(barra).getAllByRole('button');
  expect(botones[0]).toHaveAccessibleName(/^Campus \(estás acá\)/);
  expect(botones.some((boton) => (boton.getAttribute('aria-label') ?? '').startsWith('Cafetería'))).toBe(true);

  lista.focus();
  await user.keyboard('2');
  await waitFor(() => { expect(juego?.getAttribute('data-nivel')).toMatch(/^grupo:/); });
  expect(within(barra).getAllByRole('button')[1]).toHaveAttribute('aria-current', 'location');

  lista.focus();
  await user.keyboard('{Escape}');
  await waitFor(() => { expect(juego).toHaveAttribute('data-nivel', 'campus'); });

  await user.click(within(barra).getByRole('button', { name: /^Taller/ }));
  await waitFor(() => { expect(juego).toHaveAttribute('data-nivel', 'taller'); });
  await user.click(within(barra).getByRole('button', { name: /^Campus/ }));
  await waitFor(() => { expect(juego).toHaveAttribute('data-nivel', 'campus'); });
});
