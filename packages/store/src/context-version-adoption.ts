import { ContextAdoptionEvidenceSchema, HarnessConsumptionEvidenceSchema, type VersionedContext } from '@cauce/protocol';
import type { DatabaseClient } from './db.js';
import { canonicalContextFiles } from './context-version-model.js';
import { lockContextTarget, readContextVersion } from './context-version.js';

export async function versionedContextForDelivery(client: DatabaseClient, tenant: string, alias: string,
  ids: readonly string[]): Promise<VersionedContext | undefined> {
  const row = (await client.query<{ company_id: string; desired_version: string }>(
    `SELECT current.company_id,current.desired_version FROM agent_context_state current JOIN tenants tenant ON tenant.id=current.tenant_id
    WHERE current.tenant_id=$1 AND current.alias=$2 AND current.company_id=tenant.company_id AND current.desired_version>0`, [tenant, alias])).rows[0];
  if (!row || ids.length === 0) return undefined;
  const target = { company_id: row.company_id, tenant_id: tenant, alias };
  const version = await readContextVersion(client, target, Number(row.desired_version));
  await client.query(`UPDATE deliveries SET context_version=$3,context_digest=$4
    WHERE recipient_tenant=$1 AND recipient_alias=$2 AND id=ANY($5::uuid[])`, [tenant, alias, version.version, version.digest, ids]);
  return { ...target, version: version.version, digest: version.digest, files: canonicalContextFiles(version.files) };
}
export async function recordContextAdoptionInTransaction(client: DatabaseClient, input: {
  readonly deliveryId: string; readonly tenantId: string; readonly alias: string; readonly result: Record<string, unknown> | undefined;
}): Promise<boolean> {
  const adoption = ContextAdoptionEvidenceSchema.safeParse(input.result?.context_adoption);
  const consumed = HarnessConsumptionEvidenceSchema.safeParse(input.result?.harness_consumption_v1);
  if (!adoption.success || !consumed.success || adoption.data.input_sha256 !== consumed.data.input_sha256) return false;
  const expected = (await client.query<{ company_id: string; context_version: string; context_digest: string }>(
    `SELECT tenant.company_id,delivery.context_version,delivery.context_digest FROM deliveries delivery
      JOIN tenants tenant ON tenant.id=delivery.recipient_tenant WHERE delivery.id=$1 AND delivery.recipient_tenant=$2
      AND delivery.recipient_alias=$3 AND delivery.status='done'`, [input.deliveryId, input.tenantId, input.alias])).rows[0];
  if (!expected || Number(expected.context_version) !== adoption.data.version || expected.context_digest !== adoption.data.digest) return false;
  const target = { company_id: expected.company_id, tenant_id: input.tenantId, alias: input.alias };
  await lockContextTarget(client, target);
  const changed = await client.query(`UPDATE agent_context_state SET applied_version=$4,applied_digest=$5,applied_at=clock_timestamp()
    WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND applied_version<$4 AND desired_version>=$4`,
  [target.company_id, input.tenantId, input.alias, adoption.data.version, adoption.data.digest]);
  await client.query(`UPDATE agent_context_outbox SET applied_at=clock_timestamp(),apply_error=NULL
    WHERE company_id=$1 AND tenant_id=$2 AND alias=$3 AND version=$4`, [target.company_id, input.tenantId, input.alias, adoption.data.version]);
  if (changed.rowCount === 1) await client.query(`INSERT INTO audit_events(tenant_id,actor_alias,action,decision,company_id,metadata)
    VALUES($1,$2,'context.adopted','allow',$3,$4::jsonb)`, [input.tenantId, input.alias, target.company_id,
    JSON.stringify({ delivery_id: input.deliveryId, version: adoption.data.version, digest: adoption.data.digest,
      harness: consumed.data.harness_id, native_turn_id: consumed.data.native_turn_id })]);
  return changed.rowCount === 1;
}
