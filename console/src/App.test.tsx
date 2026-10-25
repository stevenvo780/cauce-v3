import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { App } from './App';
import { renderWithApi } from './test/render';
import { server } from './mocks/server';

async function openTools() {
  const button = await screen.findByRole('button', { name: 'Gestión' });
  if (button.getAttribute('aria-expanded') !== 'true') await userEvent.click(button);
}

/** The roster lives in the sidebar: each agent is a link whose target depends on the section. */
async function agentLink(alias: string) {
  const roster = await screen.findByRole('list', { name: 'Agentes' });
  return within(roster).findByRole('link', { name: new RegExp(`^${alias}\\b`) });
}

it('shows the server-side login entry point when no BFF session exists', async () => {
  server.use(http.get('http://localhost/v3/auth/session', () => HttpResponse.json({ authenticated: false })));
  renderWithApi(<App />);

  expect(await screen.findByRole('link', { name: /iniciar sesión/i })).toHaveAttribute(
    'href',
    'http://localhost/v3/auth/login',
  );
});

it('abre /terminal/:tenant/:alias directamente sin reescribir su ruta canónica', async () => {
  window.history.pushState({}, '', '/terminal/Steven/kant');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: 'Terminal de agentes' }, { timeout: 10_000 })).toBeInTheDocument();
  expect(await screen.findByRole('heading', { level: 2, name: /^kant/ })).toBeInTheDocument();
  expect(await agentLink('kant')).toHaveAttribute('aria-current', 'page');
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

  expect(await screen.findByRole('heading', { level: 1, name: 'Cuentas' }, { timeout: 10_000 }))
    .toBeInTheDocument();
  await waitFor(() => { expect(accessReads).toBe(1); });
  await openTools();
  await user.click(screen.getByRole('link', { name: 'Ajustes' }));
  expect(await screen.findByRole('heading', { level: 1, name: 'Ajustes' }, { timeout: 10_000 }))
    .toBeInTheDocument();
  expect(accessReads).toBe(1);
});

it('muestra una ruta desconocida sin sustituirla por otra vista, aunque traiga segmentos de más', async () => {
  window.history.pushState({}, '', '/unknown/nested/segment');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 1, name: /ruta no encontrada/i }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.getByText('/unknown/nested/segment')).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: /cauce en una pantalla/i })).toBeNull();
  expect(window.location.pathname).toBe('/unknown/nested/segment');
});

it('abre /messages/:tenant/:alias en la conversación, que es adonde navega el roster', async () => {
  window.history.pushState({}, '', '/messages/Miguel/kratos');
  renderWithApi(<App />);

  expect(await screen.findByRole('heading', { level: 2, name: 'kratos' }, { timeout: 10_000 })).toBeInTheDocument();
  expect(screen.queryByRole('heading', { level: 1, name: /ruta no encontrada/i })).toBeNull();
  expect(window.location.pathname).toBe('/messages/Miguel/kratos');
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

it('deja navegar a «Ajustes» sin config.write para consultar la vista en solo lectura', async () => {
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
  const entrada = await screen.findByRole('link', { name: 'Ajustes' }, { timeout: 10_000 });
  await waitFor(() => { expect(entrada).not.toHaveAttribute('aria-disabled'); });

  await userEvent.click(entrada);
  expect(window.location.pathname).toBe('/config');
});

async function pickLane(user: ReturnType<typeof userEvent.setup>, lane: RegExp) {
  await user.click(screen.getByRole('button', { name: 'Opciones de la conversación' }));
  await user.click(await screen.findByRole('menuitemradio', { name: lane }));
}

it('conserva el borrador y su carril al visitar herramientas, aislado por agente', async () => {
  window.history.pushState({}, '', '/messages/Steven/argos');
  const user = userEvent.setup();
  renderWithApi(<App />);
  const input = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
  await user.type(input, 'Revisa el trabajo pendiente');
  await pickLane(user, /^Batch/);
  await openTools();
  await user.click(screen.getByRole('link', { name: 'Cuentas' }));
  await screen.findByRole('heading', { name: 'Cuentas' });
  await user.click(await agentLink('argos'));
  expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toHaveValue('Revisa el trabajo pendiente');
  expect(screen.getByText('Batch')).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'Opciones de la conversación' }));
  expect(await screen.findByRole('menuitemradio', { name: /^Batch/ })).toBeChecked();
  await user.keyboard('{Escape}');
  await user.click(await agentLink('kratos'));
  expect(await screen.findByRole('textbox', { name: 'Mensaje para kratos' })).toHaveValue('');
  await user.click(await agentLink('argos'));
  expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toHaveValue('Revisa el trabajo pendiente');
});

