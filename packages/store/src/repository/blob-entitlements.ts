import type { DatabaseClient } from '../db.js';
import { tenantReadableSql } from './acl-edges.js';

const HEX_SHA256 = /^[a-f0-9]{64}$/u;

export interface BlobDeliveryGrantInput {
  readonly sha256: string;
  readonly sourceTenant: string;
  readonly sourceAlias: string;
  readonly targetTenant: string;
  readonly targetAlias: string;
  readonly deliveryId: string;
}

export async function sourceCanReadBlob(
  client: DatabaseClient, tenant: string, alias: string, sha256: string,
): Promise<boolean> {
  if (!HEX_SHA256.test(sha256) || !tenant || !alias) return false;
  const owned = await client.query(
    `SELECT 1 FROM blobs WHERE tenant_id=$1 AND sha256=$2 LIMIT 1 FOR KEY SHARE`,
    [tenant, sha256],
  );
  if (owned.rowCount === 1) return true;
  const granted = await client.query(
    `SELECT 1 FROM blob_delivery_grants
     WHERE target_tenant_id=$1 AND target_alias=$2 AND sha256=$3
     LIMIT 1 FOR SHARE`,
    [tenant, alias, sha256],
  );
  return granted.rowCount === 1;
}

export async function grantBlobForDelivery(
  client: DatabaseClient,
  input: BlobDeliveryGrantInput,
): Promise<boolean> {
  if (!HEX_SHA256.test(input.sha256)
    || !input.sourceTenant || !input.sourceAlias || !input.targetTenant || !input.targetAlias) {
    return false;
  }
  const granted = await client.query<{ created: boolean; granted: boolean }>(
    `WITH owned AS MATERIALIZED (
       SELECT blob.tenant_id AS owner_tenant_id
       FROM blobs blob
       WHERE blob.tenant_id=$2 AND blob.sha256=$1
       FOR KEY SHARE OF blob
     ), prior AS MATERIALIZED (
       SELECT grant_row.owner_tenant_id
       FROM blob_delivery_grants grant_row
       WHERE grant_row.target_tenant_id=$2 AND grant_row.target_alias=$3
         AND grant_row.sha256=$1 AND NOT EXISTS(SELECT 1 FROM owned)
       ORDER BY grant_row.owner_tenant_id,grant_row.delivery_id
       LIMIT 1
       FOR SHARE OF grant_row
     ), owner AS MATERIALIZED (
       SELECT owner_tenant_id FROM owned
       UNION ALL
       SELECT owner_tenant_id FROM prior
     ), inserted AS (
       INSERT INTO blob_delivery_grants(
         delivery_id,sha256,owner_tenant_id,source_tenant_id,source_alias,
         target_tenant_id,target_alias
       )
       SELECT delivery.id,$1,owner.owner_tenant_id,$2,$3,$4,$5
       FROM owner
       JOIN deliveries delivery ON delivery.id=$6::uuid
         AND delivery.recipient_tenant=$4 AND delivery.recipient_alias=$5
       WHERE ${tenantReadableSql('$4::text', 'owner.owner_tenant_id')}
       ON CONFLICT (delivery_id,sha256) DO NOTHING
       RETURNING owner_tenant_id
     )
     SELECT EXISTS(SELECT 1 FROM inserted) AS created,
            EXISTS(SELECT 1 FROM inserted) OR EXISTS(
              SELECT 1 FROM blob_delivery_grants prior JOIN owner
                ON owner.owner_tenant_id=prior.owner_tenant_id
              WHERE prior.delivery_id=$6::uuid AND prior.sha256=$1
                AND prior.source_tenant_id=$2 AND prior.source_alias=$3
                AND prior.target_tenant_id=$4 AND prior.target_alias=$5
            ) AS granted`,
    [input.sha256, input.sourceTenant, input.sourceAlias,
      input.targetTenant, input.targetAlias, input.deliveryId],
  );
  if (granted.rows[0]?.created === true) {
    await client.query(
      `INSERT INTO audit_events(
         tenant_id,actor_alias,action,decision,delivery_id,metadata
       ) VALUES($1,$2,'blob.grant','allow',$3::uuid,
         jsonb_build_object(
           'sha256',$4::text,'source_tenant',$1::text,'source_alias',$2::text,
           'target_tenant',$5::text,'target_alias',$6::text
         ))`,
      [input.sourceTenant, input.sourceAlias, input.deliveryId,
        input.sha256, input.targetTenant, input.targetAlias],
    );
  }
  return granted.rows[0]?.granted === true;
}
