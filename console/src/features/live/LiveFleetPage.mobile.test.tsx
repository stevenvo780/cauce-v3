import { act, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { renderWithApi } from '../../test/render';
import { LiveFleetPage } from './LiveFleetPage';

afterEach(() => { vi.restoreAllMocks(); });

it('keeps the graph and its layers ahead of the activity list on a phone', async () => {
  let isMobile = true;
  const viewportListeners = new Set<() => void>();
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query === '(max-width: 760px)' && isMobile,
    media: query,
    onchange: null,
    addEventListener: vi.fn((_event, listener) => { viewportListeners.add(listener as () => void); }),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
  window.history.replaceState({}, '', '/live');
  const user = userEvent.setup();
  const { container } = renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  const map = document.querySelector<HTMLDetailsElement>('details.live-mapa');
  expect(map).toHaveAttribute('open');
  const layers = screen.getByRole('group', { name: 'Capa del mapa' });
  const strip = screen.getByRole('group', { name: 'Capa del mapa' }).closest('.live-command-strip');
  expect(strip).toContainElement(layers);
  const table = container.querySelector('table[data-objeto-principal="tabla-de-flota"]');
  expect(layers.compareDocumentPosition(map as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(map?.compareDocumentPosition(table as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  await user.click(within(layers).getByRole('button', { name: 'Permisos' }));
  expect(within(layers).getByRole('button', { name: 'Permisos' })).toHaveAttribute('aria-pressed', 'true');
  const search = screen.getByRole('searchbox', { name: 'Buscar un alias' });
  await user.type(search, 'kant');
  expect(search).toHaveValue('kant');
  expect(map).toHaveAttribute('open');
  const summary = map?.querySelector('summary');
  expect(summary).not.toBeNull();
  if (!summary) throw new Error('the graph disclosure summary is missing');
  await user.click(summary);
  expect(map).not.toHaveAttribute('open');
  await user.clear(search);
  expect(map).not.toHaveAttribute('open');
  await user.click(summary);
  expect(map).toHaveAttribute('open');
  isMobile = false;
  act(() => { viewportListeners.forEach((listener) => { listener(); }); });
  const resizedMap = container.querySelector<HTMLDetailsElement>('details.live-mapa');
  expect(resizedMap).not.toBeNull();
  expect(resizedMap?.isConnected).toBe(true);
  expect(resizedMap).toHaveAttribute('open');
  await user.click(screen.getByRole('button', { name: /refrescar ahora/i }));
  const refreshedMap = container.querySelector<HTMLDetailsElement>('details.live-mapa');
  expect(refreshedMap).not.toBeNull();
  expect(refreshedMap?.isConnected).toBe(true);
  expect(refreshedMap).toHaveAttribute('open');
  const currentLayers = screen.getByRole('group', { name: 'Capa del mapa' });
  expect(within(currentLayers).getByRole('button', { name: 'Permisos' })).toHaveAttribute('aria-pressed', 'true');
  await user.click(within(currentLayers).getByRole('button', { name: 'Ahora' }));
  expect(within(currentLayers).getByRole('button', { name: 'Ahora' })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByRole('button', { name: /refrescar ahora/i })).toBeEnabled();
  expect(screen.getByRole('combobox', { name: 'Intervalo de refresco' })).toBeEnabled();
});

it('pone la tabla operativa antes del mapa expandido en una pantalla amplia', async () => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    addListener: vi.fn(),
    removeListener: vi.fn(),
    dispatchEvent: vi.fn(() => false),
  }));
  window.history.replaceState({}, '', '/live');
  const { container } = renderWithApi(<LiveFleetPage />);
  await screen.findByLabelText('Veredicto de la flota');
  const layers = screen.getByRole('group', { name: 'Capa del mapa' });
  const table = container.querySelector('table[data-objeto-principal="tabla-de-flota"]');
  const map = container.querySelector('details.live-mapa');
  expect(map).not.toHaveAttribute('open');
  expect(layers.compareDocumentPosition(table as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(table?.compareDocumentPosition(map as Node)).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  const summary = map?.querySelector('summary');
  expect(summary).not.toBeNull();
  if (!summary) throw new Error('the graph disclosure summary is missing');
  await userEvent.click(summary);
  expect(map).toHaveAttribute('open');
});
