import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { App } from './App';
import { renderWithApi } from './test/render';
import { server } from './mocks/server';

async function openTools() {
  const button = await screen.findByRole('button', { name: 'Herramientas' });
  if (button.getAttribute('aria-expanded') !== 'true') await userEvent.click(button);
}

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
  expect(screen.getByRole('button', { name: 'Herramientas' })).toHaveAttribute('aria-expanded', 'false');
  await userEvent.click(screen.getByRole('button', { name: /^Cuenta de/ }));
  expect(within(screen.getByRole('dialog', { name: 'Cuenta y apariencia' })).getByText('Steven:kant')).toBeInTheDocument();
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
  await openTools();
  await user.click(screen.getByRole('link', { name: /ajustes y altas/i }));
  expect(await screen.findByRole('heading', { level: 1, name: /ajustes y altas/i }, { timeout: 10_000 }))
    .toBeInTheDocument();
  expect(accessReads).toBe(1);
});

it('el menú tiene UNA sola entrada para cuentas, cuotas y licencias, no tres que se llaman casi igual', async () => {
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i });
  await openTools();
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

  expect(await screen.findByRole('heading', { level: 2, name: 'kratos' }, { timeout: 10_000 })).toBeInTheDocument();
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
  await openTools();
  await user.click(screen.getByRole('link', { name: /^queues & dlq$/i }));

  expect(window.location.pathname).toBe('/queues');
  expect(await screen.findByRole('heading', { level: 1, name: /colas y dlq operativo/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.getByRole('main')).toHaveFocus();
});

it('conserva el href real que permite abrir una ruta en otra pestaña', async () => {
  window.history.pushState({}, '', '/accounts');
  renderWithApi(<App />);

  await screen.findByRole('heading', { level: 1, name: /cuentas y cuotas/i }, { timeout: 10_000 });
  await openTools();
  expect(screen.getByRole('link', { name: /^queues & dlq$/i })).toHaveAttribute('href', '/queues');
  expect(window.location.pathname).toBe('/accounts');
});

it('el menú contiene la portada más ocho entradas consolidadas', async () => {
  window.history.pushState({}, '', '/live');
  renderWithApi(<App />);

  const nav = await screen.findByRole('navigation', { name: /principal/i }, { timeout: 10_000 });
  await openTools();
  const entradas = within(nav).getAllByRole('link').map((link) => link.textContent);

  expect(entradas).toEqual([
    'Conversaciones',
    'Grafo y actividad',
    'Resumen',
    'Cuentas y cuotas',
    'Queues & DLQ',
    'Señales y auditoría',
    'Ajustes y altas',
    'Terminal de agentes',
    'Ayuda',
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

  await openTools();
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

  await openTools();
  const entrada = await screen.findByRole('link', { name: /ajustes y altas/i }, { timeout: 10_000 });
  await waitFor(() => { expect(entrada).not.toHaveAttribute('aria-disabled'); });
  await userEvent.click(entrada);
  expect(window.location.pathname).toBe('/config');
});

it('la raíz abre las conversaciones', async () => {
  window.history.pushState({}, '', '/');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Mensajes' }, { timeout: 10_000 })).toBeInTheDocument();
  await waitFor(() => { expect(window.location.pathname).toBe('/messages'); });
});

it('conserva el borrador y sus opciones al visitar herramientas, aislado por agente', async () => {
  window.history.pushState({}, '', '/messages/Steven/argos');
  const user = userEvent.setup();
  renderWithApi(<App />);
  const input = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
  await user.type(input, 'Revisá el trabajo pendiente');
  await user.click(screen.getByRole('button', { name: 'Más' }));
  await user.selectOptions(screen.getByLabelText('Carril'), 'batch');
  await openTools();
  await user.click(screen.getByRole('link', { name: 'Cuentas y cuotas' }));
  await screen.findByRole('heading', { name: 'Cuentas y cuotas' });
  await user.click(screen.getByRole('link', { name: 'Volver a la conversación' }));
  expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toHaveValue('Revisá el trabajo pendiente');
  expect(screen.getByText(/Envío en segundo plano/)).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Más' }));
  expect(screen.getByLabelText('Carril')).toHaveValue('batch');
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('button', { name: /conversación con kratos,/i }));
  expect(await screen.findByRole('textbox', { name: 'Mensaje para kratos' })).toHaveValue('');
  await user.click(screen.getByRole('button', { name: /conversación con argos,/i }));
  expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toHaveValue('Revisá el trabajo pendiente');
});

it.each([true, false])('un envío pendiente sobrevive a salir del hilo y volver; éxito=%s', async (success) => {
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let settled = false;
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    calls += 1;
    await pending;
    if (!success) { settled = true; return HttpResponse.json({ error: 'invalid_request', message: 'Intento rechazado' }, { status: 400 }); }
    return HttpResponse.json({
      message_id: '10000000-0000-4000-8000-000000000001',
      delivery_ids: ['20000000-0000-4000-8000-000000000001'], duplicate: false,
      request_id: '30000000-0000-4000-8000-000000000001', trace_id: 'trace-console-test',
      idempotency_key: input.idempotency_key, tenant_id: 'Steven', actor_alias: 'kant',
      request_hash: 'a'.repeat(64), causal_hash: 'b'.repeat(64),
    }, { status: 202 });
  }), http.post('*/v3/console/publish-intents/confirm', async ({ request }) => {
    settled = true;
    return HttpResponse.json({ version: 1, confirmed: true, ...await request.json() as object });
  }));
  window.history.pushState({}, '', '/messages/Steven/argos');
  const user = userEvent.setup();
  renderWithApi(<App />);
  try {
    const input = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
    await user.type(input, 'Un único envío pendiente');
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => { expect(calls).toBe(1); });
    await openTools();
    await user.click(screen.getByRole('link', { name: 'Cuentas y cuotas' }));
    await screen.findByRole('heading', { name: 'Cuentas y cuotas' });
    await user.click(screen.getByRole('link', { name: 'Volver a la conversación' }));
    expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Enviando…' })).toBeDisabled();
    await openTools();
    await user.click(screen.getByRole('link', { name: 'Cuentas y cuotas' }));
    await screen.findByRole('heading', { name: 'Cuentas y cuotas' });
    release();
    await waitFor(() => { expect(settled).toBe(true); });
    await user.click(screen.getByRole('link', { name: 'Volver a la conversación' }));
    const restored = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
    await waitFor(() => { expect(restored).not.toBeDisabled(); });
    expect(restored).toHaveValue(success ? '' : 'Un único envío pendiente');
    expect(calls).toBe(1);
    if (!success) expect(await screen.findByRole('alert')).toHaveTextContent('Intento rechazado');
  } finally { release(); }
});

