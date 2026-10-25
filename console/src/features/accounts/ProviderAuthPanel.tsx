import { useCallback, useEffect, useRef, useState } from 'react';
import { assertProviderAuthTarget, type ProviderAuthClient, type ProviderAuthDriftReason, type ProviderAuthReason, type ProviderAuthRequest, type ProviderAuthSnapshot } from '../../api/client/provider-auth-client';
import { probeFailureMessage } from './provider-probe-messages';
import { ApiError } from '../../api/client/core';
import { spanishWithReason } from '../../api/error-message';
import { describeKnownOperationError } from './quota-messages';
import { Button } from '../../components/kit';
import { ProviderAuthTerminal } from './ProviderAuthTerminal';

interface Props {
  request: ProviderAuthRequest; client: ProviderAuthClient; onAuthenticated?: (snapshot: ProviderAuthSnapshot) => void; title?: string; showRuntime?: boolean;
  /** Opens the provider login as soon as the panel mounts; the click that mounted it was the consent. */
  autoStart?: boolean;
}
const active = (value: ProviderAuthSnapshot) => ['opening', 'awaiting_login', 'verifying'].includes(value.status);
const runtimeDriftMessage = 'El contenedor del agente quedó con una imagen anterior. Cierra este inicio de sesión y vuelve a abrirlo para preparar el contenedor e iniciar sesión con la configuración actual.';
const hostUnavailableMessage = (hostId: string) => `El ordenador ${hostId} no está disponible. Revisa su estado y su conexión antes de volver a iniciar sesión.`;
const stopReasons: Record<ProviderAuthDriftReason, string> = {
  CONTAINER_IMAGE_OR_OWNERSHIP_DRIFT: 'La imagen o las etiquetas de propiedad del contenedor no coinciden con la configuración aprobada.',
  CONTAINER_RESOURCE_LIMITS_DRIFT: 'Los límites de recursos del contenedor no coinciden con la configuración aprobada.',
  CONTAINER_ISOLATION_DRIFT: 'El aislamiento del contenedor no coincide con la configuración aprobada.',
};
const stopReason = (reason?: ProviderAuthReason) => reason !== undefined && Object.hasOwn(stopReasons, reason) ? `${stopReasons[reason as ProviderAuthDriftReason]} ` : '';
const stopUnconfirmedMessage = (reason?: ProviderAuthReason, cleanupPending = false) => `No se confirmó la parada. ${stopReason(reason)}${cleanupPending ? 'El perfil sigue reservado; revisa' : 'Revisa'} su recuperación y confirma la parada antes de volver a iniciar sesión.`;
const message = (value: ProviderAuthSnapshot) => value.cleanup_pending || value.error === 'STOP_UNCONFIRMED' ? stopUnconfirmedMessage(value.reason, value.cleanup_pending)
  : value.error === 'RUNTIME_DRIFT' ? runtimeDriftMessage
    : probeFailureMessage(value.reason) ?? (value.error === 'HOST_UNAVAILABLE' ? hostUnavailableMessage(value.host_id)
      : value.error === 'IDENTITY_MISMATCH' ? 'La cuenta conectada no corresponde a la identidad autorizada.'
        : value.error === 'FUNCTIONAL_CHECK_FAILED' ? 'La cuenta aún no pasó una llamada funcional.'
          : value.status === 'expired' ? 'La conexión caducó. Relee la operación antes de continuar.'
            : 'La conexión no se pudo verificar. Relee la operación antes de continuar.');

function requestError(cause: unknown, hostId: string): string {
  const fallback = 'No se pudo verificar esta conexión. Relee el estado de la operación y vuelve a intentarlo.';
  if (!(cause instanceof ApiError)) return fallback;
  if (cause.code === 'STOP_UNCONFIRMED') return stopUnconfirmedMessage();
  if (cause.code === 'RUNTIME_DRIFT') return runtimeDriftMessage;
  if (cause.code === 'HOST_UNAVAILABLE') return hostUnavailableMessage(hostId);
  if (cause.status === 401 || cause.code === 'unauthorized') {
    return 'La sesión de consola venció. Vuelve a entrar e inicia la conexión del proveedor otra vez.';
  }
  if (cause.code === 'forbidden') {
    return spanishWithReason(
      'Tu sesión ya no tiene permiso para controlar esta conexión. Pide un rol vigente y vuelve a iniciar la operación.',
      cause.message,
    );
  }
  if (cause.code === 'INVALID_REQUEST') {
    return spanishWithReason(
      'La solicitud no coincide con la operación o el entorno. Relee la operación y vuelve a iniciar la conexión.',
      cause.message,
    );
  }
  if (cause.code === 'LOGIN_FAILED') {
    return spanishWithReason(
      'No se pudo completar el inicio de sesión del proveedor. Relee el entorno y vuelve a autenticar la cuenta.',
      cause.message,
    );
  }
  const known = cause.code === undefined ? undefined : describeKnownOperationError(cause.code);
  if (known !== undefined) return known;
  return spanishWithReason(fallback, cause.message);
}

