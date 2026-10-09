import { sha256Hex } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { providerAccountConsentSql } from './configuration/company-scope.js';
import { agentContextReconcileLockKey } from './repository/agent-context-lock.js';
import { LEGACY_ADOPTION_FIELDS, LegacyAdoptionError, LegacyAdoptionFactsSchema,
  type LegacyAdoptionBlocker, type LegacyAdoptionFence, type LegacyAdoptionFacts, type LegacyAdoptionRow,
  type LegacyAdoptionTarget, type LegacyAdoptionValues } from './fleet-adoption-contracts.js';

interface AgentRow extends LegacyAdoptionValues {
  runtime_key: string | null; harness_id: string | null; primary_room_id: string | null;
  enabled: boolean; lifecycle_state: string; retired_at: Date | null; purged_at: Date | null;
  model_id: string | null; reasoning_effort: string | null;
}
interface MemberRow { room_id: string; role: string; enabled: boolean; retired_at: Date | null;
  room_enabled: boolean; room_retired_at: Date | null; allow_route: boolean }
export async function assertLegacySupervisorFence(fence: LegacyAdoptionFence, targets: readonly LegacyAdoptionTarget[]) {
  try { await fence.assertHeld(); }
  catch { throw new LegacyAdoptionError('unavailable', targets.map(target => ({ target, code: 'supervisor_not_fenced' }))); }
}
export async function lockLegacyAdoptionTargets(client: DatabaseClient, targets: readonly LegacyAdoptionTarget[]): Promise<void> {
  for (const target of targets) {
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [agentContextReconcileLockKey(target.tenant_id, target.alias)]);
  }
  await client.query('LOCK TABLE memberships,role_policies,provider_accounts IN SHARE MODE');
}
export function legacyAdoptionDesired(facts: LegacyAdoptionFacts): LegacyAdoptionValues {
  return { host_id: facts.placement.host_id, runtime_mode: facts.placement.mode,
    container_name: facts.placement.container_name ?? null, runtime_user: facts.placement.runtime_user,
    home_directory: facts.placement.home_directory, state_directory: facts.placement.state_directory,
    systemd_user: facts.placement.systemd_user ?? null, primary_account_id: facts.primary_account_id };
}
export async function legacyAdoptionSnapshot(client: DatabaseClient, targets: readonly LegacyAdoptionTarget[], fence: LegacyAdoptionFence) {
  const rows: LegacyAdoptionRow[] = []; const blockers: LegacyAdoptionBlocker[] = [];
  const unresolved = await client.query(`SELECT 1 FROM fleet_operations
    WHERE status NOT IN ('cancelled','succeeded') LIMIT 1`);
  for (const target of targets) {
    const block = (code: LegacyAdoptionBlocker['code'], field?: LegacyAdoptionBlocker['field']) => {
      blockers.push({ target, code, ...(field === undefined ? {} : { field }) });
    };
    if (unresolved.rowCount) block('active_fleet_cohort');
    const agent = (await client.query<AgentRow>(`SELECT runtime_key,harness_id,primary_room_id,enabled,lifecycle_state,
      retired_at,purged_at,model_id,reasoning_effort,${LEGACY_ADOPTION_FIELDS.join(',')}
      FROM agents WHERE tenant_id=$1 AND alias=$2 FOR UPDATE`, [target.tenant_id, target.alias])).rows[0];
    if (!agent) { block('agent_missing'); continue; }
    if (agent.runtime_key === null) { block('not_legacy_baseline'); continue; }
    const baseline = (await client.query<{ baseline: boolean; runtime_key: string }>(
      'SELECT baseline,runtime_key FROM fleet_runtime_identities WHERE tenant_id=$1 AND alias=$2 FOR SHARE',
      [target.tenant_id, target.alias])).rows[0];
    if (!baseline?.baseline || baseline.runtime_key !== agent.runtime_key) block('not_legacy_baseline');
    const tenant = (await client.query<{ retired_at: Date | null; purged_at: Date | null }>(
      'SELECT retired_at,purged_at FROM tenants WHERE id=$1 FOR SHARE', [target.tenant_id])).rows[0];
    if (agent.retired_at || agent.purged_at || !tenant || tenant.retired_at || tenant.purged_at) block('retired_identity');
    const members = (await client.query<MemberRow>(`SELECT member.room_id,member.role,member.enabled,member.retired_at,
      room.enabled AS room_enabled,room.retired_at AS room_retired_at,policy.allow_route FROM memberships member
      JOIN rooms room ON room.id=member.room_id AND room.tenant_id=member.tenant_id
      JOIN role_policies policy ON policy.role=member.role
      WHERE member.tenant_id=$1 AND member.alias=$2 AND member.enabled AND member.retired_at IS NULL
      ORDER BY member.room_id FOR SHARE OF member,room,policy`,
      [target.tenant_id, target.alias])).rows;
    if (members.length !== 1) block('membership_ambiguous');
    else if (agent.primary_room_id !== members[0]?.room_id || !members[0].room_enabled
      || members[0].room_retired_at !== null || !members[0].allow_route) block('primary_membership_changed');
    if ((await client.query(`SELECT 1 FROM deliveries WHERE recipient_tenant=$1 AND recipient_alias=$2
      AND status IN ('leased','accepted','started') LIMIT 1`, [target.tenant_id, target.alias])).rowCount) block('active_delivery');
    if ((await client.query(`SELECT 1 FROM jobs WHERE tenant_id=$1 AND status NOT IN ('done','failed','cancelled')
      AND (payload->>'alias'=$2 OR payload->>'recipient_alias'=$2
        OR (kind='system.context.write.quarantine.v1' AND payload->>'alias' IS NULL)) LIMIT 1`, [target.tenant_id, target.alias])).rowCount) block('active_context_job');
    let facts: LegacyAdoptionFacts;
    try {
      await assertLegacySupervisorFence(fence, [target]);
      const measured = await fence.measure(target);
      if (measured && typeof measured === 'object' && 'supervisor_fenced' in measured && measured.supervisor_fenced !== true) {
        block('supervisor_not_fenced'); continue;
      }
      const parsed = LegacyAdoptionFactsSchema.safeParse(measured);
      if (!parsed.success) { block('facts_unavailable'); continue; }
      facts = parsed.data;
    } catch (error) { block(error instanceof LegacyAdoptionError ? 'supervisor_not_fenced' : 'facts_unavailable'); continue; }
    if (facts.target.tenant_id !== target.tenant_id || facts.target.alias !== target.alias
      || facts.runtime_key !== agent.runtime_key || facts.harness_id !== agent.harness_id) block('runtime_identity_changed');
    const before = Object.fromEntries(LEGACY_ADOPTION_FIELDS.map(field => [field, agent[field]])) as LegacyAdoptionValues;
    const desired = legacyAdoptionDesired(facts); const patch: Partial<LegacyAdoptionValues> = {};
    for (const field of LEGACY_ADOPTION_FIELDS) {
      const observed = desired[field];
      if (field === 'primary_account_id' && observed === null) continue;
      if (before[field] !== null && before[field] !== observed) block('contradictory_field', field);
      else if (before[field] === null && observed !== null) patch[field] = observed;
    }
    if (facts.primary_account_id !== null) {
      const account = (await client.query(`SELECT 1 FROM provider_accounts WHERE id=$1 AND enabled AND provider=$3
        AND ${providerAccountConsentSql('provider_accounts', '$2')} FOR SHARE`, [facts.primary_account_id, target.tenant_id, facts.account_provider])).rowCount;
      if (account !== 1) block('account_not_authorized');
    }
    const after = { ...before, ...patch };
    const placementCount = [after.container_name, after.runtime_user, after.home_directory, after.state_directory].filter(value => value !== null).length;
    if (![0, 4].includes(placementCount)) {
      const constraint = await client.query(`SELECT 1 FROM pg_constraint WHERE conrelid='agents'::regclass
        AND conname='agents_placement_atomic'`);
      if (constraint.rowCount) block('legacy_placement_unrepresentable');
    }
    rows.push({ target, runtime_key: agent.runtime_key, before, patch,
      guard_sha256: sha256Hex({ agent, members, baseline }), facts_sha256: sha256Hex(facts) });
  }
  try { await assertLegacySupervisorFence(fence, targets); }
  catch { for (const target of targets) blockers.push({ target, code: 'supervisor_not_fenced' }); }
  return { rows, blockers };
}
