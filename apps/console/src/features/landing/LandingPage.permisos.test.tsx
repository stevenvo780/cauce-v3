import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { App } from '../../App';
import { NAV_ENTRIES } from '../../nav';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';

/**
 * **El menú se dibuja UNA vez, y la portada no lo repite.**
 *
 * Historia, porque explica por qué estas pruebas dicen ahora lo contrario de lo que decían:
 *
 *  1. El commit 252cf3c dejó «Ajustes y altas» inerte —con su motivo— para quien no tiene
 *     `config.write`. La portada volvía a prometerla como enlace VIVO, porque su lista de atajos
 *     estaba escrita a mano. El verificador hizo clic y navegó.
 *  2. La ronda siguiente arregló el síntoma por la fuente: la portada pasó a leer `NAV_ENTRIES` y
 *     `useNavAvailability()`, las MISMAS que la barra. Estas pruebas comparaban las dos copias
 *     entre sí para que no volvieran a divergir.
 *  3. El 2026-08-23, midiendo la portada a 1280×900: ese panel es **el menú lateral otra vez**,
 *     cinco centímetros a la derecha del menú lateral, con los mismos siete rótulos y los mismos
 *     siete iconos, ocupando media pantalla de la vista que existe para resumir. Dos copias que no
 *     pueden divergir siguen siendo dos copias.
 *
 * Así que se retira el panel, y la invariante se vuelve MÁS fuerte, no más débil: ya no es «las dos
 * copias coinciden», es «no hay una segunda copia». Estas pruebas fallan si alguien la reintroduce.
 * La defensa original —el atajo inerte con su motivo— no se pierde: se comprueba donde vive de
 * verdad, que es la barra lateral.
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
