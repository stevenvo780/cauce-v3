import { createHash } from 'node:crypto';
import { AgentQuotaReceiptSchema, type AgentQuotaReceipt } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import type { AgentQuotaSnapshot } from './agent-quota-bindings.js';
import { StoreError } from './repository/errors.js';

type MeasuredReceipt = Extract<AgentQuotaReceipt, { status: 'measured' }>;
const failureCodes = ['not_authenticated', 'token_expired', 'forbidden_credential_type', 'rate_limited', 'network', 'provider_error'];
function assertSafeReport(receipt: MeasuredReceipt): void {
  const report = receipt.provider_report;
  if ([report.kind, report.source, report.plan].some(value => value != null)
    || report.available_groups.length > 0 || report.limiting_groups.length > 0
    || report.note != null && (!failureCodes.includes(report.note) || report.ok)
    || report.windows.some(window => [window.label, window.family, window.model, window.binding_note].some(value => value != null)
      || window.status != null && !['unknown', 'error', 'ok', 'rate-limited', 'exhausted'].includes(window.status))) invalid();
}
interface Account { id: string; payer_tenant_id: string; shared_with_pool: boolean; quota_identity_hash: string | null; external_account_id: string }
function invalid(): never { throw new StoreError('invalid_input', 'agent quota receipt is invalid'); }
function conflict(): never { throw new StoreError('conflict', 'agent quota sample identity or contents changed'); }
export function agentQuotaReceipt(snapshot: AgentQuotaSnapshot, value: unknown) {
  const parsed = AgentQuotaReceiptSchema.safeParse(value); if (!parsed.success) invalid();
  const receipt = parsed.data;
  if (receipt.operation_id !== snapshot.operation_id || receipt.tenant !== snapshot.tenant_id || receipt.alias !== snapshot.alias
    || receipt.host_id !== snapshot.host_id || receipt.container_name !== snapshot.container_name || receipt.harness !== snapshot.harness_id) invalid();
  if (receipt.status === 'measured' && (receipt.provider !== snapshot.harness_id || receipt.provider_report.provider !== receipt.provider
    || receipt.observation_status !== (receipt.provider_report.ok ? 'ok' : 'error'))) invalid();
  if (receipt.status === 'measured') assertSafeReport(receipt);
  return receipt;
}
export function agentQuotaHost(snapshot: AgentQuotaSnapshot): string {
  return `${snapshot.host_id}.aq-${createHash('sha256').update(snapshot.container_name).digest('hex').slice(0, 32)}`;
}
export async function findAgentQuotaAccount(client: DatabaseClient, company: string, receipt: MeasuredReceipt): Promise<Account | undefined> {
  const accounts = (await client.query<Account>(`SELECT id,payer_tenant_id,shared_with_pool,quota_identity_hash,external_account_id
    FROM provider_accounts WHERE company_id=$1 AND provider=$2 AND canonical_account_id IS NULL
      AND (quota_identity_hash=$3 OR quota_identity_hash IS NULL) ORDER BY id FOR UPDATE`,
  [company, receipt.provider, receipt.identity_hash])).rows;
  const candidates = accounts.filter(account => account.quota_identity_hash === receipt.identity_hash
    || createHash('sha256').update(JSON.stringify([receipt.provider, account.external_account_id])).digest('hex') === receipt.identity_hash);
  if (candidates.length > 1) throw new StoreError('conflict', 'multiple registered accounts share the measured identity');
  return candidates[0];
}
export function canonicalAgentQuotaReport(receipt: MeasuredReceipt, id: string) {
  const report = receipt.provider_report;
  if (report.account_id != null && report.account_id !== id
    || report.windows.some(window => window.account_id != null && window.account_id !== id)) invalid();
  const percent = (value: number | null | undefined) => value == null ? value : Math.round(value * 100) / 100;
  return { ...report, account_id: id, effective_remaining_percent: percent(report.effective_remaining_percent),
    windows: report.windows.map(window => ({ ...window, account_id: id,
      used_percent: percent(window.used_percent), remaining_percent: percent(window.remaining_percent) })) };
}
const reportFields = ['provider', 'ok', 'available', 'kind', 'source', 'plan', 'note', 'effective_remaining_percent', 'observed_at', 'available_groups', 'limiting_groups', 'account_id'];
const windowFields = ['provider', 'group_key', 'window_key', 'label', 'used_percent', 'remaining_percent', 'used_units', 'limit_units', 'window_minutes', 'reset_at', 'status', 'family', 'model', 'account_id', 'binding_note', 'captured_at'];
const numericFields = ['used_percent', 'remaining_percent', 'effective_remaining_percent', 'used_units', 'limit_units', 'window_minutes'];
function normalized(row: Record<string, unknown>, fields: readonly string[]): string {
  return JSON.stringify(fields.map(key => {
    const value = row[key] ?? null;
    if (value === null) return null;
    if (numericFields.includes(key)) return Number(value);
    if (key.endsWith('_at')) {
      if (value instanceof Date) return value.toISOString();
      if (typeof value !== 'string') conflict();
      return new Date(value).toISOString();
    }
    return value;
  }));
}
export async function assertAgentQuotaReplay(client: DatabaseClient, snapshot: AgentQuotaSnapshot, host: string,
  receipt: MeasuredReceipt, accountId: string | undefined): Promise<boolean> {
  const existing = (await client.query<{ id: string; collector_alias: string; provider_count: number; schema_version: number; app_version: string | null }>(
    `SELECT id,collector_alias,provider_count,schema_version,app_version FROM quota_collections
     WHERE collector_tenant=$1 AND host=$2 AND captured_at=$3 FOR SHARE`, [snapshot.tenant_id, host, receipt.captured_at])).rows[0];
  if (!existing) return false;
  if (!accountId || existing.collector_alias !== snapshot.alias || existing.provider_count !== 1
    || existing.schema_version !== 2 || existing.app_version !== null) conflict();
  const report = canonicalAgentQuotaReport(receipt, accountId);
  const reports = (await client.query<Record<string, unknown>>('SELECT * FROM quota_provider_reports WHERE collection_id=$1', [existing.id])).rows;
  const windows = (await client.query<Record<string, unknown>>('SELECT * FROM quota_window_samples WHERE collection_id=$1', [existing.id])).rows;
  const expectedWindows = report.windows.map(window => ({ ...window, provider: receipt.provider,
    captured_at: window.observed_at ?? report.observed_at ?? receipt.captured_at }));
  if (reports.length !== 1 || normalized(reports[0] ?? {}, reportFields) !== normalized(report, reportFields)
    || JSON.stringify(windows.map(window => normalized(window, windowFields)).sort())
      !== JSON.stringify(expectedWindows.map(window => normalized(window, windowFields)).sort())) conflict();
  return true;
}
