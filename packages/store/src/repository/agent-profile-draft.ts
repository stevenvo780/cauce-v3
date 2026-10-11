import { withAbortableTransaction, type DatabaseClient, type DatabasePool } from '../db.js';
import type { AgentProfile } from '@cauce/protocol';
import type { PersistedAgentProfile } from '../agent-profile.js';
import type { CompanyAuthority } from '../company-authority.js';
import { agentContextReconcileLockKey } from './agent-context-lock.js';
import { assertAgentContextAdmissionAllowed } from './agent-context-quarantine.js';
import { StoreError } from './errors.js';

export interface AgentProfileDraftActor {
  readonly tenant_id: string; readonly alias: string; readonly subject: string; readonly reason: string; readonly signal?: AbortSignal;
  humanAuthority(client: DatabaseClient): Promise<{ humanId: string; tenantId: string; actorAlias: string }>;
  /** The company role of the same verified person, resolved in the draft transaction. */
  companyAuthority(client: DatabaseClient): Promise<CompanyAuthority>;
}
function forbidden(): never { throw new StoreError('forbidden', 'current human configure authority is required'); }
/** Owners, administrators and the platform draft any agent of their company; a tenant operator only its own tenant's. */
async function assertAgentProfileDraftAuthority(
  client: DatabaseClient, actor: AgentProfileDraftActor, tenantId: string, alias: string,
): Promise<CompanyAuthority> {
  actor.signal?.throwIfAborted();
  let identity, authority;
  try { identity = await actor.humanAuthority(client); authority = await actor.companyAuthority(client); } catch { forbidden(); }
  if (actor.subject !== `console:${identity.humanId}` || actor.tenant_id !== identity.tenantId || actor.alias !== identity.actorAlias
    || authority.humanId !== identity.humanId || authority.homeTenant !== actor.tenant_id || authority.alias !== actor.alias) forbidden();
  const target = (await client.query<{ enabled: boolean; retired_at: Date | null; company_id: string }>(`SELECT agent.enabled,agent.retired_at,tenant.company_id
    FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
    WHERE agent.tenant_id=$1 AND agent.alias=$2 AND tenant.enabled AND tenant.retired_at IS NULL
    FOR UPDATE OF agent FOR SHARE OF tenant`, [tenantId, alias])).rows[0];
  if (authority.scope === 'company' || authority.scope === 'platform'
    ? target !== undefined && target.company_id !== authority.actingCompany
    : authority.role !== 'tenant_operator' || tenantId !== actor.tenant_id) forbidden();
  if (!target || target.enabled || target.retired_at !== null) throw new StoreError('conflict', 'draft target must be disabled and not retired');
  actor.signal?.throwIfAborted();
  return authority;
}
export async function canPrepareAgentProfileDraft(pool: DatabasePool, actor: AgentProfileDraftActor, tenantId: string, alias: string): Promise<boolean> {
  try {
    return await withAbortableTransaction(pool, actor.signal ?? AbortSignal.timeout(10_000), async client => {
      await client.query('SELECT pg_advisory_xact_lock(783_003_004)');
      await assertAgentProfileDraftAuthority(client, actor, tenantId, alias); return true;
    });
  } catch (error) { if (error instanceof StoreError && ['forbidden', 'conflict'].includes(error.code)) return false; throw error; }
}
export async function prepareAgentProfileDraft(pool: DatabasePool, profile: AgentProfile, actor: AgentProfileDraftActor,
  persist: (client: DatabaseClient) => Promise<PersistedAgentProfile>): Promise<PersistedAgentProfile> {
  if (actor.reason.trim().length < 8 || actor.reason.length > 280) throw new StoreError('invalid_input', 'draft reason is invalid');
  return withAbortableTransaction(pool, actor.signal ?? AbortSignal.timeout(10_000), async client => {
    await client.query('SELECT pg_advisory_xact_lock(783_003_004)');
    await client.query('SELECT pg_advisory_xact_lock_shared(hashtextextended($1,0))', [agentContextReconcileLockKey(profile.tenant_id, profile.alias)]);
    const authority = await assertAgentProfileDraftAuthority(client, actor, profile.tenant_id, profile.alias);
    await assertAgentContextAdmissionAllowed(client, profile.tenant_id, profile.alias);
    const state = await persist(client);
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,actor_human_id,metadata)
      VALUES($1,$2,$3,$4,$5,$6,$7::jsonb)`, [actor.tenant_id, actor.alias, 'agent_profile.draft', 'allow', authority.actingCompany, authority.humanId,
      JSON.stringify({ actor_subject: actor.subject, operator_reason: actor.reason.trim(), target_tenant: profile.tenant_id, target_alias: profile.alias,
        state: 'prepared_disabled', desired_revision: state.revision, applied_revision: state.applied_revision,
        ...(authority.platformOverride ? { platform_override: true } : {}) })]);
    actor.signal?.throwIfAborted(); return state;
  });
}
