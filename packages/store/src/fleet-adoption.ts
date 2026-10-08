import { sha256Hex } from '@cauce/protocol';
import { withTransaction, type DatabaseClient, type DatabasePool } from './db.js';
import { assertFleetAuthority, lockFleetRevision } from './repository/fleet-operation-authority.js';
import { assertFleetHumanAuthority } from './repository/fleet-operation-human.js';
import { LEGACY_ADOPTION_FIELDS, LegacyAdoptionError, LegacyAdoptionPreviewSchema, LegacyAdoptionTargetsSchema,
  type LegacyAdoptionActor, type LegacyAdoptionFence, type LegacyAdoptionPreview, type LegacyAdoptionProbe,
  type LegacyAdoptionTarget } from './fleet-adoption-contracts.js';
import { assertLegacySupervisorFence, legacyAdoptionSnapshot, lockLegacyAdoptionTargets } from './fleet-adoption-snapshot.js';

async function authority(client: DatabaseClient, actor: LegacyAdoptionActor, targets: readonly LegacyAdoptionTarget[]) {
  await actor.authorize(client);
  if (!actor.subject.startsWith('console:') && actor.subject !== 'system:legacy-fleet-installer') throw new LegacyAdoptionError('forbidden');
  if (actor.subject.startsWith('console:')) await assertFleetHumanAuthority(client, actor.tenant_id, actor.alias, actor.subject);
  for (const target of targets) await assertFleetAuthority(client, actor.tenant_id, actor.alias, { resource: 'agent', ...target });
}
async function preview(client: DatabaseClient, actor: LegacyAdoptionActor, targets: LegacyAdoptionTarget[],
  fence: LegacyAdoptionFence, expectedRevision?: number): Promise<LegacyAdoptionPreview> {
  await client.query("SET LOCAL lock_timeout='5000ms'");
  const revision = await lockFleetRevision(client, expectedRevision);
  await authority(client, actor, targets);
  await lockLegacyAdoptionTargets(client, targets);
  const snapshot = await legacyAdoptionSnapshot(client, targets, fence);
  const body = { revision, targets, ...snapshot, can_apply: snapshot.blockers.length === 0 };
  return { ...body, plan_sha256: sha256Hex(body) };
}
function targetsFor(input: unknown) {
  const parsed = LegacyAdoptionTargetsSchema.safeParse(input);
  if (!parsed.success) throw new LegacyAdoptionError('invalid_input');
  return parsed.data.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}
export async function previewLegacyFleetAdoption(pool: DatabasePool, actor: LegacyAdoptionActor,
  targets: unknown, probe: LegacyAdoptionProbe): Promise<LegacyAdoptionPreview> {
  const scope = targetsFor(targets);
  return probe.withSupervisorFence(scope, fence => withTransaction(pool, client => preview(client, actor, scope, fence)));
}
export async function applyLegacyFleetAdoption(pool: DatabasePool, actor: LegacyAdoptionActor,
  input: unknown, probe: LegacyAdoptionProbe) {
  const parsed = LegacyAdoptionPreviewSchema.safeParse(input);
  if (!parsed.success) throw new LegacyAdoptionError('invalid_input');
  const expected = parsed.data; const { plan_sha256, ...body } = expected;
  if (sha256Hex(body) !== plan_sha256 || !expected.can_apply || expected.blockers.length) throw new LegacyAdoptionError('conflict', expected.blockers);
  const targets = targetsFor(expected.targets);
  return probe.withSupervisorFence(targets, fence => withTransaction(pool, async client => {
    const current = await preview(client, actor, targets, fence, expected.revision);
    if (!current.can_apply) throw new LegacyAdoptionError('conflict', current.blockers);
    if (current.plan_sha256 !== expected.plan_sha256) throw new LegacyAdoptionError('conflict');
    for (const row of current.rows) {
      const fields = LEGACY_ADOPTION_FIELDS.filter(field => Object.hasOwn(row.patch, field));
      if (!fields.length) continue;
      if (fields.some(field => row.before[field] !== null || row.patch[field] == null)) throw new LegacyAdoptionError('conflict');
      const result = await client.query(`UPDATE agents SET ${fields.map((field, index) => `${field}=$${String(index + 3)}`).join(',')},
        updated_at=clock_timestamp() WHERE tenant_id=$1 AND alias=$2 AND runtime_key=$${String(fields.length + 3)}
        AND ${fields.map(field => `${field} IS NULL`).join(' AND ')}`,
      [row.target.tenant_id, row.target.alias, ...fields.map(field => row.patch[field]), row.runtime_key]);
      if (result.rowCount !== 1) throw new LegacyAdoptionError('conflict');
    }
    await assertLegacySupervisorFence(fence, targets); await authority(client, actor, targets);
    const changed = current.rows.filter(row => Object.keys(row.patch).length > 0);
    if (changed.length === 0) return { applied: false, revision: current.revision, state: 'configuration_backfilled' as const, plan_sha256 };
    const revision = (await client.query<{ id: string }>(`INSERT INTO config_revisions(actor_tenant,actor_alias,operation,inverse_operation,summary)
      VALUES($1,$2,$3::jsonb,$4::jsonb,'Legacy fleet metadata backfill') RETURNING id::text`,
    [actor.tenant_id, actor.alias, JSON.stringify({ resource: 'fleet_legacy_adoption', action: 'backfill', rows: changed }),
      JSON.stringify({ resource: 'fleet_legacy_adoption', action: 'restore', rows: changed.map(row => ({ target: row.target, before: row.patch, restore: row.before })) })])).rows[0];
    if (!revision) throw new LegacyAdoptionError('unavailable');
    await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,metadata)
      VALUES($1,$2,'fleet.legacy_metadata_adopted','allow',$3::jsonb)`, [actor.tenant_id, actor.alias,
      JSON.stringify({ actor_subject: actor.subject, revision: Number(revision.id), plan_sha256,
        rows: changed.map(row => ({ target: row.target, runtime_key: row.runtime_key,
          fields: Object.keys(row.patch), facts_sha256: row.facts_sha256, guard_sha256: row.guard_sha256 })) })]);
    await assertLegacySupervisorFence(fence, targets);
    return { applied: true, revision: Number(revision.id), state: 'configuration_backfilled' as const, plan_sha256 };
  }));
}
