import { lazy, Suspense, useCallback, useEffect, useRef, useState } from 'react';
import type { QuotaAccount, QuotaEnvironmentReceipt, QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import type { ProviderAuthRequest } from '../../api/client/provider-auth-client';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { FormDialog } from '../../components/dialogs';
import { Button, Notice } from '../../components/kit';
import { randomUuid } from '../../random-id';
import { accountLoginTargets, type AccountLoginTarget } from './account-login-targets';
/* The auth terminal pulls in xterm: load it only when a login actually starts. */
const ProviderAuthPanel = lazy(async () => ({ default: (await import('./ProviderAuthPanel')).ProviderAuthPanel }));
import { quotaHostSupports } from './quota-environment-capabilities';
import { describeOperationError, describeQuotaEnvironmentError } from './quota-messages';

const BUSY = ['pending', 'running', 'awaiting_auth'];

export function AccountLogin({ account, snapshot, allowed, reload, environmentId }: {
  account: QuotaAccount; snapshot?: QuotaEnvironmentsSnapshot; allowed: boolean; reload: () => Promise<void>; environmentId?: string;
}) {
  const api = useApi();
  const [requested, setRequested] = useState(false);
  const [choice, setChoice] = useState('');
  const [target, setTarget] = useState<AccountLoginTarget>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const [launched, setLaunched] = useState<string>();
  const [scope, setScope] = useState<{ operation: string; request?: ProviderAuthRequest; error?: string }>();
  const keys = useRef(new Map<string, string>());
  const cycle = useRef(0);
  const keyFor = (signature: string) => { const existing = keys.current.get(signature) ?? randomUuid(); keys.current.set(signature, existing); return existing; };
  const targets = accountLoginTargets(snapshot, account);
  const selected = environmentId ? targets.find(item => item.environmentId === environmentId)
    : targets.find(item => item.key === choice) ?? targets.find(item => item.available && item.withoutSession)
      ?? targets.find(item => item.available) ?? targets[0];
  const destination = target ?? selected;
  const environment = snapshot?.environments.find(item => item.id === destination?.environmentId && item.account_id === account.id);
  const operation = environment ? snapshot?.operations.find(item => item.environment_id === environment.id) : undefined;
  const hostId = destination?.hostId;
  const environmentHost = environment ? snapshot?.capabilities.hosts.find(host => host.host_id === environment.host_id
    && quotaHostSupports(host, account.provider, 'authenticate')) : undefined;
  const awaitingLogin = !!environment && environment.status === 'awaiting_auth' && operation?.action === 'authenticate'
    && operation.status === 'awaiting_auth';
  const brokenEnvironment = environment?.status === 'failed' && operation?.action === 'create';
  const otherOperation = !scope && !!operation && BUSY.includes(operation.status) && operation.action !== 'authenticate' && operation.action !== 'create';
  const block = !allowed ? 'Solo el dueño o un administrador de la empresa inicia sesión en las cuentas.'
    : !snapshot ? 'Todavía no llegó la lectura de entornos. Espera unos segundos.'
      : destination?.environmentId && ((!environment && !busy) || environment?.status === 'deleted' || environment?.status === 'deleting') ? 'Este entorno ya no está disponible. Actualiza cuotas y entornos.'
        : environment && !environmentHost ? 'El ordenador del entorno de esta cuenta no está disponible ahora. Revisa que esté encendido y conectado.'
          : !destination || (!environment && !snapshot.capabilities.hosts.some(host => host.host_id === hostId
            && quotaHostSupports(host, account.provider, 'create') && quotaHostSupports(host, account.provider, 'authenticate')))
            ? `Ningún ordenador de la empresa puede iniciar sesión en ${account.provider}. Conecta un ordenador con el ejecutor de cuotas en Ajustes → Ordenadores.`
          : otherOperation ? 'El entorno de esta cuenta tiene otra operación en curso. Espera a que termine.'
            : brokenEnvironment ? 'No se pudo crear el entorno de esta cuenta. Elimínalo en «Entornos de consulta» y vuelve a intentarlo.' : undefined;
  const refresh = useCallback(() => { void reload().catch(() => undefined); }, [reload]);
  useEffect(() => { if (requested && block && snapshot) { setRequested(false); setTarget(undefined); setLaunched(undefined); setError(block); } }, [requested, block, snapshot]);
  usePolling(refresh, 1500, { pausedWhile: !requested || (awaitingLogin && !!scope?.request) });

  const step = useRef(false);
  useEffect(() => {
    if (!requested || block || busy || step.current || !snapshot) return;
    const run = (work: () => Promise<QuotaEnvironmentReceipt>) => {
      const currentCycle = cycle.current;
      step.current = true; setBusy(true); setError('');
      void work().then(receipt => {
        if (receipt.environment.account_id !== account.id || receipt.environment.host_id !== hostId || receipt.operation.environment_id !== receipt.environment.id
          || (environment && receipt.environment.id !== environment.id)) throw new Error('quota_auth_scope_mismatch');
        if (currentCycle === cycle.current) {
          setTarget(previous => previous ? { ...previous, environmentId: receipt.environment.id } : previous);
          setLaunched(receipt.operation.id);
        }
        return reload();
      }).catch((cause: unknown) => {
        if (currentCycle !== cycle.current) return;
        setRequested(false); setTarget(undefined); setError(describeQuotaEnvironmentError(cause, 'No se pudo iniciar sesión en la cuenta.'));
      }).finally(() => { step.current = false; setBusy(false); });
    };
    // The broker confirms authentication after the durable operation finishes; keep its terminal mounted until then.
    if (scope) return;
    if (operation && BUSY.includes(operation.status)) return;
    if (launched && operation?.id === launched && operation.status === 'failed') {
      setLaunched(undefined); setRequested(false); setTarget(undefined); setError(describeOperationError(operation.error_code ?? 'STEP_FAILED')); return;
    }
    if (!environment) {
      if (!hostId) return;
      const input = { account_id: account.id, host_id: hostId, label: account.label.slice(0, 80) };
      run(() => api.createQuotaEnvironment({ ...input, idempotency_key: keyFor(JSON.stringify(input)) }));
      return;
    }
    if (environment.status === 'pending' || environment.status === 'running') return;
    const signature = `${environment.id}:${String(environment.version)}`;
    run(() => api.actQuotaEnvironment(environment.id, { action: 'authenticate', expected_version: environment.version,
      idempotency_key: keyFor(signature), consent: true }));
  }, [requested, block, busy, snapshot, scope, environment, operation, launched, hostId, account.id, account.label, api, reload]);

  const operationId = awaitingLogin ? operation.id : undefined;
  const provider = environment?.provider; const accountId = environment?.account_id; const environmentHostId = environment?.host_id;
  useEffect(() => {
    if (!requested || !operationId) return;
    let alive = true;
    setScope(undefined);
    // The host registers the login a moment after the operation reaches awaiting_auth: retry before reporting.
    const resolve = async (): Promise<ProviderAuthRequest> => {
      for (let attempt = 1; ; attempt++) {
        try { return await api.resolveProviderAuthOperation(operationId); }
        catch (cause) { if (attempt >= 10 || !alive) throw cause; }
        await new Promise(done => setTimeout(done, 1000));
      }
    };
    void resolve().then(request => {
      if (!alive) return;
      if (request.operation_id !== operationId || request.provider_id !== provider || request.account_id !== accountId
        || request.profile_id !== accountId || request.host_id !== environmentHostId
        || request.harness_id !== provider || request.runtime_user !== 'node') throw new Error('quota_auth_scope_mismatch');
      setScope({ operation: operationId, request });
    }).catch(() => {
      if (alive) setScope({ operation: operationId, error: 'No se pudo acreditar la autorización de esta cuenta. Cierra y pulsa «Iniciar sesión» otra vez.' });
    });
    return () => { alive = false; };
  }, [api, requested, operationId, provider, accountId, environmentHostId]);

  const authenticated = useCallback(() => {
    setChoice(target?.environmentId ?? '');
    setVerified(true); setRequested(false); setTarget(undefined);
    void reload().catch(() => { setError('La sesión quedó verificada, pero no se pudo releer la cuenta. Pulsa «Actualizar cuotas y entornos».'); });
  }, [reload, target?.environmentId]);
  // The page polls slowly: start from a fresh read so an expired login is not resumed.
  const begin = async () => {
    if (!selected || busy || requested) return;
    const currentCycle = ++cycle.current;
    setTarget(selected);
    keys.current.clear(); setVerified(false); setError(''); setLaunched(undefined); setScope(undefined); setBusy(true);
    try { await reload(); if (currentCycle === cycle.current) setRequested(true); }
    catch (cause) { setTarget(undefined); setError(describeQuotaEnvironmentError(cause, 'No se pudieron leer los entornos de la cuenta.')); }
    finally { setBusy(false); }
  };
  const close = () => { cycle.current++; setRequested(false); setTarget(undefined); setLaunched(undefined); setScope(undefined); refresh(); };
  const activeScope = requested ? scope : undefined;
  const progress = !requested || activeScope ? undefined
    : !environment ? 'Preparando el entorno de la cuenta…'
      : (environment.status === 'pending' || environment.status === 'running') ? 'Preparando el entorno de la cuenta…'
        : awaitingLogin ? 'Abriendo la terminal de inicio de sesión…' : 'Pidiendo el inicio de sesión…';
  if (environmentId && !requested && !busy && !verified && !error && environment?.refresh_status !== 'not_authenticated') return null;
  return <section aria-label={`Inicio de sesión de ${environmentId ? environment?.label ?? account.label : account.label}`} className="grid gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" disabled={!!block || busy || requested} title={block}
        onClick={() => { void begin(); }}>Iniciar sesión</Button>
      {!environmentId && targets.length > 1 ? <label className="min-w-0 text-sm">Entorno u ordenador <select aria-label="Entorno u ordenador" className="max-w-full" value={selected?.key ?? ''} disabled={busy || requested}
        onChange={event => { setChoice(event.target.value); setVerified(false); }}>{targets.map(item => <option key={item.key} value={item.key}>{item.label}{item.withoutSession && item.environmentId ? ' · Sin sesión' : ''}{!item.available ? ' · No disponible' : ''}</option>)}</select></label> : null}
    </div>
    {block && !requested && !error && (snapshot || !allowed) ? <p className="m-0 text-sm text-muted">{block}</p> : null}
    {verified && !requested ? <Notice tone="ok" role="status">Sesión iniciada y verificada.</Notice> : null}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    <FormDialog open={requested} wide anchorTop title={`Iniciar sesión en ${account.label}`}
      description={`${account.provider}${destination ? ` · ${destination.label}` : ''}`} onClose={close}>
      {progress ? <p className="m-0 text-sm" role="status">{progress}</p> : null}
      {activeScope?.error ? <Notice tone="danger" role="alert">{activeScope.error}</Notice> : null}
      {activeScope?.request ? <Suspense fallback={<p className="m-0 text-sm" role="status">Cargando terminal de autenticación…</p>}>
        <ProviderAuthPanel key={activeScope.operation} request={activeScope.request} client={api} autoStart
          onAuthenticated={authenticated} />
      </Suspense> : null}
    </FormDialog>
  </section>;
}
