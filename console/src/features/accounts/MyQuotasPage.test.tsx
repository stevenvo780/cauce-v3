import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { QuotaAccount } from '../../api/client/my-quotas-client';
import { renderWithApi } from '../../test/render';
import { server } from '../../mocks/server';
import { CompanySessionProvider } from '../auth/company-session';
import { MyQuotasPage } from './MyQuotasPage';

vi.mock('./ProviderAuthTerminal', () => ({ ProviderAuthTerminal: () => null }));

const account: QuotaAccount = { id: 'subscription', provider: 'codex', label: 'Cuenta compartida', enabled: true, version: 3,
  payer_tenant_id: 'One', shared: true, agent_count: 2, agents: [{ tenant_id: 'One', alias: 'first', enabled: true }, { tenant_id: 'One', alias: 'second', enabled: true }],
  paused_until: null, paused_reason: null, observation_status: 'ok', remaining_percent: 56, note: null,
  windows: [{ group_key: 'primary', window_key: 'weekly', model: 'gpt', label: 'Semanal', host: 'host', used_percent: 44, remaining_percent: 56,
    window_minutes: 10_080, captured_at: null, received_at: '2026-10-11T00:00:00Z', reset_at: null, observation_status: 'ok' }] };
function owner() { return <CompanySessionProvider state={{ authenticated: true, authority: { role: 'company_owner', scope: 'company',
  home_company: 'one', acting_company: 'one', platform_override: false } }}><MyQuotasPage /></CompanySessionProvider>; }

it('explica el 500 de una actualización manual de entornos antes de volver a intentarlo', async () => {
  let reads = 0;
  server.use(
    http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/quota-environments', () => {
      reads += 1;
      return reads === 1
        ? HttpResponse.json({ company_id: 'one', environments: [], operations: [],
          capabilities: { available: false, providers: [], hosts: [], actions: [] } })
        : HttpResponse.json({ error: 'internal', message: 'ENGLISH SERVER ERROR' }, { status: 500 });
    }),
    http.get('*/v3/console/preferences', () => HttpResponse.json({ version: 1, pinned_quota_accounts: [] })),
  );
  const user = userEvent.setup(); renderWithApi(owner());
  const refresh = await screen.findByRole('button', { name: 'Actualizar cuotas y entornos' });
  await waitFor(() => { expect(refresh).toBeEnabled(); });
  await user.click(refresh);
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent(/El servidor no confirmó el estado del entorno/i);
  expect(alert.textContent).not.toContain('ENGLISH SERVER ERROR');
});

