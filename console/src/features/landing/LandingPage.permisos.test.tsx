import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { App } from '../../App';
import { NAV_ENTRIES } from '../../nav';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';

/**
 * Landing navigation verification:
 * asserts the side menu is the only primary navigation surface and that no redundant
 * shortcuts panels are duplicated.
 */

const SIN_CONFIG = http.get('http://localhost/v3/console/access', () =>
  HttpResponse.json({
    subject: 'Miguel:janus', roles: [], permissions: ['message.publish'],
    observed_at: new Date().toISOString(),
  }));

/** The menu labels, minus the landing: what MUST NOT appear twice on screen. */
const ROTULOS = NAV_ENTRIES.filter((entrada) => entrada.id !== '').map((entrada) => entrada.label);

it('la portada NO vuelve a dibujar el menú: el bloque «el resto de la consola» ya no existe', async () => {
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cauce en una pantalla/i });
  expect(screen.queryByRole('list', { name: /el resto de la consola/i })).not.toBeInTheDocument();

  // The landing waits for its four sources to settle before publishing alerts. The fixture
  // intentionally delays `/status`; without waiting for a credited finding, this invariant could
  // look at the loading frame and pass even if the final frame redrew the menu labels.
  const alertas = screen.getByRole('region', { name: /lo que exige atención/i });
  await within(alertas).findByText(/entrega muerta en la dlq/i);

  // And no menu label appears as a link OUTSIDE the bar: if someone reintroduces the list with
  // another `aria-label`, this catches it anyway.
  const nav = await screen.findByRole('navigation', { name: /principal/i });
  for (const rotulo of ROTULOS) {
    const enlaces = screen.queryAllByRole('link', { name: new RegExp(`^${rotulo}`, 'i') })
      .filter((enlace) => !nav.contains(enlace));
    expect(enlaces, `«${rotulo}» está dibujado dos veces: en la barra y en la portada`).toHaveLength(0);
  }
});

it('la barra lateral SIGUE negando /config a quien no lo puede abrir, con el motivo a la vista', async () => {
  server.use(SIN_CONFIG);
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const lateral = within(nav).getByRole('link', { name: /ajustes y altas/i });
  await waitFor(() => { expect(lateral).toHaveAttribute('aria-disabled', 'true'); });
  expect(lateral).toHaveAttribute('title', expect.stringContaining('permiso de control'));

  await userEvent.click(lateral);
  expect(window.location.pathname).toBe('/');
});

it('control negativo: con el permiso puesto, esa misma entrada sí navega', async () => {
  // Without this, disabling the entry ALWAYS would also pass the test above, and the menu would
  // be broken for the operator who does have the permission.
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const lateral = within(nav).getByRole('link', { name: /ajustes y altas/i });
  await waitFor(() => { expect(lateral).not.toHaveAttribute('aria-disabled'); });
  await userEvent.click(lateral);
  expect(window.location.pathname).toBe('/config');
});

it('la barra sigue teniendo las SIETE entradas, «Terminal de agentes» incluida', async () => {
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const rotulos = within(nav).getAllByRole('link').map((enlace) => enlace.textContent);
  expect(rotulos).toEqual(['Portada', ...ROTULOS]);
});
