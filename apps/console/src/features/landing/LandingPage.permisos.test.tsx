import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { App } from '../../App';
import { NAV_ENTRIES } from '../../nav';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';

/**
 * Verificación de navegación en la portada:
 * comprueba que el menú lateral sea la única superficie de navegación primaria
 * y no se dupliquen paneles de atajos redundantes.
 */

const SIN_CONFIG = http.get('http://localhost/v3/console/access', () =>
  HttpResponse.json({
    subject: 'Miguel:janus', roles: [], permissions: ['message.publish'],
    observed_at: new Date().toISOString(),
  }));

/** Los rótulos del menú, menos la portada: lo que NO puede aparecer dos veces en la pantalla. */
const ROTULOS = NAV_ENTRIES.filter((entrada) => entrada.id !== '').map((entrada) => entrada.label);

it('la portada NO vuelve a dibujar el menú: el bloque «el resto de la consola» ya no existe', async () => {
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cauce en una pantalla/i });
  expect(screen.queryByRole('list', { name: /el resto de la consola/i })).not.toBeInTheDocument();

  // La portada espera a que se asienten sus cuatro fuentes antes de publicar alertas. El fixture
  // demora `/status` a propósito; sin esperar un hallazgo acreditado, esta invariante podía mirar
  // el frame de carga y pasar aunque el frame definitivo volviera a copiar los rótulos del menú.
  const alertas = screen.getByRole('region', { name: /lo que exige atención/i });
  await within(alertas).findByText(/entrega muerta en la dlq/i);

  // Y ningún rótulo del menú aparece como enlace FUERA de la barra: si alguien reintroduce la
  // lista con otro `aria-label`, esto la encuentra igual.
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
  await waitFor(() => expect(lateral).toHaveAttribute('aria-disabled', 'true'));
  expect(lateral).toHaveAttribute('title', expect.stringContaining('permiso de control'));

  // Y el clic NO navega. Es lo que el verificador midió al revés: hizo clic y llegó a /config.
  await userEvent.click(lateral);
  expect(window.location.pathname).toBe('/');
});

it('control negativo: con el permiso puesto, esa misma entrada sí navega', async () => {
  // Sin esto, inutilizar la entrada SIEMPRE también pasaría la prueba de arriba, y el menú
  // quedaría roto para el operador que sí tiene el permiso.
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const lateral = within(nav).getByRole('link', { name: /ajustes y altas/i });
  await waitFor(() => expect(lateral).not.toHaveAttribute('aria-disabled'));
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