it('fija una suscripción compartida en el servidor y relee la misma preferencia al volver', async () => {
  let version = 4; let pinned: string[] = []; const writes: unknown[] = [];
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/preferences', () => HttpResponse.json({ version, pinned_quota_accounts: pinned })),
    http.put('*/v3/console/preferences', async ({ request }) => { const input = await request.json() as { expected_version: number; pinned_quota_accounts: string[] };
      writes.push(input); expect(input.expected_version).toBe(version); version += 1; pinned = input.pinned_quota_accounts;
      return HttpResponse.json({ version, pinned_quota_accounts: pinned }); }));
  const user = userEvent.setup(); const view = renderWithApi(owner());
  const card = within(await screen.findByRole('article', { name: 'Cuotas de Cuenta compartida' }));
  expect(card.getByText(/Consumo compartido por 2 agentes/u)).toBeVisible();
  expect(card.getByRole('meter')).toHaveAttribute('value', '56');
  expect(card.getByText(/Reinicio no informado/u)).toBeVisible();
  await waitFor(() => { expect(card.getByRole('button', { name: 'Fijar cuenta' })).toBeEnabled(); });
  await user.click(card.getByRole('button', { name: 'Fijar cuenta' }));
  expect(await screen.findByRole('button', { name: 'Desfijar cuenta' })).toHaveAttribute('aria-pressed', 'true');
  expect(writes).toEqual([{ expected_version: 4, pinned_quota_accounts: ['subscription'] }]);
  view.unmount(); renderWithApi(owner());
  expect(await screen.findByRole('button', { name: 'Desfijar cuenta' })).toHaveAttribute('aria-pressed', 'true');
});
it('un lector de alcance tenant ve el total de agentes que comparten la cuenta sin alias ajenos', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [
    { ...account, shared: true, agent_count: 3, agents: [{ tenant_id: 'One', alias: 'janus', enabled: true }] },
  ] })));
  renderWithApi(owner());
  const card = within(await screen.findByRole('article', { name: 'Cuotas de Cuenta compartida' }));
  expect(card.getByText(/Consumo compartido por 3 agentes \(ves 1 de tu espacio\)/u)).toBeVisible();
  expect(card.queryByText(/1 agentes/u)).not.toBeInTheDocument();
});
it('datos antiguos con saldo cero no muestran el cansancio de agotado', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [
    { ...account, observation_status: 'stale', remaining_percent: 0, windows: [{ ...account.windows[0], observation_status: 'stale', remaining_percent: 0 }] },
  ] })));
  renderWithApi(owner());
  const card = within(await screen.findByRole('article', { name: 'Cuotas de Cuenta compartida' }));
  expect(card.getAllByText('Datos antiguos').length).toBeGreaterThan(0);
  expect(card.queryByText('Sin disponibilidad')).not.toBeInTheDocument();
  expect(card.queryByRole('meter')).not.toBeInTheDocument();
});
it('autenticar pide consentimiento y muestra operación pendiente sin afirmar autenticación completa', async () => {
  const environment = { id: 'env-1', company_id: 'one', account_id: 'subscription', host_id: 'host', provider: 'codex', label: 'Consulta GPT',
    status: 'ready', version: 2, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
  let operation: Record<string, unknown> | undefined; const actions: unknown[] = [];
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/quota-environments', () => HttpResponse.json({ company_id: 'one', environments: [environment], operations: operation ? [operation] : [],
      capabilities: { available: true, providers: ['codex'], hosts: [{ host_id: 'host', display_name: 'Host', providers: ['codex'], provider_actions: { codex: ['authenticate', 'query', 'update_cli', 'delete'] } }], actions: ['authenticate', 'query', 'update_cli', 'delete'] } })),
    http.post('*/v3/console/quota-environments/env-1/actions', async ({ request }) => {
      actions.push(await request.json()); environment.status = 'awaiting_auth'; environment.version = 3;
      operation = { id: 'op-1', environment_id: environment.id, action: 'authenticate', status: 'awaiting_auth', error_code: null,
        result: { login_url: 'https://provider.example.test/auth', user_code: 'TEST-CODE' }, created_at: environment.created_at, updated_at: environment.updated_at };
      return HttpResponse.json({ environment, operation }, { status: 202 }); }));
  const user = userEvent.setup(); renderWithApi(owner());
  await user.click(await screen.findByRole('button', { name: 'Autenticar cuenta' }));
  expect(actions).toHaveLength(0); await user.click(screen.getByRole('button', { name: 'Confirmar autenticación' }));
  expect(await screen.findByRole('link', { name: 'Abrir autorización del proveedor' })).toHaveAttribute('href', 'https://provider.example.test/auth');
  expect(screen.getByText(/TEST-CODE/u)).toBeVisible();
  expect(actions[0]).toMatchObject({ action: 'authenticate', expected_version: 2, consent: true });
  expect(JSON.stringify(actions[0])).not.toMatch(/shell|command|mount/iu);
  expect(screen.getAllByText(/Esperando autenticación/u).length).toBeGreaterThan(0);
  expect(screen.queryByText(/Cuenta autenticada/u)).not.toBeInTheDocument();
  for (const action of ['Autenticar cuenta', 'Consultar cuotas', 'Actualizar CLI', 'Eliminar entorno']) {
    expect(screen.getByRole('button', { name: action })).toBeDisabled();
  }
});

