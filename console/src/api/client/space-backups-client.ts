import type { RequestFn } from './system-client';

export const MAX_SPACE_BACKUP_BYTES = 1024 * 1024 * 1024;
export interface SpaceBackupTarget { company_id: string; tenant_id: string; alias: string }
export interface SpaceBackup extends SpaceBackupTarget {
  id: string; status: 'pending' | 'running' | 'ready' | 'failed'; sha256: string | null; manifest_sha256: string | null;
  bytes: number | null; error: 'HOST_UNAVAILABLE' | 'SCOPE_CHANGED' | 'EXPORT_FAILED' | 'LIMIT_EXCEEDED' | 'EXPIRED' | null; download_url: string | null;
}
export interface SpaceBackupsClient {
  createSpaceBackup(target: SpaceBackupTarget, idempotencyKey: string, signal?: AbortSignal): Promise<SpaceBackup>;
  getSpaceBackup(target: SpaceBackupTarget, id: string, signal?: AbortSignal): Promise<SpaceBackup>;
  spaceBackupDownloadUrl(backup: SpaceBackup): string;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const KEYS = ['id', 'company_id', 'tenant_id', 'alias', 'status', 'sha256', 'manifest_sha256', 'bytes', 'error', 'download_url'];
function invalid(): never { throw new Error('No se pudo verificar el backup de este espacio. Relee su estado.'); }
function path(target: SpaceBackupTarget): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(target.company_id) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(target.tenant_id)
    || !/^[a-z][a-z0-9_-]{0,63}$/u.test(target.alias)) invalid();
  return `/v3/console/spaces/${encodeURIComponent(target.tenant_id)}/${encodeURIComponent(target.alias)}/backups`;
}
function backupId(id: string): string { if (!UUID.test(id)) invalid(); return id; }
export function spaceBackupReceipt(value: unknown, target: SpaceBackupTarget, expectedId?: string): SpaceBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>; const base = path(target);
  if (Object.keys(row).length !== KEYS.length || Object.keys(row).some(key => !KEYS.includes(key))
    || typeof row.id !== 'string' || !UUID.test(row.id) || expectedId !== undefined && row.id !== expectedId
    || row.company_id !== target.company_id || row.tenant_id !== target.tenant_id || row.alias !== target.alias
    || typeof row.status !== 'string' || !['pending', 'running', 'ready', 'failed'].includes(row.status)
    || ![row.sha256, row.manifest_sha256].every(value => value === null || typeof value === 'string' && HASH.test(value))
    || row.bytes !== null && !(typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX_SPACE_BACKUP_BYTES)
    || row.error !== null && !(typeof row.error === 'string' && ['HOST_UNAVAILABLE', 'SCOPE_CHANGED', 'EXPORT_FAILED', 'LIMIT_EXCEEDED', 'EXPIRED'].includes(row.error))) invalid();
  if (row.status === 'ready') {
    if (row.error !== null || row.sha256 === null || row.manifest_sha256 === null || row.bytes === null || row.download_url !== `${base}/${row.id}/download`) invalid();
  } else {
    if (row.download_url !== null || row.status === 'failed' && row.error === null || row.status !== 'failed' && row.error !== null) invalid();
    const metadata = [row.sha256, row.manifest_sha256, row.bytes];
    if (row.status === 'pending' && metadata.some(value => value !== null)
      || row.status === 'running' && metadata.some(value => value === null) && metadata.some(value => value !== null)) invalid();
  }
  return row as unknown as SpaceBackup;
}
export function spaceBackupsClient(request: RequestFn, baseUrl: string): SpaceBackupsClient {
  return {
    createSpaceBackup: async (target, idempotencyKey, signal) => {
      if (!/^[A-Za-z0-9_-]{8,128}$/u.test(idempotencyKey)) invalid();
      return spaceBackupReceipt(await request(path(target), { method: 'POST', body: JSON.stringify({ idempotency_key: idempotencyKey }), signal }), target);
    },
    getSpaceBackup: async (target, id, signal) => spaceBackupReceipt(await request(`${path(target)}/${backupId(id)}`, { cache: 'no-store', signal }), target, id),
    spaceBackupDownloadUrl: backup => {
      const receipt = spaceBackupReceipt(backup, backup, backup.id); if (receipt.status !== 'ready') invalid();
      return `${baseUrl}${path(receipt)}/${backupId(receipt.id)}/download`;
    },
  };
}
