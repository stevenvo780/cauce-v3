import { randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import {
  ATOMIC_STATE_FILES,
  type AtomicArtifactKind,
  type AtomicStateFile,
  type DirectoryFsync,
  type UnsupportedDirectoryFsyncCode,
  UNSUPPORTED_DIRECTORY_FSYNC_CODES,
} from "./contracts.js";

const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);

export function clone<T>(value: T): T {
  return structuredClone(value);
}

export async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(fallback);
    throw error;
  }
}

function isUnsupportedDirectoryFsync(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code as UnsupportedDirectoryFsyncCode | undefined;
  return code !== undefined && (UNSUPPORTED_DIRECTORY_FSYNC_CODES as readonly string[]).includes(code);
}

export async function defaultDirectoryFsync(directory: FileHandle): Promise<void> {
  try {
    await directory.sync();
  } catch (error) {
    if (isUnsupportedDirectoryFsync(error)) return;
    throw error;
  }
}

async function copyRollbackFile(sourcePath: string, backupPath: string): Promise<boolean> {
  let source: FileHandle;
  try {
    source = await open(
      sourcePath,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  let backup: FileHandle | undefined;
  let backupExists = false;
  try {
    const before = await source.stat();
    const euid = process.geteuid?.();
    if (euid === undefined || !before.isFile() || before.uid !== euid
      || (before.mode & 0o777) !== 0o600 || before.nlink !== 1) {
      throw new Error("Atomic write target failed secure backup validation");
    }
    backup = await open(backupPath, "wx", 0o600);
    backupExists = true;
    await backup.chmod(0o600);
    const buffer = Buffer.alloc(64 * 1024);
    let sourcePosition = 0;
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, buffer.length, sourcePosition);
      if (bytesRead === 0) break;
      let written = 0;
      while (written < bytesRead) {
        const result = await backup.write(buffer, written, bytesRead - written, sourcePosition + written);
        if (result.bytesWritten <= 0) throw new Error("Atomic rollback backup write made no progress");
        written += result.bytesWritten;
      }
      sourcePosition += bytesRead;
    }
    const after = await source.stat();
    if (after.size !== before.size || sourcePosition !== before.size
      || after.dev !== before.dev || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs) {
      throw new Error("Atomic write target changed while creating rollback backup");
    }
    await backup.sync();
    return true;
  } catch (error) {
    await backup?.close().catch(() => undefined);
    backup = undefined;
    if (backupExists) await unlink(backupPath).catch(() => undefined);
    throw error;
  } finally {
    await backup?.close().catch(() => undefined);
    await source.close().catch(() => undefined);
  }
}

export async function atomicWrite(
  path: string,
  value: unknown,
  directoryFsync: DirectoryFsync = defaultDirectoryFsync,
): Promise<void> {
  const transaction = randomUUID();
  const temporary = `${path}.${transaction}.atomic-tmp`;
  const rollbackStaging = `${path}.${transaction}.atomic-backup-tmp`;
  const rollback = `${path}.${transaction}.atomic-backup`;
  const committedBackup = `${path}.${transaction}.atomic-committed`;
  const data = `${JSON.stringify(value)}\n`;
  let temporaryExists = false;
  let rollbackStagingExists = false;
  let rollbackExists = false;
  let committedBackupExists = false;
  let replacementVisible = false;
  let committed = false;
  let directory: FileHandle | undefined;
  try {
    const handle = await open(temporary, "wx", 0o600);
    temporaryExists = true;
    try {
      await handle.chmod(0o600);
      await handle.writeFile(data, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    directory = await open(
      dirname(path),
      fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
    );
    rollbackStagingExists = await copyRollbackFile(path, rollbackStaging);
    if (rollbackStagingExists) {
      await rename(rollbackStaging, rollback);
      rollbackStagingExists = false;
      rollbackExists = true;
    }

    // Persist the copied rollback image before the visible atomic rename.
    await directoryFsync(directory);
    await rename(temporary, path);
    temporaryExists = false;
    replacementVisible = true;
    try {
      await directoryFsync(directory);
      committed = true;
    } catch (commitError) {
      let rollbackError: unknown;
      try {
        if (rollbackExists) {
          await rename(rollback, path);
          rollbackExists = false;
        } else {
          await unlink(path);
        }
        replacementVisible = false;
        await directoryFsync(directory);
      } catch (error) {
        rollbackError = error;
      }
      if (rollbackError !== undefined) {
        throw new AggregateError(
          [commitError, rollbackError],
          "Directory fsync failed and the atomic write rollback could not be durably confirmed",
        );
      }
      throw commitError;
    }

    if (rollbackExists) {
      try {
        await rename(rollback, committedBackup);
        rollbackExists = false;
        committedBackupExists = true;
        await directoryFsync(directory);
      } catch (finalizeError) {
        let rollbackError: unknown;
        try {
          const availableBackup = committedBackupExists ? committedBackup : rollback;
          await rename(availableBackup, path);
          committedBackupExists = false;
          rollbackExists = false;
          replacementVisible = false;
          committed = false;
          await directoryFsync(directory);
        } catch (error) {
          rollbackError = error;
        }
        if (rollbackError !== undefined) {
          throw new AggregateError(
            [finalizeError, rollbackError],
            "Atomic write commit marker failed and rollback could not be durably confirmed",
          );
        }
        throw finalizeError;
      }
    }
  } finally {
    await directory?.close().catch(() => undefined);
    if (temporaryExists) await unlink(temporary).catch(() => undefined);
    if (rollbackStagingExists) await unlink(rollbackStaging).catch(() => undefined);
    if (rollbackExists && !replacementVisible) {
      await unlink(rollback).catch(() => undefined);
    }
    if (committedBackupExists && committed) await unlink(committedBackup).catch(() => undefined);
  }
}

export class AtomicRecoveryError extends Error {
  readonly code = "ATOMIC_RECOVERY_AMBIGUOUS";

  constructor(readonly target: AtomicStateFile) {
    super(`Atomic recovery is ambiguous for ${target}`);
    this.name = "AtomicRecoveryError";
  }
}

async function validateAtomicRecoveryFile(path: string): Promise<void> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC,
  );
  try {
    const metadata = await handle.stat();
    const euid = process.geteuid?.();
    if (euid === undefined || !metadata.isFile() || metadata.uid !== euid
      || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1) {
      throw new Error("Atomic recovery artifact failed secure validation");
    }
  } finally {
    await handle.close();
  }
}

