import { AgentEmissionRepository } from './agent-emission.js';
import { StoreError } from './errors.js';

/* A digest identifies bytes but does not authorize access across tenants. */

export interface BlobRecord {
  readonly sha256: string;
  readonly bytes: number;
  readonly media_type: string;
  readonly name: string;
  readonly tenant_id: string;
  readonly created_by: string;
  readonly created_at: Date;
  readonly last_used_at: Date;
}

export interface BlobRegistration {
  readonly sha256: string;
  readonly bytes: number;
  readonly mediaType: string;
  readonly name: string;
  readonly tenantId: string;
  readonly createdBy: string;
}

const HEX_SHA256 = /^[a-f0-9]{64}$/u;

interface BlobRow {
  sha256: string;
  bytes: string | number;
  media_type: string;
  name: string;
  tenant_id: string;
  created_by: string;
  created_at: Date;
  last_used_at: Date;
}

function record(row: BlobRow): BlobRecord {
  return { ...row, bytes: Number(row.bytes) };
}

export class BlobsRepository extends AgentEmissionRepository {
  /** Idempotent within a tenant; the first uploader keeps the authorship. */
  async registerBlob(input: BlobRegistration): Promise<BlobRecord> {
    if (!HEX_SHA256.test(input.sha256)) throw new StoreError('invalid_input', 'blob digest must be sha256 hex');
    if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
      throw new StoreError('invalid_input', 'blob size must be a positive integer');
    }
    const result = await this.pool.query<BlobRow>(
      `INSERT INTO blobs(sha256,bytes,media_type,name,tenant_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (tenant_id,sha256) DO UPDATE SET last_used_at=now()
         WHERE blobs.bytes=EXCLUDED.bytes
       RETURNING sha256,bytes,media_type,name,tenant_id,created_by,created_at,last_used_at`,
      [input.sha256, input.bytes, input.mediaType, input.name, input.tenantId, input.createdBy],
    );
    const row = result.rows[0];
    if (row === undefined) throw new StoreError('conflict', 'blob digest is unavailable');
    return record(row);
  }

  async findBlob(sha256: string, tenantId: string, alias: string): Promise<BlobRecord | undefined> {
    if (!HEX_SHA256.test(sha256)) return undefined;
    const result = await this.pool.query<BlobRow>(
      `WITH entitled AS (
         SELECT candidate.owner_tenant_id
         FROM (
           SELECT blob.tenant_id AS owner_tenant_id, 0 AS priority
           FROM blobs blob WHERE blob.tenant_id=$2 AND blob.sha256=$1
           UNION ALL
           SELECT grant_row.owner_tenant_id, 1 AS priority
           FROM blob_delivery_grants grant_row
           WHERE grant_row.target_tenant_id=$2 AND grant_row.target_alias=$3
             AND grant_row.sha256=$1
         ) candidate
         ORDER BY candidate.priority, candidate.owner_tenant_id
         LIMIT 1
       )
       UPDATE blobs blob SET last_used_at=now()
       FROM entitled
       WHERE blob.tenant_id=entitled.owner_tenant_id AND blob.sha256=$1
       RETURNING blob.sha256,blob.bytes,blob.media_type,blob.name,blob.tenant_id,
                 blob.created_by,blob.created_at,blob.last_used_at`,
      [sha256, tenantId, alias],
    );
    const row = result.rows[0];
    return row === undefined ? undefined : record(row);
  }

  async staleBlobs(unusedSince: Date, limit: number): Promise<BlobRecord[]> {
    const result = await this.pool.query<BlobRow>(
      `SELECT sha256,bytes,media_type,name,tenant_id,created_by,created_at,last_used_at
       FROM blobs WHERE last_used_at<$1 ORDER BY last_used_at ASC LIMIT $2`,
      [unusedSince, Math.max(1, Math.min(1000, Math.trunc(limit)))],
    );
    return result.rows.map(record);
  }

  async forgetBlob(sha256: string, tenantId: string): Promise<boolean> {
    if (!HEX_SHA256.test(sha256)) return false;
    const result = await this.pool.query(
      `DELETE FROM blobs blob WHERE blob.sha256=$1 AND blob.tenant_id=$2
         AND NOT EXISTS (
           SELECT 1 FROM blob_delivery_grants grant_row
           WHERE grant_row.owner_tenant_id=blob.tenant_id AND grant_row.sha256=blob.sha256
         )`,
      [sha256, tenantId],
    );
    return (result.rowCount ?? 0) > 0;
  }
}