it.each([
  { success: true, editDraft: false }, { success: false, editDraft: false },
  { success: true, editDraft: true }, { success: false, editDraft: true },
])('un envío pendiente sobrevive a navegar; éxito=$success, nuevo borrador=$editDraft', async ({ success, editDraft }) => {
  let release: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  let calls = 0;
  let publishedInput: Record<string, unknown> | undefined;
  let settled = false;
  const originalDraft = 'Un único envío pendiente';
  const nextDraft = 'El próximo mensaje todavía no se envía';
  server.use(http.post('*/v3/console/messages', async ({ request }) => {
    const input = await request.json() as Record<string, unknown>;
    publishedInput = input;
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
    await user.type(input, originalDraft);
    await user.click(screen.getByRole('button', { name: 'Enviar' }));
    await waitFor(() => { expect(calls).toBe(1); });
    await openTools();
    await user.click(screen.getByRole('link', { name: 'Cuentas' }));
    await screen.findByRole('heading', { name: 'Cuentas' });
    await user.click(await agentLink('argos'));
    const pendingInput = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
    expect(pendingInput).toBeEnabled();
    expect(pendingInput).toHaveValue(originalDraft);
    if (editDraft) { await user.clear(pendingInput); await user.type(pendingInput, nextDraft); }
    const send = screen.getByRole('button', { name: 'Enviando…' });
    expect(send).toBeDisabled();
    await user.click(send);
    await user.click(pendingInput);
    await user.keyboard('{Enter}');
    const form = pendingInput.closest('form');
    if (!form) throw new Error('Missing pending message composer');
    fireEvent.submit(form);
    expect(pendingInput).toHaveFocus();
    expect(pendingInput).toHaveValue(editDraft ? nextDraft : originalDraft);
    expect(calls).toBe(1);
    expect(publishedInput).toMatchObject({ body: { text: originalDraft }, recipients: [{ tenant_id: 'Steven', alias: 'argos' }] });
    await openTools();
    await user.click(screen.getByRole('link', { name: 'Cuentas' }));
    await screen.findByRole('heading', { name: 'Cuentas' });
    release();
    await waitFor(() => { expect(settled).toBe(true); });
    await user.click(await agentLink('argos'));
    const restored = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
    await waitFor(() => { expect(restored).not.toBeDisabled(); });
    expect(restored).toHaveValue(editDraft ? nextDraft : success ? '' : originalDraft);
    expect(calls).toBe(1);
    if (!success) expect(await screen.findByRole('alert')).toHaveTextContent('Intento rechazado');
  } finally { release(); }
});

it('abre la configuración desde el chat y conserva borrador con Atrás, Adelante y Volver', async () => {
  window.history.pushState({}, '', '/messages/Steven/argos');
  const user = userEvent.setup();
  renderWithApi(<App />);
  const input = await screen.findByRole('textbox', { name: 'Mensaje para argos' });
  await user.type(input, 'Borrador antes de configurar');
  const hilo = await screen.findByRole('region', { name: /conversación con argos/i });
  await user.click((await within(hilo).findAllByRole('button', { name: 'Opciones del mensaje' }))[0]);
  await user.click(await screen.findByRole('menuitem', { name: 'Ver detalle' }));
  expect(screen.getByRole('heading', { name: 'Mensaje que elegiste' })).toHaveFocus();
  await user.click(screen.getByRole('button', { name: 'Opciones de la conversación' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Perfil y contexto' }));
  expect(window.location.search).toBe('?view=context');
  expect(await screen.findByRole('heading', { name: 'Perfil y contexto de argos' })).toHaveFocus();
  window.history.back();
  await waitFor(() => { expect(window.location.search).toBe(''); });
  expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toHaveValue('Borrador antes de configurar');
  expect(screen.getByRole('button', { name: 'Opciones de la conversación' })).toHaveFocus();
  window.history.forward();
  expect(await screen.findByRole('heading', { name: 'Perfil y contexto de argos' })).toBeInTheDocument();
  expect(window.location.search).toBe('?view=context');
  await user.click(screen.getByRole('link', { name: 'Volver a la conversación' }));
  expect(window.location.search).toBe('');
  expect(await screen.findByRole('textbox', { name: 'Mensaje para argos' })).toHaveValue('Borrador antes de configurar');
  expect(screen.getByRole('button', { name: 'Opciones de la conversación' })).toHaveFocus();
  await user.click(screen.getByRole('textbox', { name: 'Mensaje para argos' }));
  await user.click(screen.getByRole('button', { name: 'Opciones de la conversación' }));
  await user.click(await screen.findByRole('menuitem', { name: 'Sincronizar' }));
  await user.keyboard('{Escape}');
  await user.click(screen.getByRole('textbox', { name: 'Mensaje para argos' }));
  await waitFor(() => { expect(screen.getByRole('textbox', { name: 'Mensaje para argos' })).toHaveFocus(); });
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
    await userEvent.click(screen.getByRole('button', { name: 'Cuenta y apariencia' }));
    expect(screen.getByRole('group', { name: 'Tema de la consola' })).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Cerrar sesión' })).toBeNull();
    expect(screen.getByText('Esta consola no tiene login de usuario.')).toBeVisible();
  } finally { vi.unstubAllEnvs(); }
});
