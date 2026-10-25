import { ContextAdoptionEvidenceSchema, HarnessConsumptionEvidenceSchema, type VersionedContext } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { lockContextTarget, readableContextVersion } from './context-version.js';
import type { ContextTarget } from './context-version-model.js';

async function nativeDescendant(client: DatabaseClient, target: ContextTarget, attached: number, attachedDigest: string,
  adopted: number, digest: string): Promise<boolean> {
  if (adopted <= attached) return false;
  const chain = (await client.query<{ length: string; own_native: boolean }>(`SELECT count(next.version)::text AS length,
    COALESCE(bool_and(next.source='native' AND next.actor_alias=$3 AND next.actor_human_id IS NULL),false) AS own_native
    FROM agent_context_state current JOIN agent_context_versions original USING(company_id,tenant_id,alias)
    JOIN agent_context_versions next ON (next.company_id,next.tenant_id,next.alias)=(current.company_id,current.tenant_id,current.alias)
      AND next.version>original.version AND next.version<=$5
    WHERE current.company_id=$1 AND current.tenant_id=$2 AND current.alias=$3 AND current.desired_version>=$5
      AND original.version=$4 AND original.digest=$6`,
  [target.company_id, target.tenant_id, target.alias, attached, adopted, attachedDigest])).rows[0];
  if (Number(chain?.length) !== adopted - attached || chain?.own_native !== true) return false;
  return (await readableContextVersion(client, target, adopted))?.digest === digest;
}

export async function versionedContextForDelivery(client: DatabaseClient, tenant: string, alias: string,
  ids: readonly string[]): Promise<VersionedContext | undefined> {
  const row = (await client.query<{ company_id: string; desired_version: string }>(
    `SELECT current.company_id,current.desired_version FROM agent_context_state current JOIN tenants tenant ON tenant.id=current.tenant_id
    WHERE current.tenant_id=$1 AND current.alias=$2 AND current.company_id=tenant.company_id AND current.desired_version>0`, [tenant, alias])).rows[0];
  if (!row || ids.length === 0) return undefined;
  const target = { company_id: row.company_id, tenant_id: tenant, alias };
  const version = await readableContextVersion(client, target, Number(row.desired_version));
  if (version === undefined) {
    // An unreadable version never aborts the claim: the delivery goes without context and the version shows why.
    await client.query(`UPDATE agent_context_outbox SET apply_error='context_version_unreadable'
      WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4 AND applied_at IS NULL`,
    [target.company_id, tenant, alias, Number(row.desired_version)]);
    return undefined;
  }
  await client.query(`UPDATE deliveries SET context_version=$3,context_digest=$4
    WHERE recipient_tenant=$1 AND recipient_alias=$2 AND id=ANY($5::uuid[])`, [tenant, alias, version.version, version.digest, ids]);
  return { ...target, version: version.version, digest: version.digest, files: [...version.files] };
}
export async function recordContextAdoptionInTransaction(client: DatabaseClient, input: {
  readonly deliveryId: string; readonly tenantId: string; readonly alias: string; readonly result: Record<string, unknown> | undefined;
}): Promise<boolean> {
  const adoption = ContextAdoptionEvidenceSchema.safeParse(input.result?.context_adoption);
  const consumed = HarnessConsumptionEvidenceSchema.safeParse(input.result?.harness_consumption_v1);
  if (!adoption.success || !consumed.success || adoption.data.input_sha256 !== consumed.data.input_sha256) return false;
  const expected = (await client.query<{ company_id: string; context_version: string | null; context_digest: string | null }>(
    `SELECT tenant.company_id,delivery.context_version,delivery.context_digest FROM deliveries delivery
      JOIN tenants tenant ON tenant.id=delivery.recipient_tenant WHERE delivery.id=$1 AND delivery.recipient_tenant=$2
      AND delivery.recipient_alias=$3 AND delivery.status='done'`, [input.deliveryId, input.tenantId, input.alias])).rows[0];
  if (!expected?.context_digest) return false;
  const attached = Number(expected.context_version);
  if (!Number.isSafeInteger(attached) || attached < 1) return false;
  const target = { company_id: expected.company_id, tenant_id: input.tenantId, alias: input.alias };
  await lockContextTarget(client, target);
  if ((attached !== adoption.data.version || expected.context_digest !== adoption.data.digest)
    && !await nativeDescendant(client, target, attached, expected.context_digest, adoption.data.version, adoption.data.digest)) return false;
  const changed = await client.query(`UPDATE agent_context_state SET applied_version=$4,applied_digest=$5,applied_at=clock_timestamp()
    WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND applied_version<$4 AND desired_version>=$4`,
  [target.company_id, input.tenantId, input.alias, adoption.data.version, adoption.data.digest]);
  await client.query(`UPDATE agent_context_outbox SET applied_at=clock_timestamp(),apply_error=NULL
    WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, [target.company_id, input.tenantId, input.alias, adoption.data.version]);
  if (changed.rowCount === 1) await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,metadata)
    VALUES($1,$2,'context.adopted','allow',$3,$4::jsonb)`, [input.tenantId, input.alias, target.company_id,
    JSON.stringify({ delivery_id: input.deliveryId, version: adoption.data.version, digest: adoption.data.digest,
      harness: consumed.data.harness_id, native_turn_id: consumed.data.native_turn_id,
      ...(adoption.data.version > attached ? { delivered_version: attached } : {}) })]);
  return changed.rowCount === 1;
}
