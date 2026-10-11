import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { expect, it, vi } from 'vitest';
import type { QuotaEnvironment, QuotaEnvironmentOperation } from '../../api/client/my-quotas-client';
import { ApiProvider } from '../../api/context';
import { server } from '../../mocks/server';
import { renderWithApi, testApi } from '../../test/render';
import { QuotaAuthPanel } from './QuotaAuthPanel';

vi.mock('./ProviderAuthTerminal', () => ({ ProviderAuthTerminal: () => null }));
const id = '00000000-0000-4000-8000-000000000050';
const sessionId = '00000000-0000-4000-8000-000000000051';
const environment: QuotaEnvironment = { id: 'env', company_id: 'one', account_id: 'codex-main', host_id: 'kratos', provider: 'codex',
  label: 'Mi entorno', status: 'awaiting_auth', version: 3, created_at: '2026-10-11T00:00:00Z', updated_at: '2026-10-11T00:00:00Z' };
const operation: QuotaEnvironmentOperation = { id, environment_id: environment.id, action: 'authenticate', status: 'awaiting_auth',
  error_code: null, result: null, created_at: environment.created_at, updated_at: environment.updated_at };
const scope = { operation_id: id, expected_operation_version: 7, request_id: 'quota-auth-request', provider_id: 'codex', account_id: environment.account_id,
  harness_id: 'codex', host_id: 'kratos', runtime_user: 'node', profile_id: environment.account_id };
const session = { session_id: sessionId, operation_id: id, provider_id: 'codex', account_id: scope.account_id, harness_id: 'codex', host_id: 'kratos',
  runtime_user: 'node', profile_id: scope.profile_id, method: 'device', status: 'awaiting_login', cleanup_pending: false, error: null,
  expires_at: new Date(Date.now() + 60_000).toISOString() };
const path = `http://localhost/v3/console/provider-auth/operations/${id}/scope`;
function login() {
  server.use(http.get(path, () => HttpResponse.json(scope)),
    http.post('http://localhost/v3/console/provider-auth/sessions', () => HttpResponse.json(session)),
    http.post(`http://localhost/v3/console/provider-auth/sessions/${sessionId}/verify`, () => HttpResponse.json({ ...session, status: 'authenticated' })),
    http.post(`http://localhost/v3/console/provider-auth/sessions/${sessionId}/cancel`, () => HttpResponse.json({ ...session, status: 'cancelled' })));
}
async function authenticate() {
  fireEvent.click(await screen.findByRole('button', { name: 'Conectar cuenta' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Verificar conexión' }));
}
it('usa claim_epoch del scope independiente de versión del entorno y relee tras verificar la cuenta', async () => {
  login(); const reload = vi.fn().mockResolvedValue(undefined); let input: unknown;
  server.use(http.post('http://localhost/v3/console/provider-auth/sessions', async ({ request }) => { input = await request.json(); return HttpResponse.json(session); }));
  renderWithApi(<QuotaAuthPanel environment={environment} operation={operation} allowed reload={reload} />);
  await authenticate(); await waitFor(() => { expect(reload).toHaveBeenCalledOnce(); });
  expect(input).toEqual(scope); expect(scope.expected_operation_version).not.toBe(environment.version);
  expect(JSON.stringify(input)).not.toMatch(/command|shell|mount/iu);
  expect(screen.getByText('Cuenta e identidad verificadas')).toBeVisible();
  expect(screen.getByText('codex · codex-main')).toBeVisible();
  expect(document.body.textContent).not.toContain('cuenta del agente');
});
it.each([{ provider_id: 'claude' }, { account_id: 'other' }, { host_id: 'other' }, { operation_id: sessionId },
  { runtime_user: 'dev' }, { harness_id: 'claude' }, { profile_id: 'other-profile' }])('rechaza un scope de destino distinto %j', async patch => {
  server.use(http.get(path, () => HttpResponse.json({ ...scope, ...patch })));
  renderWithApi(<QuotaAuthPanel environment={environment} operation={operation} allowed reload={vi.fn()} />);
  expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo acreditar la autorización');
  expect(screen.queryByRole('button', { name: 'Conectar cuenta' })).not.toBeInTheDocument();
});
it.each([{ allowed: false, status: 'awaiting_auth' }, { allowed: true, status: 'done' }] as const)('no resuelve scope sin estado y autoridad vigentes %j', async ({ allowed, status }) => {
  const read = vi.fn(); server.use(http.get(path, () => { read(); return HttpResponse.json(scope); }));
  renderWithApi(<QuotaAuthPanel environment={environment} operation={{ ...operation, status }} allowed={allowed} reload={vi.fn()} />);
  await waitFor(() => { expect(screen.queryByRole('button', { name: 'Conectar cuenta' })).not.toBeInTheDocument(); });
  expect(read).not.toHaveBeenCalled();
});
it('ignora respuestas atrasadas al cambiar la cuenta y sanitiza el error del servidor', async () => {
  let release: (() => void) | undefined; let reads = 0;
  server.use(http.get(path, async () => {
    reads += 1;
    if (reads === 1) { await new Promise<void>(resolve => { release = resolve; }); return HttpResponse.json(scope); }
    return HttpResponse.json({ message: 'PRIVATE_PROFILE' }, { status: 403 });
  }));
  const view = renderWithApi(<QuotaAuthPanel environment={environment} operation={operation} allowed reload={vi.fn()} />);
  await waitFor(() => { expect(reads).toBe(1); });
  view.rerender(<ApiProvider api={testApi}><QuotaAuthPanel environment={{ ...environment, account_id: 'other' }} operation={operation} allowed reload={vi.fn()} /></ApiProvider>);
  release?.(); expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo acreditar la autorización');
  expect(screen.queryByRole('button', { name: 'Conectar cuenta' })).not.toBeInTheDocument();
  expect(document.body.textContent).not.toContain('PRIVATE_PROFILE');
});
it('conserva la sesión al cambiar versión del entorno y reporta relectura fallida aparte de identidad verificada', async () => {
  login(); const reload = vi.fn().mockRejectedValue(new Error('PRIVATE_REFRESH')); const cancelled = vi.fn();
  server.use(http.post(`http://localhost/v3/console/provider-auth/sessions/${sessionId}/cancel`, () => { cancelled(); return HttpResponse.json({ ...session, status: 'cancelled' }); }));
  const view = renderWithApi(<QuotaAuthPanel environment={environment} operation={operation} allowed reload={reload} />);
  fireEvent.click(await screen.findByRole('button', { name: 'Conectar cuenta' }));
  await screen.findByRole('button', { name: 'Verificar conexión' });
  view.rerender(<ApiProvider api={testApi}><QuotaAuthPanel environment={{ ...environment, version: 4 }} operation={operation} allowed reload={reload} /></ApiProvider>);
  expect(cancelled).not.toHaveBeenCalled(); fireEvent.click(screen.getByRole('button', { name: 'Verificar conexión' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('no se pudo releer el entorno');
  expect(screen.getByText('Cuenta e identidad verificadas')).toBeVisible(); expect(document.body.textContent).not.toContain('PRIVATE_REFRESH');
});