it('registra una cuenta ofreciendo solo proveedores ejecutables y respeta límites contractuales en las cuentas y entornos', async () => {
  const environment = { id: 'env-1', company_id: 'one', account_id: 'subscription', host_id: 'host', provider: 'codex', label: 'Consulta GPT',
    status: 'ready', version: 2, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
  const writes: unknown[] = [];
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/quota-environments', () => HttpResponse.json({ company_id: 'one', environments: [environment], operations: [],
      capabilities: { available: true, providers: ['claude', 'codex'], hosts: [], actions: [] } })),
    http.post('*/v3/console/quota-accounts', async ({ request }) => { writes.push(await request.json()); return HttpResponse.json({ account_id: 'new-account', duplicate: false }); }));
  const user = userEvent.setup(); renderWithApi(owner());
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Registrar cuenta' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Registrar cuenta' }));
  const form = within(await screen.findByRole('form', { name: 'Registrar cuenta de cuotas' }));
  expect(form.getByRole('textbox', { name: 'Nombre de la cuenta' })).toHaveAttribute('maxlength', '80');
  expect(form.getByRole('combobox', { name: 'Proveedor' })).toHaveTextContent('claudecodex');
  await user.type(form.getByRole('textbox', { name: 'Nombre de la cuenta' }), 'Sin agentes');
  await user.click(form.getByRole('button', { name: 'Registrar cuenta' }));
  expect(await screen.findByText('Cuenta registrada. Crea su entorno para autenticar y consultar.')).toBeVisible();
  expect(writes[0]).toMatchObject({ label: 'Sin agentes' });
  await user.click(screen.getByRole('button', { name: 'Editar cuenta' }));
  const edit = within(await screen.findByRole('form', { name: 'Editar cuenta de cuotas' }));
  expect(edit.getByRole('textbox', { name: 'Motivo de pausa' })).toHaveAttribute('maxlength', '128');
  await user.click(edit.getByRole('button', { name: 'Cancelar' }));
  const card = within(screen.getByRole('article', { name: 'Entorno Consulta GPT' }));
  expect(card.getByRole('button', { name: 'Editar entorno' })).toBeEnabled();
  await user.click(card.getByRole('button', { name: 'Editar entorno' }));
  const editEnvironment = within(await screen.findByRole('form', { name: 'Editar entorno de cuotas' }));
  expect(editEnvironment.getByRole('textbox', { name: 'Nombre del entorno' })).toHaveAttribute('maxlength', '80');
});

it('un 409 de operación conserva error y permite relectura sin presentar el efecto como hecho', async () => {
  const environment = { id: 'env-1', company_id: 'one', account_id: 'subscription', host_id: 'host', provider: 'codex', label: 'Consulta GPT',
    status: 'ready', version: 2, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/quota-environments', () => HttpResponse.json({ company_id: 'one', environments: [environment], operations: [],
      capabilities: { available: true, providers: ['codex'], hosts: [{ host_id: 'host', display_name: 'Host', providers: ['codex'], provider_actions: { codex: ['query'] } }], actions: ['query'] } })),
    http.post('*/v3/console/quota-environments/env-1/actions', () => HttpResponse.json({ message: 'authentication already active' }, { status: 409 })));
  const user = userEvent.setup(); renderWithApi(owner());
  await user.click(await screen.findByRole('button', { name: 'Consultar cuotas' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Otro cambio llegó antes');
  expect(screen.queryByText(/Consultar cuotas: solicitud registrada/u)).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Actualizar cuotas y entornos' })).toBeEnabled();
});

it('releer cuentas conserva la sesión de autenticación del entorno mientras la autoridad sigue vigente', async () => {
  const id = '00000000-0000-4000-8000-000000000050'; const sessionId = '00000000-0000-4000-8000-000000000051';
  const cancelled = vi.fn(); const scopes = vi.fn();
  const environment = { id: 'env-1', company_id: 'one', account_id: account.id, host_id: 'host', provider: 'codex', label: 'Consulta GPT',
    status: 'awaiting_auth', version: 2, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
  const scope = { operation_id: id, expected_operation_version: 7, request_id: 'quota-auth-request', provider_id: 'codex', account_id: account.id,
    host_id: 'host', harness_id: 'codex', runtime_user: 'node', profile_id: account.id };
  const session = { session_id: sessionId, operation_id: id, provider_id: 'codex', account_id: account.id, host_id: 'host', harness_id: 'codex',
    runtime_user: 'node', profile_id: scope.profile_id, method: 'device', status: 'awaiting_login', cleanup_pending: false, error: null, expires_at: new Date(Date.now() + 60_000).toISOString() };
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: environment.updated_at, accounts: [account] })),
    http.get('*/v3/console/quota-environments', () => HttpResponse.json({ company_id: 'one', environments: [environment], operations: [{ id, environment_id: environment.id,
      action: 'authenticate', status: 'awaiting_auth', error_code: null, result: { expires_at: session.expires_at }, created_at: environment.created_at, updated_at: environment.updated_at }],
    capabilities: { available: true, providers: ['codex'], actions: ['authenticate'], hosts: [{ host_id: 'host', display_name: 'Host', providers: ['codex'], provider_actions: { codex: ['authenticate'] } }] } })),
    http.get(`*/v3/console/provider-auth/operations/${id}/scope`, () => { scopes(); return HttpResponse.json(scope); }),
    http.post('*/v3/console/provider-auth/sessions', () => HttpResponse.json(session)),
    http.post(`*/v3/console/provider-auth/sessions/${sessionId}/cancel`, () => { cancelled(); return HttpResponse.json({ ...session, status: 'cancelled' }); }));
  const user = userEvent.setup(); const view = renderWithApi(owner());
  await user.click(await screen.findByRole('button', { name: 'Conectar cuenta' }));
  await screen.findByRole('button', { name: 'Verificar conexión' });
  await user.click(screen.getByRole('button', { name: 'Actualizar cuotas y entornos' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Actualizar cuotas y entornos' })).toBeEnabled(); });
  expect(screen.getByRole('button', { name: 'Verificar conexión' })).toBeVisible();
  expect(cancelled).not.toHaveBeenCalled(); expect(scopes).toHaveBeenCalledOnce();
  view.unmount(); await waitFor(() => { expect(cancelled).toHaveBeenCalledOnce(); });
});

it('muestra el motivo del fallo con su acción y la hora de medición', async () => {
  const failing = { ...account, observation_status: 'error' as const, note: 'token_expired',
    windows: [{ ...account.windows[0], observation_status: 'error' as const, captured_at: '2026-10-11T00:00:00Z' }] };
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [failing] })));
  renderWithApi(owner());
  const card = within(await screen.findByRole('article', { name: 'Cuotas de Cuenta compartida' }));
  expect(card.getByText('Sesión caducada: autenticar de nuevo')).toBeVisible();
  expect(card.getByText(/Medida/u)).toBeVisible();
});

