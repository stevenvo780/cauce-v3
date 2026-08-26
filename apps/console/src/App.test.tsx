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

it('muestra una ruta desconocida sin sustituirla por la portada, aunque traiga segmentos de más', async () => {
  window.history.pushState({}, '', '/unknown/nested/segment');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeInTheDocument();
  expect(screen.getByText('/unknown/nested/segment')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
  expect(window.location.pathname).toBe('/unknown/nested/segment');
});

it('rechaza segmentos extra en /fleet/:tenant/:alias en vez de abrir otro agente', async () => {
  window.history.pushState({}, '', '/fleet/Steven/kant/sesion-vieja');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeInTheDocument();
  expect(screen.getByText('/fleet/Steven/kant/sesion-vieja')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: 'kant' })).toBeNull();
  expect(window.location.pathname).toBe('/fleet/Steven/kant/sesion-vieja');
});

it.each([
  '/terminal/unused/segment',
  '/config/sobrante',
  '/live/sobrante',
  '/licenses/sobrante',
])('%s conserva la URL como 404 en vez de ignorar segmentos no declarados', async (ruta) => {
  window.history.pushState({}, '', ruta);
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeInTheDocument();
  expect(screen.getByText(ruta)).toBeInTheDocument();
  expect(window.location.pathname).toBe(ruta);
});

it('navega dentro de la aplicación sin recargar la página al hacer clic en el menú', async () => {
  window.history.pushState({}, '', '/accounts');
  const user = userEvent.setup();
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  await user.click(screen.getByRole('link', { name: /^queues & dlq$/i }));

  // Si el enlace no interceptara el clic, jsdom no cambiaría la ruta y seguiríamos donde estábamos:
  // el router escucha popstate, y pushState no lo dispara solo.
  expect(window.location.pathname).toBe('/queues');
  expect(await screen.findByRole('heading', { level: 1, name: /colas y dlq operativo/i })).toBeInTheDocument();
});

it('conserva el href real que permite abrir una ruta en otra pestaña', async () => {
  window.history.pushState({}, '', '/accounts');
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i });
  expect(screen.getByRole('link', { name: /^queues & dlq$/i })).toHaveAttribute('href', '/queues');
  expect(window.location.pathname).toBe('/accounts');
});

it('el menú es la portada más SIETE entradas: el menú final del 2026-08-22', async () => {
  // No es una cifra decorativa: es el resultado de las cinco reformas del día, juntas.
  //
  // Se RETIRARON, con medición y no con opinión: «Jobs» (cero filas en la tabla desde que existe la
  // base) y «Adapters» (seis tipos de arnés que casi nunca cambian → plegados en la portada).
  // Se FUNDIERON: «Audit» es la pestaña «Auditoría» de «Señales y auditoría», y «Cuotas y
  // licencias» es la pestaña «Consumo» de «Cuentas y cuotas».
  // Se RENOMBRÓ: «Messages» → «Mensajes».
  // De trece entradas el 2026-08-06 a la portada más siete.
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const entradas = within(nav).getAllByRole('link').map((link) => link.textContent);

  expect(entradas).toEqual([
    'Portada',
    'La flota ahora',
    'Cuentas y cuotas',
    'Mensajes',
    'Queues & DLQ',
    'Señales y auditoría',
    'Ajustes y altas',
    'Terminal de agentes',
  ]);
  expect(entradas).not.toContain('Fleet');
  expect(entradas).not.toContain('Tenants & ACL');
  // 🔴 CONTROL NEGATIVO de las cinco reformas juntas: si alguien devuelve cualquiera de las cinco
  // entradas que se fueron, vuelve a haber dos sitios para el mismo dato y esto falla. Está acá y
  // no repartido por cinco ficheros porque el peligro de integrar cinco ramas es justamente que una
  // reponga en silencio lo que otra retiró.
  expect(entradas).not.toContain('Jobs');
  expect(entradas).not.toContain('Adapters');
  expect(entradas).not.toContain('Audit');
  expect(entradas).not.toContain('Cuotas y licencias');
  expect(entradas).not.toContain('Cuentas de IA');
  expect(entradas).not.toContain('Messages');
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

it('/fleet/:cliente sin alias conserva la dirección incompleta como 404', async () => {
  window.history.pushState({}, '', '/fleet/Steven');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeInTheDocument();
  expect(screen.getByText('/fleet/Steven')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/fleet/Steven');
});

/**
 * 2026-08-22. Miguel (Miguel:janus) entraba a la consola, veía "Configuration" en el menú, hacía
 * clic y recibía un 403 `control permission is required for configuration`. Medido contra
 * producción con su sesión real. El permiso no se toca: lo que estaba mal era que el menú
 * prometiera una vista que ese usuario nunca va a poder abrir.
 */
it('deja «Ajustes y altas» inerte, y con el motivo escrito, para quien no tiene config.write', async () => {
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

  const entrada = await screen.findByRole('link', { name: /ajustes y altas/i });
  await waitFor(() => expect(entrada).toHaveAttribute('aria-disabled', 'true'));
  expect(entrada).toHaveAttribute('title', expect.stringContaining('permiso de control'));

  // Y el clic NO navega: la entrada existe, dice por qué no, y no lleva a una página con un error.
  await userEvent.click(entrada);
  expect(window.location.pathname).toBe('/live');
});

it('deja «Ajustes y altas» navegable para quien SI tiene config.write', async () => {
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

  const entrada = await screen.findByRole('link', { name: /ajustes y altas/i });
  await waitFor(() => expect(entrada).not.toHaveAttribute('aria-disabled'));
  await userEvent.click(entrada);
  expect(window.location.pathname).toBe('/config');
});

/**
 * 2026-08-22 — las dos retiradas de esta ronda, y por qué se tratan DISTINTO.
 *
 * `/adapters` tiene heredera (su contenido se plegó en la portada) → alias silencioso y la barra
 * de direcciones se reescribe. `/jobs` no tiene ninguna: la tabla `jobs` medida en producción tenía
 * cero filas desde que existe la base, así que la vista no se mudó, desapareció. Mandarla a la
 * portada en silencio dejaría a quien abrió el marcador creyendo que la consola se equivocó de
 * página, así que se le dice, y se le dan las dos puertas que sí responden su pregunta.
 */
it('/adapters redirige a la portada, donde su contenido está plegado', async () => {
  window.history.pushState({}, '', '/adapters');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeInTheDocument();
  expect(await screen.findByText(/arneses declarados/i)).toBeInTheDocument();
  // El alias resuelve a la cadena vacía: si la comprobación fuera por veracidad en vez de por
  // `!== undefined`, la página sería la correcta y la URL seguiría diciendo /adapters para siempre.
  expect(window.location.pathname).toBe('/');
});

it('/jobs no da 404 ni una página que nadie pidió: dice que se retiró y adónde ir', async () => {
  window.history.pushState({}, '', '/jobs');
  renderWithApi(<App />);

  expect(await screen.findByText(/ya no es una vista de esta consola/i)).toBeInTheDocument();
  // Dentro del contenido, no en la barra lateral: los dos rótulos existen también en el menú.
  const contenido = within(screen.getByRole('main'));
  expect(contenido.getByRole('link', { name: /queues & dlq/i })).toHaveAttribute('href', '/queues');
  expect(contenido.getByRole('link', { name: /la flota ahora/i })).toHaveAttribute('href', '/live');
  // NO se redirige: la URL se queda donde está, porque no hay heredera a la que mandar.
  expect(window.location.pathname).toBe('/jobs');
});

it('la raíz "/" abre la portada, no la vista viva', async () => {
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeInTheDocument();
});
