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

export const RECORDING_RETENTION_MS = 30 * 24 * 3_600_1_000;
export const RECORDING_FILE_SUFFIX = '.cast';

export interface RecordingSweepOptions {
  /** Milisegundos de retención; por defecto 30 días. */
  readonly retentionMs?: number;
  /** Reloj inyectable para tests; por defecto Date.now. */
  readonly now?: () => number;
  /** Dónde se registra el no-op fail-closed; por defecto console.warn. */
  readonly log?: (message: string) => void;
}

export interface RecordingSweepResult {
  /** Rutas absolutas borradas en esta pasada. */
  readonly deleted: readonly string[];
  /** Rutas absolutas conservadas (dentro de retención o fuera de alcance). */
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
      // Idempotente: si otro sweeper o el relay ya lo quitó, no es un error.
    }
  }
  return { deleted, kept };
}

/** `CAUCE_TERMINAL_RECORDING_DIR` vacío o ausente significa "sin grabación, sin poda". */
export function recordingDirFromEnv(environment: NodeJS.ProcessEnv = process.env): string | undefined {
  const value = environment.CAUCE_TERMINAL_RECORDING_DIR?.trim();
  return value === undefined || value.length === 0 ? undefined : value;
}
