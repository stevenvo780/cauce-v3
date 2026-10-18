import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuotaAccount, QuotaEnvironment, QuotaEnvironmentReceipt, QuotaEnvironmentsSnapshot } from '../../api/client/my-quotas-client';
import type { ProviderAuthRequest } from '../../api/client/provider-auth-client';
import { useApi } from '../../api/context';
import { usePolling } from '../../api/use-polling';
import { FormDialog } from '../../components/dialogs';
import { Button, Notice } from '../../components/kit';
import { randomUuid } from '../../random-id';
import { ProviderAuthPanel } from './ProviderAuthPanel';
import { quotaHostSupports } from './quota-environment-capabilities';
import { describeOperationError, describeQuotaEnvironmentError } from './quota-messages';

const BUSY = ['pending', 'running', 'awaiting_auth'];

function accountEnvironment(snapshot: QuotaEnvironmentsSnapshot, account: QuotaAccount): QuotaEnvironment | undefined {
  const own = snapshot.environments.filter(environment => environment.account_id === account.id
    && environment.status !== 'deleted' && environment.status !== 'deleting');
  return own.find(environment => snapshot.capabilities.hosts.some(host => host.host_id === environment.host_id
    && quotaHostSupports(host, account.provider, 'authenticate'))) ?? own[0];
}

/** One button that leaves the account signed in: it creates the account's environment when missing, asks for the
 * login and opens the provider CLI in a private terminal. Each step is the existing typed quota operation. */
