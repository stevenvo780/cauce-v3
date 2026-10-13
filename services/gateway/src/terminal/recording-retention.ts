/**
 * Poda automática de grabaciones TUI (T014a/FR-012, decisión del dueño: 30 días).
 * Las grabaciones las escribe el terminal-relay en `CAUCE_TERMINAL_RECORDING_DIR` como
 * `<session_id>.cast` (0700/0600, tope por sesión); este sweeper sólo borra dentro de ese
 * directorio los `.cast` regulares de primer nivel con mtime más antiguo que la retención.
 * Es idempotente y fail-closed: si el directorio no existe o no se puede leer, no hace
 * nada y lo registra; jamás sigue symlinks ni baja a subdirectorios.
 */
import { lstat, readdir, stat, unlink } from 'node:fs/promises';
import { join } from 'node:path';

export const RECORDING_RETENTION_MS = 30 * 24 * 3_600_000;
const RECORDING_FILE_SUFFIX = '.cast';

interface RecordingSweepOptions {
  readonly retentionMs?: number;
  readonly now?: () => number;
  readonly log?: (message: string) => void;
}

interface RecordingSweepResult {
  readonly deleted: readonly string[];
  readonly kept: readonly string[];
}

function isPlainCastName(name: string): boolean {
  return name.endsWith(RECORDING_FILE_SUFFIX)
    && name.length > RECORDING_FILE_SUFFIX.length
    && !name.includes('/') && !name.includes('\\') && name !== '.' && name !== '..';
}

export async function sweepOldRecordings(
  directory: string,
  options: RecordingSweepOptions = {},
): Promise<RecordingSweepResult> {
  const retentionMs = options.retentionMs ?? RECORDING_RETENTION_MS;
  const now = options.now ?? Date.now;
  const log = options.log ?? ((message: string): void => { console.warn(message); });
  const deleted: string[] = [];
  const kept: string[] = [];

  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch {
    log(`sweepOldRecordings: directorio de grabaciones no legible, no se hace nada: ${directory}`);
    return { deleted, kept };
  }

  const nowMs = now();
  for (const name of entries) {
    const path = join(directory, name);
    if (!isPlainCastName(name)) {
      kept.push(path);
      continue;
    }
    let entry: Awaited<ReturnType<typeof lstat>>;
    try {
      entry = await lstat(path);
    } catch {
      continue;
    }
    if (!entry.isFile() || entry.isSymbolicLink()) {
      kept.push(path);
      continue;
    }
    let mtimeMs: number;
    try {
      mtimeMs = (await stat(path)).mtimeMs;
    } catch {
      continue;
    }
    if (nowMs - mtimeMs <= retentionMs) {
      kept.push(path);
      continue;
    }
    try {
      await unlink(path);
      deleted.push(path);
    } catch {
      // A concurrent removal is idempotent.
    }
  }
  return { deleted, kept };
}
