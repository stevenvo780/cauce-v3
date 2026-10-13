import { useCallback, useEffect, useRef, useState } from 'react';
import { useApi } from '../../api/context';
import { ApiError } from '../../api/client';
import type { Resource } from '../../api/use-resource';
import { usePolling } from '../../api/use-polling';
import { Button, Notice, Pill } from '../../components/kit';
import { Time } from '../../components/ui';
import { randomUuid } from '../../random-id';
import { canManageCompany, useCompanyAuthority } from '../auth/company-authority';
import { QUOTA_FAILURE_ACTION } from './quota-availability';
import { formatPercent } from './quotas';
import type { AgentQuotaQuery, AgentQuotaReading, AgentQuotaStatus } from './agent-quota-client';

const STATUS_LABEL: Record<AgentQuotaStatus, string> = {
  unknown: 'Sin medición', pending: 'Consulta pendiente', running: 'Consultando en el ordenador', unsupported: 'Sin lector de cuota',
  ok: 'Medición recibida', error: 'Error de consulta', failed: 'La operación falló',
};

export function AgentQuotaReader({ tenant, alias, quota }: { tenant: string; alias: string; quota: Resource<AgentQuotaReading> }) {
  const api = useApi();
  const authority = useCompanyAuthority();
  const retry = useRef<AgentQuotaQuery | null>(null);
  const mutating = useRef(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [requested, setRequested] = useState<string | null>(null);
  const data = quota.data;
  useEffect(() => {
    if (requested !== null && data?.operation?.id === requested) setRequested(null);
  }, [data?.operation?.id, requested]);
  const awaitingReceipt = requested !== null && data?.operation?.id !== requested;
  const pending = awaitingReceipt || data?.operation?.status === 'pending' || data?.operation?.status === 'running';
  const reloadQuota = quota.reload;
  const poll = useCallback(() => { if (!mutating.current) void reloadQuota(); }, [reloadQuota]);
  usePolling(poll, pending ? 2_000 : 0);
  const canQuery = canManageCompany(authority?.role) && data?.reader_available && data.can_query;

  async function query() {
    if (!canQuery || quota.error || quota.loading || pending || mutating.current) return;
    mutating.current = true; setBusy(true); setError('');
    retry.current ??= { expected_revision: data.revision, idempotency_key: randomUuid() };
    try {
      const receipt = await api.queryAgentQuota(tenant, alias, retry.current);
      retry.current = null; setRequested(receipt.operation_id);
    } catch (cause) {
      if (cause instanceof ApiError && [400, 401, 403, 404, 409, 422].includes(cause.status)) retry.current = null;
      setError(cause instanceof Error ? cause.message : 'No se confirmó la consulta. Relee su estado antes de reintentar.');
    } finally {
      const result = await reloadQuota();
      if (result.error) setError(result.error.message);
      mutating.current = false; setBusy(false);
    }
  }
  async function reread() {
    const result = await reloadQuota();
    setError(result.error?.message ?? '');
  }
  const status = awaitingReceipt ? 'pending' : data?.status;
  return <section aria-label={`Cuota de ${alias}`} className="mt-3 grid gap-3 rounded-lg border border-line p-3">
    <header className="flex flex-wrap items-center justify-between gap-2"><h3 className="m-0 text-sm font-semibold">Cuota del agente</h3>
      {status && status !== 'unsupported' ? <Pill tone={status === 'error' || status === 'failed' ? 'danger' : 'neutral'}>{STATUS_LABEL[status]}</Pill> : null}
    </header>
    {quota.loading && !data ? <p className="m-0 text-xs" role="status">Leyendo la cuota del agente…</p> : null}
    {error || quota.error ? <Notice tone="danger" role="alert">{error || quota.error?.message}</Notice> : null}
    {pending ? <p className="m-0 text-xs" role="status">La consulta sigue pendiente; la ficha relee el resultado del ordenador.</p> : null}
    {data ? <>
      <p className="m-0 text-xs text-muted">{data.captured_at ? <>Última medición: <Time value={data.captured_at} /></> : 'Todavía no hay una medición persistida.'}</p>
      {data.sample ? <QuotaMeasurement data={data} /> : null}
      {data.operation?.status === 'failed' ? <Notice tone="danger">{QUOTA_FAILURE_ACTION[data.operation.error_code ?? ''] ?? 'La consulta en el ordenador falló. Relee o consulta de nuevo.'}</Notice> : null}
      {data.reader_available && !canQuery ? <p className="m-0 text-xs text-muted">La consulta requiere permiso de administración y un lector disponible en el ordenador.</p> : null}
    </> : null}
    <div className="flex flex-wrap gap-2">
      {canQuery ? <Button size="sm" disabled={busy || quota.loading || !!quota.error || pending} onClick={() => { void query(); }}>{busy ? 'Encolando…' : retry.current ? 'Reintentar consulta' : 'Consultar'}</Button> : null}
      <Button size="sm" disabled={busy || quota.loading} onClick={() => { void reread(); }}>Releer cuota</Button>
    </div>
  </section>;
}

function QuotaMeasurement({ data }: { data: AgentQuotaReading }) {
  const sample = data.sample;
  if (!sample) return null;
  const failure = !sample.ok && sample.note ? QUOTA_FAILURE_ACTION[sample.note] ?? 'El proveedor no acreditó la medición.' : null;
  return <div className="grid gap-2">
    {data.binding ? <p className="m-0 text-xs text-muted">Cuenta {data.binding.account_id}. {data.binding.shared || data.binding.agent_count > 1
      ? `Consumo compartido por ${String(data.binding.agent_count)} agentes; el saldo pertenece a la misma suscripción.` : 'Cuota de esta suscripción.'}</p> : null}
    {failure ? <Notice tone="danger">{failure}</Notice> : null}
    <p className="m-0 text-sm">{sample.ok && sample.effective_remaining_percent != null
      ? `Último saldo medido: ${formatPercent(sample.effective_remaining_percent)}.` : 'Saldo no acreditado en la última medición.'}</p>
    {sample.windows.map(window => <div className="grid gap-1 border-t border-line pt-2" key={`${window.group_key}:${window.window_key}:${window.model ?? ''}`}>
      <p className="m-0 text-xs">{window.label ?? window.window_key}{window.model ? ` · ${window.model}` : ''}: {' '}
        {sample.ok && window.remaining_percent != null && !['unknown', 'error', 'rate-limited'].includes(window.status ?? '')
          ? `${formatPercent(window.remaining_percent)} medido` : 'sin saldo acreditado'}</p>
      <p className="m-0 text-xs text-muted">{window.observed_at ? <>Medida <Time value={window.observed_at} />. </> : null}
        {window.reset_at ? <>Reinicio <Time value={window.reset_at} /></> : 'Reinicio no informado.'}</p>
    </div>)}
  </div>;
}
