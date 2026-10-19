import { fireEvent, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it, vi } from 'vitest';
import type { FleetOperation } from '@cauce/protocol/fleet-operation';
import { server } from '../../mocks/server';
import { renderWithApi, testApi } from '../../test/render';
import { ApiProvider } from '../../api/context';
import { AuthOperationPanel } from './AuthOperationPanel';
import { AgentFleetOperation } from './AgentFleetOperation';

vi.mock('../accounts/ProviderAuthTerminal', () => ({ ProviderAuthTerminal: () => null }));
const id = '00000000-0000-4000-8000-000000000050';
const sessionId = '00000000-0000-4000-8000-000000000051';
const operation: FleetOperation = { id, kind: 'start', target: { resource: 'agent', tenant_id: 'Steven', alias: 'kant' },
  status: 'awaiting_auth', version: 2, request_sha256: 'a'.repeat(64), actor: { tenant_id: 'Steven', alias: 'kant' },
  expected_revision: 4, desired_revision: 5, applied_revision: null, steps: [{ name: 'authenticate', status: 'waiting' }], error: null,
  created_at: '2026-10-07T12:00:00Z', updated_at: '2026-10-07T12:00:00Z' };
const scope = { operation_id: id, expected_operation_version: 2, request_id: 'auth-request-one', provider_id: 'codex',
  account_id: 'codex-main', harness_id: 'codex', host_id: 'kratos', runtime_user: 'dev', profile_id: 'private-profile-route' };
const session = { session_id: sessionId, operation_id: id, provider_id: 'codex', account_id: 'codex-main', harness_id: 'codex',
  host_id: 'kratos', runtime_user: 'dev', profile_id: scope.profile_id, method: 'device', status: 'awaiting_login',
  expires_at: new Date(Date.now() + 60_000).toISOString(), cleanup_pending: false, error: null };
