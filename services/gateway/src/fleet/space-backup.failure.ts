import { z } from 'zod';
import type { DatabaseClient, SpaceBackupRow } from '@cauce/store';
import { redactExecutorStderr } from './host-stderr.js';

export const SpaceBackupFailureSchema = z.object({
  type: z.string().regex(/^[A-Za-z][A-Za-z0-9]{0,63}$/u),
  message: z.string().min(1).max(384),
  stage: z.enum(['runtime', 'local', 'worker']),
}).strict();
export type SpaceBackupFailure = z.infer<typeof SpaceBackupFailureSchema>;
const HelperFailure = z.object({ event: z.literal('space_backup_failure'),
  cause_type: z.string().max(64), cause_message: z.string().max(1024),
  stage: z.enum(['runtime', 'local']),
}).strict();
const FAILURE_TYPES = new Set(['Error', 'SafeFailure', 'SpaceArchiveFailure', 'LimitExceeded', 'OSError', 'ValueError',
  'TypeError', 'KeyError', 'RuntimeError', 'PermissionError', 'FileNotFoundError', 'NotADirectoryError', 'IsADirectoryError',
  'TimeoutError', 'TimeoutExpired', 'SubprocessError', 'CalledProcessError', 'BadZipFile', 'ZodError']);

export function safeBackupFailure(value: SpaceBackupFailure): SpaceBackupFailure {
  const message = redactExecutorStderr(value.message)
    .replace(/\b((?:pass(?:word|wd)?|secret|token|api[_-]?key)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s"',;]+)/giu, '$1[redacted]')
    .replace(/\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/giu, '[url]')
    .replace(/(?:[A-Za-z]:\\|~?\/)[^\s"'<>]*/gu, '[ruta]')
    .replace(/\b[^\s@]+@[^\s@]+\.[^\s@]+/gu, '[correo]')
    .replace(/[A-Za-z0-9_+/=-]{24,}/gu, '[redacted]')
    .replace(/[\p{Cc}\p{Cf}\s]+/gu, ' ').trim().slice(0, 384);
  return { type: FAILURE_TYPES.has(value.type) ? value.type : 'Error',
    message: message || 'Space backup failed without a verified diagnostic', stage: value.stage };
}

export function backupHelperFailure(stderr: string): SpaceBackupFailure | undefined {
  for (const line of stderr.split('\n').reverse()) {
    try {
      const result = HelperFailure.safeParse(JSON.parse(line) as unknown);
      if (result.success) return safeBackupFailure({ type: result.data.cause_type,
        message: result.data.cause_message, stage: result.data.stage });
    } catch { continue; }
  }
  return undefined;
}

export class SpaceBackupHelperError extends Error {
  constructor(readonly failure: SpaceBackupFailure) { super(`${failure.type}: ${failure.message}`); }
}

export function backupFailure(error: unknown): SpaceBackupFailure {
  if (error instanceof SpaceBackupHelperError) return safeBackupFailure(error.failure);
  return safeBackupFailure({ type: error instanceof Error ? error.name : 'Error',
    message: error instanceof Error ? error.message : 'Space backup failed without a verified diagnostic', stage: 'worker' });
}

export async function readBackupFailure(client: DatabaseClient, row: SpaceBackupRow): Promise<SpaceBackupFailure | undefined> {
  if (row.status !== 'failed' || !['EXPORT_FAILED', 'LIMIT_EXCEEDED'].includes(row.error ?? '')) return undefined;
  const event = (await client.query<{ failure: unknown }>(`SELECT metadata->'failure' AS failure FROM audit_events
    WHERE company_id=$1 AND tenant_id=$2 AND actor_alias=$3 AND action='space.backup.failed'
      AND metadata->>'id'=$4 AND metadata->>'host_id'=$5 AND metadata->>'claim_epoch'=$6
      AND metadata->>'error'=$7 AND metadata->>'component'='backup'
    ORDER BY created_at DESC,id DESC LIMIT 1`,
  [row.company_id, row.tenant_id, row.alias, row.id, row.host_id, String(row.claim_epoch), row.error])).rows[0];
  const parsed = SpaceBackupFailureSchema.safeParse(event?.failure);
  return parsed.success ? safeBackupFailure(parsed.data) : undefined;
}
