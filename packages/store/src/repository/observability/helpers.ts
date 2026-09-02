import { isTenant, type Tenant } from '@cauce/protocol';
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
  return isTenant(trustedTenant) ? trustedTenant : row.tenant_id;
}
