import { useCallback, useEffect, useRef, useState } from 'react';
import { assertProviderAuthTarget, type ProviderAuthClient, type ProviderAuthRequest, type ProviderAuthSnapshot } from '../../api/client/provider-auth-client';
import { ApiError } from '../../api/client/core';
import { describeOperationError } from './quota-messages';
import { ProviderAuthTerminal } from './ProviderAuthTerminal';

interface Props { request: ProviderAuthRequest; client: ProviderAuthClient; onAuthenticated?: (snapshot: ProviderAuthSnapshot) => void; title?: string; showRuntime?: boolean }
const active = (value: ProviderAuthSnapshot) => ['opening', 'awaiting_login', 'verifying'].includes(value.status);
const message = (value: ProviderAuthSnapshot) => value.cleanup_pending ? 'No se confirmó la parada. El perfil sigue reservado; revisa su recuperación.'
  : value.error === 'IDENTITY_MISMATCH' ? 'La cuenta conectada no corresponde a la identidad autorizada.'
    : value.error === 'FUNCTIONAL_CHECK_FAILED' ? 'La cuenta aún no pasó una llamada funcional.'
      : value.status === 'expired' ? 'La conexión caducó. Relee la operación antes de continuar.'
        : 'La conexión no se pudo verificar. Relee la operación antes de continuar.';

function requestError(cause: unknown): string {
  if (!(cause instanceof ApiError)) return 'No se pudo verificar esta conexión. Relee el estado de la operación y vuelve a intentarlo.';
  if (cause.status === 401 || cause.code === 'unauthorized') return 'La sesión de consola venció. Vuelve a entrar e inicia la conexión del proveedor otra vez.';
  if (cause.code === 'forbidden') return 'Tu sesión ya no tiene permiso para controlar esta conexión. Pide un rol vigente y vuelve a iniciar la operación.';
  if (cause.code === 'INVALID_REQUEST') return 'La solicitud no coincide con la operación o el entorno. Relee la operación y vuelve a iniciar la conexión.';
  if (cause.code === 'LOGIN_FAILED') return 'No se pudo completar el inicio de sesión del proveedor. Relee el entorno y vuelve a autenticar la cuenta.';
  return cause.code ? describeOperationError(cause.code)
    : 'No se pudo verificar esta conexión. Relee el estado de la operación y vuelve a intentarlo.';
}

export function ProviderAuthPanel({ request, client, onAuthenticated, title = 'Conectar la cuenta del agente', showRuntime = true }: Props) {
  const [session, setSession] = useState<ProviderAuthSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = useRef<ProviderAuthSnapshot | null>(null);
  const alive = useRef(true);
  const scopeKey = JSON.stringify(request);
  const currentScope = useRef(scopeKey);
  currentScope.current = scopeKey;
  const accepted = useRef<string | null>(null);
  const accept = useCallback((value: ProviderAuthSnapshot) => {
    assertProviderAuthTarget(value, request);
    if (scopeKey !== currentScope.current) { if (active(value)) void client.cancel(value.session_id).catch(() => undefined); return; }
    current.current = value;
    if (!alive.current) return;
    setSession(value); setError(value.status === 'failed' || value.status === 'expired' || value.cleanup_pending ? message(value) : null);
    if (value.status === 'authenticated' && accepted.current !== value.session_id) {
      accepted.current = value.session_id; onAuthenticated?.(value);
    }
  }, [request, onAuthenticated, scopeKey, client]);
  useEffect(() => {
    alive.current = true;
    current.current = null; accepted.current = null; setSession(null); setError(null); setBusy(false);
    return () => {
      alive.current = false;
      const value = current.current;
      if (value && active(value)) void client.cancel(value.session_id).catch(() => undefined);
    };
  }, [client, scopeKey]);
  useEffect(() => {
    if (!session || !active(session)) return;
    let disposed = false;
    let pending = false;
    const timer = setInterval(() => {
      if (pending) return;
      pending = true;
      void client.get(session.session_id).then(value => { if (!disposed) accept(value); })
        .catch(cause => { if (!disposed) setError(requestError(cause)); })
        .finally(() => { pending = false; });
    }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client, session, accept]);
  const run = async (action: 'start' | 'verify' | 'cancel') => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const value = action === 'start' ? await client.start(request) : session ? await client[action](session.session_id) : null;
      if (value) accept(value);
    } catch (cause) { if (alive.current) setError(requestError(cause)); }
    finally { if (alive.current) setBusy(false); }
  };
  const disconnected = useCallback(() => { if (alive.current && current.current && active(current.current)) {
    setError('El terminal de autenticación se cerró. Relee el estado de la operación.');
  } }, []);
  return <section aria-label="Conexión de proveedor">
    <h3>{title}</h3>
    <p>{request.provider_id} · {request.account_id}{showRuntime ? ` · ${request.harness_id}` : ''}</p>
    <p>{request.host_id}{showRuntime ? ` · ${request.runtime_user}` : ''}</p>
    {error && <p role="alert">{error}</p>}
    {!session && <button disabled={busy} onClick={() => { void run('start'); }}>Conectar cuenta</button>}
    {session?.status === 'awaiting_login' && <>
      <p>{session.method === 'device' ? 'Sigue la autorización del proveedor en el terminal.' : 'Completa el inicio de sesión en el terminal.'}</p>
      <ProviderAuthTerminal session={session} client={client} onDisconnect={disconnected} />
      <button disabled={busy} onClick={() => { void run('verify'); }}>Verificar conexión</button>
    </>}
    {session && active(session) && <button disabled={busy} onClick={() => { void run('cancel'); }}>Cancelar conexión</button>}
    {session?.status === 'authenticated' && <p role="status">Cuenta e identidad verificadas</p>}
    {session?.status === 'cancelled' && <p role="status">Conexión cancelada</p>}
  </section>;
}
