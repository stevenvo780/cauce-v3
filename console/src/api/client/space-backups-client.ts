import type { RequestFn } from './system-client';

export const MAX_SPACE_BACKUP_BYTES = 16 * 1024 * 1024 * 1024 + 8 * 1024 * 1024 + 64 * 1024 * 1024;
export interface SpaceBackupTarget { company_id: string; tenant_id: string; alias: string }
export interface SpaceBackupFailure { type: string; message: string; stage: 'runtime' | 'local' | 'worker' }
export interface SpaceBackup extends SpaceBackupTarget {
  id: string; status: 'pending' | 'running' | 'ready' | 'failed'; sha256: string | null; manifest_sha256: string | null;
  created_at: string; expires_at: string;
  bytes: number | null; error: 'HOST_UNAVAILABLE' | 'SCOPE_CHANGED' | 'EXPORT_FAILED' | 'LIMIT_EXCEEDED' | 'EXPIRED' | null; download_url: string | null;
  failure?: SpaceBackupFailure;
}
export interface SpaceBackupsClient {
  createSpaceBackup(target: SpaceBackupTarget, idempotencyKey: string, signal?: AbortSignal): Promise<SpaceBackup>;
  getSpaceBackup(target: SpaceBackupTarget, id: string, signal?: AbortSignal): Promise<SpaceBackup>;
  listSpaceBackups(target: SpaceBackupTarget, signal?: AbortSignal): Promise<SpaceBackup[]>;
  deleteSpaceBackup(target: SpaceBackupTarget, id: string, signal?: AbortSignal): Promise<void>;
  spaceBackupDownloadUrl(backup: SpaceBackup): string;
  downloadSpaceBackup(backup: SpaceBackup, signal: AbortSignal): Promise<ReadableStream<Uint8Array>>;
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
const HASH = /^[a-f0-9]{64}$/u;
const KEYS = ['id', 'company_id', 'tenant_id', 'alias', 'status', 'sha256', 'manifest_sha256', 'bytes', 'error', 'download_url', 'created_at', 'expires_at'];
const timestamp = (value: unknown): value is string => typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/u.test(value) && Number.isFinite(Date.parse(value));
function invalid(): never { throw new Error('No se pudo verificar el backup de este espacio. Relee su estado.'); }
function path(target: SpaceBackupTarget): string {
  if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(target.company_id) || !/^[A-Za-z][A-Za-z0-9_-]{0,63}$/u.test(target.tenant_id)
    || !/^[a-z][a-z0-9_-]{0,63}$/u.test(target.alias)) invalid();
  return `/v3/console/spaces/${encodeURIComponent(target.tenant_id)}/${encodeURIComponent(target.alias)}/backups`;
}
function backupId(id: string): string { if (!UUID.test(id)) invalid(); return id; }
function validFailure(value: unknown): value is SpaceBackupFailure {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const failure = value as Record<string, unknown>;
  return Object.keys(failure).length === 3 && Object.keys(failure).every(key => ['type', 'message', 'stage'].includes(key))
    && typeof failure.type === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/u.test(failure.type)
    && typeof failure.message === 'string' && failure.message.length > 0 && failure.message.length <= 384
    && !/[\p{Cc}\p{Cf}]/u.test(failure.message)
    && typeof failure.stage === 'string' && ['runtime', 'local', 'worker'].includes(failure.stage);
}
export function spaceBackupReceipt(value: unknown, target: SpaceBackupTarget, expectedId?: string): SpaceBackup {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  const row = value as Record<string, unknown>; const base = path(target);
  if (Object.keys(row).filter(key => key !== 'failure').length !== KEYS.length || Object.keys(row).some(key => !KEYS.includes(key) && key !== 'failure')
    || typeof row.id !== 'string' || !UUID.test(row.id) || expectedId !== undefined && row.id !== expectedId
    || row.company_id !== target.company_id || row.tenant_id !== target.tenant_id || row.alias !== target.alias
    || !timestamp(row.created_at) || !timestamp(row.expires_at) || Date.parse(row.expires_at) <= Date.parse(row.created_at)
    || typeof row.status !== 'string' || !['pending', 'running', 'ready', 'failed'].includes(row.status)
    || ![row.sha256, row.manifest_sha256].every(value => value === null || typeof value === 'string' && HASH.test(value))
    || row.bytes !== null && !(typeof row.bytes === 'number' && Number.isSafeInteger(row.bytes) && row.bytes > 0 && row.bytes <= MAX_SPACE_BACKUP_BYTES)
    || row.error !== null && !(typeof row.error === 'string' && ['HOST_UNAVAILABLE', 'SCOPE_CHANGED', 'EXPORT_FAILED', 'LIMIT_EXCEEDED', 'EXPIRED'].includes(row.error))
    || row.failure !== undefined && (row.status !== 'failed' || !['EXPORT_FAILED', 'LIMIT_EXCEEDED'].includes(String(row.error)) || !validFailure(row.failure))) invalid();
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
    listSpaceBackups: async (target, signal) => {
      const value = await request<unknown>(path(target), { cache: 'no-store', signal });
      if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 1 || !('backups' in value) || !Array.isArray(value.backups)) invalid();
      const backups = value.backups.map((row: unknown) => spaceBackupReceipt(row, target));
      if (new Set(backups.map(row => row.id)).size !== backups.length) invalid();
      return backups;
    },
    deleteSpaceBackup: async (target, id, signal) => {
      await request(`${path(target)}/${backupId(id)}`, { method: 'DELETE', body: JSON.stringify({ confirm: true }), signal });
    },
    spaceBackupDownloadUrl: backup => {
      const receipt = spaceBackupReceipt(backup, backup, backup.id); if (receipt.status !== 'ready') invalid();
      return `${baseUrl}${path(receipt)}/${backupId(receipt.id)}/download`;
    },
    downloadSpaceBackup: async (backup, signal) => {
      const receipt = spaceBackupReceipt(backup, backup, backup.id); if (receipt.status !== 'ready') invalid();
      const response = await request<Response>(`${path(receipt)}/${backupId(receipt.id)}/download`, { cache: 'no-store', signal },
        { responseMode: 'stream' });
      const declared = response.headers.get('content-length');
      if (!response.body || declared !== null && declared !== String(receipt.bytes)) { await response.body?.cancel(); invalid(); }
      return response.body;
    },
  };
}
