import type { Tenant } from '@cauce/protocol';
import type { CompanyAuthority } from '../../company-authority.js';
import type { DatabaseClient } from '../../db.js';
import type { CompanyAuthoritySource } from '../fleet-hosts.js';

/** The authority is a verified person acting as platform administrator for exactly this actor. */
export function isPlatformActor(
  authority: CompanyAuthority, actorTenant: Tenant, actorAlias: string,
): authority is CompanyAuthority & { readonly humanId: string } {
  return authority.homeTenant === actorTenant && authority.alias === actorAlias && authority.humanId !== null
    && authority.role === 'platform_admin' && authority.scope === 'platform';
}

/**
 * A platform administrator acting in a company reaches the deliveries whose source and recipient
 * tenants both belong to that company, the same reach fleet operations give it. Anything else,
 * including a company or tenant role, keeps the tenant scope.
 */
export async function platformCompanyReach(
  client: DatabaseClient, actorTenant: Tenant, actorAlias: string,
  row: { recipient_tenant: Tenant; tenant_id: Tenant }, source: CompanyAuthoritySource,
): Promise<CompanyAuthority | undefined> {
  const authority = await source(client);
  if (!isPlatformActor(authority, actorTenant, actorAlias)) return undefined;
  const tenants = [...new Set([row.tenant_id, row.recipient_tenant])];
  const owners = await client.query<{ company_id: string }>(
    'SELECT company_id FROM tenants WHERE id=ANY($1::text[]) ORDER BY id FOR SHARE', [tenants],
  );
  return owners.rows.length === tenants.length && owners.rows.every((owner) => owner.company_id === authority.actingCompany)
    ? authority : undefined;
}

/** The audit columns that name the person and the company a platform reach acted in. */
export function platformAudit(authority: CompanyAuthority | undefined): { company: string | null; human: string | null; metadata: Record<string, unknown> } {
  return authority === undefined ? { company: null, human: null, metadata: {} } : {
    company: authority.actingCompany, human: authority.humanId,
    metadata: { acting_company: authority.actingCompany, home_company: authority.homeCompany, platform_override: authority.platformOverride },
  };
}
