import type { CompanyAuthority } from '../company-authority.js';
import type { DatabaseClient } from '../db.js';
import { ConfigurationError } from './contracts.js';

/** Active operators whose home membership controls through an enabled room, tenant and company, as the authority resolver demands. */
export const QUALIFIED_PEOPLE_SQL = `SELECT person.id,person.company_id FROM console_users person
  JOIN human_tenant_memberships home ON home.human_id=person.id AND home.tenant_id=person.tenant_id
  JOIN tenants tenant ON tenant.id=person.tenant_id AND tenant.company_id=person.company_id
  JOIN companies company ON company.id=tenant.company_id
  WHERE person.active AND person.role='operator' AND company.enabled AND company.retired_at IS NULL
    AND tenant.enabled AND tenant.retired_at IS NULL AND tenant.purged_at IS NULL
    AND home.enabled AND home.revoked_at IS NULL AND home.role='operator' AND home.actor_alias=person.alias
    AND 'control'=ANY(home.permissions) AND EXISTS(
      SELECT 1 FROM memberships membership
      JOIN role_policies role ON role.role=membership.role
      JOIN rooms room ON room.id=membership.room_id AND room.tenant_id=membership.tenant_id
      JOIN agents agent ON agent.tenant_id=membership.tenant_id AND agent.alias=membership.alias
      WHERE membership.tenant_id=person.tenant_id AND membership.alias=person.alias
        AND membership.enabled AND membership.retired_at IS NULL AND role.allow_control
        AND room.enabled AND room.retired_at IS NULL AND room.purged_at IS NULL
        AND agent.retired_at IS NULL AND agent.purged_at IS NULL)`;

interface HolderStanding { readonly qualified: boolean; readonly agentEnabled: boolean }
export type HolderStandings = ReadonlyMap<string, HolderStanding>;

/**
 * The people homed in the acting company that the actor must leave as they are, with the same
 * hierarchy as people administration: below the platform nobody reaches an owner or a platform
 * administrator, and only an owner reaches an administrator. The actor is never its own holder.
 */
export async function protectedHolders(client: DatabaseClient, authority: CompanyAuthority): Promise<HolderStandings> {
  if (authority.role === 'platform_admin') return new Map();
  const rows = (await client.query<{ human_id: string; qualified: boolean; agent_enabled: boolean }>(
    `WITH qualified AS (${QUALIFIED_PEOPLE_SQL}), holder AS (
       SELECT human_id FROM company_admins WHERE company_id=$1 AND (role='owner' OR $2::boolean)
       UNION SELECT human_id FROM platform_admins)
     SELECT person.id::text AS human_id,EXISTS(SELECT 1 FROM qualified WHERE qualified.id=person.id) AS qualified,
       COALESCE(agent.enabled AND agent.retired_at IS NULL AND agent.purged_at IS NULL,false) AS agent_enabled
     FROM holder JOIN console_users person ON person.id=holder.human_id AND person.company_id=$1
     LEFT JOIN agents agent ON agent.tenant_id=person.tenant_id AND agent.alias=person.alias
     WHERE person.id IS DISTINCT FROM $3::uuid`,
    [authority.actingCompany, authority.role !== 'company_owner', authority.humanId],
  )).rows;
  return new Map(rows.map(row => [row.human_id, { qualified: row.qualified, agentEnabled: row.agent_enabled }]));
}

/** A holder that qualified, or whose actor agent was enabled, before the mutation must still do so after it. */
export function assertHoldersKept(authority: CompanyAuthority, before: HolderStandings, after: HolderStandings): void {
  for (const [humanId, standing] of before) {
    const kept = after.get(humanId);
    if ((standing.qualified && kept?.qualified !== true) || (standing.agentEnabled && kept?.agentEnabled !== true)) {
      throw new ConfigurationError('forbidden', authority.role === 'company_owner'
        ? 'un dueño no puede deshabilitar ni retirar el acceso de otro dueño ni el de un administrador de plataforma'
        : 'solo un dueño o la plataforma pueden deshabilitar o retirar el acceso de un administrador, y solo la plataforma el de un dueño o un administrador de plataforma');
    }
  }
}
