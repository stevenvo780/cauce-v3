import type { ConfigMutation, FleetOperationRequest } from '@cauce/protocol';
import {
  companyAgentAllowance, lockCompanyAllowance, PENDING_PLAN_AGENT_SQL, PLAN_AGENT_SQL, type CompanyAuthority, type CompanyAuthoritySource, type DatabaseClient, type DatabasePool,
} from '@cauce/store';

type Queryable = Pick<DatabaseClient, 'query'>;

export interface AgentTarget {
  readonly tenant_id: string;
  readonly alias: string;
}

export class PlanLimitError extends Error {
  readonly code = 'plan_limit_reached';
  constructor(readonly limit: number, readonly used: number) {
    super(limit === 0
      ? 'La empresa no tiene un plan activo: contrata uno en Ajustes > Plan y pagos para crear agentes.'
      : `La empresa ya usa ${String(used)} de ${String(limit)} agentes de su plan.`);
    this.name = 'PlanLimitError';
  }
}

export function createdConfigurationAgents(mutation: ConfigMutation): AgentTarget[] {
  if (mutation.resource === 'batch') return mutation.mutations.flatMap(leaf => createdConfigurationAgents(leaf));
  return mutation.resource === 'agent' && mutation.action === 'create' ? [{ tenant_id: mutation.tenant_id, alias: mutation.alias }] : [];
}

/** Creating an agent and restoring a retired one both bring an agent back into the plan count. */
export function createdFleetAgents(request: FleetOperationRequest): AgentTarget[] {
  return (request.kind === 'create' || request.kind === 'restore') && request.target.resource === 'agent'
    ? [{ tenant_id: request.target.tenant_id, alias: request.target.alias }] : [];
}

/**
 * Only targets of `company` that do not already count as used are added, so the check gives the same
 * answer before and after the creating statement and leaves other companies' targets to their own guards.
 */
export async function assertAgentAllowance(db: Queryable, company: string, targets: readonly AgentTarget[]): Promise<void> {
  if (targets.length === 0) return;
  await lockCompanyAllowance(db, company);
  const adding = (await db.query<{ adding: number }>(
    `SELECT count(DISTINCT (target.tenant_id,target.alias))::integer AS adding
       FROM unnest($2::text[],$3::text[]) AS target(tenant_id,alias)
       JOIN tenants tenant ON tenant.id=target.tenant_id AND tenant.company_id=$1
       LEFT JOIN agents agent ON agent.tenant_id=target.tenant_id AND agent.alias=target.alias
      WHERE (agent.tenant_id IS NULL OR NOT ${PLAN_AGENT_SQL})
        AND (target.tenant_id,target.alias) NOT IN (${PENDING_PLAN_AGENT_SQL})`,
    [company, targets.map(target => target.tenant_id), targets.map(target => target.alias)])).rows[0]?.adding ?? 0;
  if (adding === 0) return;
  const allowance = await companyAgentAllowance(db, company);
  if (allowance.exempt) return;
  const limit = allowance.limit ?? 0;
  if (allowance.used + adding > limit) throw new PlanLimitError(limit, allowance.used);
}

/** Runs the check inside the caller's transaction, after its company authority resolves. */
export function admittingAuthority(source: CompanyAuthoritySource, targets: readonly AgentTarget[]): CompanyAuthoritySource {
  if (targets.length === 0) return source;
  return async (client: DatabaseClient): Promise<CompanyAuthority> => {
    const authority = await source(client);
    await assertAgentAllowance(client, authority.actingCompany, targets);
    return authority;
  };
}

/** For principals without a console company authority: the actor's own company is the one charged. */
export async function assertActorAgentAllowance(pool: DatabasePool, actorTenant: string, targets: readonly AgentTarget[]): Promise<void> {
  if (targets.length === 0) return;
  const company = (await pool.query<{ company_id: string | null }>('SELECT company_id FROM tenants WHERE id=$1', [actorTenant])).rows[0]?.company_id;
  if (company === undefined || company === null) return;
  await assertAgentAllowance(pool, company, targets);
}