it('el poller existente actualiza la tarjeta cuando acaba la consulta automática, sin pulsar botones', async () => {
  let phase: 'pending' | 'running' | 'done' = 'pending';
  const environment = { id: 'env-query', company_id: 'one', account_id: account.id, host_id: 'host', provider: 'codex', label: 'Consulta GPT',
    status: 'ready', version: 2, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
  const accountsRead = vi.fn(); const environmentsRead = vi.fn(); const actions = vi.fn();
  server.use(http.get('*/v3/console/quota-accounts', () => {
    accountsRead(); const observation_status = phase === 'done' ? 'ok' : 'stale';
    return HttpResponse.json({ company_id: 'one', observed_at: environment.updated_at, accounts: [{ ...account,
      refresh_status: phase === 'done' ? 'fresh' : 'updating', observation_status, remaining_percent: phase === 'done' ? 72 : 56,
      windows: [{ ...account.windows[0], observation_status, remaining_percent: phase === 'done' ? 72 : 56 }] }] });
  }), http.get('*/v3/console/quota-environments', () => {
    environmentsRead(); return HttpResponse.json({ company_id: 'one', environments: [{ ...environment, refresh_status: phase === 'done' ? 'fresh' : 'updating' }],
      operations: [{ id: 'query', environment_id: environment.id, action: 'query', status: phase, error_code: null, result: null,
        created_at: environment.created_at, updated_at: environment.updated_at }],
      capabilities: { available: true, providers: ['codex'], hosts: [], actions: ['query'] } });
  }), http.post('*/v3/console/quota-environments/:id/actions', () => { actions(); return HttpResponse.json({}, { status: 500 }); }));
  const intervals = vi.spyOn(window, 'setInterval'); renderWithApi(owner());
  const card = within(await screen.findByRole('article', { name: 'Cuotas de Cuenta compartida' }));
  expect(card.getByRole('status')).toHaveTextContent('Actualizando…');
  expect(card.queryByRole('meter')).not.toBeInTheDocument();
  await screen.findByRole('article', { name: 'Entorno Consulta GPT' });
  const tick = intervals.mock.calls.find(([, period]) => period === 15_000)?.[0];
  if (typeof tick !== 'function') throw new Error('No se registró el poller existente.');
  phase = 'running'; act(() => { tick(); });
  await waitFor(() => { expect(accountsRead).toHaveBeenCalledTimes(2); });
  await screen.findByText(/Consultar cuotas · En ejecución/u);
  expect(card.getByRole('status')).toHaveTextContent('Actualizando…');
  phase = 'done'; act(() => { tick(); });
  await waitFor(() => { expect(card.getByRole('meter')).toHaveAttribute('value', '72'); });
  expect(screen.queryByText('Actualizando…')).not.toBeInTheDocument();
  expect(accountsRead).toHaveBeenCalledTimes(3); expect(environmentsRead).toHaveBeenCalledTimes(3);
  expect(intervals.mock.calls.filter(([, period]) => period === 15_000)).toHaveLength(1);
  expect(actions).not.toHaveBeenCalled();
});

const emptyEnvironments = () => HttpResponse.json({ company_id: 'one', environments: [], operations: [], capabilities: { available: true, providers: ['codex'], hosts: [], actions: [] } });
function adminSession() { return <CompanySessionProvider state={{ authenticated: true, authority: { role: 'company_admin', scope: 'company',
  home_company: 'one', acting_company: 'one', platform_override: false } }}><MyQuotasPage /></CompanySessionProvider>; }

it('editar una cuenta con pausa automática no reenvía el motivo reservado y lo muestra traducido', async () => {
  const patches: unknown[] = [];
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z',
      accounts: [{ ...account, paused_until: '2026-10-12T17:00:00Z', paused_reason: 'quota_exhausted:weekly' }] })),
    http.get('*/v3/console/quota-environments', emptyEnvironments),
    http.patch('*/v3/console/quota-accounts/subscription', async ({ request }) => { patches.push(await request.json()); return HttpResponse.json({ account_id: 'subscription', version: 4 }); }));
  const user = userEvent.setup(); renderWithApi(owner());
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Editar cuenta' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Editar cuenta' }));
  const form = within(await screen.findByRole('form', { name: 'Editar cuenta de cuotas' }));
  expect(form.getByText('Pausada por cuota agotada en weekly')).toBeVisible();
  expect(form.queryByRole('textbox', { name: 'Motivo de pausa' })).not.toBeInTheDocument();
  await user.clear(form.getByRole('textbox', { name: 'Nombre de la cuenta' })); await user.type(form.getByRole('textbox', { name: 'Nombre de la cuenta' }), 'Renombrada');
  await user.click(form.getByRole('button', { name: 'Guardar cuenta' }));
  expect(await screen.findByText('Cuenta actualizada.')).toBeVisible();
  expect(patches).toEqual([{ expected_version: 3, label: 'Renombrada', enabled: true }]);
});