const path = `http://localhost/v3/console/provider-auth/operations/${id}/scope`;
const operationPath = `http://localhost/v3/console/fleet/operations/${id}`;
function login() {
  server.use(http.get(path, () => HttpResponse.json(scope)),
    http.post('http://localhost/v3/console/provider-auth/sessions', () => HttpResponse.json(session)),
    http.post(`http://localhost/v3/console/provider-auth/sessions/${sessionId}/verify`, () => HttpResponse.json({ ...session, status: 'authenticated' })),
    http.post(`http://localhost/v3/console/provider-auth/sessions/${sessionId}/cancel`, () => HttpResponse.json({ ...session, status: 'cancelled' })));
}
async function authenticate() {
  fireEvent.click(await screen.findByRole('button', { name: 'Iniciar sesión' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Verificar conexión' }));
}
describe('operation-scoped provider authentication', () => {
  it('requires preparation instead of authentication or resume for a drifted container', () => {
    const control = vi.fn();
    renderWithApi(<AgentFleetOperation operation={{ ...operation, error: { code: 'RUNTIME_DRIFT', step: 'authenticate', retryable: false } }}
      busy={false} current control={control} onAuthRefreshed={vi.fn()} />);
    expect(screen.getByRole('alert')).toHaveTextContent('El contenedor del agente quedó con una imagen anterior. Cancela esta operación y pulsa Preparar para recrearlo; luego inicia sesión.');
    expect(screen.getByText('Requiere preparación')).toBeInTheDocument();
    expect(screen.getAllByRole('status')[0]).toHaveTextContent('Cancela esta operación y pulsa Preparar');
    expect(screen.queryByLabelText('Autenticación de la operación')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Iniciar sesión' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reanudar' })).not.toBeInTheDocument();
    const cancel = screen.getByRole('button', { name: 'Cancelar' });
    expect(cancel).toBeEnabled(); expect(cancel).toHaveClass('primary');
    fireEvent.click(cancel); expect(control).toHaveBeenCalledWith('cancel');
  });
  it('uses the private server scope, hides its profile and rereads current version without automatically resuming', async () => {
    login(); const refreshed = vi.fn(); const resume = vi.fn(); let posted: unknown;
    server.use(http.post('http://localhost/v3/console/provider-auth/sessions', async ({ request }) => {
      posted = await request.json(); return HttpResponse.json(session);
    }), http.get(operationPath, () => HttpResponse.json({ ...operation, version: 3 })),
    http.post(`${operationPath}/resume`, () => { resume(); return HttpResponse.json({}); }));
    renderWithApi(<AuthOperationPanel operation={operation} allowed onRefreshed={refreshed} />);
    await authenticate();
    expect(await screen.findByText(/Cuenta verificada\. Ya puedes pulsar «Reanudar»/i)).toBeInTheDocument();
    expect(posted).toEqual(scope);
    expect(refreshed).toHaveBeenCalledWith({ ...operation, version: 3 });
    expect(resume).not.toHaveBeenCalled();
    expect(document.body.textContent).not.toContain(scope.profile_id);
  });
  it.each([{ allowed: false, status: 'awaiting_auth' }, { allowed: true, status: 'queued' }] as const)(
    'does not resolve private scope with allowed=$allowed and status=$status', async ({ allowed, status }) => {
      const read = vi.fn(); server.use(http.get(path, () => { read(); return HttpResponse.json(scope); }));
      renderWithApi(<AuthOperationPanel operation={{ ...operation, status }} allowed={allowed} onRefreshed={vi.fn()} />);
      await waitFor(() => { expect(screen.queryByRole('button', { name: 'Iniciar sesión' })).toBeNull(); });
      expect(read).not.toHaveBeenCalled();
    });
  it.each([{ expected_operation_version: 3 }, { operation_id: sessionId }])('refuses a private scope for another operation or version: %j', async (patch) => {
    server.use(http.get(path, () => HttpResponse.json({ ...scope, ...patch })));
    renderWithApi(<AuthOperationPanel operation={operation} allowed onRefreshed={vi.fn()} />);
    await screen.findByRole('alert');
    expect(screen.queryByRole('button', { name: 'Iniciar sesión' })).toBeNull();
    expect(document.body.textContent).not.toContain(scope.profile_id);
  });
  it.each([{ version: 1 }, { request_sha256: 'b'.repeat(64) }, { target: { resource: 'agent', tenant_id: 'Other', alias: 'kant' } }])(
    'keeps an authenticated account separate from an unverifiable operation reread: %j', async (patch) => {
      login(); const refreshed = vi.fn(); server.use(http.get(operationPath, () => HttpResponse.json({ ...operation, ...patch })));
      renderWithApi(<AuthOperationPanel operation={operation} allowed onRefreshed={refreshed} />);
      await authenticate();
      expect(await screen.findByRole('alert')).toHaveTextContent(/no pudimos actualizar la operación/i);
      expect(refreshed).not.toHaveBeenCalled();
      expect(screen.queryByText(/Cuenta verificada/i)).toBeNull();
    });
  it('ignores a delayed scope from the previous version and sanitizes backend denial', async () => {
    let release: (() => void) | undefined;
    let reads = 0;
    server.use(http.get(path, async () => {
      reads += 1;
      if (reads === 1) { await new Promise<void>(resolve => { release = resolve; }); return HttpResponse.json(scope); }
      return HttpResponse.json({ error: 'forbidden', message: 'PRIVATE_PROFILE_LOCATOR' }, { status: 403 });
    }));
    const view = renderWithApi(<AuthOperationPanel operation={operation} allowed onRefreshed={vi.fn()} />);
    await waitFor(() => { expect(reads).toBe(1); });
    view.rerender(<ApiProvider api={testApi}><AuthOperationPanel operation={{ ...operation, version: 3 }} allowed onRefreshed={vi.fn()} /></ApiProvider>);
    release?.();
    expect(await screen.findByRole('alert')).toHaveTextContent(/corresponde a otra operación/i);
    fireEvent.click(screen.getByRole('button', { name: 'Reintentar' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/No se pudo preparar el inicio de sesión/i);
    await waitFor(() => { expect(screen.queryByRole('button', { name: 'Iniciar sesión' })).toBeNull(); });
    expect(document.body.textContent).not.toContain('PRIVATE_PROFILE_LOCATOR');
  });

  it('keeps its active login across the journal version increments created by its own reservation', async () => {
    login(); const cancelled = vi.fn(); const scopes = vi.fn(); const refreshed = vi.fn();
    server.use(http.get(path, () => { scopes(); return HttpResponse.json(scope); }),
      http.post(`http://localhost/v3/console/provider-auth/sessions/${sessionId}/cancel`, () => {
        cancelled(); return HttpResponse.json({ ...session, status: 'cancelled' });
      }), http.get(operationPath, () => HttpResponse.json({ ...operation, version: 4 })));
    const view = renderWithApi(<AuthOperationPanel operation={operation} allowed onRefreshed={refreshed} />);
    fireEvent.click(await screen.findByRole('button', { name: 'Iniciar sesión' }));
    await screen.findByRole('button', { name: 'Verificar conexión' });
    view.rerender(<ApiProvider api={testApi}><AuthOperationPanel operation={{ ...operation, version: 3 }} allowed onRefreshed={refreshed} /></ApiProvider>);
    expect(await screen.findByRole('button', { name: 'Verificar conexión' })).toBeEnabled();
    expect(cancelled).not.toHaveBeenCalled(); expect(scopes).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar conexión' }));
    await screen.findByText(/Cuenta verificada\. Ya puedes pulsar «Reanudar»/i);
    expect(refreshed).toHaveBeenCalledWith({ ...operation, version: 4 });
  });
});
