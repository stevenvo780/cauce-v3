import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { mockActivity } from '../../mocks/data';
import { server } from '../../mocks/server';
import { renderLive } from './render-live';

beforeEach(() => {
  window.history.replaceState({}, '', '/live');
});

async function elegir(user: ReturnType<typeof userEvent.setup>, opcion: RegExp) {
  await user.click(await screen.findByRole('button', { name: /^Frecuencia de lectura/ }));
  await user.click(await screen.findByRole('menuitemradio', { name: opcion }));
}

it('ofrece 2 s, 5 s, 15 s y pausa, y arranca en 5 s', async () => {
  const user = userEvent.setup();
  renderLive();

  const disparador = await screen.findByRole('button', { name: 'Frecuencia de lectura: cada 5 s' });
  await user.click(disparador);

  const opciones = await screen.findAllByRole('menuitemradio');
  expect(opciones.map((opcion) => opcion.textContent)).toEqual(['Cada 2 s', 'Cada 5 s', 'Cada 15 s', 'En pausa']);
  expect(screen.getByRole('menuitemradio', { name: 'Cada 5 s' })).toBeChecked();
});

it('elegir otra frecuencia cambia el rótulo del selector y la opción marcada', async () => {
  const user = userEvent.setup();
  renderLive();

  await elegir(user, /^Cada 15 s$/);

  const disparador = await screen.findByRole('button', { name: 'Frecuencia de lectura: cada 15 s' });
  expect(disparador).toHaveTextContent('Cada 15 s');
  await user.click(disparador);
  expect(await screen.findByRole('menuitemradio', { name: 'Cada 15 s' })).toBeChecked();
  expect(screen.getByRole('menuitemradio', { name: 'Cada 5 s' })).not.toBeChecked();
});

it('«En pausa» deja de leer la actividad sola, y «Actualizar ahora» sigue leyendo bajo demanda', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    let lecturas = 0;
    server.use(http.get('http://localhost/v3/console/activity', () => {
      lecturas += 1;
      return HttpResponse.json(mockActivity());
    }));
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLive();
    await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(lecturas).toBeGreaterThanOrEqual(1); });

    await elegir(user, /^En pausa$/);
    expect(await screen.findByRole('button', { name: 'Frecuencia de lectura: en pausa' })).toBeInTheDocument();
    const antes = lecturas;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(lecturas).toBe(antes);

    await user.click(screen.getByRole('button', { name: /actualizar ahora/i }));
    await waitFor(() => { expect(lecturas).toBeGreaterThan(antes); });
  } finally { vi.useRealTimers(); }
});

it('en pausa, el dato viejo no se sigue presentando como un veredicto fresco', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  try {
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    renderLive();
    const veredicto = await screen.findByLabelText('Veredicto de la flota');
    await waitFor(() => { expect(veredicto).not.toHaveAttribute('data-tone', 'desconocido'); });

    await elegir(user, /^En pausa$/);
    await vi.advanceTimersByTimeAsync(40_000);

    await waitFor(() => { expect(veredicto).toHaveAttribute('data-tone', 'desconocido'); });
    expect(within(veredicto).getByText(/dato está viejo/i)).toBeInTheDocument();
  } finally { vi.useRealTimers(); }
});
