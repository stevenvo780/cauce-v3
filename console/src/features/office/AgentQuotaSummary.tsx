import { FATIGUE_LABEL, OBSERVATION_LABEL } from '../accounts/quota-availability';
import { formatPercent, formatResetIn } from '../accounts/quotas';
import { quotaWindowLabel, type AgentQuotaBar } from './agent-quota-bar';

const resetClock = new Intl.DateTimeFormat('es', { dateStyle: 'short', timeStyle: 'short' });

export function AgentQuotaSummary({ quota, now }: { quota: AgentQuotaBar; now: number }) {
  const account = quota.account;
  return <div className="grid gap-1 text-xs leading-snug">
    <strong>{account ? `Cuenta: ${account.label}` : 'Sin cuenta vinculada'}</strong>
    <span>{FATIGUE_LABEL[quota.state]}{quota.remaining !== null ? ` · ${formatPercent(quota.remaining)} restante` : ''}</span>
    {account?.shared ? <span>Consumo compartido por {account.agent_count} agentes</span> : null}
    {account?.windows.map(window => {
      const reset = window.reset_at ? Date.parse(window.reset_at) : NaN;
      const remaining = account.observation_status === 'ok' && quota.state !== 'error' && window.observation_status === 'ok' ? window.remaining_percent : null;
      return <div key={`${window.group_key}:${window.window_key}:${window.model ?? ''}:${window.host}`}>
        <span>{quotaWindowLabel(window)}{window.model ? ` · ${window.model}` : ''}: {remaining !== null ? `${formatPercent(remaining)} restante` : OBSERVATION_LABEL[quota.state === 'error' ? 'error' : account.observation_status === 'ok' ? window.observation_status : account.observation_status]}</span>
        <span className="block">{Number.isFinite(reset) ? <>Se reinicia {formatResetIn((reset - now) / 1000)} · <time dateTime={window.reset_at ?? undefined}>{resetClock.format(reset)}</time></> : 'Reinicio no informado'}</span>
      </div>;
    })}
    {account && !account.windows.length ? <span>No hay ventanas informadas.</span> : null}
  </div>;
}
