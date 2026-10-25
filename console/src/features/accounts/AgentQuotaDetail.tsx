import { useContext } from 'react';
import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { usePolling } from '../../api/use-polling';
import { ErrorNotice } from '../../components/ErrorNotice';
import { FleetContext, useQuotaAccounts } from '../../shell/fleet-context';
import { QuotaAccountCard } from './QuotaAccountCard';
import { AgentQuotaReader } from './AgentQuotaReader';
import { quotaReadFailure } from './quota-messages';
import { agentQuotaBar } from '../office/agent-quota-bar';
import { QuotaMeter } from '../office/QuotaMeter';
import { activityRowNotRunning, agentFatigue, agentQuotaAccounts, failedQuotaRead, FATIGUE_LABEL, NOT_RUNNING_QUOTA_MESSAGE, quotaTargetUnavailableReason, readerUnavailableReason } from './quota-availability';

export function AgentQuotaDetail({ tenant, alias, compact = false }: { tenant: string; alias: string; compact?: boolean }) {
  const api = useApi();
  // The linked accounts come from the fleet's shared quota read; only this agent's reader is read here.
  const quotas = useQuotaAccounts();
  const fleet = useContext(FleetContext);
  const snapshot = useResource(`agent-quota:${tenant}/${alias}`, () => api.getAgentQuota(tenant, alias));
  usePolling(() => { void snapshot.reload(); }, 30_000);
  const accounts = agentQuotaAccounts(quotas.data?.accounts ?? [], tenant, alias);
  const notRunning = activityRowNotRunning(fleet?.activity.data?.agents?.find(agent => agent.tenant_id === tenant && agent.alias === alias));
  const noReader = notRunning || accounts.length > 0 ? null : readerUnavailableReason(snapshot.data);
  const unavailableTarget = notRunning ? null : quotaTargetUnavailableReason(snapshot.data);
  const fatigue = quotas.error ? 'error' : noReader !== null ? 'no_reader' : agentFatigue(quotas.data?.accounts ?? [], tenant, alias);
  const bar = agentQuotaBar(quotas.data?.accounts ?? [], `${tenant}/${alias}`, Boolean(quotas.error), Date.now());
  const displayBar = fatigue === 'no_reader' ? { ...bar, remaining: null } : bar;
  const reading = quotas.loading && !quotas.data && !quotas.error;
  return <section aria-label={`Disponibilidad de ${alias}`} className="mt-3 grid gap-2">
    <span data-fatigue={fatigue} className="flex items-center gap-2 text-xs text-muted">
      <QuotaMeter quota={displayBar} reading={reading} className="w-24 shrink-0" />
      <span>{FATIGUE_LABEL[fatigue]}</span>
    </span>
    {quotas.loading && !quotas.data && noReader === null ? <p className="m-0 text-xs" role="status">Leyendo cuotas de la cuenta…</p> : null}
    {!compact && notRunning ? <p className="m-0 text-xs text-muted">{NOT_RUNNING_QUOTA_MESSAGE}</p> : null}
    {!compact && noReader !== null ? <p className="m-0 text-xs text-muted">{noReader}</p> : null}
    {!compact && unavailableTarget !== null ? <p className="m-0 text-xs text-muted">{unavailableTarget}</p> : null}
    {!compact && quotas.error ? <ErrorNotice failure={quotaReadFailure(quotas.error, 'No se pudo leer la cuota de la cuenta. Relee la cuota del agente.')} /> : null}
    {!compact && accounts.map(account => <QuotaAccountCard key={account.id} account={quotas.error ? failedQuotaRead(account) : account} pinned={false} />)}
    {!compact && !notRunning && quotas.data && !quotas.error && !accounts.length && noReader === null && snapshot.data ? <p className="m-0 text-xs text-muted">{snapshot.data.binding
      ? `Cuenta ${snapshot.data.binding.account_id} vinculada, sin datos de cuota disponibles para esta sesión.`
      : 'No hay una cuenta vinculada con cuota disponible para esta sesión.'}</p> : null}
    {!compact ? <AgentQuotaReader key={`${tenant}/${alias}`} tenant={tenant} alias={alias} quota={snapshot} notRunning={notRunning} /> : null}
  </section>;
}
