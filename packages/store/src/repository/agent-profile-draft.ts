import { withAbortableTransaction, type DatabaseClient, type DatabasePool } from '../db.js';
import type { AgentProfile } from '@cauce/protocol';
import type { PersistedAgentProfile } from '../agent-profile.js';
import { agentContextReconcileLockKey } from './agent-context-lock.js';
import { assertAgentContextAdmissionAllowed } from './agent-context-quarantine.js';
import { StoreError } from './errors.js';

export interface AgentProfileDraftActor {
  readonly tenant_id: string; readonly alias: string; readonly subject: string; readonly reason: string; readonly signal?: AbortSignal;
  humanAuthority(client: DatabaseClient): Promise<{ humanId: string; tenantId: string; actorAlias: string }>;
}
function forbidden(): never { throw new StoreError('forbidden', 'current human configure authority is required'); }
async function assertAgentProfileDraftAuthority(client: DatabaseClient, actor: AgentProfileDraftActor, tenantId: string, alias: string): Promise<void> {
  actor.signal?.throwIfAborted();
  let identity; try { identity = await actor.humanAuthority(client); } catch { forbidden(); }
  if (actor.subject !== `console:${identity.humanId}` || actor.tenant_id !== identity.tenantId || actor.alias !== identity.actorAlias) forbidden();
  const human = await client.query(`SELECT 1 FROM console_users person JOIN human_tenant_memberships human ON human.human_id=person.id
    AND human.tenant_id=person.tenant_id AND human.actor_alias=person.alias
    WHERE person.id=$1 AND person.active AND person.role='operator' AND person.tenant_id=$2 AND person.alias=$3
      AND human.enabled AND human.revoked_at IS NULL AND human.role='operator' AND 'control'=ANY(human.permissions)
    FOR SHARE OF person,human`, [identity.humanId, actor.tenant_id, actor.alias]);
  if (!human.rowCount) forbidden();
  const authority = await client.query<{ is_hub: boolean }>(`SELECT tenant.is_hub FROM memberships member
    JOIN agents agent ON agent.tenant_id=member.tenant_id AND agent.alias=member.alias
    JOIN tenants tenant ON tenant.id=member.tenant_id JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
    JOIN role_policies policy ON policy.role=member.role
    WHERE member.tenant_id=$1 AND member.alias=$2 AND member.enabled AND policy.allow_control AND tenant.enabled AND room.enabled
      AND agent.retired_at IS NULL AND tenant.retired_at IS NULL AND room.retired_at IS NULL AND member.retired_at IS NULL
    FOR SHARE OF member,agent,tenant,room,policy`, [actor.tenant_id, actor.alias]);
  if (!authority.rowCount) forbidden();
  const target = (await client.query<{ enabled: boolean; retired_at: Date | null; is_hub: boolean }>(`SELECT agent.enabled,agent.retired_at,tenant.is_hub
    FROM agents agent JOIN tenants tenant ON tenant.id=agent.tenant_id
    WHERE agent.tenant_id=$1 AND agent.alias=$2 AND tenant.enabled AND tenant.retired_at IS NULL
    FOR UPDATE OF agent FOR SHARE OF tenant`, [tenantId, alias])).rows[0];
  if (!target || target.enabled || target.retired_at !== null) throw new StoreError('conflict', 'draft target must be disabled and not retired');
  if (actor.tenant_id !== tenantId) {
    if (!target.is_hub && !authority.rows.some(row => row.is_hub)) forbidden();
    const edges = await client.query(`SELECT 1 FROM acl_edges WHERE from_tenant=$1 AND to_tenant=$2 AND enabled AND allow_control
      AND to_jsonb(acl_edges)->>'retired_at' IS NULL FOR SHARE`, [actor.tenant_id, tenantId]);
    if (!edges.rowCount) forbidden();
  }
  actor.signal?.throwIfAborted();
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
    await assertAgentProfileDraftAuthority(client, actor, profile.tenant_id, profile.alias);
    await assertAgentContextAdmissionAllowed(client, profile.tenant_id, profile.alias);
    const state = await persist(client);
    await client.query('INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata) VALUES($1,$2,$3,$4,$5::jsonb)',
      [actor.tenant_id, actor.alias, 'agent_profile.draft', 'allow', JSON.stringify({ actor_subject: actor.subject, operator_reason: actor.reason.trim(),
        target_tenant: profile.tenant_id, target_alias: profile.alias, state: 'prepared_disabled', desired_revision: state.revision, applied_revision: state.applied_revision })]);
    actor.signal?.throwIfAborted(); return state;
  });
}
