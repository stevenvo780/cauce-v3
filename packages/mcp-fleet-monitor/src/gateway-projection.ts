import { AliasSchema, TenantSchema } from '@cauce/protocol';

export const MAX_GATEWAY_ITEMS = 100;

export class GatewayReadError extends Error {
  constructor(readonly code: 'gateway_unavailable' | 'gateway_timeout' | 'gateway_unauthorized'
    | 'gateway_forbidden' | 'gateway_response_invalid' | 'gateway_response_too_large') {
    super(code);
  }
}

function invalid(): never { throw new GatewayReadError('gateway_response_invalid'); }

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return invalid();
  return value as Record<string, unknown>;
}

function boolean(value: unknown): boolean {
  return typeof value === 'boolean' ? value : invalid();
}

function optionalBoolean(value: unknown): boolean | null {
  return value === null ? null : boolean(value);
}

function timestamp(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value !== 'string' || value.length > 40
    || !/^\d{4}-\d{2}-\d{2}T[\d:.]+(?:Z|[+-]\d{2}:\d{2})$/u.test(value)
    || !Number.isFinite(Date.parse(value))) return invalid();
  return new Date(value).toISOString();
}

function scopedRows(value: unknown, tenant: string): Record<string, unknown>[] {
  if (!TenantSchema.safeParse(tenant).success || !Array.isArray(value)) return invalid();
  return value.map(record).filter((row) => {
    if (!TenantSchema.safeParse(row.tenant_id).success) return invalid();
    return row.tenant_id === tenant;
  });
}

function identity(row: Record<string, unknown>, tenant: string) {
  const alias = AliasSchema.safeParse(row.alias);
  if (!alias.success) return invalid();
  return { tenant_id: tenant, alias: alias.data };
}

function bounded<T>(items: T[]) {
  return { items: items.slice(0, MAX_GATEWAY_ITEMS), total: items.length, truncated: items.length > MAX_GATEWAY_ITEMS };
}

export function projectGatewayStatus(value: unknown, tenant: string) {
  const data = record(value);
  if (typeof data.version !== 'string' || !/^\d{1,3}\.\d{1,3}$/u.test(data.version)) return invalid();
  const presence = scopedRows(data.presence, tenant).map((row) => ({
    ...identity(row, tenant), online: boolean(row.online), last_heartbeat_at: timestamp(row.last_heartbeat_at),
  }));
  return {
    tenant_id: tenant, version: data.version,
    online: presence.filter((row) => row.online).length,
    presence: bounded(presence),
  };
}

export function projectGatewayAgents(value: unknown, tenant: string) {
  const agents = scopedRows(record(value).items, tenant).map((row) => {
    const status = row.deployment_status;
    if (status !== 'online' && status !== 'offline' && status !== 'disabled' && status !== 'unknown') return invalid();
    return {
      ...identity(row, tenant), enabled: boolean(row.enabled), online: optionalBoolean(row.online),
      deployment_status: status, last_heartbeat_at: timestamp(row.last_heartbeat_at),
    };
  });
  return { tenant_id: tenant, ...bounded(agents) };
}
