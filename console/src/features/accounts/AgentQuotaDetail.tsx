import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { usePolling } from '../../api/use-polling';
import { ErrorNotice } from '../../components/ErrorNotice';
import { useQuotaAccounts } from '../../shell/fleet-context';
import { FatigueIndicator } from './FatigueIndicator';
import { QuotaAccountCard } from './QuotaAccountCard';
import { AgentQuotaReader } from './AgentQuotaReader';
import { quotaReadFailure } from './quota-messages';
import { agentFatigue, agentQuotaAccounts, failedQuotaRead, quotaTargetUnavailableReason, readerUnavailableReason } from './quota-availability';

export function AgentQuotaDetail({ tenant, alias, compact = false }: { tenant: string; alias: string; compact?: boolean }) {
  const api = useApi();
  // The linked accounts come from the fleet's shared quota read; only this agent's reader is read here.
  const quotas = useQuotaAccounts();
  const snapshot = useResource(`agent-quota:${tenant}/${alias}`, () => api.getAgentQuota(tenant, alias));
  usePolling(() => { void snapshot.reload(); }, 30_000);
  const accounts = agentQuotaAccounts(quotas.data?.accounts ?? [], tenant, alias);
  const noReader = accounts.length === 0 ? readerUnavailableReason(snapshot.data) : null;
  const unavailableTarget = quotaTargetUnavailableReason(snapshot.data);
  const fatigue = quotas.error ? 'error' : noReader !== null ? 'no_reader' : agentFatigue(quotas.data?.accounts ?? [], tenant, alias);
  return <section aria-label={`Disponibilidad de ${alias}`} className="mt-3 grid gap-2">
    <FatigueIndicator state={fatigue} />
    {quotas.loading && !quotas.data && noReader === null ? <p className="m-0 text-xs" role="status">Leyendo cuotas de la cuenta…</p> : null}
    {!compact && noReader !== null ? <p className="m-0 text-xs text-muted">{noReader}</p> : null}
    {!compact && unavailableTarget !== null ? <p className="m-0 text-xs text-muted">{unavailableTarget}</p> : null}
    {!compact && quotas.error ? <ErrorNotice failure={quotaReadFailure(quotas.error, 'No se pudo leer la cuota de la cuenta. Relee la cuota del agente.')} /> : null}
    {!compact && accounts.map(account => <QuotaAccountCard key={account.id} account={quotas.error ? failedQuotaRead(account) : account} pinned={false} />)}
    {!compact && quotas.data && !quotas.error && !accounts.length && noReader === null && snapshot.data ? <p className="m-0 text-xs text-muted">{snapshot.data.binding
      ? `Cuenta ${snapshot.data.binding.account_id} vinculada, sin datos de cuota disponibles para esta sesión.`
      : 'No hay una cuenta vinculada con cuota disponible para esta sesión.'}</p> : null}
    {!compact ? <AgentQuotaReader key={`${tenant}/${alias}`} tenant={tenant} alias={alias} quota={snapshot} /> : null}
  </section>;
}
