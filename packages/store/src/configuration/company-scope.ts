import type { ConfigMutation } from '@cauce/protocol';
import type { DatabaseClient } from '../db.js';
import { ConfigurationError } from './contracts.js';

/** The company that owns every pre-company resource and the still-global catalogs. */
export const LEGACY_COMPANY = 'humanizar';

/** Payer consent for a provider account: its own payer, or a pool account paid by the same company. */
export function providerAccountConsentSql(account: string, consumerTenant: string): string {
  return `(${account}.payer_tenant_id=${consumerTenant} OR (${account}.shared_with_pool AND EXISTS (
    SELECT 1 FROM tenants consent_payer JOIN tenants consent_consumer ON consent_consumer.company_id=consent_payer.company_id
    WHERE consent_payer.id=${account}.payer_tenant_id AND consent_consumer.id=${consumerTenant})))`;
}

export function configurationTenantScopeSql(owner: string, hub: boolean): string {
  return `EXISTS (SELECT 1 FROM tenants scope_owner JOIN tenants scope_actor
    ON scope_actor.company_id=scope_owner.company_id
    WHERE scope_actor.id=$1 AND scope_owner.id=${owner})${hub ? '' : ` AND ${owner}=$1`}`;
}

export async function assertCompanyMutation(
  client: DatabaseClient, mutation: ConfigMutation, company: string,
): Promise<void> {
  const leaves = mutation.resource === 'batch' ? mutation.mutations : [mutation];
  const tenants = new Set<string>();
  const accounts = new Set<string>();
  const createdTenants = new Set<string>();
  const createdAccounts = new Set<string>();
  for (const leaf of leaves) {
    if (['harness', 'role_policy', 'chain_policy'].includes(leaf.resource) && company !== LEGACY_COMPANY) {
      throw new ConfigurationError('forbidden', 'global configuration is reserved to the legacy company');
    }
    if (leaf.resource === 'agent' && typeof leaf.value?.host_id === 'string' && company !== LEGACY_COMPANY) {
      throw new ConfigurationError('forbidden', 'fleet hosts are reserved to the legacy company');
    }
    if (leaf.resource === 'tenant') {
      tenants.add(leaf.id);
      if (leaf.action === 'create') createdTenants.add(leaf.id);
    }
    if ('tenant_id' in leaf) tenants.add(leaf.tenant_id);
    if (leaf.resource === 'acl_edge') { tenants.add(leaf.from_tenant); tenants.add(leaf.to_tenant); }
    if ('account_id' in leaf) accounts.add(leaf.account_id);
    if (leaf.resource === 'provider_account') {
      accounts.add(leaf.id);
      if (leaf.action === 'create') createdAccounts.add(leaf.id);
      if (typeof leaf.value?.payer_tenant_id === 'string') tenants.add(leaf.value.payer_tenant_id);
    }
  }
  if (accounts.size > 0) {
    const payers = await client.query<{ id: string; payer_tenant_id: string }>(
      'SELECT id,payer_tenant_id FROM provider_accounts WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [[...accounts]],
    );
    if ([...accounts].some(id => !createdAccounts.has(id) && !payers.rows.some(row => row.id === id))) {
      throw new ConfigurationError('not_found', 'provider account was not found');
    }
    for (const row of payers.rows) tenants.add(row.payer_tenant_id);
  }
  if (tenants.size === 0) return;
  const owners = await client.query<{ id: string; company_id: string }>(
    'SELECT id,company_id FROM tenants WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [[...tenants]],
  );
  if (owners.rows.some(row => row.company_id !== company)) {
    throw new ConfigurationError('forbidden', 'configuration resource is outside the actor company');
  }
  if ([...tenants].some(id => !createdTenants.has(id) && !owners.rows.some(row => row.id === id))) {
    throw new ConfigurationError('not_found', 'tenant was not found');
  }
}
