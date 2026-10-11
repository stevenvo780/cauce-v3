import { useCallback, useEffect, useRef, useState } from 'react';
import type { QuotaEnvironment, QuotaEnvironmentOperation } from '../../api/client/my-quotas-client';
import type { ProviderAuthRequest } from '../../api/client/provider-auth-client';
import { useApi } from '../../api/context';
import { Button, Notice } from '../../components/kit';
import { ProviderAuthPanel } from './ProviderAuthPanel';

export function QuotaAuthPanel({ environment, operation, allowed, reload }: {
  environment: QuotaEnvironment; operation: QuotaEnvironmentOperation; allowed: boolean; reload: () => Promise<void>;
}) {
  const api = useApi();
  const permitted = allowed && operation.status === 'awaiting_auth' && operation.action === 'authenticate'
    && operation.environment_id === environment.id && environment.status === 'awaiting_auth';
  const key = JSON.stringify([environment.company_id, environment.id, environment.provider, environment.account_id,
    environment.host_id, environment.status, operation.id, operation.status, permitted]);
  const current = useRef(key); current.current = key;
  const [scope, setScope] = useState<{ key: string; request?: ProviderAuthRequest; error?: string }>();
  const [retry, setRetry] = useState(0);
  const [refreshError, setRefreshError] = useState('');
  useEffect(() => {
    if (!permitted) return;
    let alive = true;
    setScope(undefined); setRefreshError('');
    void api.resolveProviderAuthOperation(operation.id).then(request => {
      if (!alive || current.current !== key) return;
      if (request.operation_id !== operation.id || request.provider_id !== environment.provider
        || request.account_id !== environment.account_id || request.profile_id !== environment.account_id || request.host_id !== environment.host_id
        || request.harness_id !== environment.provider || request.runtime_user !== 'node') {
        throw new Error('quota_auth_scope_mismatch');
      }
      setScope({ key, request });
    }).catch(() => {
      if (alive && current.current === key) setScope({ key, error: 'No se pudo acreditar la autorización para esta cuenta y entorno. Relee su estado antes de conectar.' });
    });
    return () => { alive = false; };
  }, [api, key, permitted, retry, operation.id, environment.provider, environment.account_id, environment.host_id]);
  const authenticated = useCallback(() => {
    void reload().catch(() => {
      if (current.current === key) setRefreshError('La cuenta se verificó, pero no se pudo releer el entorno. Actualiza cuotas y entornos antes de continuar.');
    });
  }, [reload, key]);
  const activeScope = permitted && scope?.key === key ? scope : undefined;
  return <section aria-label={`Autenticación de ${environment.label}`} className="grid gap-2">
    {!permitted ? <p className="text-sm">La conexión necesita una operación de autenticación vigente y permiso sobre este ordenador.</p> : null}
    {permitted && !activeScope ? <p role="status">Leyendo autorización de la cuenta…</p> : null}
    {activeScope?.error ? <Notice tone="danger" role="alert">{activeScope.error}
      <Button size="sm" onClick={() => { setRetry(value => value + 1); }}>Releer autorización del entorno</Button></Notice> : null}
    {activeScope?.request ? <ProviderAuthPanel key={key} request={activeScope.request} client={api} title="Conectar la cuenta del entorno"
      showRuntime={false} onAuthenticated={authenticated} /> : null}
    {refreshError ? <Notice tone="danger" role="alert">{refreshError}</Notice> : null}
  </section>;
}
