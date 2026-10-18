import type { AccountQuotaWindow, QuotaAccount } from '../../api/client/my-quotas-client';
import { accountFatigue, agentFatigue, agentQuotaAccounts, FATIGUE_LABEL, type FatigueState } from '../accounts/quota-availability';
import { formatPercent } from '../accounts/quotas';

export interface AgentQuotaBar {
  account?: QuotaAccount;
  remaining: number | null;
  limiting?: AccountQuotaWindow;
  state: FatigueState;
  label: string;
  color: string;
}

export function quotaWindowLabel(window: AccountQuotaWindow): string {
  const minutes = window.window_minutes ?? ({ '5h': 300, five_hour: 300, '7d': 10_080, seven_day: 10_080, weekly: 10_080 } as Record<string, number>)[window.window_key];
  return minutes === 300 ? '5h' : minutes === 10_080 ? 'sem' : window.label ?? window.window_key;
}

export function agentQuotaBar(accounts: readonly QuotaAccount[], id: string, failed: boolean, now: number): AgentQuotaBar {
  const cut = id.indexOf('/');
  const tenant = id.slice(0, cut);
  const alias = id.slice(cut + 1);
  const state = failed ? 'error' : agentFatigue(accounts, tenant, alias);
  const bound = agentQuotaAccounts(accounts, tenant, alias);
  const account = bound.filter(value => accountFatigue(value, now) === state)
    .sort((left, right) => (right.remaining_percent ?? -1) - (left.remaining_percent ?? -1)).at(0) ?? bound.at(0);
  const limiting = account?.windows.filter(window => window.observation_status === 'ok' && window.remaining_percent !== null && Number.isFinite(window.remaining_percent))
    .sort((left, right) => (left.remaining_percent ?? 0) - (right.remaining_percent ?? 0)).at(0);
  const known = state === 'available' || state === 'low' || state === 'exhausted';
  const remaining = known && account?.observation_status === 'ok' && limiting?.remaining_percent != null
    ? Math.max(0, Math.min(100, limiting.remaining_percent)) : null;
  return { account, remaining, limiting, state,
    label: remaining === null || !limiting ? FATIGUE_LABEL[state] : `${quotaWindowLabel(limiting)} ${formatPercent(remaining)}`,
    color: remaining === null ? '#94a3b8' : remaining > 50 ? '#4ade80' : remaining >= 20 ? '#fbbf24' : '#f87171' };
}
