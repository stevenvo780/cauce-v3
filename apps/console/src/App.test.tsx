import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { App } from './App';
import { renderWithApi } from './test/render';
import { server } from './mocks/server';

it('provides basic accessible landmarks and identity guidance', async () => {
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);
  // La consola ya no se pinta antes de saber quién sos: hasta que /v3/auth/session contesta sólo
  // existe la pantalla de verificación, así que los landmarks aparecen después del await.
  expect(await screen.findByRole('navigation', { name: /principal/i })).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  expect(screen.getByRole('link', { name: /saltar al contenido/i })).toHaveAttribute('href', '#main-content');
  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i })).toBeInTheDocument();
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
  // `fleet` ya no es una entrada de menú, así que ninguna queda marcada como página actual. Lo que
  // importa —y lo que se rompería si el alias se aplicara a las rutas con parámetros— es que la
  // barra de direcciones NO se reescriba a /live.
  expect(window.location.pathname).toBe('/fleet/Steven/kant');
});

it('el menú tiene UNA sola entrada para cuentas, cuotas y licencias, no tres que se llaman casi igual', async () => {
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const entries = within(nav).getAllByRole('link')
    .filter((link) => /cuota|licencia|cuenta/i.test(link.textContent ?? ''));
  expect(entries.map((link) => link.textContent)).toEqual(['Cuentas y cuotas']);
});

it.each([
  ['/licenses'],
  ['/quotas'],
  ['/assignments'],
])('redirige %s a «Cuentas y cuotas» en vez de dejar el enlace guardado en la nada', async (ruta) => {
  // Las tres rutas se retiraron fusionando vistas: un marcador viejo tiene que llegar a la heredera,
  // no caer en el fallback a "La flota ahora" —que es una página que nadie pidió—.
  //
  // 🔴 CONTROL: `/licenses` apuntaba a `/quotas`, que a su vez ya no existe. Si alguien deja el
  // alias encadenado, ESTA prueba lo agarra: `matchRoute` resuelve el mapa una sola vez, así que
  // `/licenses` terminaría en "La flota ahora" con la barra diciendo /licenses.
  window.history.pushState({}, '', ruta);
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Cuentas y cuotas' })).toBeInTheDocument();
  await waitFor(() => expect(window.location.pathname).toBe('/accounts'));
});

it('redirige /audit a «Señales y auditoría», donde la auditoría es una pestaña', async () => {
  window.history.pushState({}, '', '/audit');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Señales y auditoría' })).toBeInTheDocument();
  await waitFor(() => expect(window.location.pathname).toBe('/observability'));
});

it('falls back to the live fleet room for an unknown route id even with extra pathname segments', async () => {
  window.history.pushState({}, '', '/unknown/nested/segment');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i })).toBeInTheDocument();
});

it('ignores extra pathname segments on non-fleet routes and keeps rendering the existing page', async () => {
  window.history.pushState({}, '', '/terminal/unused/segment');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Ultimate Terminal' })).toBeInTheDocument();
});

it('navega dentro de la aplicación sin recargar la página al hacer clic en el menú', async () => {
  window.history.pushState({}, '', '/accounts');
  const user = userEvent.setup();
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await user.click(screen.getByRole('link', { name: /^jobs$/i }));

  // Si el enlace no interceptara el clic, jsdom no cambiaría la ruta y seguiríamos donde estábamos:
  // el router escucha popstate, y pushState no lo dispara solo.
  expect(window.location.pathname).toBe('/jobs');
  expect(await screen.findByRole('heading', { level: 1, name: /jobs/i })).toBeInTheDocument();
});

it('deja pasar ctrl+clic al navegador para poder abrir en otra pestaña', async () => {
  window.history.pushState({}, '', '/accounts');
  const user = userEvent.setup();
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await user.keyboard('{Control>}');
  await user.click(screen.getByRole('link', { name: /^jobs$/i }));
  await user.keyboard('{/Control}');

  // Con modificador el clic es del navegador, no nuestro: la ruta no debe moverse.
  expect(window.location.pathname).toBe('/accounts');
});

