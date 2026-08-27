import type { Tenant } from '@cauce/protocol';
import type { DeliveryRow } from './contracts.js';

/** Deployment status derived from registry + presence only; no host-side reporter exists yet
 *  (see docs/adr/006-agent-registry-and-deferred-execution.md), so this never claims more than
 *  Postgres actually knows. */
export function agentDeploymentStatus(row: Record<string, unknown>): string {
  if (row.enabled !== true) return 'disabled';
  if (row.online === true) return 'online';
  if (row.online === false) return 'offline';
  return 'unknown';
}

export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

export const aliasPattern = /^[a-z][a-z0-9_-]{0,63}$/u;

export const tenantPattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  const marker = '…[truncated]';
  const contentBudget = Math.max(0, maxBytes - Buffer.byteLength(marker, 'utf8'));
  let used = 0;
  let result = '';
  for (const character of value) {
    const bytes = Buffer.byteLength(character, 'utf8');
    if (used + bytes > contentBudget) break;
    result += character;
    used += bytes;
  }
  return { value: `${result}${marker}`, truncated: true };
}

export function originRelayTenant(row: Pick<DeliveryRow, 'tenant_id' | 'origin'>): Tenant {
  const trustedTenant = row.origin?.metadata.bridge_tenant;
  return typeof trustedTenant === 'string' && tenantPattern.test(trustedTenant)
    ? trustedTenant
    : row.tenant_id;
}
