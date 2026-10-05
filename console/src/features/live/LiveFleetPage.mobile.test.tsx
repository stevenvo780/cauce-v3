import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

it.each([true, false])('keeps the graph visible before the list at compact=%s', async (compact) => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: compact && query === '(max-width: 760px)', media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), addListener: vi.fn(),
    removeListener: vi.fn(), dispatchEvent: vi.fn(() => false),
  }));
  window.history.replaceState({}, '', '/live');
  const user = userEvent.setup();
  const { container } = renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  const map = screen.getByRole('region', { name: 'Mapa de la flota' });
  const table = container.querySelector('table[data-objeto-principal="tabla-de-flota"]');
  expect(map.tagName).toBe('SECTION');
  expect(map.querySelector('summary')).toBeNull();
  expect(map.compareDocumentPosition(table as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const legend = container.querySelector('details.live-leyenda');
  expect(legend).not.toBeNull();
  if (!legend) throw new Error('fleet reference is missing');
  expect(legend.compareDocumentPosition(table as Node) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  const layers = within(map).getByRole('group', { name: 'Capa del mapa' });
  await user.click(within(layers).getByRole('button', { name: 'Permisos' }));
  const search = screen.getByRole('searchbox', { name: 'Buscar un alias' });
  await user.type(search, 'kant');
  await user.click(screen.getByRole('button', { name: 'Refrescar ahora' }));
  act(() => { window.dispatchEvent(new Event('resize')); });
  expect(screen.getByRole('region', { name: 'Mapa de la flota' })).toBe(map);
  expect(within(layers).getByRole('button', { name: 'Permisos' })).toHaveAttribute('aria-pressed', 'true');
  expect(search).toHaveValue('kant');
  await user.click(screen.getByLabelText('Ajustes de refresco'));
  expect(screen.getByRole('combobox', { name: 'Intervalo de refresco' })).toBeEnabled();
  vi.restoreAllMocks();
});
