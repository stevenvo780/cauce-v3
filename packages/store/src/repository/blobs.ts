import { QuotasRepository } from './quotas.js';
import { StoreError } from './errors.js';

/* The index of the gateway's blob store (migration 042). A digest is a capability: whoever names
   it may read it, tenant or not, because the message that carried it already crossed that edge.
   `last_used_at` moves on every read so a purge can tell abandoned bytes from live ones. */

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

export class BlobsRepository extends QuotasRepository {
  /** Idempotent for the same digest and size; the first uploader keeps the authorship. */
  async registerBlob(input: BlobRegistration): Promise<BlobRecord> {
    if (!HEX_SHA256.test(input.sha256)) throw new StoreError('invalid_input', 'blob digest must be sha256 hex');
    if (!Number.isSafeInteger(input.bytes) || input.bytes <= 0) {
      throw new StoreError('invalid_input', 'blob size must be a positive integer');
    }
    const result = await this.pool.query<BlobRow>(
      `INSERT INTO blobs(sha256,bytes,media_type,name,tenant_id,created_by)
       VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (sha256) DO UPDATE SET last_used_at=now()
       RETURNING sha256,bytes,media_type,name,tenant_id,created_by,created_at,last_used_at`,
      [input.sha256, input.bytes, input.mediaType, input.name, input.tenantId, input.createdBy],
    );
    const row = result.rows[0];
    if (row === undefined) throw new Error('blob registration returned no row');
    if (Number(row.bytes) !== input.bytes) {
      throw new StoreError('conflict', 'a blob with this digest already exists with another size');
    }
    return record(row);
  }

  async findBlob(sha256: string): Promise<BlobRecord | undefined> {
    if (!HEX_SHA256.test(sha256)) return undefined;
    const result = await this.pool.query<BlobRow>(
      `UPDATE blobs SET last_used_at=now() WHERE sha256=$1
       RETURNING sha256,bytes,media_type,name,tenant_id,created_by,created_at,last_used_at`,
      [sha256],
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

  async forgetBlob(sha256: string): Promise<boolean> {
    if (!HEX_SHA256.test(sha256)) return false;
    const result = await this.pool.query('DELETE FROM blobs WHERE sha256=$1', [sha256]);
    return (result.rowCount ?? 0) > 0;
  }
}
