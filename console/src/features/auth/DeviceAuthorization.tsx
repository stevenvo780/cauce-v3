import { useEffect, useState, type SyntheticEvent } from 'react';
import { ApiError } from '../../api/client/core';
import { useApi } from '../../api/context';
import type { PendingDeviceAuthorization } from '../../api/types';
import { Logo } from '../../components/brand/Logo';
import { Button, Notice } from '../../components/kit';
import { humanProfileName } from './account-identity';
import { sessionAuthority, type AuthGateState } from './auth-session';

function normalizedCode(value: string): string {
  const characters = value.toUpperCase().replace(/[\s-]/gu, '');
  return characters.length === 8 ? `${characters.slice(0, 4)}-${characters.slice(4)}` : value.toUpperCase();
}

function failureMessage(cause: unknown): string {
  if (cause instanceof ApiError) {
    if (cause.status === 401) return 'Tu sesión venció. Vuelve a iniciar sesión y consulta el código otra vez.';
    if (cause.status === 403) return 'No se pudo autorizar con esta sesión. Revisa la empresa activa y vuelve a iniciar sesión.';
    if (cause.status === 404 || cause.status === 410) return 'El código no existe, caducó o ya fue utilizado. Inicia otra solicitud en la terminal.';
    if (cause.status === 409) return 'La solicitud ya fue resuelta o la sesión cambió. Consulta el código otra vez.';
    if (cause.status === 429) return 'Consultaste demasiados códigos. Espera un minuto antes de volver a intentarlo.';
  }
  return 'No se pudo consultar el dispositivo. Comprueba la conexión y vuelve a intentarlo.';
}

function displayDate(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.valueOf()) ? 'Hora no informada' : date.toLocaleString('es');
}

