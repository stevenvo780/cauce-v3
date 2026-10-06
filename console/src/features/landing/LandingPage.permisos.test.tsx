import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { App } from '../../App';
import { NAV_ENTRIES, PRIMARY_NAV_IDS } from '../../nav';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';

/**
 * Landing navigation verification:
 * asserts the side menu is the only primary navigation surface and that no redundant
 * shortcuts panels are duplicated.
 */

const READ_ONLY_ACCESS = http.get('http://localhost/v3/console/access', () =>
  HttpResponse.json({
    subject: 'Miguel:janus', roles: [], permissions: ['message.publish'],
    observed_at: new Date().toISOString(),
  }));

/** «Gestión» opens by itself on the secondary routes: only a collapsed group needs the click. */
async function openTools(nav: HTMLElement) {
  const toggle = within(nav).getByRole('button', { name: 'Gestión' });
  if (toggle.getAttribute('aria-expanded') !== 'true') await userEvent.click(toggle);
}

/** The menu labels, minus the landing: what MUST NOT appear twice on screen. */
const ROTULOS = NAV_ENTRIES.filter((entrada) => entrada.id !== 'overview').map((entrada) => entrada.label);

it('la portada NO vuelve a dibujar el menú: el bloque «el resto de la consola» ya no existe', async () => {
  window.history.pushState({}, '', '/overview');
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

it('sin permiso de escritura, la barra abre /config en solo lectura', async () => {
  server.use(READ_ONLY_ACCESS);
  window.history.pushState({}, '', '/overview');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  await openTools(nav);
  const lateral = within(nav).getByRole('link', { name: 'Ajustes' });
  expect(lateral).not.toHaveAttribute('aria-disabled');
  await userEvent.click(lateral);
  expect(window.location.pathname).toBe('/config');
  await screen.findByRole('heading', { level: 1, name: 'Ajustes' });
  expect(await screen.findByText(/^Solo lectura:/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('tab', { name: 'Espacios y salas' }));
  for (const crear of await screen.findAllByRole('button', { name: /^Crear$/ })) expect(crear).toBeDisabled();
});

it('abrir /config desde la barra no elude la denegación de lectura del servidor', async () => {
  server.use(READ_ONLY_ACCESS, http.get('http://localhost/v3/console/config', () => HttpResponse.json(
    { error: 'forbidden', message: 'read permission is required for configuration' }, { status: 403 },
  )));
  window.history.pushState({}, '', '/overview');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  await openTools(nav);
  await userEvent.click(within(nav).getByRole('link', { name: 'Ajustes' }));
  expect(window.location.pathname).toBe('/config');
  expect(await screen.findByText(/necesita permiso de lectura/i)).toBeInTheDocument();
  expect(screen.queryByRole('list', { name: 'Agentes configurados' })).not.toBeInTheDocument();
});

it('con el permiso de escritura, esa misma entrada sigue navegando', async () => {
  window.history.pushState({}, '', '/overview');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  await openTools(nav);
  const lateral = within(nav).getByRole('link', { name: 'Ajustes' });
  await waitFor(() => { expect(lateral).not.toHaveAttribute('aria-disabled'); });
  await userEvent.click(lateral);
  expect(window.location.pathname).toBe('/config');
});

it('la barra sigue teniendo todas las entradas del menú, «Terminal» incluida', async () => {
  window.history.pushState({}, '', '/overview');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  await openTools(nav);
  const rotulos = within(nav).getAllByRole('link').map((enlace) => enlace.textContent);
  // The primary routes come first, then the «Gestión» group in menu order.
  const primarias = PRIMARY_NAV_IDS.map((id) => NAV_ENTRIES.find((entry) => entry.id === id)?.label);
  const gestion = NAV_ENTRIES.filter((entry) => !PRIMARY_NAV_IDS.includes(entry.id)).map((entry) => entry.label);
  expect(rotulos).toEqual([...primarias, ...gestion]);
});