it('el alta de cuenta no ofrece gemini aunque las capacidades lo anuncien', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [] })),
    http.get('*/v3/console/quota-environments', () => HttpResponse.json({ company_id: 'one', environments: [], operations: [],
      capabilities: { available: true, providers: ['codex', 'gemini', 'grok'], hosts: [], actions: ['create'] } })),
    http.get('*/v3/console/preferences', () => HttpResponse.json({ version: 1, pinned_quota_accounts: [] })));
  const user = userEvent.setup(); renderWithApi(owner());
  await user.click(await screen.findByRole('button', { name: 'Registrar cuenta' }));
  const provider = within(await screen.findByRole('form', { name: 'Registrar cuenta de cuotas' })).getByRole('combobox', { name: 'Proveedor' });
  expect(within(provider).getByRole('option', { name: 'codex' })).toBeInTheDocument();
  expect(within(provider).getByRole('option', { name: 'grok' })).toBeInTheDocument();
  expect(within(provider).queryByRole('option', { name: 'gemini' })).not.toBeInTheDocument();
});

it('reanudar manda pausa y motivo nulos, y una fecha elegida se envía como instante con zona', async () => {
  const patches: Record<string, unknown>[] = [];
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z',
      accounts: [{ ...account, paused_until: '2026-10-12T17:00:00Z', paused_reason: 'quota_exhausted:weekly' }] })),
    http.get('*/v3/console/quota-environments', emptyEnvironments),
    http.patch('*/v3/console/quota-accounts/subscription', async ({ request }) => { patches.push(await request.json() as Record<string, unknown>); return HttpResponse.json({ account_id: 'subscription', version: 4 }); }));
  const user = userEvent.setup(); renderWithApi(owner());
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Editar cuenta' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Editar cuenta' }));
  let form = within(await screen.findByRole('form', { name: 'Editar cuenta de cuotas' }));
  fireEvent.change(form.getByLabelText('Pausa hasta (hora de tu navegador)'), { target: { value: '2026-12-10T08:30' } });
  expect(form.getByText(/Se guardará:/u)).toBeVisible();
  await user.click(form.getByRole('button', { name: 'Guardar cuenta' }));
  await screen.findByText('Cuenta actualizada.');
  expect(patches[0]).toMatchObject({ paused_until: new Date('2026-12-10T08:30').toISOString(), paused_reason: null });
  await user.click(screen.getByRole('button', { name: 'Editar cuenta' }));
  form = within(await screen.findByRole('form', { name: 'Editar cuenta de cuotas' }));
  await user.click(form.getByRole('checkbox', { name: 'Reanudar ahora (quita la pausa)' }));
  await user.click(form.getByRole('button', { name: 'Guardar cuenta' }));
  await waitFor(() => { expect(patches).toHaveLength(2); });
  expect(patches[1]).toMatchObject({ paused_until: null, paused_reason: null });
});

