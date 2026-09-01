import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { App } from './App';
import { renderWithApi } from './test/render';
import { server } from './mocks/server';

it('provides basic accessible landmarks and identity guidance', async () => {
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);
  // The console no longer renders before knowing who you are: until /v3/auth/session responds
  // only the verification screen exists, so the landmarks appear after the await.
  expect(await screen.findByRole('navigation', { name: /principal/i })).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveAttribute('id', 'main-content');
  expect(screen.getByRole('link', { name: /saltar al contenido/i })).toHaveAttribute('href', '#main-content');
  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.getByRole('main')).not.toHaveFocus();
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

it('redirige el detalle legado de Fleet a la única Terminal y conserva el agente exacto', async () => {
  window.history.pushState({}, '', '/fleet/Steven/kant');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' }, { timeout: 10_000 })).toBeInTheDocument();
  expect(await screen.findByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  await waitFor(() => { expect(window.location.pathname).toBe('/terminal/Steven/kant'); });
  expect(screen.queryByRole('link', { name: /volver a fleet/i })).not.toBeInTheDocument();
});

it('abre /terminal/:tenant/:alias directamente sin reescribir su ruta canónica', async () => {
  window.history.pushState({}, '', '/terminal/Steven/kant');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' }, { timeout: 10_000 })).toBeInTheDocument();
  expect(await screen.findByRole('tab', { name: /kant/i })).toHaveAttribute('aria-selected', 'true');
  expect(window.location.pathname).toBe('/terminal/Steven/kant');
});

it('un detalle de Terminal desconocido falla cerrado y no lo sustituye por la flota general', async () => {
  window.history.pushState({}, '', '/terminal/Steven/fantasma');
  renderWithApi(<App />);

  expect(await screen.findByText(/no observa al agente Steven:fantasma/i, {}, { timeout: 10_000 }))
    .toBeInTheDocument();
  expect(screen.queryByRole('complementary', { name: 'Flota de agentes' })).not.toBeInTheDocument();
  expect(window.location.pathname).toBe('/terminal/Steven/fantasma');
});

it('la barra y Terminal comparten una sola lectura del estado del relay', async () => {
  let capabilityReads = 0;
  server.use(http.get('*/v3/console/terminal/capability', () => {
    capabilityReads += 1;
    return HttpResponse.json({
      available: false,
      capabilities: [],
      reason: 'Relay no desplegado en este test.',
    });
  }));
  window.history.pushState({}, '', '/terminal');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' }, { timeout: 10_000 }))
    .toBeInTheDocument();
  await waitFor(() => { expect(capabilityReads).toBe(1); });
});

it('la barra y las páginas activas comparten una sola consulta de acceso', async () => {
  let accessReads = 0;
  server.use(http.get('*/v3/console/access', () => {
    accessReads += 1;
    return HttpResponse.json({
      subject: 'Steven:kant', roles: ['operator'],
      permissions: ['config.write', 'config.rollback'],
    });
  }));
  window.history.pushState({}, '', '/accounts');
  const user = userEvent.setup();
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Cuentas y cuotas' }, { timeout: 10_000 }))
    .toBeInTheDocument();
  await waitFor(() => { expect(accessReads).toBe(1); });
  await user.click(screen.getByRole('link', { name: /ajustes y altas/i }));
  expect(await screen.findByRole('heading', { level: 1, name: /ajustes y altas/i }, { timeout: 10_000 }))
    .toBeInTheDocument();
  expect(accessReads).toBe(1);
});

it('el menú tiene UNA sola entrada para cuentas, cuotas y licencias, no tres que se llaman casi igual', async () => {
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  const entries = within(nav).getAllByRole('link')
    .filter((link) => /cuota|licencia|cuenta/i.test(link.textContent));
  expect(entries.map((link) => link.textContent)).toEqual(['Cuentas y cuotas']);
});

it.each([
  ['/licenses'],
  ['/quotas'],
  ['/assignments'],
])('redirige %s a «Cuentas y cuotas» en vez de dejar el enlace guardado en la nada', async (ruta) => {
  window.history.pushState({}, '', ruta);
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Cuentas y cuotas' }, { timeout: 10_000 })).toBeInTheDocument();
  await waitFor(() => { expect(window.location.pathname).toBe('/accounts'); });
});

it('redirige /audit a «Señales y auditoría», donde la auditoría es una pestaña', async () => {
  window.history.pushState({}, '', '/audit');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Señales y auditoría' }, { timeout: 10_000 })).toBeInTheDocument();
  await waitFor(() => { expect(window.location.pathname).toBe('/observability'); });
});

it('muestra una ruta desconocida sin sustituirla por la portada, aunque traiga segmentos de más', async () => {
  window.history.pushState({}, '', '/unknown/nested/segment');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.getByText('/unknown/nested/segment')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
  expect(window.location.pathname).toBe('/unknown/nested/segment');
});

it('rechaza segmentos extra en /fleet/:tenant/:alias en vez de abrir otro agente', async () => {
  window.history.pushState({}, '', '/fleet/Steven/kant/sesion-vieja');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.getByText('/fleet/Steven/kant/sesion-vieja')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: 'kant' })).toBeNull();
  expect(window.location.pathname).toBe('/fleet/Steven/kant/sesion-vieja');
});

