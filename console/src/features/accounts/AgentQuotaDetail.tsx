import { useApi } from '../../api/context';
import { useResource } from '../../api/use-resource';
import { usePolling } from '../../api/use-polling';
import { Notice } from '../../components/kit';
import { FatigueIndicator } from './FatigueIndicator';
import { QuotaAccountCard } from './QuotaAccountCard';
import { agentFatigue, agentQuotaAccounts, failedQuotaRead } from './quota-availability';

export function AgentQuotaDetail({ tenant, alias, compact = false }: { tenant: string; alias: string; compact?: boolean }) {
  const api = useApi();
  const quotas = useResource(`agent-quota-account:${tenant}/${alias}`, () => api.getQuotaAccounts());
  usePolling(() => { void quotas.reload(); }, 30_000);
  const fatigue = quotas.error ? 'error' : agentFatigue(quotas.data?.accounts ?? [], tenant, alias);
  const accounts = agentQuotaAccounts(quotas.data?.accounts ?? [], tenant, alias);
  return <section aria-label={`Disponibilidad de ${alias}`} className="mt-3 grid gap-2">
    <FatigueIndicator state={fatigue} />
    {quotas.loading && !quotas.data ? <p className="m-0 text-xs" role="status">Leyendo cuotas de la cuenta…</p> : null}
    {!compact && quotas.error ? <Notice tone="danger" role="alert">{quotas.error.message}</Notice> : null}
    {!compact && accounts.map(account => <QuotaAccountCard key={account.id} account={quotas.error ? failedQuotaRead(account) : account} pinned={false} />)}
    {!compact && quotas.data && !quotas.error && !accounts.length ? <p className="m-0 text-xs text-muted">No hay una cuenta vinculada con cuota disponible para esta sesión.</p> : null}
  </section>;
}
