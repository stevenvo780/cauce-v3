import type { ConfigMutation } from '@cauce/protocol';
import { companyScopeSql, type CompanyAuthority } from '../company-authority.js';
import type { DatabaseClient } from '../db.js';
import {
  ConfigurationError, type ConfigurationAction, type ConfigurationCapabilities, type ConfigurationCapabilityResource,
  type ConfigurationLeafMutation, type ConfigurationResourceCapability,
} from './contracts.js';

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

/** Snapshot reads bind `$1` to the acting company and `$2` to the actor tenant, or null when the authority spans the company. */
export function configurationScopeSql(owner: string): string {
  return `${companyScopeSql(owner, '$1')} AND ($2::text IS NULL OR ${owner}=$2)`;
}

const LIFECYCLE: readonly ConfigurationAction[] = ['create', 'update', 'delete', 'retire', 'restore'];
const WRITE: readonly ConfigurationAction[] = ['create', 'update', 'delete'];
const CAPABILITY_RESOURCES: readonly ConfigurationCapabilityResource[] = [
  'tenant', 'room', 'membership', 'acl_edge', 'harness', 'role_policy', 'chain_policy',
  'egress_destination', 'agent', 'provider_account', 'alias_routing_ceiling',
  'agent_account_binding', 'agent_profile', 'fleet_host',
];
/** Installation catalogs live in platform revisions, so a batch never mixes them with company resources. */
const PLATFORM_RESOURCES: ReadonlySet<string> = new Set(['harness', 'role_policy', 'chain_policy']);

export function isPlatformMutation(mutation: ConfigMutation): boolean {
  return (mutation.resource === 'batch' ? mutation.mutations : [mutation]).some((leaf) => PLATFORM_RESOURCES.has(leaf.resource));
}

/** The platform, owners and administrators act on the whole acting company; the hub grants nothing. */
export function companyWide(authority: CompanyAuthority): boolean {
  return authority.role === 'platform_admin' || authority.role === 'company_owner' || authority.role === 'company_admin';
}

/**
 * Harnesses and role policies run on every company's machines, so only the platform CLI writes them.
 * A provider account spends its payer's money, so a company administrator does not manage it.
 */
function resourceCapability(resource: ConfigurationCapabilityResource, authority: CompanyAuthority): ConfigurationResourceCapability {
  const none: ConfigurationResourceCapability = { resource, actions: [], scope: 'none' };
  const wide = companyWide(authority);
  if (!wide && authority.role !== 'tenant_operator') return none;
  const company = (actions: readonly ConfigurationAction[]): ConfigurationResourceCapability => ({ resource, actions, scope: 'company' });
  const own = (actions: readonly ConfigurationAction[], scope: 'tenant' | 'outgoing_acl' = 'tenant'): ConfigurationResourceCapability =>
    ({ resource, actions, scope, tenant_id: authority.homeTenant });
  switch (resource) {
    case 'harness': case 'role_policy': case 'agent_profile': return none;
    case 'chain_policy': return authority.role === 'platform_admin' ? { resource, actions: ['update'], scope: 'platform' } : none;
    case 'fleet_host': return authority.role === 'platform_admin' ? { resource, actions: WRITE, scope: 'platform' } : wide ? company(['update', 'delete']) : none;
    case 'tenant': return wide ? company(LIFECYCLE) : none;
    case 'agent': case 'agent_account_binding': return wide ? company(WRITE) : none;
    case 'alias_routing_ceiling': return wide ? company(['create', 'delete']) : none;
    case 'provider_account': return wide && authority.role !== 'company_admin' ? company(WRITE) : none;
    case 'room': case 'membership': return wide ? company(LIFECYCLE) : own(LIFECYCLE);
    case 'egress_destination': return wide ? company(WRITE) : own(WRITE);
    case 'acl_edge': return wide ? company(WRITE) : own(WRITE, 'outgoing_acl');
  }
}

export function configurationCapabilities(authority: CompanyAuthority): ConfigurationCapabilities {
  return {
    actor: { tenant_id: authority.homeTenant, alias: authority.alias,
      can_control: companyWide(authority) || authority.role === 'tenant_operator',
      role: authority.role, scope: authority.scope, company_id: authority.actingCompany,
      platform_override: authority.platformOverride },
    resources: CAPABILITY_RESOURCES.map((resource) => resourceCapability(resource, authority)),
  };
}