it('un administrador de empresa lee las cuotas pero no puede registrar, editar ni eliminar cuentas', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/quota-environments', emptyEnvironments));
  renderWithApi(adminSession());
  expect(await screen.findByRole('article', { name: 'Cuotas de Cuenta compartida' })).toBeVisible();
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Fijar cuenta' })).toBeEnabled(); });
  expect(screen.getByRole('button', { name: 'Registrar cuenta' })).toBeDisabled();
  expect(screen.getByRole('button', { name: 'Editar cuenta' })).toBeDisabled();
});

it('un 503 sin mensaje y un 409 en inglés se muestran traducidos', async () => {
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/quota-environments', emptyEnvironments),
    http.patch('*/v3/console/quota-accounts/subscription', () => HttpResponse.json({ message: 'quota account version changed or the change is not allowed' }, { status: 409 })));
  const user = userEvent.setup(); renderWithApi(owner());
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Editar cuenta' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Editar cuenta' }));
  await user.click(within(await screen.findByRole('form', { name: 'Editar cuenta de cuotas' })).getByRole('button', { name: 'Guardar cuenta' }));
  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('Otro cambio llegó antes');
  expect(alert).not.toHaveTextContent('quota account');
});

it('si fijar una tarjeta da 409 relee las preferencias y ofrece releerlas', async () => {
  let version = 4; let reads = 0;
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/quota-environments', emptyEnvironments),
    http.get('*/v3/console/preferences', () => { reads += 1; return HttpResponse.json({ version, pinned_quota_accounts: [] }); }),
    http.put('*/v3/console/preferences', () => { version = 5; return HttpResponse.json({ message: 'stale' }, { status: 409 }); }));
  const user = userEvent.setup(); renderWithApi(owner());
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Fijar cuenta' })).toBeEnabled(); });
  const before = reads;
  await user.click(screen.getByRole('button', { name: 'Fijar cuenta' }));
  expect(await screen.findByRole('button', { name: 'Releer tarjetas fijadas' })).toBeVisible();
  await waitFor(() => { expect(reads).toBeGreaterThan(before); });
});
it('anuncia la carga inicial de entornos mientras el snapshot viaja', async () => {
  server.use(http.get('*/v3/console/quota-environments', async () => {
    await new Promise(resolve => { setTimeout(resolve, 600); });
    return HttpResponse.json({ company_id: 'one', environments: [], operations: [],
      capabilities: { available: false, providers: [], hosts: [], actions: [] } });
  }));
  renderWithApi(owner());
  expect(await screen.findByText(/El formulario se habilita cuando llega la lectura/u)).toBeVisible();
  expect(await screen.findByText(/No hay entornos de consulta/u)).toBeVisible();
});
