import type { DatabaseClient } from './db.js';
import { assertPlatformAdmin, COMPANY_ID_PATTERN, lockPlatformConfiguration, type CompanyAuthority } from './company-authority.js';
import { StoreError } from './repository/errors.js';

export interface CompanyPurgeBlocker { kind: string; id: string; [key: string]: unknown }
export interface CompanyPurgeSnapshot {
  format: 'cauce-company-purge'; version: 1; company_id: string; captured_at: string;
  records: Record<string, Record<string, unknown>[]>;
}
export interface CompanyPurgeReceipt {
  company_id: string; deletion: 'purged'; backup_path: string; deleted_rows: Record<string, number>;
}
export class CompanyPurgeBlockedError extends StoreError {
  constructor(readonly blockers: CompanyPurgeBlocker[]) {
    super('conflict', 'company still has physical resources or references owned by another company');
    this.name = 'CompanyPurgeBlockedError';
  }
}

/** Persist serializedSnapshot verbatim to preserve PostgreSQL numeric precision before deleting in the caller's transaction. */
export async function purgeCompany(
  client: DatabaseClient, authority: CompanyAuthority, company: string, input: { confirmation: string },
  saveBackup: (snapshot: CompanyPurgeSnapshot, serializedSnapshot: string) => Promise<string>,
): Promise<CompanyPurgeReceipt> {
  assertPlatformAdmin(authority);
  if (!COMPANY_ID_PATTERN.test(company) || input.confirmation !== company) {
    throw new StoreError('invalid_input', 'confirmation must match the company identifier');
  }
  await lockPlatformConfiguration(client);
  try {
    const prepared = (await client.query<{ snapshot: CompanyPurgeSnapshot; snapshot_json: string; snapshot_hash: string; blockers: CompanyPurgeBlocker[] }>(
      'SELECT snapshot,snapshot::text AS snapshot_json,snapshot_hash,blockers FROM cauce_prepare_company_purge($1,$2)', [company, authority.humanId],
    )).rows[0];
    if (!prepared) throw new StoreError('not_found', 'company is unavailable');
    if (prepared.blockers.length > 0) throw new CompanyPurgeBlockedError(prepared.blockers);
    const backupPath = await saveBackup(prepared.snapshot, prepared.snapshot_json);
    if (backupPath.trim().length === 0) throw new StoreError('invalid_input', 'a durable company backup is required');
    const row = (await client.query<{ deleted_rows: Record<string, number> }>(
      'SELECT cauce_purge_company($1,$2,$3,$4,$5) AS deleted_rows',
      [company, authority.humanId, input.confirmation, backupPath, prepared.snapshot_hash],
    )).rows[0];
    if (!row) throw new StoreError('conflict', 'company purge has no durable receipt');
    return { company_id: company, deletion: 'purged', backup_path: backupPath, deleted_rows: row.deleted_rows };
  } catch (error) {
    if (error instanceof StoreError) throw error;
    const code = error !== null && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code === '42501') throw new StoreError('forbidden', 'platform administrator authority is required');
    if (code === 'P0002') throw new StoreError('not_found', 'company is unavailable');
    if (code === '22023') throw new StoreError('invalid_input', 'invalid company purge confirmation');
    if (code === '55000' || code === '23503' || code === '40P01' || code === '55P03' || code === '40001') {
      throw new StoreError('conflict', 'company must be retired and have no physical resources or foreign references');
    }
    throw error;
  }
}
