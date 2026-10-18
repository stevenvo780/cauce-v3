import type { ConfigAction, ConfigurationSnapshot } from '../../api/types';
import type { ConfigFormDefinition } from './config-form-model';

interface Capability {
  resource: string;
  actions: string[];
  scope: 'hub' | 'company' | 'platform' | 'tenant' | 'outgoing_acl' | 'none';
  tenant_id?: string;
}

interface Capabilities {
  actor: { tenant_id: string; can_control: boolean };
  resources: Capability[];
}

function capabilities(snapshot: ConfigurationSnapshot): Capabilities | undefined | null {
  const raw = (snapshot as unknown as Record<string, unknown>).capabilities;
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== 'object') return null;
  const value = raw as Partial<Capabilities>;
  if (!value.actor || typeof value.actor.tenant_id !== 'string'
    || typeof value.actor.can_control !== 'boolean'
    || !Array.isArray(value.resources)) return null;
  if (value.resources.some((entry: unknown) => {
    if (entry === null || typeof entry !== 'object') return true;
    const record = entry as Partial<Capability>;
    return typeof record.resource !== 'string'
    || !Array.isArray(record.actions) || !record.actions.every((action) => typeof action === 'string')
    || !['hub', 'company', 'platform', 'tenant', 'outgoing_acl', 'none'].includes(record.scope ?? '')
    || (record.tenant_id !== undefined && typeof record.tenant_id !== 'string');
  })) return null;
  return value as Capabilities;
}

export function scopedFormIdentity(snapshot: ConfigurationSnapshot, definition: ConfigFormDefinition): Record<string, string> {
  const access = capabilities(snapshot);
  if (!access) return {};
  const resource = access.resources.find((entry) => entry.resource === definition.resource);
  if (!resource || !['tenant', 'outgoing_acl'].includes(resource.scope)) return {};
  const key = resource.scope === 'outgoing_acl' ? 'from_tenant' : definition.resource === 'tenant' ? 'id' : 'tenant_id';
  return { [key]: resource.tenant_id ?? access.actor.tenant_id };
}

export const PLATFORM_CATALOG_REASON = 'Solo el administrador de plataforma puede cambiar esta política.';

/** Hides platform catalogs when the snapshot names a role other than platform_admin. A snapshot without a role stays unchanged. */
export function platformCatalogReason(snapshot: ConfigurationSnapshot | undefined, resource: string): string | undefined {
  if (!snapshot || (resource !== 'role_policy' && resource !== 'chain_policy')) return undefined;
  const role = (snapshot as { capabilities?: { actor?: { role?: unknown } } }).capabilities?.actor?.role;
  if (typeof role === 'string' && role !== 'platform_admin') return PLATFORM_CATALOG_REASON;
  return undefined;
}

export function canUseConfigForm(snapshot: ConfigurationSnapshot, definition: ConfigFormDefinition, action: ConfigAction, row?: Record<string, unknown>): boolean {
  const access = capabilities(snapshot);
  if (access === undefined) return action !== 'retire' && action !== 'restore';
  if (!access?.actor.can_control) return false;
  const resource = access.resources.find((entry) => entry.resource === definition.resource);
  if (!resource || !resource.actions.includes(action) || resource.scope === 'none') return false;
  if (['hub', 'company', 'platform'].includes(resource.scope)) return true;
  const identity = scopedFormIdentity(snapshot, definition);
  return row === undefined || Object.entries(identity).every(([key, value]) => row[key] === value);
}

export function retiredConfigRows(snapshot: ConfigurationSnapshot | undefined, collection: string): Record<string, unknown>[] | undefined {
  const raw = (snapshot as unknown as Record<string, unknown> | undefined)?.retired;
  if (!raw || typeof raw !== 'object' || !['tenants', 'rooms', 'memberships'].includes(collection)) return undefined;
  const rows = (raw as Record<string, unknown>)[collection];
  return Array.isArray(rows) ? rows.filter((row): row is Record<string, unknown> => row !== null && typeof row === 'object' && !Array.isArray(row)) : undefined;
}