it('el foco sigue la selección y vuelve al agente al cerrar la conversación', async () => {
  window.history.pushState({}, '', '/messages');
  const user = userEvent.setup();
  renderWithApi(<App />);
  const agent = await screen.findByRole('button', { name: /conversación con argos,/i });
  await user.click(agent);
  expect(await screen.findByRole('heading', { name: 'argos', level: 2 })).toHaveFocus();
  await user.click(screen.getByRole('link', { name: 'Volver a los agentes' }));
  expect(await screen.findByRole('button', { name: /conversación con argos,/i })).toHaveFocus();
});

it('las herramientas se cierran con Escape y devuelven el foco al control', async () => {
  window.history.pushState({}, '', '/messages');
  const user = userEvent.setup();
  renderWithApi(<App />);
  await openTools();
  await user.tab();
  await user.keyboard('{Escape}');
  expect(screen.getByRole('button', { name: 'Herramientas' })).toHaveFocus();
  expect(screen.queryByRole('region', { name: 'Herramientas de Cauce' })).toBeNull();
});

it('un agente desconocido conserva su aviso, oculta el roster móvil y permite volver', async () => {
  window.history.pushState({}, '', '/messages/Steven/fantasma');
  const user = userEvent.setup();
  renderWithApi(<App />);
  const missing = await screen.findByText(/El servidor no observa a/);
  expect(missing.closest('.messenger-empty')).toHaveAttribute('data-state', 'missing');
  expect(missing.closest('.messenger-shell')).toHaveAttribute('data-conversacion', 'abierta');
  await user.click(screen.getByRole('link', { name: 'Volver a los agentes' }));
  expect(window.location.pathname).toBe('/messages');
  expect(await screen.findByRole('button', { name: /conversación con argos,/i })).toBeInTheDocument();
});