export async function recoverAtomicArtifacts(
  directoryPath: string,
  targets: readonly AtomicStateFile[],
  directoryFsync: DirectoryFsync,
): Promise<void> {
  const groups = new Map<AtomicStateFile, Map<string, Set<AtomicArtifactKind>>>();
  const entries = await readdir(directoryPath);
  // A manual list omitted `delivery-transaction.json` — exactly the WAL that makes the inbox/outbox
  // pair atomic. Deriving both parsers from the single source prevents the next durable file
  // from being outside recovery again even if it appears in `ATOMIC_STATE_FILES`.
  const escapedTargets = ATOMIC_STATE_FILES.map((target) => (
    target.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
  ));
  const targetPattern = `(${escapedTargets.join("|")})`;
  const currentPattern = new RegExp(
    `^${targetPattern}\\.([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\\.atomic-(tmp|backup-tmp|backup|committed)$`,
    "u",
  );
  const legacyPattern = new RegExp(
    `^${targetPattern}\\.[0-9]+\\.[0-9a-f-]{36}\\.(?:tmp|rollback)$`,
    "u",
  );

  for (const entry of entries) {
    const legacy = legacyPattern.exec(entry);
    const legacyTarget = targets.find((candidate) => candidate === legacy?.[1]);
    if (legacyTarget !== undefined) throw new AtomicRecoveryError(legacyTarget);
    const match = currentPattern.exec(entry);
    if (match === null) {
      const target = targets.find((candidate) => entry.startsWith(`${candidate}.`) && entry.includes(".atomic-"));
      if (target !== undefined) throw new AtomicRecoveryError(target);
      continue;
    }
    const target = targets.find((candidate) => candidate === match[1]);
    if (target === undefined) continue;
    const transaction = match[2];
    const kind = match[3];
    if (transaction === undefined
      || (kind !== "tmp" && kind !== "backup-tmp" && kind !== "backup" && kind !== "committed")) {
      throw new AtomicRecoveryError(target);
    }
    const transactions = groups.get(target) ?? new Map<string, Set<AtomicArtifactKind>>();
    const kinds = transactions.get(transaction) ?? new Set<AtomicArtifactKind>();
    kinds.add(kind);
    transactions.set(transaction, kinds);
    groups.set(target, transactions);
  }

  if (groups.size === 0) return;
  const directory = await open(
    directoryPath,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
  );
  try {
    for (const [target, transactions] of groups) {
      const artifacts: { transaction: string; kind: AtomicArtifactKind; path: string }[] = [];
      for (const [transaction, kinds] of transactions) {
        if ((kinds.has("backup") && kinds.has("committed"))
          || (kinds.has("backup-tmp") && (kinds.has("backup") || kinds.has("committed")))) {
          throw new AtomicRecoveryError(target);
        }
        for (const kind of kinds) {
          const path = join(directoryPath, `${target}.${transaction}.atomic-${kind}`);
          await validateAtomicRecoveryFile(path);
          artifacts.push({ transaction, kind, path });
        }
      }
      const backups = artifacts.filter((artifact) => artifact.kind === "backup");
      if (backups.length > 1) throw new AtomicRecoveryError(target);
      const targetPath = join(directoryPath, target);
      const backup = backups[0];
      if (backup !== undefined) {
        await rename(backup.path, targetPath);
        await directoryFsync(directory);
      } else if (artifacts.some((artifact) => artifact.kind === "committed")) {
        await validateAtomicRecoveryFile(targetPath).catch(() => {
          throw new AtomicRecoveryError(target);
        });
      }
      for (const artifact of artifacts) {
        if (artifact.path === backup?.path) continue;
        await unlink(artifact.path).catch((error: unknown) => {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        });
      }
      await directoryFsync(directory);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
}

export async function prepareStateDirectory(directory: string): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const handle = await open(
    directory,
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
  );
  try {
    const metadata = await handle.stat();
    const euid = process.geteuid?.();
    if (euid === undefined || !metadata.isDirectory() || metadata.uid !== euid) {
      throw new Error("Durable state directory failed secure validation");
    }
    await handle.chmod(0o700);
  } finally {
    await handle.close();
  }
}