function ownTenant(leaf: ConfigurationLeafMutation): string | undefined {
  if (leaf.resource === 'acl_edge') return leaf.from_tenant;
  return 'tenant_id' in leaf ? leaf.tenant_id : undefined;
}

/** Every leaf needs its action granted; a tenant grant holds only inside the actor's own tenant. */
export function authorizeConfigurationMutation(mutation: ConfigMutation, capabilities: ConfigurationCapabilities): void {
  const leaves = mutation.resource === 'batch' ? mutation.mutations : [mutation];
  const platform = leaves.filter((leaf) => PLATFORM_RESOURCES.has(leaf.resource)).length;
  if (platform > 0 && platform < leaves.length) {
    throw new ConfigurationError('invalid_input', 'a configuration batch cannot mix platform catalogs and company resources');
  }
  for (const leaf of leaves) {
    if (leaf.resource === 'harness' || leaf.resource === 'role_policy') {
      throw new ConfigurationError('forbidden', 'harness definitions and role policies are written through the platform CLI');
    }
    const capability = capabilities.resources.find((entry) => entry.resource === leaf.resource);
    if (!capability?.actions.includes(leaf.action)) {
      throw new ConfigurationError('forbidden', `${leaf.resource} ${leaf.action} is outside the actor authority`);
    }
    if ((capability.scope === 'tenant' || capability.scope === 'outgoing_acl') && ownTenant(leaf) !== capability.tenant_id) {
      throw new ConfigurationError('forbidden', 'configuration resource is outside the actor tenant');
    }
    // Waiving prior contact means writing to a group nobody in it ever addressed.
    if (leaf.resource === 'egress_destination' && capability.scope === 'tenant' && leaf.value?.require_prior_contact === false) {
      throw new ConfigurationError('forbidden', 'waiving prior contact on an egress destination requires company authority');
    }
  }
}

/**
 * Every tenant, payer and host a mutation names must belong to the acting company. An ACL edge is
 * written from its own side: its target may sit in a linked company, and the database keeps it hub to hub.
 */
export async function assertCompanyMutation(
  client: DatabaseClient, mutation: ConfigMutation, company: string,
): Promise<void> {
  const leaves = mutation.resource === 'batch' ? mutation.mutations : [mutation];
  const tenants = new Set<string>();
  const peers = new Set<string>();
  const accounts = new Set<string>();
  const hosts = new Set<string>();
  const createdTenants = new Set<string>();
  const createdAccounts = new Set<string>();
  for (const leaf of leaves) {
    if (leaf.resource === 'agent' && typeof leaf.value?.host_id === 'string') hosts.add(leaf.value.host_id);
    if (leaf.resource === 'tenant') {
      tenants.add(leaf.id);
      if (leaf.action === 'create') createdTenants.add(leaf.id);
    }
    if ('tenant_id' in leaf) tenants.add(leaf.tenant_id);
    if (leaf.resource === 'acl_edge') { tenants.add(leaf.from_tenant); peers.add(leaf.to_tenant); }
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
  if (hosts.size > 0) {
    const placed = await client.query<{ company_id: string }>(
      'SELECT company_id FROM fleet_hosts WHERE host_id=ANY($1::text[]) ORDER BY host_id FOR SHARE', [[...hosts]],
    );
    if (placed.rows.some(row => row.company_id !== company)) throw new ConfigurationError('forbidden', 'fleet host belongs to another company');
  }
  const named = [...new Set([...tenants, ...peers])];
  if (named.length === 0) return;
  const owners = await client.query<{ id: string; company_id: string }>(
    'SELECT id,company_id FROM tenants WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [named],
  );
  const companyOf = new Map(owners.rows.map(row => [row.id, row.company_id]));
  const linked = async (peer: string): Promise<boolean> => (await client.query<{ linked: boolean }>(
    'SELECT cauce_lock_company_link($1,$2) AS linked', [company, peer])).rows[0]?.linked === true;
  if ([...tenants].some(id => companyOf.has(id) && companyOf.get(id) !== company)) {
    throw new ConfigurationError('forbidden', 'configuration resource is outside the actor company');
  }
  for (const peer of new Set([...peers].flatMap(id => companyOf.get(id) ?? []).filter(id => id !== company))) {
    if (!await linked(peer)) throw new ConfigurationError('forbidden', 'configuration resource is outside the actor company');
  }
  if (named.some(id => !createdTenants.has(id) && !companyOf.has(id))) {
    throw new ConfigurationError('not_found', 'tenant was not found');
  }
}
