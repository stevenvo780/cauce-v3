import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

beforeEach(() => { window.history.replaceState({}, '', '/live'); });

it('opens the graph by default and preserves layers, filtering and disclosure', async () => {
  const user = userEvent.setup();
  renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  const map = document.querySelector<HTMLDetailsElement>('details.live-mapa');
  expect(map).toHaveAttribute('open');
  const layers = screen.getByRole('group', { name: 'Capa del mapa' });
  await user.click(within(layers).getByRole('button', { name: 'Permisos' }));
  expect(within(layers).getByRole('button', { name: 'Permisos' })).toHaveAttribute('aria-pressed', 'true');
  const search = screen.getByRole('searchbox', { name: 'Buscar un alias' });
  await user.type(search, 'kant');
  expect(search).toHaveValue('kant');
  expect(map).toHaveAttribute('open');
  const summary = map?.querySelector('summary');
  expect(summary).not.toBeNull();
  await user.click(summary!);
  expect(map).not.toHaveAttribute('open');
  await user.clear(search);
  expect(map).not.toHaveAttribute('open');
  await user.click(summary!);
  expect(map).toHaveAttribute('open');
  expect(within(layers).getByRole('button', { name: 'Permisos' })).toHaveAttribute('aria-pressed', 'true');
  await user.click(within(layers).getByRole('button', { name: 'Ahora' }));
  expect(within(layers).getByRole('button', { name: 'Ahora' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /refrescar ahora/i })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'Intervalo de refresco' })).toBeEnabled();
});
