import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client/core';
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
  it('keeps a login the poll already verified when the slower verify reply fails afterwards', async () => {
    let failVerify: (cause: unknown) => void = () => undefined;
    let authenticated = false;
    const fetcher: RequestFn = async <T,>(path: string) => {
      if (path.endsWith('/verify')) return new Promise<T>((_resolve, reject) => { failVerify = reject; });
      return (authenticated ? { ...session, status: 'authenticated' } : session) as T;
    };
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Verificar conexión' }));
    authenticated = true;
    await screen.findByText('Cuenta e identidad verificadas', undefined, { timeout: 3000 });
    failVerify(new ApiError('operator lost permission', 403, 'forbidden'));
    await new Promise(resolve => setTimeout(resolve, 50));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText('Cuenta e identidad verificadas')).toBeInTheDocument();
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
  it.each([
    ['CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT', 'La imagen o las etiquetas de propiedad del contenedor'],
    ['CONTAINER_RESOURCE_LIMITS_DRIFT', 'Los límites de recursos del contenedor'],
    ['CONTAINER_ISOLATION_DRIFT', 'El aislamiento del contenedor'],
  ] as const)('explains %s while preserving unconfirmed cleanup', async (reason, expected) => {
    const fetcher: RequestFn = async <T,>() => ({ ...session, status: 'failed', cleanup_pending: true, error: 'STOP_UNCONFIRMED', reason }) as T;
    const done = vi.fn(); render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} onAuthenticated={done} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se confirmó la parada.'); expect(alert).toHaveTextContent(expected);
    expect(alert).toHaveTextContent('El perfil sigue reservado; revisa su recuperación y confirma la parada antes de volver a iniciar sesión.');
    expect(screen.queryByRole('button', { name: 'Conectar cuenta' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Verificar conexión' })).not.toBeInTheDocument();
    expect(done).not.toHaveBeenCalled();
  });
  it('explains an unconfirmed stop without claiming the released profile is reserved', async () => {
    const fetcher: RequestFn = async <T,>() => ({ ...session, status: 'failed', cleanup_pending: false,
      error: 'STOP_UNCONFIRMED', reason: 'CONTAINER_RESOURCE_LIMITS_DRIFT' }) as T;
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se confirmó la parada. Los límites de recursos del contenedor');
    expect(alert).toHaveTextContent('Revisa su recuperación y confirma la parada antes de volver a iniciar sesión.');
    expect(alert.textContent).not.toContain('reservado');
  });
  it.each([
    ['PROBE_TIMEOUT', 'El proveedor tardó más de lo permitido en responder la prueba de identidad.'],
    ['PROBE_IDENTITY_MISMATCH', 'La cuenta conectada no es la esperada.'],
    [undefined, 'La cuenta conectada no corresponde a la identidad autorizada.'],
  ] as const)('explains the failed identity probe %s instead of a generic mismatch', async (reason, expected) => {
    const fetcher: RequestFn = async <T,>() => ({ ...session, status: 'failed', error: 'IDENTITY_MISMATCH', ...(reason ? { reason } : {}) }) as T;
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(expected);
  });
  it('rejects an unknown cleanup reason without echoing it', async () => {
    const fetcher: RequestFn = async <T,>() => ({ ...session, status: 'failed', cleanup_pending: true,
      error: 'STOP_UNCONFIRMED', reason: 'SYNTHETIC_PRIVATE_REASON' }) as T;
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('No se pudo verificar esta conexión.');
    expect(document.body.textContent).not.toContain('SYNTHETIC_PRIVATE_REASON');
  });
  it('explains an unconfirmed stop HTTP error without echoing private details', async () => {
    const fetcher: RequestFn = () => Promise.reject(new ApiError('SYNTHETIC_PRIVATE_TOKEN', 503, 'STOP_UNCONFIRMED'));
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('No se confirmó la parada. Revisa su recuperación y confirma la parada');
    expect(alert.textContent).not.toContain('reservado');
    expect(alert.textContent).not.toContain('SYNTHETIC_PRIVATE_TOKEN');
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
  it('keeps a concrete forbidden reason and translates a stable operation code', async () => {
    const forbidden: RequestFn = () => Promise.reject(new ApiError('operator must be hub', 403, 'forbidden'));
    render(<ProviderAuthPanel request={request} client={providerAuthClient(forbidden)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    const hub = await screen.findByRole('alert');
    expect(hub).toHaveTextContent('Pide un rol vigente');
    expect(hub).toHaveTextContent('operator must be hub');
  });
  it('translates a stable host-unavailable code without echoing the server sentence', async () => {
    const fetcher: RequestFn = () => Promise.reject(new ApiError('ENGLISH SERVER ERROR', 503, 'HOST_UNAVAILABLE'));
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('El ordenador kratos no está disponible. Revisa su estado y su conexión');
    expect(alert.textContent).not.toContain('ENGLISH SERVER ERROR');
  });
  it.each(['RUNTIME_DRIFT', 'HOST_UNAVAILABLE'] as const)('explains %s from a validated failed snapshot', async error => {
    const fetcher: RequestFn = async <T,>() => ({ ...session, status: 'failed', error }) as T;
    const done = vi.fn(); render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} onAuthenticated={done} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(error === 'RUNTIME_DRIFT'
      ? 'El contenedor del agente quedó con una imagen anterior. Cancela esta operación y pulsa Preparar para recrearlo; luego inicia sesión.'
      : 'El ordenador kratos no está disponible. Revisa su estado y su conexión');
    expect(done).not.toHaveBeenCalled();
  });
  it('explains runtime drift from an HTTP error without showing server details', async () => {
    const fetcher: RequestFn = () => Promise.reject(new ApiError('SYNTHETIC_PRIVATE_TOKEN', 503, 'RUNTIME_DRIFT'));
    render(<ProviderAuthPanel request={request} client={providerAuthClient(fetcher)} />);
    fireEvent.click(screen.getByRole('button', { name: 'Conectar cuenta' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Cancela esta operación y pulsa Preparar para recrearlo; luego inicia sesión.');
    expect(alert.textContent).not.toContain('SYNTHETIC_PRIVATE_TOKEN');
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
