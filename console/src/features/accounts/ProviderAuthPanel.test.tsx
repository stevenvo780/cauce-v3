import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ProviderAuthPanel } from './ProviderAuthPanel';
import { providerAuthClient, type ProviderAuthRequest, type ProviderAuthSnapshot } from '../../api/client/provider-auth-client';
import type { RequestFn } from '../../api/client/system-client';
import type { RequestOptions } from '../../api/client/core';

vi.mock('./ProviderAuthTerminal', () => ({ ProviderAuthTerminal: () => null }));
const request: ProviderAuthRequest = { operation_id: '00000000-0000-4000-8000-000000000050', expected_operation_version: 2, request_id: 'auth-request-one',
  provider_id: 'codex', account_id: 'codex-main', harness_id: 'codex', host_id: 'kratos', runtime_user: 'dev', profile_id: 'codex-main' };
const snapshot: ProviderAuthSnapshot & Pick<ProviderAuthRequest, 'request_id' | 'expected_operation_version'> = { ...request, session_id: '00000000-0000-4000-8000-000000000051', method: 'device',
  status: 'awaiting_login', expires_at: new Date(Date.now() + 60_000).toISOString(), cleanup_pending: false, error: null };
const { request_id: unusedRequestId, expected_operation_version: unusedVersion, ...session } = snapshot;
void unusedRequestId; void unusedVersion;

describe('provider auth panel', () => {
  it('shows provider/account/host/user without a private profile and credits only a verified server result', async () => {
    const paths: string[] = [];
    const fetcher: RequestFn = async <T,>(path: string) => { paths.push(path); return (path.endsWith('/verify')
      ? { ...session, status: 'authenticated' } : session) as T; };
    const onAuthenticated = vi.fn();
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} onAuthenticated={onAuthenticated} />);
    expect(screen.getByText('codex · codex-main · codex')).toBeInTheDocument();
    expect(screen.getByText(/kratos/)).toBeInTheDocument();
    expect(screen.queryByText(/perfil codex-main/i)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    await screen.findByRole('button', { name: 'Verificar conexión' });
    expect(onAuthenticated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Verificar conexión' }));
    await screen.findByText('Cuenta e identidad verificadas');
    expect(onAuthenticated).toHaveBeenCalledWith(expect.objectContaining({ status: 'authenticated' }));
    expect(paths).toContain('/v3/console/provider-auth/sessions/00000000-0000-4000-8000-000000000051/verify');
  });
  it('never marks a wrong account authenticated and keeps private errors out of the page', async () => {
    const fetcher: RequestFn = async <T,>() => ({ ...session, account_id: 'other-account', status: 'authenticated' }) as T;
    const done = vi.fn();
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} onAuthenticated={done} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    await screen.findByRole('alert'); expect(done).not.toHaveBeenCalled();
    expect(screen.queryByText('Cuenta e identidad verificadas')).not.toBeInTheDocument();
  });
  it('shows incomplete cleanup instead of inviting another login after failed termination', async () => {
    const fetcher: RequestFn = async <T,>(path: string) => (path.endsWith('/cancel')
      ? { ...session, status: 'failed', cleanup_pending: true, error: 'STOP_UNCONFIRMED' } : session) as T;
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    await screen.findByRole('button', { name: 'Cancelar conexión' });
    fireEvent.click(screen.getByRole('button', { name: 'Cancelar conexión' }));
    await screen.findByText(/No se confirmó la parada/);
    expect(screen.queryByRole('button', { name: 'Conectar cuenta' })).not.toBeInTheDocument();
  });
  it('uses CSRF requests and keeps a failed device login unverified', async () => {
    const calls: { options: unknown; init: RequestInit | undefined }[] = [];
    const fetcher: RequestFn = async <T,>(_path: string, init?: RequestInit, options?: RequestOptions) => { calls.push({ options, init });
      return { ...session, status: 'failed', error: 'LOGIN_FAILED' } as T; };
    const done = vi.fn(); render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} onAuthenticated={done} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    await waitFor(() => { expect(screen.getByRole('alert')).toBeInTheDocument(); });
    expect(calls[0]?.options).toMatchObject({ requireCsrf: true }); expect(done).not.toHaveBeenCalled();
  });
  it('cancels and removes the previous sensitive session when its target identity changes', async () => {
    const paths: string[] = [];
    const fetcher: RequestFn = async <T,>(path: string) => { paths.push(path); return session as T; };
    const client = providerAuthClient(fetcher);
    const view = render(<ProviderAuthPanel request={request} client={client} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    await screen.findByRole('button', { name: 'Verificar conexión' });
    view.rerender(<ProviderAuthPanel request={{ ...request, account_id: 'other-account', profile_id: 'other-account' }} client={client} />);
    await screen.findByRole('button', { name: 'Conectar cuenta' });
    expect(screen.queryByRole('button', { name: 'Verificar conexión' })).not.toBeInTheDocument();
    expect(paths).toContain(`/v3/console/provider-auth/sessions/${session.session_id}/cancel`);
  });
  it('rejects a server authenticated receipt with incomplete cleanup or extra private fields', async () => {
    for (const patch of [{ cleanup_pending: true }, { transcript: 'SYNTHETIC_PRIVATE_TOKEN' }]) {
      const fetcher: RequestFn = async <T,>() => ({ ...session, status: 'authenticated', ...patch }) as T;
      const done = vi.fn(); const view = render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} onAuthenticated={done} />);
      fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
      await screen.findByRole('alert'); expect(done).not.toHaveBeenCalled();
      expect(screen.queryByText(/SYNTHETIC_PRIVATE/)).not.toBeInTheDocument(); view.unmount();
    }
  });
});