export function DeviceAuthorization({ gate, initialCode }: { gate: AuthGateState; initialCode: string }) {
  const api = useApi();
  const checkSession = gate.check;
  const [code, setCode] = useState(() => normalizedCode(initialCode));
  const [requestedCode, setRequestedCode] = useState(() => normalizedCode(initialCode));
  const [request, setRequest] = useState<PendingDeviceAuthorization>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [completed, setCompleted] = useState<'approved' | 'denied'>();
  const [revision, setRevision] = useState(0);
  const authority = sessionAuthority(gate.state);
  const authenticated = gate.state?.authenticated === true && authority !== undefined;

  useEffect(() => { document.title = 'Autorizar dispositivo · Cauce'; }, []);

  useEffect(() => {
    if (!requestedCode || !authenticated) return;
    setRequest(undefined); setCompleted(undefined); setError('');
    if (!/^[A-Z2-9]{4}-[A-Z2-9]{4}$/u.test(requestedCode)) {
      setError('Introduce el código de ocho caracteres que muestra cauce login, por ejemplo ABCD-EFGH.');
      return;
    }
    let active = true;
    setBusy(true);
    void api.getDeviceAuthorization(requestedCode).then((next) => {
      if (active) setRequest(next);
    }).catch((cause: unknown) => {
      if (active) {
        setError(failureMessage(cause));
        if (cause instanceof ApiError && cause.status === 401) void checkSession();
      }
    }).finally(() => { if (active) setBusy(false); });
    return () => { active = false; };
  }, [api, authenticated, requestedCode, revision, checkSession]);

  function submit(event: SyntheticEvent<HTMLFormElement>) {
    event.preventDefault();
    setRequestedCode(normalizedCode(code));
    setRevision((value) => value + 1);
  }

  async function decide(decision: 'approve' | 'deny') {
    if (busy || !request || !authenticated) return;
    setBusy(true); setError('');
    try {
      const result = await api.decideDeviceAuthorization(requestedCode, decision);
      if (result.status !== (decision === 'approve' ? 'approved' : 'denied')) throw new Error('Invalid decision receipt');
      setCompleted(result.status); setRequest(undefined);
    } catch (cause) {
      setError(failureMessage(cause));
      if (cause instanceof ApiError && cause.status === 401) await gate.check();
    } finally { setBusy(false); }
  }

  return (
    <main id="main-content" className="grid min-h-dvh place-items-center bg-canvas p-4 text-fg">
      <section className="grid w-full max-w-lg gap-4 rounded-2xl border border-line bg-surface p-6 shadow-pop">
        <Logo />
        <h1 className="m-0 text-xl font-semibold">Autorizar dispositivo</h1>
        <p className="m-0 text-sm">Da acceso a Cauce desde la terminal donde iniciaste <code>cauce login --dispositivo</code>.</p>
        <Notice tone="warn">Autoriza solo si tú iniciaste esta solicitud y reconoces el equipo. Si otra persona te envió este código, recházalo: obtendría acceso con tu identidad y tu empresa activa.</Notice>
        {!authenticated ? <Notice tone="danger">Necesitas una sesión con identidad y empresa activa. Inicia sesión en una consola con acceso nominal.</Notice> : (
          <>
            <dl className="m-0 grid min-w-0 grid-cols-1 gap-1 text-sm">
              <div className="min-w-0 break-words"><dt className="inline font-semibold">Persona: </dt><dd className="m-0 inline">{humanProfileName(gate.state)}{gate.state?.subject ? ` (${gate.state.subject})` : ''}</dd></div>
              <div className="min-w-0"><dt className="inline font-semibold">Empresa activa: </dt><dd className="m-0 inline break-all">{authority.acting_company}</dd></div>
            </dl>
            <form className="grid gap-3" onSubmit={submit}>
              <label htmlFor="device-user-code">Código del dispositivo
                <input id="device-user-code" name="user_code" autoComplete="off" autoCapitalize="characters" spellCheck={false}
                  required maxLength={32} value={code} disabled={busy} onChange={(event) => {
                    setCode(event.target.value); setRequestedCode(''); setRequest(undefined); setCompleted(undefined); setError('');
                  }} />
              </label>
              <Button type="submit" disabled={busy}>{busy ? 'Consultando…' : 'Consultar solicitud'}</Button>
            </form>
            {request ? (
              <section aria-label="Solicitud de acceso" className="grid gap-3 rounded-lg border border-line p-4">
                <h2 className="m-0 text-base font-semibold">Solicitud de acceso</h2>
                <dl className="m-0 grid min-w-0 grid-cols-1 gap-2 text-sm">
                  <div><dt className="font-semibold">Cliente</dt><dd className="m-0 break-words">{request.client_name}</dd></div>
                  <div><dt className="font-semibold">Solicitado</dt><dd className="m-0">{displayDate(request.created_at)}</dd></div>
                  <div><dt className="font-semibold">IP de origen</dt><dd className="m-0">{request.masked_ip}</dd></div>
                  <div><dt className="font-semibold">Caduca</dt><dd className="m-0">{displayDate(request.expires_at)}</dd></div>
                </dl>
                <p className="m-0 text-sm">Este equipo recibirá una sesión con la persona y empresa indicadas arriba.</p>
                <div className="flex flex-wrap gap-2">
                  <Button variant="primary" disabled={busy} onClick={() => { void decide('approve'); }}>Autorizar</Button>
                  <Button variant="danger" disabled={busy} onClick={() => { void decide('deny'); }}>Rechazar</Button>
                </div>
              </section>
            ) : null}
            {completed ? <Notice role="status" tone={completed === 'approved' ? 'info' : 'warn'}>{completed === 'approved'
              ? 'Dispositivo autorizado. Vuelve a la terminal para continuar.'
              : 'Solicitud rechazada. Este dispositivo no recibió acceso.'}</Notice> : null}
            <Button variant="ghost" disabled={busy || gate.busy} onClick={() => { void gate.logout(); }}>Cerrar sesión y usar otra cuenta</Button>
          </>
        )}
        {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
      </section>
    </main>
  );
}