it('abre /messages/:tenant/:alias en la conversación, que es adonde navega el roster', async () => {
  window.history.pushState({}, '', '/messages/Miguel/kratos');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Mensajes' }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeNull();
  expect(window.location.pathname).toBe('/messages/Miguel/kratos');
});

it('CONTROL NEGATIVO — /messages con una aridad distinta sigue siendo 404', async () => {
  window.history.pushState({}, '', '/messages/Miguel');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/messages/Miguel');
});

it.each([
  '/terminal/solo-tenant',
  '/terminal/tenant/alias/sobrante',
  '/config/sobrante',
  '/live/sobrante',
  '/licenses/sobrante',
])('%s conserva la URL como 404 en vez de ignorar segmentos no declarados', async (ruta) => {
  window.history.pushState({}, '', ruta);
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.getByText(ruta)).toBeInTheDocument();
  expect(window.location.pathname).toBe(ruta);
});

it('navega dentro de la aplicación sin recargar la página al hacer clic en el menú', async () => {
  window.history.pushState({}, '', '/accounts');
  const user = userEvent.setup();
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i }, { timeout: 10_000 });
  await user.click(screen.getByRole('link', { name: /^queues & dlq$/i }));

  expect(window.location.pathname).toBe('/queues');
  expect(await screen.findByRole('heading', { level: 1, name: /colas y dlq operativo/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveFocus();
});

it('conserva el href real que permite abrir una ruta en otra pestaña', async () => {
  window.history.pushState({}, '', '/accounts');
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i }, { timeout: 10_000 });
  expect(screen.getByRole('link', { name: /^queues & dlq$/i })).toHaveAttribute('href', '/queues');
  expect(window.location.pathname).toBe('/accounts');
});

it('el menú contiene la portada más siete entradas consolidadas', async () => {
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i }, { timeout: 10_000 });
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
  expect(entradas).not.toContain('Jobs');
  expect(entradas).not.toContain('Adapters');
  expect(entradas).not.toContain('Audit');
  expect(entradas).not.toContain('Cuotas y licencias');
  expect(entradas).not.toContain('Cuentas de IA');
  expect(entradas).not.toContain('Messages');
});

it('redirige /fleet y /topology a la vista que las absorbió, reescribiendo la barra de direcciones', async () => {
  window.history.pushState({}, '', '/fleet');
  const primera = renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/live');
  primera.unmount();

  window.history.pushState({}, '', '/topology');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/live');
});

it('/activity sigue llegando a la vista viva, como antes', async () => {
  window.history.pushState({}, '', '/activity');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /la flota ahora/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(window.location.pathname).toBe('/live');
});

it('/fleet/:cliente sin alias conserva la dirección incompleta como 404', async () => {
  window.history.pushState({}, '', '/fleet/Steven');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.getByText('/fleet/Steven')).toBeInTheDocument();
  expect(window.location.pathname).toBe('/fleet/Steven');
});

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

  const entrada = await screen.findByRole('link', { name: /ajustes y altas/i }, { timeout: 10_000 });
  await waitFor(() => { expect(entrada).toHaveAttribute('aria-disabled', 'true'); });
  expect(entrada).toHaveAttribute('title', expect.stringContaining('permiso de control'));

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

  const entrada = await screen.findByRole('link', { name: /ajustes y altas/i }, { timeout: 10_000 });
  await waitFor(() => { expect(entrada).not.toHaveAttribute('aria-disabled'); });
  await userEvent.click(entrada);
  expect(window.location.pathname).toBe('/config');
});

it('la raíz "/" abre la portada, no la vista viva', async () => {
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /cauce en una pantalla/i }, { timeout: 10_000 })).toBeInTheDocument();
});
