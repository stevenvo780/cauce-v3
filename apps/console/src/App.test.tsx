import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { App } from './App';
import { renderWithApi } from './test/render';
import { server } from './mocks/server';

it('provides basic accessible landmarks and identity guidance', async () => {
  window.history.pushState({}, '', '/fleet');
  renderWithApi(<App />);
  // La consola ya no se pinta antes de saber quién sos: hasta que /v3/auth/session contesta sólo
  // existe la pantalla de verificación, así que los landmarks aparecen después del await.
  expect(await screen.findByRole('navigation', { name: /principal/i })).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  expect(screen.getByRole('link', { name: /saltar al contenido/i })).toHaveAttribute('href', '#main-content');
  expect(await screen.findByRole('heading', { level: 1, name: /fleet/i })).toBeInTheDocument();
  expect(screen.getByText(/Cookie HttpOnly esperada/i)).toBeInTheDocument();
  expect(await screen.findByText('Steven:kant')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /cerrar sesión/i })).toBeInTheDocument();
});

it('shows the server-side login entry point when no BFF session exists', async () => {
  server.use(http.get('http://localhost/v3/auth/session', () => HttpResponse.json({ authenticated: false })));
  renderWithApi(<App />);

  expect(await screen.findByRole('link', { name: /iniciar sesión/i })).toHaveAttribute(
    'href',
    'http://localhost/v3/auth/login',
  );
});

it('routes /fleet/:tenant/:alias to the bot detail instead of the fleet list', async () => {
  window.history.pushState({}, '', '/fleet/Steven/kant');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'kant' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /volver a fleet/i })).toHaveAttribute('href', '/fleet');
  expect(screen.getByRole('link', { name: /^fleet$/i })).toHaveAttribute('aria-current', 'page');
});

it('el menú tiene UNA sola entrada para cuotas y licencias, no dos que se llaman casi igual', async () => {
  window.history.pushState({}, '', '/fleet');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const entries = within(nav).getAllByRole('link')
    .filter((link) => /cuota|licencia/i.test(link.textContent ?? ''));
  expect(entries.map((link) => link.textContent)).toEqual(['Cuotas y licencias']);
});

it('redirige /licenses a la vista fusionada en vez de dejar el enlace guardado en la nada', async () => {
  // La ruta se retiró al fusionar las dos vistas: un marcador viejo tiene que llegar a la heredera,
  // no caer en el fallback a "Sala de máquinas" —que es una página que nadie pidió—.
  window.history.pushState({}, '', '/licenses');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Cuotas y licencias' })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/quotas');
});

it('falls back to the live fleet room for an unknown route id even with extra pathname segments', async () => {
  window.history.pushState({}, '', '/unknown/nested/segment');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /sala de máquinas/i })).toBeInTheDocument();
});

it('ignores extra pathname segments on non-fleet routes and keeps rendering the existing page', async () => {
  window.history.pushState({}, '', '/terminal/unused/segment');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Ultimate Terminal' })).toBeInTheDocument();
});

it('navega dentro de la aplicación sin recargar la página al hacer clic en el menú', async () => {
  window.history.pushState({}, '', '/fleet');
  const user = userEvent.setup();
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /fleet & presencia/i });
  await user.click(screen.getByRole('link', { name: /^cuentas de ia$/i }));

  // Si el enlace no interceptara el clic, jsdom no cambiaría la ruta y seguiríamos en Fleet:
  // el router escucha popstate, y pushState no lo dispara solo.
  expect(window.location.pathname).toBe('/accounts');
  expect(await screen.findByRole('heading', { level: 1, name: /cuentas de ia/i })).toBeInTheDocument();
});

it('deja pasar ctrl+clic al navegador para poder abrir en otra pestaña', async () => {
  window.history.pushState({}, '', '/fleet');
  const user = userEvent.setup();
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /fleet & presencia/i });
  await user.keyboard('{Control>}');
  await user.click(screen.getByRole('link', { name: /^cuentas de ia$/i }));
  await user.keyboard('{/Control}');

  // Con modificador el clic es del navegador, no nuestro: la ruta no debe moverse.
  expect(window.location.pathname).toBe('/fleet');
});
