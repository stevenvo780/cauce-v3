import type { RequestFn } from './system-client';
import { quotaEnvironmentReceipt } from './v4-responses';
import { quotaAccounts, quotaEnvironments } from './quota-responses';
import { agentQuotaClient, type AgentQuotaClient } from '../../features/accounts/agent-quota-client';

export type QuotaObservationStatus = 'unknown' | 'error' | 'stale' | 'ok';
export type QuotaRefreshStatus = 'fresh' | 'updating' | 'not_authenticated' | 'executor_unavailable' | 'deleted' | 'busy' | 'read_only' | 'failed' | 'stale';
export type QuotaProvider = 'claude' | 'codex' | 'gemini' | 'grok' | 'muse' | 'agy';
export const QUOTA_ACCOUNT_PROVIDERS = ['claude', 'codex', 'gemini', 'grok', 'muse', 'agy'] as const;
export type QuotaAccountProvider = typeof QUOTA_ACCOUNT_PROVIDERS[number];
export interface AccountQuotaWindow {
  group_key: string; window_key: string; model: string | null; label: string | null; host: string;
  used_percent: number | null; remaining_percent: number | null; window_minutes: number | null;
  captured_at: string | null; received_at: string | null; reset_at: string | null; observation_status: QuotaObservationStatus;
}
export interface QuotaAccount {
  id: string; provider: string; label: string; enabled: boolean; version: number; payer_tenant_id: string;
  shared: boolean; agent_count: number; agents: { tenant_id: string; alias: string; enabled: boolean }[];
  paused_until: string | null; paused_reason: string | null; observation_status: QuotaObservationStatus;
  remaining_percent: number | null; note: string | null; windows: AccountQuotaWindow[]; refresh_status?: QuotaRefreshStatus;
}
export interface QuotaAccountsSnapshot { company_id: string; observed_at: string; accounts: QuotaAccount[] }
export type QuotaEnvironmentAction = 'create' | 'authenticate' | 'query' | 'update_cli' | 'delete';
export interface QuotaEnvironment {
  id: string; company_id: string; account_id: string; host_id: string; provider: QuotaProvider; label: string;
  status: 'pending' | 'running' | 'ready' | 'awaiting_auth' | 'failed' | 'deleting' | 'deleted';
  version: number; created_at: string; updated_at: string; refresh_status?: QuotaRefreshStatus;
}
export interface QuotaEnvironmentOperation {
  id: string; environment_id: string; action: QuotaEnvironmentAction;
  status: 'pending' | 'running' | 'awaiting_auth' | 'done' | 'failed';
  error_code: string | null; result: Record<string, unknown> | null; created_at: string; updated_at: string;
}
export interface QuotaEnvironmentsSnapshot {
  company_id: string; environments: QuotaEnvironment[]; operations: QuotaEnvironmentOperation[];
  capabilities: { available: boolean; providers: QuotaProvider[]; hosts: QuotaHostCapabilities[]; actions: QuotaEnvironmentAction[] };
}
export interface QuotaHostCapabilities {
  host_id: string; display_name: string; providers: QuotaProvider[];
  provider_actions: Partial<Record<QuotaProvider, QuotaEnvironmentAction[]>>;
}
export interface QuotaEnvironmentReceipt { environment: QuotaEnvironment; operation: QuotaEnvironmentOperation; duplicate?: boolean }
export interface MyQuotasClient extends AgentQuotaClient {
  getQuotaAccounts(): Promise<QuotaAccountsSnapshot>;
  createQuotaAccount(input: { provider: QuotaAccountProvider; label: string; idempotency_key: string }): Promise<{ account_id: string; duplicate: boolean }>;
  updateQuotaAccount(id: string, input: { expected_version: number; label?: string; enabled?: boolean; paused_until?: string | null; paused_reason?: string | null }): Promise<unknown>;
  deleteQuotaAccount(id: string, version: number): Promise<unknown>;
  getQuotaEnvironments(): Promise<QuotaEnvironmentsSnapshot>;
  createQuotaEnvironment(input: { account_id: string; host_id: string; label: string; idempotency_key: string }): Promise<QuotaEnvironmentReceipt>;
  updateQuotaEnvironment(id: string, input: { expected_version: number; label: string }): Promise<{ environment: QuotaEnvironment }>;
  actQuotaEnvironment(id: string, input: { action: QuotaEnvironmentAction; expected_version: number; idempotency_key: string; consent?: true }): Promise<QuotaEnvironmentReceipt>;
  deleteQuotaEnvironment(id: string, input: { expected_version: number; idempotency_key: string }): Promise<QuotaEnvironmentReceipt>;
}
export function myQuotasClient(request: RequestFn): MyQuotasClient {
  const accounts = '/v3/console/quota-accounts';
  const environments = '/v3/console/quota-environments';
  const write = <T>(path: string, method: string, input: unknown) => request<T>(path, { method, body: JSON.stringify(input) });
  const id = encodeURIComponent;
  return {
    ...agentQuotaClient(request),
    getQuotaAccounts: async () => quotaAccounts(await request(accounts, { cache: 'no-store' })),
    createQuotaAccount: input => write(accounts, 'POST', input),
    updateQuotaAccount: (accountId, input) => write(`${accounts}/${id(accountId)}`, 'PATCH', input),
    deleteQuotaAccount: (accountId, version) => request(`${accounts}/${id(accountId)}?expected_version=${String(version)}`, { method: 'DELETE' }),
    getQuotaEnvironments: async () => quotaEnvironments(await request(environments, { cache: 'no-store' })),
    createQuotaEnvironment: async input => quotaEnvironmentReceipt(await write(environments, 'POST', input)),
    updateQuotaEnvironment: (environmentId, input) => write(`${environments}/${id(environmentId)}`, 'PATCH', input),
    actQuotaEnvironment: async (environmentId, input) => quotaEnvironmentReceipt(await write(`${environments}/${id(environmentId)}/actions`, 'POST', input)),
    deleteQuotaEnvironment: async (environmentId, input) => quotaEnvironmentReceipt(await request(`${environments}/${id(environmentId)}?${new URLSearchParams({ expected_version: String(input.expected_version), idempotency_key: input.idempotency_key })}`, { method: 'DELETE' })),
  };
}
