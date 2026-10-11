import { screen, waitFor, within } from '@testing-library/react';
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
  payer_tenant_id: 'One', shared: true, agents: [{ tenant_id: 'One', alias: 'first', enabled: true }, { tenant_id: 'One', alias: 'second', enabled: true }],
  paused_until: null, paused_reason: null, observation_status: 'ok', remaining_percent: 56, note: null,
  windows: [{ group_key: 'primary', window_key: 'weekly', model: 'gpt', label: 'Semanal', host: 'host', used_percent: 44, remaining_percent: 56,
    window_minutes: 10_080, captured_at: null, received_at: '2026-10-11T00:00:00Z', reset_at: null, observation_status: 'ok' }] };
function owner() { return <CompanySessionProvider state={{ authenticated: true, authority: { role: 'company_owner', scope: 'company',
  home_company: 'one', acting_company: 'one', platform_override: false } }}><MyQuotasPage /></CompanySessionProvider>; }

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

it('registra una cuenta sin ejecutor y respeta límites contractuales en las cuentas y entornos', async () => {
  const environment = { id: 'env-1', company_id: 'one', account_id: 'subscription', host_id: 'host', provider: 'codex', label: 'Consulta GPT',
    status: 'ready', version: 2, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
  const writes: unknown[] = [];
  server.use(http.get('*/v3/console/quota-accounts', () => HttpResponse.json({ company_id: 'one', observed_at: '2026-10-11T00:00:00Z', accounts: [account] })),
    http.get('*/v3/console/quota-environments', () => HttpResponse.json({ company_id: 'one', environments: [environment], operations: [],
      capabilities: { available: false, providers: [], hosts: [], actions: [] } })),
    http.post('*/v3/console/quota-accounts', async ({ request }) => { writes.push(await request.json()); return HttpResponse.json({ account_id: 'new-account', duplicate: false }); }));
  const user = userEvent.setup(); renderWithApi(owner());
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Registrar cuenta' })).toBeEnabled(); });
  await user.click(screen.getByRole('button', { name: 'Registrar cuenta' }));
  const form = within(await screen.findByRole('form', { name: 'Registrar cuenta de cuotas' }));
  expect(form.getByRole('textbox', { name: 'Nombre de la cuenta' })).toHaveAttribute('maxlength', '80');
  expect(form.getByRole('combobox', { name: 'Proveedor' })).toHaveTextContent('claudecodexgeminigrok');
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
    http.post('*/v3/console/quota-environments/env-1/actions', () => HttpResponse.json({ message: 'Hay una autenticación activa. Relee el entorno.' }, { status: 409 })));
  const user = userEvent.setup(); renderWithApi(owner());
  await user.click(await screen.findByRole('button', { name: 'Consultar cuotas' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Hay una autenticación activa.');
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
  const user = userEvent.setup(); renderWithApi(owner());
  await user.click(await screen.findByRole('button', { name: 'Conectar cuenta' }));
  await screen.findByRole('button', { name: 'Verificar conexión' });
  await user.click(screen.getByRole('button', { name: 'Actualizar cuotas y entornos' }));
  await waitFor(() => { expect(screen.getByRole('button', { name: 'Actualizar cuotas y entornos' })).toBeEnabled(); });
  expect(screen.getByRole('button', { name: 'Verificar conexión' })).toBeVisible();
  expect(cancelled).not.toHaveBeenCalled(); expect(scopes).toHaveBeenCalledOnce();
});
