import type { QuotaAccountsSnapshot, QuotaEnvironmentsSnapshot } from './my-quotas-client';

function failed(): never { throw new Error('No se pudo verificar la lectura de cuotas. Relee antes de continuar.'); }
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) failed();
  return value as Record<string, unknown>;
}
function array(value: unknown): unknown[] { if (!Array.isArray(value)) failed(); return value as unknown[]; }
function text(value: unknown): boolean { return typeof value === 'string' && value.length > 0; }
function percent(value: unknown): boolean { return value === null || typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100; }
function status(value: unknown): boolean { return ['unknown', 'error', 'stale', 'ok'].includes(String(value)); }
function version(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value > 0; }
function nullableText(value: unknown): boolean { return value === null || typeof value === 'string'; }
function date(value: unknown): boolean { return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value)); }
function nullableDate(value: unknown): boolean { return value === null || date(value); }
function provider(value: unknown): boolean { return ['claude', 'codex', 'gemini', 'grok', 'muse', 'agy'].includes(String(value)); }
function action(value: unknown): boolean { return ['create', 'authenticate', 'query', 'update_cli', 'delete'].includes(String(value)); }
function refreshStatus(value: unknown): boolean {
  return value === undefined || typeof value === 'string' && ['fresh', 'updating', 'not_authenticated', 'executor_unavailable', 'deleted', 'busy', 'read_only', 'failed', 'stale'].includes(value);
}
export function quotaAccounts(value: unknown): QuotaAccountsSnapshot {
  const row = object(value);
  if (!text(row.company_id) || !date(row.observed_at)) failed();
  const accounts = array(row.accounts).map(value => {
    const account = object(value);
    if (![account.id, account.provider, account.payer_tenant_id].every(text) || (account.label !== null && !text(account.label))
      || typeof account.enabled !== 'boolean' || typeof account.shared !== 'boolean' || !version(account.version)
      || !status(account.observation_status) || !percent(account.remaining_percent) || !nullableDate(account.paused_until)
      || !nullableText(account.paused_reason) || !nullableText(account.note) || !refreshStatus(account.refresh_status)) failed();
    for (const item of array(account.agents)) { const agent = object(item);
      if (![agent.tenant_id, agent.alias].every(text) || typeof agent.enabled !== 'boolean') failed(); }
    if (typeof account.agent_count !== 'number' || !Number.isSafeInteger(account.agent_count) || account.agent_count < array(account.agents).length) failed();
    for (const item of array(account.windows)) { const window = object(item);
      if (![window.group_key, window.window_key, window.host].every(text) || !status(window.observation_status)
        || !percent(window.used_percent) || !percent(window.remaining_percent) || !nullableText(window.model) || !nullableText(window.label)
        || ![window.captured_at, window.received_at, window.reset_at].every(nullableDate)
        || window.window_minutes !== null && !(typeof window.window_minutes === 'number' && Number.isSafeInteger(window.window_minutes) && window.window_minutes > 0)) failed(); }
    return { ...account, label: account.label ?? account.id };
  });
  return { ...row, accounts } as unknown as QuotaAccountsSnapshot;
}
export function quotaEnvironments(value: unknown): QuotaEnvironmentsSnapshot {
  const row = object(value); const capability = object(row.capabilities);
  if (!text(row.company_id) || typeof capability.available !== 'boolean') failed();
  if (!array(capability.providers).every(provider) || !array(capability.actions).every(action)) failed();
  for (const item of array(capability.hosts)) {
    const host = object(item); const providers = array(host.providers); const actions = object(host.provider_actions);
    if (![host.host_id, host.display_name].every(text) || !providers.every(provider)) failed();
    for (const [key, value] of Object.entries(actions)) {
      if (!providers.includes(key) || !provider(key) || !array(value).every(action)) failed();
    }
  }
  for (const item of array(row.environments)) verifyQuotaEnvironment(item);
  for (const item of array(row.operations)) verifyQuotaOperation(item);
  return value as QuotaEnvironmentsSnapshot;
}
export function verifyQuotaEnvironment(value: unknown): void {
  const environment = object(value);
  if (![environment.id, environment.company_id, environment.account_id, environment.host_id, environment.label].every(text) || !provider(environment.provider)
    || !version(environment.version) || ![environment.created_at, environment.updated_at].every(date)
    || !['pending', 'running', 'ready', 'awaiting_auth', 'failed', 'deleting', 'deleted'].includes(String(environment.status)) || !refreshStatus(environment.refresh_status)) failed();
}
export function verifyQuotaOperation(value: unknown): void {
  const operation = object(value);
  if (![operation.id, operation.environment_id].every(text) || !['create', 'authenticate', 'query', 'update_cli', 'delete'].includes(String(operation.action))
    || !['pending', 'running', 'awaiting_auth', 'done', 'failed'].includes(String(operation.status))
    || ![operation.created_at, operation.updated_at].every(date) || !nullableText(operation.error_code)) failed();
  if (operation.result !== null) object(operation.result);
}
