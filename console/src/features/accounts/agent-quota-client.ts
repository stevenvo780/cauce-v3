import { QuotaProviderReportSchema } from '@cauce/protocol/quotas';
import type { QuotaProviderReport } from '@cauce/protocol';
import type { RequestFn } from '../../api/client/system-client';

export type AgentQuotaStatus = 'unknown' | 'pending' | 'running' | 'unsupported' | 'ok' | 'error' | 'failed';
export interface AgentQuotaOperation {
  id: string; status: 'pending' | 'running' | 'done' | 'failed'; error_code: string | null;
  created_at: string; updated_at: string;
}
export interface AgentQuotaReading {
  tenant_id: string; alias: string; revision: number; reader_available: boolean; can_query: boolean;
  reason: 'quota_reader_unavailable' | null; status: AgentQuotaStatus; captured_at: string | null;
  binding: null | { account_id: string; enabled: boolean; shared: boolean; agent_count: number };
  sample: QuotaProviderReport | null; operation: AgentQuotaOperation | null;
}
export interface AgentQuotaQuery { expected_revision: number; idempotency_key: string }
export interface AgentQuotaQueryReceipt { operation_id: string; status: AgentQuotaOperation['status'] }
export interface AgentQuotaClient {
  getAgentQuota(tenant: string, alias: string): Promise<AgentQuotaReading>;
  queryAgentQuota(tenant: string, alias: string, input: AgentQuotaQuery): Promise<AgentQuotaQueryReceipt>;
}
function invalid(): never { throw new Error('No se pudo verificar la lectura de cuota del agente. Relee antes de consultar.'); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function text(value: unknown): value is string { return typeof value === 'string' && value.length > 0; }
function date(value: unknown): value is string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
}
function operationStatus(value: unknown): boolean { return ['pending', 'running', 'done', 'failed'].includes(String(value)); }
function reading(value: unknown, tenant: string, alias: string): AgentQuotaReading {
  const row = record(value);
  if (row.tenant_id !== tenant || row.alias !== alias || typeof row.reader_available !== 'boolean' || typeof row.can_query !== 'boolean'
    || !Number.isSafeInteger(row.revision) || Number(row.revision) < 0 || row.reason !== null && row.reason !== 'quota_reader_unavailable'
    || !['unknown', 'pending', 'running', 'unsupported', 'ok', 'error', 'failed'].includes(String(row.status))
    || row.captured_at !== null && !date(row.captured_at)) invalid();
  if (row.binding !== null) {
    const binding = record(row.binding);
    if (!text(binding.account_id) || typeof binding.enabled !== 'boolean' || typeof binding.shared !== 'boolean'
      || !Number.isSafeInteger(binding.agent_count) || Number(binding.agent_count) < 0) invalid();
  }
  if (row.operation !== null) {
    const operation = record(row.operation);
    if (!text(operation.id) || !operationStatus(operation.status) || operation.error_code !== null && !text(operation.error_code)
      || !date(operation.created_at) || !date(operation.updated_at)) invalid();
  }
  const sample = row.sample === null ? null : QuotaProviderReportSchema.safeParse(row.sample);
  if (sample !== null && !sample.success) invalid();
  if (sample !== null && (!date(row.captured_at) || row.binding === null
    || sample.data.account_id !== record(row.binding).account_id)) invalid();
  if (row.can_query && !row.reader_available) invalid();
  return { ...row, sample: sample === null ? null : sample.data } as unknown as AgentQuotaReading;
}
export function agentQuotaClient(request: RequestFn): AgentQuotaClient {
  const path = (tenant: string, alias: string) => `/v3/console/agents/${encodeURIComponent(tenant)}/${encodeURIComponent(alias)}/quota`;
  return {
    getAgentQuota: async (tenant, alias) => reading(await request(path(tenant, alias), { cache: 'no-store' }), tenant, alias),
    queryAgentQuota: async (tenant, alias, input) => {
      if (!Number.isSafeInteger(input.expected_revision) || input.expected_revision < 0
        || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(input.idempotency_key)) invalid();
      const row = record(await request(path(tenant, alias), { method: 'POST', body: JSON.stringify(input) }));
      if (!text(row.operation_id) || !operationStatus(row.status)) invalid();
      return { operation_id: row.operation_id, status: row.status } as AgentQuotaQueryReceipt;
    },
  };
}