it('el menú tiene NUEVE entradas: las tres fusiones del 2026-08-22 sacaron dos más', async () => {
  // No es una cifra decorativa. El 2026-08-22 Steven señaló tres pares de vistas redundantes y las
  // tres se fundieron sin perder un dato: «Audit» es la pestaña «Auditoría» de «Señales y
  // auditoría», y «Cuotas y licencias» es la pestaña «Consumo» de «Cuentas y cuotas». De trece
  // entradas en agosto a nueve.
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const entradas = within(nav).getAllByRole('link').map((link) => link.textContent);

  expect(entradas).toEqual([
    'La flota ahora',
    'Cuentas y cuotas',
    'Messages',
    'Queues & DLQ',
    'Jobs',
    'Adapters',
    'Señales y auditoría',
    'Configuración y altas',
    'Ultimate Terminal',
  ]);
  expect(entradas).not.toContain('Fleet');
  expect(entradas).not.toContain('Tenants & ACL');
  // 🔴 CONTROL NEGATIVO de la fusión: si alguien devuelve cualquiera de las dos entradas retiradas,
  // vuelve a haber dos sitios para el mismo dato y esto falla.
  expect(entradas).not.toContain('Audit');
  expect(entradas).not.toContain('Cuotas y licencias');
  expect(entradas).not.toContain('Cuentas de IA');
});

it('redirige /fleet y /topology a la vista que las absorbió, reescribiendo la barra de direcciones', async () => {
  // Un marcador guardado que se rompe es un defecto, y caer al fallback sin decir nada es peor:
  // deja al operador en una página que no pidió y con la URL mintiendo sobre dónde está.
  window.history.pushState({}, '', '/fleet');
  const primera = renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/live');
  primera.unmount();

  window.history.pushState({}, '', '/topology');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/live');
});

it('/activity sigue llegando a la vista viva, como antes', async () => {
  window.history.pushState({}, '', '/activity');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/live');
});

it('/fleet/:cliente sin alias no identifica a nadie y lo dice, en vez de caer en el fallback mudo', async () => {
  window.history.pushState({}, '', '/fleet/Steven');
  renderWithApi(<App />);

  expect(await screen.findByText(/ya no identifica a nadie/i)).toBeInTheDocument();
});

/**
 * 2026-08-22. Miguel (Miguel:janus) entraba a la consola, veía "Configuration" en el menú, hacía
 * clic y recibía un 403 `control permission is required for configuration`. Medido contra
 * producción con su sesión real. El permiso no se toca: lo que estaba mal era que el menú
 * prometiera una vista que ese usuario nunca va a poder abrir.
 */
it('deja «Configuración y altas» inerte, y con el motivo escrito, para quien no tiene config.write', async () => {
  server.use(
    http.get('http://localhost/v3/console/access', () =>
      HttpResponse.json({
        subject: 'Miguel:janus',
        roles: [],
        permissions: ['message.publish', 'message.notify'],
        observed_at: new Date().toISOString(),
      })),
  );
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const entrada = await screen.findByRole('link', { name: /configuración y altas/i });
  await waitFor(() => expect(entrada).toHaveAttribute('aria-disabled', 'true'));
  expect(entrada).toHaveAttribute('title', expect.stringContaining('permiso de control'));

  // Y el clic NO navega: la entrada existe, dice por qué no, y no lleva a una página con un error.
  await userEvent.click(entrada);
  expect(window.location.pathname).toBe('/live');
});

it('deja «Configuración y altas» navegable para quien SI tiene config.write', async () => {
  server.use(
    http.get('http://localhost/v3/console/access', () =>
      HttpResponse.json({
        subject: 'Steven:kant',
        roles: ['operator'],
        permissions: ['message.publish', 'config.write', 'config.rollback'],
        observed_at: new Date().toISOString(),
      })),
  );
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const entrada = await screen.findByRole('link', { name: /configuración y altas/i });
  await waitFor(() => expect(entrada).not.toHaveAttribute('aria-disabled'));
  await userEvent.click(entrada);
  expect(window.location.pathname).toBe('/config');
});