export function ProviderAuthPanel({ request, client, onAuthenticated, title = 'Conectar la cuenta del agente', showRuntime = true, autoStart = false }: Props) {
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
    if (!alive.current) { if (active(value)) void client.cancel(value.session_id).catch(() => undefined); return; }
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
        .catch((cause: unknown) => { if (!disposed) setError(requestError(cause, request.host_id)); })
        .finally(() => { pending = false; });
    }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [client, session, accept, request.host_id]);
  const run = async (action: 'start' | 'verify' | 'cancel') => {
    if (busy) return;
    setBusy(true); setError(null);
    try {
      const value = action === 'start' ? await client.start(request) : session ? await client[action](session.session_id) : null;
      if (value) accept(value);
    } catch (cause) {
      // A late reply (the verify POST after the poll already saw «authenticated») must not undo a verified login.
      if (alive.current && current.current?.status !== 'authenticated') setError(requestError(cause, request.host_id));
    }
    finally { if (alive.current) setBusy(false); }
  };
  const started = useRef<string | null>(null);
  useEffect(() => {
    if (!autoStart || started.current === scopeKey) return;
    started.current = scopeKey; void run('start');
  });
  const disconnected = useCallback(() => { if (alive.current && current.current && active(current.current)) {
    setError('El terminal de autenticación se cerró. Relee el estado de la operación.');
  } }, []);
  return <section aria-label="Conexión de proveedor" className="grid min-w-0 gap-2 wrap-anywhere">
    {autoStart ? null : <>
      <h3>{title}</h3>
      <p>{request.provider_id} · {request.account_id}{showRuntime ? ` · ${request.harness_id}` : ''}</p>
      <p>{request.host_id}{showRuntime ? ` · ${request.runtime_user}` : ''}</p>
    </>}
    {error && <p role="alert">{error}</p>}
    {autoStart && !session && !error ? <p role="status">Abriendo el inicio de sesión del proveedor…</p> : null}
    {!session && (!autoStart || (!busy && error)) && <Button size="sm" disabled={busy} onClick={() => { void run('start'); }}>{autoStart ? 'Reintentar' : 'Conectar cuenta'}</Button>}
    {/* The stream stays open while verifying: closing it cancels the session and aborts the verification. */}
    {(session?.status === 'awaiting_login' || session?.status === 'verifying') && <>
      <p role={session.status === 'verifying' ? 'status' : undefined}>{session.status === 'verifying' ? 'Verificando la cuenta con el proveedor…'
        : session.method === 'device' ? 'Sigue la autorización del proveedor en el terminal.' : 'Completa el inicio de sesión en el terminal.'}
        {autoStart && session.status === 'awaiting_login' ? ' Cuando el proveedor confirme el inicio de sesión, pulsa «Verificar conexión».' : ''}</p>
      <ProviderAuthTerminal session={session} client={client} onDisconnect={disconnected} />
      <p className="m-0 text-xs text-muted">Toca el enlace del terminal para abrir la página del proveedor; el código que muestra el terminal es el que debes ingresar allí. También puedes seleccionar el texto del terminal para copiarlo.</p>
    </>}
    <div className="flex flex-wrap gap-2">
      {session?.status === 'awaiting_login' && <Button size="sm" variant="primary" disabled={busy} onClick={() => { void run('verify'); }}>Verificar conexión</Button>}
      {session && active(session) && <Button size="sm" disabled={busy} onClick={() => { void run('cancel'); }}>Cancelar conexión</Button>}
    </div>
    {session?.status === 'authenticated' && <p role="status">Cuenta e identidad verificadas</p>}
    {session?.status === 'cancelled' && <p role="status">Conexión cancelada</p>}
  </section>;
}