it('abre la configuración desde el chat y conserva borrador con Atrás, Adelante y Volver', async () => {
  window.history.pushState({}, '', '/messages/Steven/argos');
  const user = userEvent.setup();
  renderWithApi(<App />);
  const input = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
  await user.type(input, 'Borrador antes de configurar');
  await user.click(screen.getByRole('button', { name: 'Más' }));
  await user.click(screen.getByRole('button', { name: 'Ver detalle del último mensaje' }));
  expect(screen.getByRole('heading', { name: 'Mensaje que elegiste' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Más' }));
  await user.click(screen.getByRole('link', { name: 'Configurar agente' }));
  expect(window.location.search).toBe('?view=context');
  expect(await screen.findByRole('heading', { name: 'Configuración de argos' })).toHaveFocus();
  window.history.back();
  await waitFor(() => { expect(window.location.search).toBe(''); });
  expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toHaveValue('Borrador antes de configurar');
  expect(screen.getByRole('button', { name: 'Más' })).toHaveFocus();
  window.history.forward();
  expect(await screen.findByRole('heading', { name: 'Configuración de argos' })).toBeInTheDocument();
  expect(window.location.search).toBe('?view=context');
  await user.click(screen.getByRole('link', { name: 'Volver a la conversación' }));
  expect(window.location.search).toBe('');
  expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toHaveValue('Borrador antes de configurar');
  expect(screen.getByRole('button', { name: 'Más' })).toHaveFocus();
  await user.click(screen.getByRole('textbox', { name: 'Mensaje para argos' }));
  await user.click(screen.getByRole('button', { name: 'Más' }));
  await user.click(screen.getByRole('button', { name: /^Sincronizar$/ }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('textbox', { name: 'Mensaje para argos' }));
  await waitFor(() => { expect(screen.getByRole('textbox', { name: 'Mensaje para argos' })).toHaveFocus(); });
});

it('las identidades del hilo y el indicador de trabajo proceden de datos reales', async () => {
  window.history.pushState({}, '', '/messages/Steven/argos');
  renderWithApi(<App />);
  const row = await screen.findByRole('button', { name: /conversación con argos,/i });
  await waitFor(() => { expect(row.querySelector('.chat-avatar')).toHaveAttribute('data-working', 'true'); });
  const conversation = await screen.findByRole('region', { name: 'Conversación con argos' });
  expect(conversation.querySelector('.transcript-direction')).toHaveTextContent(/kant.*hacia.*argos/);
});

it.each([1280, 390])('el chat a %i conserva una sola cabecera y el borrador al usar cuenta y tema', async (width) => {
  vi.spyOn(window, 'matchMedia').mockImplementation((query) => ({
    matches: query.includes('1100px') ? width <= 1100 : query.includes('760px') && width <= 760,
    media: query, onchange: null,
    addEventListener: () => undefined, removeEventListener: () => undefined,
    addListener: () => undefined, removeListener: () => undefined, dispatchEvent: () => false,
  }));
  window.history.pushState({}, '', '/messages/Steven/argos');
  const user = userEvent.setup();
  renderWithApi(<App />);
  const composer = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
  await user.type(composer, 'Borrador que conserva su destino');
  expect(document.querySelector('.topbar')).toBeNull();
  expect(document.querySelector('.chat-page-heading')).toBeNull();
  expect(screen.getByRole('heading', { name: 'argos', level: 2 })).toBeVisible();
  const trigger = screen.getByRole('button', { name: /^Cuenta de/ });
  expect(trigger.closest('.sidebar')).not.toBeNull();
  expect(screen.getAllByRole('button', { name: /^Cuenta de/ })).toHaveLength(1);
  expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
  await user.click(trigger);
  await user.click(screen.getByRole('button', { name: 'Oscuro' }));
  await user.keyboard('{Escape}');
  expect(trigger).toHaveFocus();
  expect(composer).toHaveValue('Borrador que conserva su destino');
  expect(window.location.pathname).toBe('/messages/Steven/argos');
  expect(screen.getByRole('link', { name: 'Volver a los agentes' })).toBeInTheDocument();
  window.localStorage.removeItem('cauce.tema');
  document.documentElement.removeAttribute('data-theme');
});

it('MOCK y ausencia de login permanecen visibles con la cuenta cerrada en un chat', async () => {
  vi.stubEnv('VITE_USE_MOCKS', 'true');
  server.use(http.get('http://localhost/v3/auth/session', () => HttpResponse.json({ error: 'not_found' }, { status: 404 })));
  window.history.pushState({}, '', '/messages/Steven/argos');
  try {
    renderWithApi(<App />);
    await screen.findByRole('textbox', { name: 'Mensaje para argos' });
    expect(screen.getByText('MOCK API')).toBeVisible();
    expect(screen.getByText('Esta consola no tiene login de usuario.')).toBeVisible();
    expect(screen.queryByRole('dialog', { name: 'Cuenta y apariencia' })).toBeNull();
    expect(document.querySelector('.topbar')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Cuenta y apariencia' }));
    expect(screen.getByRole('group', { name: 'Tema de la consola' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
    expect(screen.getByText('Esta consola no tiene login de usuario.')).toBeVisible();
  } finally { vi.unstubAllEnvs(); }
});

it('los datos tardíos del chat no quitan el foco de la cuenta abierta', async () => {
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  server.use(http.get('http://localhost/v3/console/access', async () => {
    await pending;
    return HttpResponse.json({ subject: 'Steven:kant', roles: ['operator'], permissions: ['message.publish'] });
  }));
  window.history.pushState({}, '', '/messages/Steven/argos');
  try {
    renderWithApi(<App />);
    await userEvent.click(await screen.findByRole('button', { name: /^Cuenta de/ }));
    const heading = screen.getByRole('heading', { name: 'Cuenta y apariencia' });
    expect(heading).toHaveFocus();
    release();
    await screen.findByRole('heading', { name: 'argos', level: 2 });
    expect(heading).toHaveFocus();
    await userEvent.keyboard('{Escape}');
    expect(screen.getByRole('button', { name: /^Cuenta de/ })).toHaveFocus();
  } finally { release(); }
});
