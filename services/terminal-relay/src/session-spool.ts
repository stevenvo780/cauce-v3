import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeSync
} from 'node:fs';
import { dirname } from 'node:path';
import {
  claimEpoch,
  isClaimToken,
  type SessionCloseReport,
} from './gateway-client.js';

export function loadCloseSpool(path: string | undefined, spooledReports: Map<string, SessionCloseReport>): void {
  if (path === undefined || !existsSync(path)) return;
  const raw = readFileSync(path, 'utf8');
  if (raw.trim().length === 0) return;
  const parsed: unknown = JSON.parse(raw);
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('terminal close report spool is invalid');
  }
  const document = parsed as Record<string, unknown>;
  const version = document.version;
  if ((version !== 1 && version !== 2) || !Array.isArray(document.reports)
      || document.reports.length > 10_000) {
    throw new Error('terminal close report spool has an unsupported shape');
  }
  if (version === 2 && (statSync(path).mode & 0o077) !== 0) {
    throw new Error('terminal close report spool containing claim fences must be mode 0600');
  }
  for (const item of document.reports) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) {
      throw new Error('terminal close report spool contains an invalid report');
    }
    const record = item as Record<string, unknown>;
    const rawClaimToken = record.claim_token;
    const rawClaimEpoch = record.claim_epoch;
    const hasClaim = rawClaimToken !== undefined || rawClaimEpoch !== undefined;
    if (typeof record.session_id !== 'string' || typeof record.reason !== 'string' ||
        (record.exit_code !== null &&
          (typeof record.exit_code !== 'number' || !Number.isSafeInteger(record.exit_code))) ||
        typeof record.bytes_in !== 'number' || !Number.isSafeInteger(record.bytes_in) || record.bytes_in < 0 ||
        typeof record.bytes_out !== 'number' || !Number.isSafeInteger(record.bytes_out) || record.bytes_out < 0 ||
        (version === 1 && hasClaim) ||
        (version === 2 && hasClaim
          && (!isClaimToken(rawClaimToken) || claimEpoch(rawClaimEpoch) === undefined))) {
      throw new Error('terminal close report spool contains invalid fields');
    }
    spooledReports.set(record.session_id, {
      reason: record.reason,
      exit_code: record.exit_code,
      bytes_in: record.bytes_in,
      bytes_out: record.bytes_out,
      ...(version === 2 && hasClaim
        ? { claim_token: rawClaimToken as string, claim_epoch: rawClaimEpoch as string }
        : {}),
    });
  }
}

/** Atomic, fsync'd snapshot. A duplicate after a crash is harmless because gateway close is idempotent. */
export function persistCloseSpool(path: string | undefined, spooledReports: Map<string, SessionCloseReport>): void {
  if (path === undefined) return;
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.tmp`;
  const body = Buffer.from(`${JSON.stringify({
    version: 2,
    reports: [...spooledReports].map(([session_id, report]) => ({ session_id, ...report }))
  })}\n`, 'utf8');
  try {
    unlinkSync(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  const descriptor = openSync(temporary, 'wx', 0o600);
  try {
    writeSync(descriptor, body);
    fsyncSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
  renameSync(temporary, path);
  // fsync of the temporary file makes its content durable, but not the directory entry created
  // by rename(2). Without syncing the directory, a power cut can return the spool to its
  // previous name/version and resurrect a phantom slot after restart.
  const directoryDescriptor = openSync(dirname(path), 'r');
  try {
    fsyncSync(directoryDescriptor);
  } finally {
    closeSync(directoryDescriptor);
  }
}
