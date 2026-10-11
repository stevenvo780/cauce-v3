import type { CompanyInventory, OfficeLayout, ConsolePreferences, RegistrationResult } from './company-client';
import type { QuotaEnvironmentReceipt } from './my-quotas-client';
import type { VersionedContextSnapshot } from './context-versions-client';
import { verifyQuotaEnvironment, verifyQuotaOperation } from './quota-responses';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('El servidor no confirmó una respuesta válida. Relee el estado antes de continuar.');
  return value as Record<string, unknown>;
}
function nonempty(value: unknown): value is string { return typeof value === 'string' && value.trim().length > 0; }
function version(value: unknown): boolean { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function failed(): never { throw new Error('El servidor no confirmó el estado de la operación. Relee antes de continuar.'); }

export function registrationReceipt(value: unknown): RegistrationResult {
  const row = object(value); const user = object(row.user); const company = object(row.company); const hub = object(row.hub);
  if (![user.id, user.username, user.email, user.name, company.id, company.slug, company.name, hub.id, hub.name].every(nonempty)) failed();
  return value as RegistrationResult;
}
export function companyInventory(value: unknown): CompanyInventory {
  const row = object(value);
  if (!nonempty(row.home_company) || !nonempty(row.acting_company) || typeof row.platform_override !== 'boolean' || !Array.isArray(row.companies)) failed();
  for (const value of row.companies) { const company = object(value); if (!nonempty(company.id) || !nonempty(company.name) || !version(company.version)
    || !['enabled', 'disabled', 'retired'].includes(String(company.state))) failed(); }
  return value as CompanyInventory;
}
export function consolePreferences(value: unknown): ConsolePreferences {
  const row = object(value);
  if (!version(row.version) || !Array.isArray(row.pinned_quota_accounts) || !row.pinned_quota_accounts.every(nonempty)) failed();
  return value as ConsolePreferences;
}
export function officeLayout(value: unknown): OfficeLayout {
  const row = object(value);
  if (!nonempty(row.company_id) || !version(row.version) || !Array.isArray(row.rooms)) failed();
  for (const value of row.rooms) { const room = object(value); if (!nonempty(room.tenant_id) || !nonempty(room.room_id) || !Array.isArray(room.parts)) failed();
    const parts: unknown[] = room.parts;
    for (const item of [room, ...parts]) { const geometry = object(item);
      if (!['x', 'y', 'width', 'height'].every(key => typeof geometry[key] === 'number' && Number.isFinite(geometry[key]))) failed(); }
  }
  return value as OfficeLayout;
}
export function quotaEnvironmentReceipt(value: unknown): QuotaEnvironmentReceipt {
  const row = object(value); const environment = object(row.environment); const operation = object(row.operation);
  verifyQuotaEnvironment(environment); verifyQuotaOperation(operation);
  if (!nonempty(environment.id) || !version(environment.version) || !nonempty(operation.id) || operation.environment_id !== environment.id
    || !['pending', 'running', 'awaiting_auth', 'done', 'failed'].includes(String(operation.status))) failed();
  return value as QuotaEnvironmentReceipt;
}
export function versionedContext(value: unknown): VersionedContextSnapshot {
  const row = object(value); const sync = object(row.sync); const application = object(row.application);
  if (!version(row.version) || !version(row.desired_version) || (row.applied_version !== null && !version(row.applied_version))
    || !Array.isArray(row.files) || !['pending', 'synced', 'error'].includes(String(sync.state))
    || !['pending', 'applied', 'error'].includes(String(application.state))) failed();
  for (const item of row.files as unknown[]) { const file = object(item); if (!nonempty(file.path) || typeof file.content !== 'string') failed(); }
  for (const value of [sync.git_commit, sync.pushed_at, sync.last_error, application.last_error]) if (value !== null && typeof value !== 'string') failed();
  return value as VersionedContextSnapshot;
}