export function AccountLogin({ account, snapshot, allowed, reload }: {
  account: QuotaAccount; snapshot?: QuotaEnvironmentsSnapshot; allowed: boolean; reload: () => Promise<void>;
}) {
  const api = useApi();
  const [requested, setRequested] = useState(false);
  const [hostChoice, setHostChoice] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [verified, setVerified] = useState(false);
  const [launched, setLaunched] = useState<string>();
  const [scope, setScope] = useState<{ operation: string; request?: ProviderAuthRequest; error?: string }>();
  const keys = useRef(new Map<string, string>());
  const keyFor = (signature: string) => { const existing = keys.current.get(signature) ?? randomUuid(); keys.current.set(signature, existing); return existing; };
  const environment = snapshot ? accountEnvironment(snapshot, account) : undefined;
  const operation = environment ? snapshot?.operations.find(item => item.environment_id === environment.id) : undefined;
  const hosts = snapshot?.capabilities.hosts.filter(host => quotaHostSupports(host, account.provider, 'create')
    && quotaHostSupports(host, account.provider, 'authenticate')) ?? [];
  const hostId = hosts.some(host => host.host_id === hostChoice) ? hostChoice : hosts[0]?.host_id ?? '';
  const environmentHost = environment ? snapshot?.capabilities.hosts.find(host => host.host_id === environment.host_id
    && quotaHostSupports(host, account.provider, 'authenticate')) : undefined;
  const awaitingLogin = !!environment && environment.status === 'awaiting_auth' && operation?.action === 'authenticate'
    && operation.status === 'awaiting_auth';
  const brokenEnvironment = environment?.status === 'failed' && operation?.action === 'create';
  const otherOperation = !!operation && BUSY.includes(operation.status) && operation.action !== 'authenticate' && operation.action !== 'create';
  const block = !allowed ? 'Solo el dueño o un administrador de la empresa inicia sesión en las cuentas.'
    : !snapshot ? 'Todavía no llegó la lectura de entornos. Espera unos segundos.'
      : environment && !environmentHost ? 'El ordenador del entorno de esta cuenta no está disponible ahora. Revisa que esté encendido y conectado.'
        : !environment && !hosts.length ? `Ningún ordenador de la empresa puede iniciar sesión en ${account.provider}. Conecta un ordenador con el ejecutor de cuotas en Ajustes → Ordenadores.`
          : otherOperation ? 'El entorno de esta cuenta tiene otra operación en curso. Espera a que termine.'
            : brokenEnvironment ? 'No se pudo crear el entorno de esta cuenta. Elimínalo en «Entornos de consulta» y vuelve a intentarlo.' : undefined;
  const refresh = useCallback(() => { void reload().catch(() => undefined); }, [reload]);
  useEffect(() => { if (requested && block && snapshot) { setRequested(false); setLaunched(undefined); setError(block); } }, [requested, block, snapshot]);
  usePolling(refresh, 1500, { pausedWhile: !requested || awaitingLogin });

  const step = useRef(false);
  useEffect(() => {
    if (!requested || block || busy || step.current || !snapshot) return;
    const run = (work: () => Promise<QuotaEnvironmentReceipt>) => {
      step.current = true; setBusy(true); setError('');
      void work().then(receipt => { setLaunched(receipt.operation.id); return reload(); }).catch((cause: unknown) => {
        setRequested(false); setError(describeQuotaEnvironmentError(cause, 'No se pudo iniciar sesión en la cuenta.'));
      }).finally(() => { step.current = false; setBusy(false); });
    };
    if (scope) {
      // A login was opened for scope.operation: its panel owns the rest, even while verification runs the operation.
      if (operation?.id === scope.operation && operation.status === 'done') { setVerified(true); setRequested(false); setScope(undefined); }
      return;
    }
    if (operation && BUSY.includes(operation.status)) return;
    if (launched && operation?.id === launched && operation.status === 'failed') {
      setLaunched(undefined); setRequested(false); setError(describeOperationError(operation.error_code ?? 'STEP_FAILED')); return;
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
    setVerified(true); setRequested(false);
    void reload().catch(() => { setError('La sesión quedó verificada, pero no se pudo releer la cuenta. Pulsa «Actualizar cuotas y entornos».'); });
  }, [reload]);
  const close = () => { setRequested(false); setLaunched(undefined); setScope(undefined); refresh(); };
  const activeScope = requested ? scope : undefined;
  const progress = !requested || activeScope ? undefined
    : !environment ? 'Preparando el entorno de la cuenta…'
      : (environment.status === 'pending' || environment.status === 'running') ? 'Preparando el entorno de la cuenta…'
        : awaitingLogin ? 'Abriendo la terminal de inicio de sesión…' : 'Pidiendo el inicio de sesión…';
  const hostName = snapshot?.capabilities.hosts.find(host => host.host_id === (environment?.host_id ?? hostId))?.display_name;
  return <section aria-label={`Inicio de sesión de ${account.label}`} className="grid gap-2">
    <div className="flex flex-wrap items-center gap-2">
      <Button size="sm" variant="primary" disabled={!!block || busy || requested} title={block}
        onClick={() => { keys.current.clear(); setVerified(false); setError(''); setLaunched(undefined); setScope(undefined); setRequested(true); }}>Iniciar sesión</Button>
      {!environment && hosts.length > 1 ? <label className="text-sm">Ordenador <select value={hostId} disabled={busy || requested}
        onChange={event => { setHostChoice(event.target.value); }}>{hosts.map(host => <option key={host.host_id} value={host.host_id}>{host.display_name}</option>)}</select></label> : null}
    </div>
    {verified && !requested ? <Notice tone="ok" role="status">Sesión iniciada y verificada.</Notice> : null}
    {error ? <Notice tone="danger" role="alert">{error}</Notice> : null}
    <FormDialog open={requested} wide anchorTop title={`Iniciar sesión en ${account.label}`}
      description={`${account.provider}${hostName ? ` · ${hostName}` : ''}`} onClose={close}>
      {progress ? <p className="m-0 text-sm" role="status">{progress}</p> : null}
      {activeScope?.error ? <Notice tone="danger" role="alert">{activeScope.error}</Notice> : null}
      {activeScope?.request ? <ProviderAuthPanel key={activeScope.operation} request={activeScope.request} client={api} autoStart
        onAuthenticated={authenticated} /> : null}
    </FormDialog>
  </section>;
}
