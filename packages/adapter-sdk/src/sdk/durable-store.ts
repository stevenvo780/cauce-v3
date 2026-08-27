import { createHash, randomUUID } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  mkdir,
  open,
  readFile,
  readdir,
  rename,
  stat,
  unlink,
  type FileHandle,
} from "node:fs/promises";
import { dirname, join } from "node:path";
import { ConsumerLeaseError } from "./errors.js";
import type {
  Delivery, DeliveryEvent, StructuredOutput,
} from "./types.js";
import type {
  DelegationMaterializationNotice,
  DelegationRejectionNotice,
  ProfileRuntimeAdoptionEvidence,
} from "@cauce/protocol";

export type InboxState = "accepted" | "started" | "done" | "failed";

export interface InboxRecord {
  readonly delivery_id: string;
  readonly fingerprint: string;
  readonly epoch: number;
  readonly attempt: number;
  readonly claim_token: string;
  readonly previous_claim_tokens?: readonly string[];
  readonly state: InboxState;
  /**
   * Recovery contract for executions created after the durable pre-invocation gate shipped.
   * Legacy `started` records have no value and therefore remain conservatively ambiguous.
   */
  readonly execution_intent_protocol?: "preinvoke-v1";
  /** Exact execution-intent event durably confirmed by the remote store for this attempt. */
  readonly execution_intent_receipt_event_id?: string;
  readonly origin: Delivery["origin"];
  readonly request?: Delivery;
  readonly output?: StructuredOutput;
  readonly profile_adoption?: ProfileRuntimeAdoptionEvidence;
  /** Exact store-side outcome of this turn's StructuredOutput.messages. */
  readonly delegation_rejections?: readonly DelegationRejectionNotice[];
  readonly delegation_materializations?: readonly DelegationMaterializationNotice[];
  readonly error?: { readonly code: string; readonly message: string; readonly retryable: boolean };
  /**
   * Stable evidence that the state-changing lifecycle event was created for this attempt.
   *
   * The event may no longer be in the outbox because the relay acknowledged it. Keeping the
   * identifier prevents a later duplicate delivery from manufacturing an endless stream of new
   * terminal ACKs after the exact original event was already confirmed.
   */
  readonly lifecycle_event_ids?: {
    readonly accepted?: string;
    readonly started?: string;
    readonly execution_started?: string;
    readonly terminal?: string;
  };
  readonly updated_at: string;
}

interface InboxFile {
  readonly version: 1;
  readonly deliveries: Record<string, InboxRecord>;
  readonly last_transaction_id?: string;
}

interface OutboxFile {
  readonly version: 1;
  readonly pending: readonly DeliveryEvent[];
  readonly last_transaction_id?: string;
}

interface DeliveryTransactionFile {
  readonly version: 1;
  readonly transaction_id: string;
  readonly inbox_updates?: Readonly<Record<string, InboxRecord>>;
  readonly outbox_pending?: readonly DeliveryEvent[];
}

/**
 * Metadatos descriptivos de la conversación de origen asociados a una sesión nativa.
 */
export interface SessionOrigin {
  readonly adapter: string;
  readonly channel: string;
  readonly conversation_id: string;
}

export interface SessionRecord {
  readonly native_id: string;
  readonly initialized: boolean;
  /** Origen de la conversación, opcional si la entrega no declaró conversación de origen. */
  readonly origin?: SessionOrigin;
}

export interface ProcessedFaninReply {
  readonly tenantId: string;
  readonly alias: string;
  readonly reply: string;
  /** Local terminal transition time; the newest one is this coordinator's own synthesis. */
  readonly updatedAt: string;
  /**
   * Delegated branch this reply closed, as the store wrote it into the agent.response
   * correlation. Two branches delegated to the same alias are distinct here, which a
   * tenant/alias key cannot express.
   */
  readonly childDeliveryId?: string;
  readonly outputIndex?: number;
  readonly targetTenant?: string;
}

export interface DelegationBranchIdentity {
  readonly outputIndex: number;
  readonly targetTenant?: string;
  readonly alias: string;
  readonly childDeliveryId?: string;
}

/** Ramas hermanas de un mismo abanico, tal como este adaptador las tiene registradas. */
export interface DelegationBranchProgress {
  /** Destinos materializados, preserving duplicates and output order. */
  readonly delegated: readonly string[];
  readonly branches: readonly DelegationBranchIdentity[];
  readonly rejected: readonly Pick<DelegationRejectionNotice, "output_index" | "target" | "code">[];
  /** Ramas hermanas ya cerradas localmente, más nuevas primero. El texto es de este adaptador. */
  readonly returned: readonly ProcessedFaninReply[];
  /** Destinos delegados sin respuesta terminal local todavía, sin la rama que llega ahora. */
  readonly pending: readonly string[];
  readonly pendingBranches: readonly DelegationBranchIdentity[];
}

export const CANONICAL_OPEN_CODE_SESSION_FILE = "canonical-opencode-session.json";
export const MAX_SESSIONS_FILE_BYTES = 1024 * 1024;
export const MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS = 24 * 60 * 60 * 1_000;
const DELEGATION_CONTEXT_PRUNE_RETRY_MS = 60_000;
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/** Directory fsync is optional only when the filesystem explicitly reports it unsupported. */
export const UNSUPPORTED_DIRECTORY_FSYNC_CODES = ["EINVAL", "ENOTSUP", "EOPNOTSUPP"] as const;
type UnsupportedDirectoryFsyncCode = typeof UNSUPPORTED_DIRECTORY_FSYNC_CODES[number];
export type DirectoryFsync = (directory: FileHandle) => Promise<void>;

export interface DurableStoreOpenOptions {
  /** Kant/OpenCode reloads sessions under its acquired stable-alias lease. */
  readonly deferSessions?: boolean;
  /** Deterministic fault injection for durability tests; production omits it. */
  readonly directoryFsync?: DirectoryFsync;
}

export type CanonicalOpenCodeSessionPointer =
  | {
      readonly version: 1;
      readonly state: "active";
      readonly alias: "kant";
      readonly harness: "opencode";
      readonly scope_key: string;
      readonly session_id: string;
    }
  | {
      readonly version: 1;
      readonly state: "unavailable";
      readonly alias: "kant";
      readonly harness: "opencode";
      readonly scope_key: null;
      readonly session_id: null;
      readonly reason: "missing" | "ambiguous" | "invalid";
    };

interface SessionsFile {
  readonly version: 1;
  readonly sessions: Record<string, SessionRecord>;
}

interface FencingFile {
  readonly version: 1;
  readonly epoch: number;
}

export type DeliveryAcceptance = "created" | "retry" | "duplicate" | "stale" | "blocked";

export interface EventCorrelation {
  readonly event_id: string;
  readonly delivery_id: string;
  readonly attempt: number;
  readonly claim_token: string;
}

export interface EventDeliveryFeedback {
  readonly delegation_rejections?: readonly DelegationRejectionNotice[];
  readonly delegation_materializations?: readonly DelegationMaterializationNotice[];
  /** Sólo receipts terminales concluyentes; `superseded`/ausencia conservan el evento para replay. */
  readonly terminal_receipt?: "applied" | "duplicate" | "ownership_lost";
  /** Applied/duplicate receipt for the exact `execution_started` barrier event. */
  readonly execution_intent_receipt?: "applied" | "duplicate";
}

export interface DeliveryTransitionDetails {
  readonly output?: StructuredOutput;
  readonly profileAdoption?: ProfileRuntimeAdoptionEvidence;
  readonly error?: InboxRecord["error"];
  readonly retainRequest?: boolean;
  readonly attempt?: number;
  readonly claimToken?: string;
  readonly executionIntentProtocol?: "preinvoke-v1";
}

export interface LifecycleAcceptance {
  readonly acceptance: DeliveryAcceptance;
  readonly record: InboxRecord;
  /** Present only when this call created a new accepted lifecycle event. */
  readonly event?: DeliveryEvent;
}

export interface LifecycleTransition {
  readonly record: InboxRecord;
  readonly event: DeliveryEvent;
}

type LifecycleEventSlot = "accepted" | "started" | "execution_started" | "terminal";

const EMPTY_INBOX: InboxFile = { version: 1, deliveries: {} };
const EMPTY_OUTBOX: OutboxFile = { version: 1, pending: [] };
const EMPTY_SESSIONS: SessionsFile = { version: 1, sessions: {} };
const EMPTY_FENCING: FencingFile = { version: 1, epoch: 0 };
const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);

function lifecycleSlot(event: DeliveryEvent): LifecycleEventSlot | undefined {
  if (event.execution_started === true) return "execution_started";
  if (event.claim_renewal === true) return undefined;
  if (event.phase === "accepted") return "accepted";
  if (event.phase === "started") return "started";
  if (event.phase === "done" || event.phase === "failed") return "terminal";
  return undefined;
}

function lifecycleEventFor(
  record: InboxRecord,
  phase: InboxState,
  occurredAt: string,
  epoch = record.epoch,
): DeliveryEvent {
  return {
    event_id: randomUUID(),
    delivery_id: record.delivery_id,
    attempt: record.attempt,
    claim_token: record.claim_token,
    epoch,
    phase,
    occurred_at: occurredAt,
    ...(record.origin === undefined ? {} : { origin: record.origin }),
    ...(record.output === undefined ? {} : { output: record.output }),
    ...(record.profile_adoption === undefined ? {} : { profile_adoption: record.profile_adoption }),
    ...(record.error === undefined ? {} : { error: record.error }),
  };
}

function withLifecycleEvent(record: InboxRecord, event: DeliveryEvent): InboxRecord {
  const slot = lifecycleSlot(event);
  if (slot === undefined || record.lifecycle_event_ids?.[slot] !== undefined) return record;
  return {
    ...record,
    lifecycle_event_ids: {
      ...record.lifecycle_event_ids,
      [slot]: event.event_id,
    },
  };
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
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

async function defaultDirectoryFsync(directory: FileHandle): Promise<void> {
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
    while (true) {
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

async function atomicWrite(
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

export const ATOMIC_STATE_FILES = [
  "delivery-transaction.json",
  "inbox.json",
  "outbox.json",
  "sessions.json",
  "fencing.json",
  CANONICAL_OPEN_CODE_SESSION_FILE,
] as const;
type AtomicStateFile = typeof ATOMIC_STATE_FILES[number];
type AtomicArtifactKind = "tmp" | "backup-tmp" | "backup" | "committed";

class AtomicRecoveryError extends Error {
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

async function recoverAtomicArtifacts(
  directoryPath: string,
  targets: readonly AtomicStateFile[],
  directoryFsync: DirectoryFsync,
): Promise<void> {
  const targetSet = new Set<string>(targets);
  const groups = new Map<AtomicStateFile, Map<string, Set<AtomicArtifactKind>>>();
  const entries = await readdir(directoryPath);
  // Una lista manual omitió `delivery-transaction.json`: exactamente el WAL que hace atómica la
  // pareja inbox/outbox. Derivar ambos parsers de la fuente única evita que el próximo fichero
  // durable quede otra vez fuera del recovery aunque sí esté en `ATOMIC_STATE_FILES`.
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
    if (legacy !== null && targetSet.has(legacy[1]!)) {
      throw new AtomicRecoveryError(legacy[1] as AtomicStateFile);
    }
    const match = currentPattern.exec(entry);
    if (match === null) {
      const target = targets.find((candidate) => entry.startsWith(`${candidate}.`) && entry.includes(".atomic-"));
      if (target !== undefined) throw new AtomicRecoveryError(target);
      continue;
    }
    const target = match[1] as AtomicStateFile;
    if (!targetSet.has(target)) continue;
    const transaction = match[2]!;
    const kind = match[3] as AtomicArtifactKind;
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
      const artifacts: Array<{ transaction: string; kind: AtomicArtifactKind; path: string }> = [];
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
      if (backups.length === 1) {
        await rename(backups[0]!.path, targetPath);
        await directoryFsync(directory);
      } else if (artifacts.some((artifact) => artifact.kind === "committed")) {
        await validateAtomicRecoveryFile(targetPath).catch(() => {
          throw new AtomicRecoveryError(target);
        });
      }
      for (const artifact of artifacts) {
        if (backups.length === 1 && artifact.path === backups[0]!.path) continue;
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

class InvalidSessionsFileError extends Error {
  readonly code = "INVALID_SESSIONS_FILE";

  constructor() {
    super("sessions.json failed secure validation");
    this.name = "InvalidSessionsFileError";
  }
}

function invalidSessionsFile(): never {
  throw new InvalidSessionsFileError();
}

function rejectDuplicateJsonKeys(text: string): void {
  let offset = 0;
  const whitespace = (): void => {
    while (/\s/u.test(text[offset] ?? "")) offset += 1;
  };
  const string = (): string => {
    if (text[offset] !== '"') invalidSessionsFile();
    const start = offset;
    offset += 1;
    while (offset < text.length) {
      if (text[offset] === "\\") {
        offset += 2;
        continue;
      }
      if (text[offset] === '"') {
        offset += 1;
        try {
          return JSON.parse(text.slice(start, offset)) as string;
        } catch {
          invalidSessionsFile();
        }
      }
      offset += 1;
    }
    invalidSessionsFile();
  };
  const value = (): void => {
    whitespace();
    if (text[offset] === "{") {
      offset += 1;
      whitespace();
      const keys = new Set<string>();
      if (text[offset] === "}") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        const key = string();
        if (keys.has(key)) invalidSessionsFile();
        keys.add(key);
        whitespace();
        if (text[offset] !== ":") invalidSessionsFile();
        offset += 1;
        value();
        whitespace();
        if (text[offset] === "}") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") invalidSessionsFile();
        offset += 1;
        whitespace();
      }
      invalidSessionsFile();
    }
    if (text[offset] === "[") {
      offset += 1;
      whitespace();
      if (text[offset] === "]") {
        offset += 1;
        return;
      }
      while (offset < text.length) {
        value();
        whitespace();
        if (text[offset] === "]") {
          offset += 1;
          return;
        }
        if (text[offset] !== ",") invalidSessionsFile();
        offset += 1;
      }
      invalidSessionsFile();
    }
    if (text[offset] === '"') {
      string();
      return;
    }
    const start = offset;
    while (offset < text.length && !/[\s,}\]]/u.test(text[offset]!)) offset += 1;
    if (offset === start) invalidSessionsFile();
  };
  value();
  whitespace();
  if (offset !== text.length) invalidSessionsFile();
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

/**
 * Juego de caracteres y cotas de los tres campos de `SessionOrigin`.
 *
 * El tope importa por una razón concreta y no por prolijidad: `validateSessionsFile` admite
 * hasta 4096 entradas y `readSessionsSecure` rechaza el fichero entero pasado 1 MiB. Un origen
 * sin cota multiplicado por 4096 entradas empuja contra ese techo, y pasarse NO degrada: deja
 * al alias sin ninguna sesión con INVALID_SESSIONS_FILE.
 */
const SESSION_ORIGIN_FIELD = /^[A-Za-z0-9._:@+-]{1,128}$/u;

/**
 * Un origen con forma inesperada se DESCARTA; no invalida el fichero.
 *
 * Es deliberadamente asimétrico con el resto del validador, que es estricto y tira. La razón es
 * la consecuencia: `native_id` es lo único de lo que depende reanudar una conversación, así que
 * ahí una forma rara es corrupción y hay que parar. `origin` es una etiqueta para el humano;
 * perderla degrada a "sin origen" —que es la respuesta honesta que el lector ya sabe dar— y
 * tirar por ella convertiría un metadato cosmético en una caída del alias.
 */
export function sanitizeSessionOrigin(value: unknown): SessionOrigin | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (!exactKeys(record, ["adapter", "channel", "conversation_id"])) return undefined;
  const { adapter, channel, conversation_id: conversationId } = record;
  if (typeof adapter !== "string" || !SESSION_ORIGIN_FIELD.test(adapter)) return undefined;
  if (typeof channel !== "string" || !SESSION_ORIGIN_FIELD.test(channel)) return undefined;
  if (typeof conversationId !== "string"
    || !SESSION_ORIGIN_FIELD.test(conversationId)) return undefined;
  return { adapter, channel, conversation_id: conversationId };
}

function validateSessionsFile(value: unknown): SessionsFile {
  if (typeof value !== "object" || value === null || Array.isArray(value)) invalidSessionsFile();
  const root = value as Record<string, unknown>;
  if (!exactKeys(root, ["version", "sessions"]) || root.version !== 1
    || typeof root.sessions !== "object" || root.sessions === null || Array.isArray(root.sessions)) {
    invalidSessionsFile();
  }
  const entries = Object.entries(root.sessions as Record<string, unknown>);
  if (entries.length > 4096) invalidSessionsFile();
  const sessions = Object.create(null) as Record<string, SessionRecord>;
  for (const [key, valueRecord] of entries) {
    if (!/^(?:hermes|opencode|claude|codex|openclaw|fake):[A-Za-z0-9._:-]{1,500}$/u.test(key)
      || typeof valueRecord !== "object"
      || valueRecord === null
      || Array.isArray(valueRecord)) invalidSessionsFile();
    const record = valueRecord as Record<string, unknown>;
    // Las DOS formas admitidas, y sólo esas: la vieja (sin `origin`) sigue siendo válida tal
    // cual, así que ninguna entrada escrita antes de este cambio se rompe.
    if (!(exactKeys(record, ["native_id", "initialized"])
        || exactKeys(record, ["native_id", "initialized", "origin"]))
      || typeof record.native_id !== "string"
      || !/^[A-Za-z0-9._:-]{1,512}$/u.test(record.native_id)
      || typeof record.initialized !== "boolean") invalidSessionsFile();
    const origin = sanitizeSessionOrigin(record.origin);
    sessions[key] = {
      native_id: record.native_id,
      initialized: record.initialized,
      ...(origin === undefined ? {} : { origin }),
    };
  }
  return { version: 1, sessions };
}

async function readSessionsSecure(path: string): Promise<SessionsFile> {
  let handle: FileHandle;
  try {
    handle = await open(
      path,
      fsConstants.O_RDONLY
        | O_CLOEXEC
        | fsConstants.O_NOFOLLOW
        | fsConstants.O_NONBLOCK,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return clone(EMPTY_SESSIONS);
    throw new InvalidSessionsFileError();
  }
  try {
    const before = await handle.stat();
    const euid = process.geteuid?.();
    if (euid === undefined
      || !before.isFile()
      || before.uid !== euid
      || (before.mode & 0o777) !== 0o600
      || before.nlink !== 1
      || before.size <= 0
      || before.size > MAX_SESSIONS_FILE_BYTES) invalidSessionsFile();

    const buffer = Buffer.alloc(MAX_SESSIONS_FILE_BYTES + 1);
    let length = 0;
    while (length <= MAX_SESSIONS_FILE_BYTES) {
      const { bytesRead } = await handle.read(
        buffer,
        length,
        MAX_SESSIONS_FILE_BYTES + 1 - length,
        null,
      );
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    const after = await handle.stat();
    if (length > MAX_SESSIONS_FILE_BYTES
      || length !== before.size
      || after.size !== before.size
      || after.dev !== before.dev
      || after.ino !== before.ino
      || after.mtimeMs !== before.mtimeMs
      || after.ctimeMs !== before.ctimeMs) invalidSessionsFile();

    const text = buffer.subarray(0, length).toString("utf8");
    rejectDuplicateJsonKeys(text);
    let decoded: unknown;
    try {
      decoded = JSON.parse(text) as unknown;
    } catch {
      invalidSessionsFile();
    }
    return validateSessionsFile(decoded);
  } catch (error) {
    if (error instanceof InvalidSessionsFileError) throw error;
    throw new InvalidSessionsFileError();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export function isCanonicalOpenCodeScopeKey(value: string): boolean {
  return /^auth-v1:[A-Za-z0-9_-]{43}$/u.test(value);
}

export function isCanonicalOpenCodeSessionId(value: string): boolean {
  return /^ses_[A-Za-z0-9_-]{4,124}$/u.test(value);
}

function canonicalOpenClawTerminalKey(alias: string): string | undefined {
  return /^[a-z][a-z0-9_-]{0,63}$/u.test(alias)
    ? `openclaw:${alias}:shared:${alias}`
    : undefined;
}

function unavailableCanonicalOpenCodeSession(
  reason: "missing" | "ambiguous" | "invalid",
): CanonicalOpenCodeSessionPointer {
  return {
    version: 1,
    state: "unavailable",
    alias: "kant",
    harness: "opencode",
    scope_key: null,
    session_id: null,
    reason,
  };
}

function activeCanonicalOpenCodeSession(scopeKey: string, sessionId: string): CanonicalOpenCodeSessionPointer {
  return {
    version: 1,
    state: "active",
    alias: "kant",
    harness: "opencode",
    scope_key: scopeKey,
    session_id: sessionId,
  };
}

function deliveryFingerprint(delivery: Delivery): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        delivery_id: delivery.delivery_id,
        message_id: delivery.message_id,
        request_id: delivery.request_id,
        trace_id: delivery.trace_id,
        tenant_id: delivery.tenant_id,
        room_id: delivery.room_id,
        actor_alias: delivery.actor_alias,
        recipient_alias: delivery.recipient_alias,
        origin: delivery.origin,
        authenticated_context: delivery.authenticated_context,
        body: delivery.body,
      }),
    )
    .digest("hex");
}

function objectRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function visibleText(value: unknown): value is string {
  return typeof value === "string" && /[\p{L}\p{N}\p{P}\p{S}]/u.test(value);
}

async function prepareStateDirectory(directory: string): Promise<void> {
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

/**
 * Durable, process-serialized inbox/outbox/session state.
 * Files and directories are owner-only; no prompt or harness output is logged.
 */
export class DurableStore {
  private inbox: InboxFile = clone(EMPTY_INBOX);
  private outbox: OutboxFile = clone(EMPTY_OUTBOX);
  private sessions: SessionsFile = clone(EMPTY_SESSIONS);
  private fencing: FencingFile = clone(EMPTY_FENCING);
  private tail: Promise<void> = Promise.resolve();
  private canonicalOpenCodeScopeKey: string | undefined;
  private canonicalOpenCodeReconciled = false;
  private delegationContextPruneTimer: ReturnType<typeof setTimeout> | undefined;
  private recoveryRequired = false;

  private constructor(
    private readonly directory: string,
    private readonly directoryFsync: DirectoryFsync,
  ) {}

  static async open(directory: string, options: DurableStoreOpenOptions = {}): Promise<DurableStore> {
    await prepareStateDirectory(directory);
    const store = new DurableStore(directory, options.directoryFsync ?? defaultDirectoryFsync);
    const startupRecoveryTargets: readonly AtomicStateFile[] = options.deferSessions === true
      ? ["delivery-transaction.json", "inbox.json", "outbox.json", "fencing.json"]
      : ATOMIC_STATE_FILES;
    await recoverAtomicArtifacts(directory, startupRecoveryTargets, store.directoryFsync);
    const [loadedInbox, loadedOutbox, transaction, sessions, fencing] = await Promise.all([
      readJson(store.path("inbox.json"), EMPTY_INBOX),
      readJson(store.path("outbox.json"), EMPTY_OUTBOX),
      readJson<DeliveryTransactionFile | undefined>(
        store.path("delivery-transaction.json"),
        undefined,
      ),
      options.deferSessions === true
        ? Promise.resolve(clone(EMPTY_SESSIONS))
        : readSessionsSecure(store.path("sessions.json")),
      readJson(store.path("fencing.json"), EMPTY_FENCING),
    ]);
    store.inbox = loadedInbox;
    store.outbox = loadedOutbox;
    store.sessions = sessions;
    store.fencing = fencing;
    if (transaction !== undefined) await store.recoverDeliveryTransaction(transaction);
    await store.pruneExpiredDelegationContexts();
    return store;
  }

  private path(name: string): string {
    return join(this.directory, name);
  }

  private atomicWrite(name: string, value: unknown): Promise<void> {
    return atomicWrite(this.path(name), value, this.directoryFsync);
  }

  /**
   * Write-ahead transaction over the historical inbox/outbox files.
   *
   * The intent is durable before either target changes. A crash at any later instruction leaves
   * enough information to idempotently finish both writes on reopen. Keeping the patch small
   * avoids rewriting the unbounded inbox for renewals and ACKs, while preserving the existing
   * files for old diagnostics and rollback tooling.
   */
  private async commitDeliveryState(
    inbox: InboxFile,
    outbox: OutboxFile,
    targets: { readonly inbox: boolean; readonly outbox: boolean },
  ): Promise<void> {
    if (!targets.inbox && !targets.outbox) return;
    const transactionId = randomUUID();
    const inboxUpdates = targets.inbox
      ? Object.fromEntries(Object.entries(inbox.deliveries).filter(
          ([deliveryId, record]) => this.inbox.deliveries[deliveryId] !== record,
        ))
      : undefined;
    const transaction: DeliveryTransactionFile = {
      version: 1,
      transaction_id: transactionId,
      ...(inboxUpdates === undefined ? {} : { inbox_updates: inboxUpdates }),
      ...(targets.outbox ? { outbox_pending: outbox.pending } : {}),
    };
    await this.atomicWrite("delivery-transaction.json", transaction);
    try {
      const committedInbox: InboxFile = targets.inbox
        ? { version: 1, deliveries: inbox.deliveries, last_transaction_id: transactionId }
        : this.inbox;
      const committedOutbox: OutboxFile = targets.outbox
        ? { version: 1, pending: outbox.pending, last_transaction_id: transactionId }
        : this.outbox;
      if (targets.inbox) await this.atomicWrite("inbox.json", committedInbox);
      if (targets.outbox) await this.atomicWrite("outbox.json", committedOutbox);
      this.inbox = committedInbox;
      this.outbox = committedOutbox;
      this.recoveryRequired = false;
    } catch (error) {
      this.recoveryRequired = true;
      throw error;
    }
  }

  private async recoverDeliveryTransaction(transaction?: DeliveryTransactionFile): Promise<void> {
    const pending = transaction ?? await readJson<DeliveryTransactionFile | undefined>(
      this.path("delivery-transaction.json"),
      undefined,
    );
    if (pending === undefined) {
      this.recoveryRequired = false;
      return;
    }
    if (pending.inbox_updates !== undefined
      && this.inbox.last_transaction_id !== pending.transaction_id) {
      const recoveredInbox: InboxFile = {
        version: 1,
        deliveries: { ...this.inbox.deliveries, ...pending.inbox_updates },
        last_transaction_id: pending.transaction_id,
      };
      await this.atomicWrite("inbox.json", recoveredInbox);
      this.inbox = recoveredInbox;
    }
    if (pending.outbox_pending !== undefined
      && this.outbox.last_transaction_id !== pending.transaction_id) {
      const recoveredOutbox: OutboxFile = {
        version: 1,
        pending: pending.outbox_pending,
        last_transaction_id: pending.transaction_id,
      };
      await this.atomicWrite("outbox.json", recoveredOutbox);
      this.outbox = recoveredOutbox;
    }
    this.recoveryRequired = false;
  }

  private withoutExpiredDelegationContexts(nowMs: number): InboxFile {
    let changed = false;
    const deliveries: Record<string, InboxRecord> = { ...this.inbox.deliveries };
    for (const [deliveryId, record] of Object.entries(deliveries)) {
      if (record.request === undefined || (record.state !== "done" && record.state !== "failed")) continue;
      const updatedAtMs = Date.parse(record.updated_at);
      if (Number.isFinite(updatedAtMs)
        && nowMs - updatedAtMs < MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS) continue;
      const withoutRequest = { ...record };
      delete withoutRequest.request;
      deliveries[deliveryId] = withoutRequest;
      changed = true;
    }
    return changed ? { version: 1, deliveries } : this.inbox;
  }

  private scheduleDelegationContextPrune(
    nowMs = Date.now(),
    minimumDelayMs = 0,
  ): void {
    if (this.delegationContextPruneTimer !== undefined) {
      clearTimeout(this.delegationContextPruneTimer);
      this.delegationContextPruneTimer = undefined;
    }
    let nextExpiryMs = Number.POSITIVE_INFINITY;
    for (const record of Object.values(this.inbox.deliveries)) {
      if (record.request === undefined || (record.state !== "done" && record.state !== "failed")) continue;
      const updatedAtMs = Date.parse(record.updated_at);
      nextExpiryMs = Math.min(
        nextExpiryMs,
        Number.isFinite(updatedAtMs)
          ? updatedAtMs + MAX_RETAINED_DELEGATION_CONTEXT_AGE_MS
          : nowMs,
      );
    }
    if (!Number.isFinite(nextExpiryMs)) return;
    const delayMs = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(1, minimumDelayMs, Math.ceil(nextExpiryMs - nowMs)),
    );
    this.delegationContextPruneTimer = setTimeout(() => {
      this.delegationContextPruneTimer = undefined;
      void this.pruneExpiredDelegationContexts().catch(() => {
        this.scheduleDelegationContextPrune(Date.now(), DELEGATION_CONTEXT_PRUNE_RETRY_MS);
      });
    }, delayMs);
    this.delegationContextPruneTimer.unref();
  }

  async pruneExpiredDelegationContexts(nowMs = Date.now()): Promise<number> {
    if (!Number.isFinite(nowMs)) throw new RangeError("Delegation context prune time must be finite");
    return this.serialized(async () => {
      const nextInbox = this.withoutExpiredDelegationContexts(nowMs);
      if (nextInbox === this.inbox) {
        this.scheduleDelegationContextPrune();
        return 0;
      }
      const removed = Object.keys(this.inbox.deliveries)
        .filter((deliveryId) =>
          this.inbox.deliveries[deliveryId]?.request !== undefined
          && nextInbox.deliveries[deliveryId]?.request === undefined)
        .length;
      await this.commitDeliveryState(nextInbox, this.outbox, { inbox: true, outbox: false });
      this.scheduleDelegationContextPrune();
      return removed;
    });
  }

  private async serialized<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      if (this.recoveryRequired) await this.recoverDeliveryTransaction();
      return await operation();
    } finally {
      release();
    }
  }

  get epoch(): number {
    return this.fencing.epoch;
  }

  async activateEpoch(epoch: number): Promise<"same" | "advanced"> {
    return this.serialized(async () => {
      if (!Number.isSafeInteger(epoch) || epoch <= 0) throw new RangeError("Epoch must be positive");
      if (epoch < this.fencing.epoch) {
        throw new RangeError(`Cannot lower fencing epoch from ${this.fencing.epoch} to ${epoch}`);
      }
      if (epoch === this.fencing.epoch) return "same";
      this.fencing = { version: 1, epoch };
      await this.atomicWrite("fencing.json", this.fencing);
      return "advanced";
    });
  }

  async accept(
    delivery: Delivery,
    occurredAt: string,
  ): Promise<{ acceptance: DeliveryAcceptance; record: InboxRecord }> {
    const accepted = await this.acceptInternal(delivery, occurredAt, false);
    return { acceptance: accepted.acceptance, record: accepted.record };
  }

  /**
   * Persist a newly accepted attempt and its transport event in the same atomic state image.
   *
   * On a duplicate from a legacy split-file store, this also reconstructs the one missing event
   * for the record's current state and records its stable id. That recovery can cause one safe
   * at-least-once replay, but never a permanent new-event loop after the relay ACKs it.
   */
  async acceptAndEnqueue(delivery: Delivery, occurredAt: string): Promise<LifecycleAcceptance> {
    return this.acceptInternal(delivery, occurredAt, true);
  }

  private async acceptInternal(
    delivery: Delivery,
    occurredAt: string,
    enqueueLifecycle: boolean,
  ): Promise<LifecycleAcceptance> {
    return this.serialized(async () => {
      const existing = this.inbox.deliveries[delivery.delivery_id];
      const fingerprint = deliveryFingerprint(delivery);
      if (existing !== undefined) {
        if (existing.fingerprint !== fingerprint) {
          throw new Error(`delivery_id collision for ${delivery.delivery_id}`);
        }
        if (delivery.attempt < existing.attempt) {
          return { acceptance: "stale", record: clone(existing) };
        }
        if (delivery.attempt === existing.attempt) {
          if (delivery.claim_token === existing.claim_token && enqueueLifecycle) {
            const recovered = await this.ensureCurrentLifecycleEventUnlocked(existing);
            return { acceptance: "duplicate", record: clone(recovered) };
          }
          return {
            acceptance: delivery.claim_token === existing.claim_token ? "duplicate" : "stale",
            record: clone(existing),
          };
        }
        const seenClaims = [...(existing.previous_claim_tokens ?? []), existing.claim_token];
        if (seenClaims.includes(delivery.claim_token)) {
          return { acceptance: "stale", record: clone(existing) };
        }
        if (existing.state !== "failed" || existing.error?.retryable !== true) {
          return { acceptance: "blocked", record: clone(existing) };
        }
      }
      const record: InboxRecord = {
        delivery_id: delivery.delivery_id,
        fingerprint,
        epoch: delivery.epoch,
        attempt: delivery.attempt,
        claim_token: delivery.claim_token,
        ...(existing === undefined
          ? {}
          : { previous_claim_tokens: [...(existing.previous_claim_tokens ?? []), existing.claim_token] }),
        state: "accepted",
        origin: delivery.origin,
        request: delivery,
        updated_at: occurredAt,
      };
      const baseInbox = this.withoutExpiredDelegationContexts(Date.now());
      const event = enqueueLifecycle ? lifecycleEventFor(record, "accepted", occurredAt) : undefined;
      const committedRecord = event === undefined ? record : withLifecycleEvent(record, event);
      const nextInbox: InboxFile = {
        version: 1,
        deliveries: { ...baseInbox.deliveries, [delivery.delivery_id]: committedRecord },
      };
      const nextOutbox: OutboxFile = event === undefined
        ? this.outbox
        : { version: 1, pending: [...this.outbox.pending, event] };
      await this.commitDeliveryState(nextInbox, nextOutbox, {
        inbox: true,
        outbox: event !== undefined,
      });
      this.scheduleDelegationContextPrune();
      return {
        acceptance: existing === undefined ? "created" : "retry",
        record: clone(committedRecord),
        ...(event === undefined ? {} : { event: clone(event) }),
      };
    });
  }

  async ensureCurrentLifecycleEvent(
    correlation: Pick<InboxRecord, "delivery_id" | "attempt" | "claim_token">,
  ): Promise<InboxRecord> {
    return this.serialized(async () => {
      const existing = this.inbox.deliveries[correlation.delivery_id];
      if (existing === undefined) throw new Error(`Unknown delivery ${correlation.delivery_id}`);
      if (existing.attempt !== correlation.attempt || existing.claim_token !== correlation.claim_token) {
        throw new Error(`Stale lifecycle correlation for delivery ${correlation.delivery_id}`);
      }
      return clone(await this.ensureCurrentLifecycleEventUnlocked(existing));
    });
  }

  private async ensureCurrentLifecycleEventUnlocked(existing: InboxRecord): Promise<InboxRecord> {
    const slot: LifecycleEventSlot = existing.state === "done" || existing.state === "failed"
      ? "terminal"
      : existing.state;
    if (existing.lifecycle_event_ids?.[slot] !== undefined) return existing;

    const pending = this.outbox.pending.find((event) => (
      event.delivery_id === existing.delivery_id
      && event.attempt === existing.attempt
      && event.claim_token === existing.claim_token
      && lifecycleSlot(event) === slot
      && (slot !== "terminal" || event.phase === existing.state)
    ));
    const event = pending
      ?? lifecycleEventFor(existing, existing.state, existing.updated_at, this.fencing.epoch);
    const recovered = withLifecycleEvent(existing, event);
    const nextInbox: InboxFile = {
      version: 1,
      deliveries: { ...this.inbox.deliveries, [existing.delivery_id]: recovered },
    };
    const nextOutbox: OutboxFile = pending === undefined
      ? { version: 1, pending: [...this.outbox.pending, event] }
      : this.outbox;
    await this.commitDeliveryState(nextInbox, nextOutbox, {
      inbox: true,
      outbox: pending === undefined,
    });
    return recovered;
  }

  getDelivery(deliveryId: string): InboxRecord | undefined {
    const record = this.inbox.deliveries[deliveryId];
    return record === undefined ? undefined : clone(record);
  }

  private faninRoot(delivery: Delivery): InboxRecord | undefined {
    if (delivery.body.type !== "agent.fanin") return undefined;
    const correlation = objectRecord(delivery.body.correlation);
    const rootMessageId = typeof correlation?.root_message_id === "string"
      ? correlation.root_message_id
      : undefined;
    const rootDeliveryId = typeof correlation?.root_delivery_id === "string"
      ? correlation.root_delivery_id
      : undefined;
    if (rootMessageId === undefined || rootDeliveryId === undefined) return undefined;
    const root = this.inbox.deliveries[rootDeliveryId];
    if (
      root?.state !== "done"
      || root.request === undefined
      || root.output === undefined
      || root.request.message_id !== rootMessageId
      || root.request.trace_id !== delivery.trace_id
      || root.request.recipient_alias !== delivery.recipient_alias
      || root.output.messages.length === 0
    ) {
      return undefined;
    }
    return root;
  }

  private continuationBelongsToRoot(delivery: Delivery, rootDeliveryId: string): boolean {
    const seen = new Set<string>();
    let response: Delivery | undefined = delivery;
    for (let depth = 0; response !== undefined && depth < 16; depth += 1) {
      const source = this.continuationSource(response);
      if (source === undefined || seen.has(source.delivery_id)) return false;
      if (source.delivery_id === rootDeliveryId) return true;
      seen.add(source.delivery_id);
      response = source.request?.body.type === "agent.response" ? source.request : undefined;
    }
    return false;
  }

  /**
   * Resolves an authenticated agent.response back to the exact local delivery
   * that created its delegated branch. The local terminal output is part of
   * the proof: a wire correlation alone can never recover retained context.
   */
  continuationSource(delivery: Delivery): InboxRecord | undefined {
    if (delivery.body.type !== "agent.response") return undefined;
    const correlation = objectRecord(delivery.body.correlation);
    const sourceDeliveryId = typeof correlation?.response_to_delivery_id === "string"
      ? correlation.response_to_delivery_id
      : undefined;
    const childDeliveryId = typeof correlation?.child_delivery_id === "string"
      ? correlation.child_delivery_id
      : undefined;
    if (sourceDeliveryId === undefined) return undefined;
    const source = this.inbox.deliveries[sourceDeliveryId];
    const exactBranch = source?.delegation_materializations;
    const correlatedBranch = exactBranch === undefined
      ? source?.output?.messages.some((message) => message.to === delivery.actor_alias)
      : childDeliveryId !== undefined && exactBranch.some((branch) => (
          branch.child_delivery_id === childDeliveryId
          && branch.target_alias === delivery.actor_alias
        ));
    if (
      source?.state !== "done"
      || source.request === undefined
      || source.output === undefined
      || source.request.trace_id !== delivery.trace_id
      || source.request.recipient_alias !== delivery.recipient_alias
      || !correlatedBranch
    ) {
      return undefined;
    }
    return clone(source);
  }

  /**
   * Estado de las ramas hermanas del abanico que esta `agent.response` viene a cerrar.
   *
   * Consolida el estado desde el inbox durable local:
   *  - `branches`: entregas materializadas por el store (por output_index y child_delivery_id);
   *  - `rejected`: salidas rechazadas por el store;
   *  - `returned`: respuestas generadas al cerrar ramas hermanas;
   *  - `pending`: ramas pendientes restantes.
   *
   * Devuelve `undefined` para abanicos de una sola rama.
   */
  branchProgressForResponse(delivery: Delivery): DelegationBranchProgress | undefined {
    const source = this.continuationSource(delivery);
    if (source?.request === undefined || source.output === undefined) return undefined;
    const rejected = (source.delegation_rejections ?? []).map((rejection) => ({
      output_index: rejection.output_index,
      ...(rejection.target === undefined ? {} : { target: rejection.target }),
      code: rejection.code,
    }));
    const rejectedIndexes = new Set(rejected.map((rejection) => rejection.output_index));
    const branches: DelegationBranchIdentity[] = source.delegation_materializations === undefined
      ? source.output.messages.flatMap((message, outputIndex) => (
          rejectedIndexes.has(outputIndex)
            ? []
            : [{ outputIndex, alias: message.to }]
        ))
      : [...source.delegation_materializations]
          .sort((left, right) => left.output_index - right.output_index)
          .map((branch) => ({
            outputIndex: branch.output_index,
            targetTenant: branch.target_tenant,
            alias: branch.target_alias,
            childDeliveryId: branch.child_delivery_id,
          }));
    if (Math.max(source.output.messages.length, branches.length + rejected.length) < 2) return undefined;

    const returned = Object.values(this.inbox.deliveries)
      .filter((record) => {
        if (record.delivery_id === delivery.delivery_id) return false;
        const request = record.request;
        const correlation = objectRecord(request?.body.correlation);
        return record.state === "done"
          && request?.body.type === "agent.response"
          && request.trace_id === delivery.trace_id
          && request.recipient_alias === delivery.recipient_alias
          && correlation?.response_to_delivery_id === source.delivery_id
          && this.continuationSource(request)?.delivery_id === source.delivery_id
          && visibleText(record.output?.reply);
      })
      .sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at)
        || right.delivery_id.localeCompare(left.delivery_id))
      .map((record): ProcessedFaninReply => {
        const correlation = objectRecord(record.request!.body.correlation);
        const childDeliveryId = typeof correlation?.child_delivery_id === "string"
          ? correlation.child_delivery_id
          : undefined;
        const exact = childDeliveryId === undefined
          ? undefined
          : branches.find((branch) => branch.childDeliveryId === childDeliveryId);
        return {
          tenantId: record.request!.tenant_id,
          alias: record.request!.actor_alias,
          reply: record.output!.reply!.trim(),
          updatedAt: record.updated_at,
          ...(childDeliveryId === undefined ? {} : { childDeliveryId }),
          ...(exact === undefined ? {} : {
            outputIndex: exact.outputIndex,
            ...(exact.targetTenant === undefined ? {} : { targetTenant: exact.targetTenant }),
          }),
        };
      });

    const currentCorrelation = objectRecord(delivery.body.correlation);
    const currentChildDeliveryId = typeof currentCorrelation?.child_delivery_id === "string"
      ? currentCorrelation.child_delivery_id
      : undefined;
    const closures = [
      { alias: delivery.actor_alias, childDeliveryId: currentChildDeliveryId },
      ...returned.map((entry) => ({ alias: entry.alias, childDeliveryId: entry.childDeliveryId })),
    ];
    const closedIndexes = new Set<number>();
    const seenChildDeliveries = new Set<string>();
    for (const closure of closures) {
      if (closure.childDeliveryId !== undefined) {
        if (seenChildDeliveries.has(closure.childDeliveryId)) continue;
        seenChildDeliveries.add(closure.childDeliveryId);
        const exact = branches.find((branch) => (
          branch.childDeliveryId === closure.childDeliveryId
          && branch.alias === closure.alias
        ));
        if (exact !== undefined) {
          closedIndexes.add(exact.outputIndex);
          continue;
        }
      }
      // Legacy receipts have no child ids. Consume one unmatched occurrence, never the alias set.
      const legacy = branches.find((branch) => (
        !closedIndexes.has(branch.outputIndex)
        && branch.childDeliveryId === undefined
        && branch.alias === closure.alias
      ));
      if (legacy !== undefined) closedIndexes.add(legacy.outputIndex);
    }
    const pendingBranches = branches.filter((branch) => !closedIndexes.has(branch.outputIndex));
    return {
      delegated: branches.map((branch) => branch.alias),
      branches,
      rejected,
      returned,
      pending: pendingBranches.map((branch) => branch.alias),
      pendingBranches,
    };
  }

  /**
   * Returns every terminal visible reply produced locally while processing
   * correlated child responses for this fan-in root. Branch text from the wire
   * is deliberately not consulted here.
   */
  processedRepliesForFanin(delivery: Delivery): readonly ProcessedFaninReply[] {
    const root = this.faninRoot(delivery);
    if (root?.request === undefined) return [];
    const correlation = objectRecord(delivery.body.correlation);
    const rootMessageId = correlation?.root_message_id;
    const rootDeliveryId = root.delivery_id;

    return Object.values(this.inbox.deliveries)
      .filter((record) => {
        const request = record.request;
        const responseCorrelation = objectRecord(request?.body.correlation);
        return record.state === "done"
          && request?.body.type === "agent.response"
          && request.trace_id === delivery.trace_id
          && request.recipient_alias === delivery.recipient_alias
          && responseCorrelation?.root_message_id === rootMessageId
          && responseCorrelation?.root_delivery_id === rootDeliveryId
          && this.continuationBelongsToRoot(request, rootDeliveryId)
          && record.output?.messages.length === 0
          && visibleText(record.output?.reply);
      })
      // Newest first: the coordinator's last completed turn is its actual synthesis, and
      // tenant/alias/delivery ordering says nothing about which reply that is.
      .sort((left, right) =>
        right.updated_at.localeCompare(left.updated_at)
        || right.delivery_id.localeCompare(left.delivery_id))
      .map((record) => {
        const childDeliveryId = objectRecord(record.request!.body.correlation)?.child_delivery_id;
        return {
          tenantId: record.request!.tenant_id,
          alias: record.request!.actor_alias,
          reply: record.output!.reply!.trim(),
          updatedAt: record.updated_at,
          ...(typeof childDeliveryId === "string" && childDeliveryId.length > 0
            ? { childDeliveryId }
            : {}),
        };
      });
  }

  pendingDeliveries(): readonly InboxRecord[] {
    return Object.values(this.inbox.deliveries)
      .filter((record) => record.state === "accepted" || record.state === "started")
      .map(clone);
  }

  async transition(
    deliveryId: string,
    state: InboxState,
    occurredAt: string,
    details: DeliveryTransitionDetails = {},
  ): Promise<InboxRecord> {
    return (await this.transitionInternal(deliveryId, state, occurredAt, details, false)).record;
  }

  /** Atomically commits the state transition and the exact event that reports it. */
  async transitionAndEnqueue(
    deliveryId: string,
    state: InboxState,
    occurredAt: string,
    details: DeliveryTransitionDetails = {},
  ): Promise<LifecycleTransition> {
    const result = await this.transitionInternal(deliveryId, state, occurredAt, details, true);
    if (result.event === undefined) throw new Error("Lifecycle transition did not create an event");
    return { record: result.record, event: result.event };
  }

  private async transitionInternal(
    deliveryId: string,
    state: InboxState,
    occurredAt: string,
    details: DeliveryTransitionDetails,
    enqueueLifecycle: boolean,
  ): Promise<{ readonly record: InboxRecord; readonly event?: DeliveryEvent }> {
    return this.serialized(async () => {
      const existing = this.inbox.deliveries[deliveryId];
      if (existing === undefined) throw new Error(`Unknown delivery ${deliveryId}`);
      if (details.attempt !== undefined && details.attempt !== existing.attempt) {
        throw new Error(`Stale attempt ${details.attempt} for delivery ${deliveryId}`);
      }
      if (details.claimToken !== undefined && details.claimToken !== existing.claim_token) {
        throw new Error(`Stale claim token for delivery ${deliveryId}`);
      }
      const terminal = state === "done" || state === "failed";
      const next: InboxRecord = {
        delivery_id: existing.delivery_id,
        fingerprint: existing.fingerprint,
        epoch: existing.epoch,
        attempt: existing.attempt,
        claim_token: existing.claim_token,
        ...(existing.previous_claim_tokens === undefined
          ? {}
          : { previous_claim_tokens: existing.previous_claim_tokens }),
        state,
        ...(details.executionIntentProtocol === undefined
          ? (existing.execution_intent_protocol === undefined
              ? {}
              : { execution_intent_protocol: existing.execution_intent_protocol })
          : { execution_intent_protocol: details.executionIntentProtocol }),
        ...(existing.execution_intent_receipt_event_id === undefined
          ? {}
          : { execution_intent_receipt_event_id: existing.execution_intent_receipt_event_id }),
        origin: existing.origin,
        ...(!terminal || details.retainRequest === true ? { request: existing.request } : {}),
        ...(details.output === undefined ? {} : { output: details.output }),
        ...(details.profileAdoption === undefined ? {} : { profile_adoption: details.profileAdoption }),
        ...(details.error === undefined ? {} : { error: details.error }),
        ...(existing.lifecycle_event_ids === undefined
          ? {}
          : { lifecycle_event_ids: existing.lifecycle_event_ids }),
        updated_at: occurredAt,
      };
      const event = enqueueLifecycle
        ? lifecycleEventFor(next, state, occurredAt, this.fencing.epoch)
        : undefined;
      const committedNext = event === undefined ? next : withLifecycleEvent(next, event);
      const deliveries: Record<string, InboxRecord> = {
        ...this.inbox.deliveries,
        [deliveryId]: committedNext,
      };
      if (state === "done" && existing.request?.body.type === "agent.fanin") {
        const root = this.faninRoot(existing.request);
        if (root !== undefined) {
          for (const [candidateId, candidate] of Object.entries(deliveries)) {
            const request = candidate.request;
            if (request === undefined
              || (candidate.state !== "done" && candidate.state !== "failed")) continue;
            const belongsToRoot = request.delivery_id === root.delivery_id
              || (request.body.type === "agent.response"
                && this.continuationBelongsToRoot(request, root.delivery_id));
            if (!belongsToRoot) continue;
            const withoutRequest = { ...candidate };
            delete withoutRequest.request;
            deliveries[candidateId] = withoutRequest;
          }
        }
      }
      const nextInbox: InboxFile = {
        version: 1,
        deliveries,
      };
      const nextOutbox: OutboxFile = event === undefined
        ? this.outbox
        : { version: 1, pending: [...this.outbox.pending, event] };
      await this.commitDeliveryState(nextInbox, nextOutbox, {
        inbox: true,
        outbox: event !== undefined,
      });
      this.scheduleDelegationContextPrune();
      return {
        record: clone(committedNext),
        ...(event === undefined ? {} : { event: clone(event) }),
      };
    });
  }

  async enqueue(event: DeliveryEvent): Promise<void> {
    await this.serialized(async () => {
      const alreadyPending = this.outbox.pending.some((candidate) => candidate.event_id === event.event_id);
      const existing = this.inbox.deliveries[event.delivery_id];
      const correlated = existing?.attempt === event.attempt
        && existing.claim_token === event.claim_token
        ? withLifecycleEvent(existing, event)
        : existing;
      const markerChanged = existing !== undefined && correlated !== undefined && correlated !== existing;
      if (alreadyPending && !markerChanged) return;
      const nextInbox: InboxFile = markerChanged
        ? {
            version: 1,
            deliveries: { ...this.inbox.deliveries, [event.delivery_id]: correlated },
          }
        : this.inbox;
      const nextOutbox: OutboxFile = alreadyPending
        ? this.outbox
        : { version: 1, pending: [...this.outbox.pending, event] };
      await this.commitDeliveryState(nextInbox, nextOutbox, {
        inbox: markerChanged,
        outbox: !alreadyPending,
      });
    });
  }

  pendingEvents(): readonly DeliveryEvent[] {
    return clone(this.outbox.pending);
  }

  async acknowledge(correlation: EventCorrelation): Promise<boolean> {
    return this.acknowledgeResult(correlation);
  }

  /**
   * Confirm one exact event and persist its delegation receipt in the same WAL transaction.
   * A restart therefore sees either both feedback+removal or the still-pending event to replay.
   */
  async acknowledgeResult(
    correlation: EventCorrelation,
    feedback: EventDeliveryFeedback = {},
  ): Promise<boolean> {
    return this.serialized(async () => {
      const acknowledgedEvent = this.outbox.pending.find((event) => sameCorrelation(event, correlation));
      if (acknowledgedEvent === undefined) return false;
      const pending = this.outbox.pending.filter((event) => !sameCorrelation(event, correlation));
      const existing = this.inbox.deliveries[correlation.delivery_id];
      const terminalFeedback = (acknowledgedEvent.phase === "done" || acknowledgedEvent.phase === "failed")
        && existing?.attempt === correlation.attempt
        && existing.claim_token === correlation.claim_token
        && (feedback.delegation_rejections !== undefined
          || feedback.delegation_materializations !== undefined);
      const terminalOwnershipLost = (acknowledgedEvent.phase === "done" || acknowledgedEvent.phase === "failed")
        && existing?.attempt === correlation.attempt
        && existing.claim_token === correlation.claim_token
        && feedback.terminal_receipt === "ownership_lost";
      const executionIntentConfirmed = acknowledgedEvent.execution_started === true
        && existing?.attempt === correlation.attempt
        && existing.claim_token === correlation.claim_token
        && feedback.execution_intent_receipt !== undefined;
      if (feedback.execution_intent_receipt !== undefined && !executionIntentConfirmed) {
        throw new Error("Execution intent receipt does not match a current durable marker");
      }
      // El store remoto rechazó este resultado terminal: conservar `done` local bloquearía para
      // siempre el intento superior que el bus tiene derecho a entregar. Se degrada a un failed
      // retryable, pero se conserva el id terminal ya confirmado para que una redelivery del MISMO
      // intento no fabrique otro evento ni vuelva a ejecutar el trabajo ambiguo.
      const ownershipReleasedRecord = terminalOwnershipLost && existing !== undefined
        ? (() => {
            const retained: { -readonly [Key in keyof InboxRecord]: InboxRecord[Key] } = {
              ...existing,
            };
            delete retained.output;
            delete retained.profile_adoption;
            delete retained.delegation_rejections;
            delete retained.delegation_materializations;
            delete retained.error;
            return {
              ...retained,
              state: "failed" as const,
              error: {
                code: "TERMINAL_ACK_OWNERSHIP_LOST",
                message: "The durable relay rejected this terminal result because claim ownership was lost",
                retryable: true,
              },
            };
          })()
        : existing;
      let nextRecord: InboxRecord | undefined = ownershipReleasedRecord;
      if (executionIntentConfirmed && nextRecord !== undefined) {
        nextRecord = {
          ...nextRecord,
          execution_intent_receipt_event_id: acknowledgedEvent.event_id,
        };
      }
      if (terminalFeedback && !terminalOwnershipLost) {
        if (ownershipReleasedRecord === undefined) {
          throw new Error(`Terminal feedback has no inbox record for ${correlation.delivery_id}`);
        }
        nextRecord = {
          ...ownershipReleasedRecord,
          ...(feedback.delegation_rejections === undefined
            ? {}
            : { delegation_rejections: clone(feedback.delegation_rejections) }),
          ...(feedback.delegation_materializations === undefined
            ? {}
            : { delegation_materializations: clone(feedback.delegation_materializations) }),
        };
      }
      const inboxChanged = terminalFeedback || terminalOwnershipLost || executionIntentConfirmed;
      let nextInbox: InboxFile = this.inbox;
      if (inboxChanged) {
        if (nextRecord === undefined) {
          throw new Error(`Terminal receipt has no inbox record for ${correlation.delivery_id}`);
        }
        nextInbox = {
          version: 1,
          deliveries: { ...this.inbox.deliveries, [correlation.delivery_id]: nextRecord },
        };
      }
      await this.commitDeliveryState(nextInbox, { version: 1, pending }, {
        inbox: inboxChanged,
        outbox: true,
      });
      return true;
    });
  }

  pendingEventsFor(correlation: Pick<EventCorrelation, "delivery_id" | "attempt" | "claim_token">): readonly DeliveryEvent[] {
    return clone(this.outbox.pending.filter((event) => (
      event.delivery_id === correlation.delivery_id
      && event.attempt === correlation.attempt
      && event.claim_token === correlation.claim_token
    )));
  }

  getSession(key: string): SessionRecord | undefined {
    const record = this.sessions.sessions[key];
    return record === undefined ? undefined : clone(record);
  }

  async setSession(key: string, record: SessionRecord): Promise<void> {
    await this.serialized(async () => {
      const next = validateSessionsFile({
        version: 1,
        sessions: { ...this.sessions.sessions, [key]: record },
      });
      await this.atomicWrite("sessions.json", next);
      this.sessions = next;
    });
  }

  /**
   * Confirma una sesión nativa OpenClaw y publica en el MISMO rename el selector que consume la
   * TUI de terminal.
   *
   * La entrada fuente conserva `origin` para que las herramientas operativas puedan distinguir
   * conversaciones. El pointer fijo, en cambio, contiene sólo el identificador nativo opaco y el
   * bit de inicialización: copiar el `conversation_id` ahí duplicaba un identificador de usuario
   * sin que el consumidor lo necesitara. Una sola escritura evita que un reinicio deje publicada
   * una sesión que todavía figura como no inicializada, o viceversa.
   */
  async setCanonicalOpenClawTerminalSession(
    alias: string,
    sourceKey: string,
    record: SessionRecord,
  ): Promise<void> {
    const pointerKey = canonicalOpenClawTerminalKey(alias);
    if (pointerKey === undefined || !sourceKey.startsWith(`openclaw:${alias}:`)) {
      throw new Error("Invalid canonical OpenClaw terminal session scope");
    }
    if (record.initialized !== true) {
      throw new Error("Canonical OpenClaw terminal session must be initialized");
    }
    await this.serialized(async () => {
      const pointer: SessionRecord = {
        native_id: record.native_id,
        initialized: true,
      };
      const next = validateSessionsFile({
        version: 1,
        sessions: {
          ...this.sessions.sessions,
          [sourceKey]: record,
          [pointerKey]: pointer,
        },
      });
      await this.atomicWrite("sessions.json", next);
      this.sessions = next;
    });
  }

  /**
   * Repara el pointer OpenClaw bajo la lease estable del alias, antes de conectar al relay.
   *
   * Un pointer ya publicado es la única selección canónica y sobrevive reinicios. Para stores
   * anteriores a este contrato sólo se adopta automáticamente una sesión humana cuando existe
   * exactamente una; con cero o varias se deja ausente para no convertir `mtime` ni el orden del
   * JSON en una elección de conversación inventada. El siguiente turno humano válido lo publica.
   */
  async reconcileCanonicalOpenClawTerminalSession(alias: string): Promise<boolean> {
    const pointerKey = canonicalOpenClawTerminalKey(alias);
    if (pointerKey === undefined) {
      throw new Error("Invalid canonical OpenClaw terminal session scope");
    }
    return this.serialized(async () => {
      await recoverAtomicArtifacts(
        this.directory,
        ["sessions.json"],
        this.directoryFsync,
      );
      this.sessions = await readSessionsSecure(this.path("sessions.json"));

      const current = this.sessions.sessions[pointerKey];
      if (current?.initialized === true) {
        // Los primeros writers copiaban también `origin`. Se corrige in-place sin cambiar la
        // sesión seleccionada ni revelar el valor en errores o logs.
        if (current.origin !== undefined) {
          const next = validateSessionsFile({
            version: 1,
            sessions: {
              ...this.sessions.sessions,
              [pointerKey]: { native_id: current.native_id, initialized: true },
            },
          });
          await this.atomicWrite("sessions.json", next);
          this.sessions = next;
        }
        return true;
      }

      const prefix = `openclaw:${alias}:`;
      const candidates = Object.entries(this.sessions.sessions).filter(([key, candidate]) => (
        key.startsWith(prefix)
        && key !== pointerKey
        && !key.endsWith(".agent-lane")
        && candidate.initialized === true
      ));
      const sessions = { ...this.sessions.sessions };
      delete sessions[pointerKey];
      if (candidates.length === 1) {
        const candidate = candidates[0]![1];
        sessions[pointerKey] = { native_id: candidate.native_id, initialized: true };
      }
      const next = validateSessionsFile({ version: 1, sessions });
      if (JSON.stringify(next) !== JSON.stringify(this.sessions)) {
        await this.atomicWrite("sessions.json", next);
        this.sessions = next;
      }
      return candidates.length === 1;
    });
  }

  /**
   * Rebuild the non-sensitive Kant/OpenCode pointer from durable mappings.
   * This is deliberately opt-in so no other alias or harness publishes it.
   */
  async reconcileCanonicalOpenCodeSession(): Promise<CanonicalOpenCodeSessionPointer> {
    return this.serialized(async () => {
      try {
        // Runtime calls this only from AdapterClient.onLeaseAcquired, replacing
        // the pre-lease snapshot and removing the load/reconcile TOCTOU.
        await recoverAtomicArtifacts(
          this.directory,
          ["sessions.json", CANONICAL_OPEN_CODE_SESSION_FILE],
          this.directoryFsync,
        );
        this.sessions = await readSessionsSecure(this.path("sessions.json"));
      } catch (error) {
        this.canonicalOpenCodeScopeKey = undefined;
        this.canonicalOpenCodeReconciled = false;
        if (error instanceof AtomicRecoveryError
          && error.target === CANONICAL_OPEN_CODE_SESSION_FILE) throw error;
        await this.atomicWrite(
          CANONICAL_OPEN_CODE_SESSION_FILE,
          unavailableCanonicalOpenCodeSession("invalid"),
        );
        throw error;
      }
      const mappings = this.canonicalOpenCodeMappings();
      this.canonicalOpenCodeScopeKey = undefined;
      let pointer: CanonicalOpenCodeSessionPointer;
      if (mappings.length === 0) {
        pointer = unavailableCanonicalOpenCodeSession("missing");
      } else if (mappings.length > 1) {
        pointer = unavailableCanonicalOpenCodeSession("ambiguous");
      } else {
        const mapping = mappings[0]!;
        if (!isCanonicalOpenCodeScopeKey(mapping.scopeKey)
          || !isCanonicalOpenCodeSessionId(mapping.sessionId)) {
          pointer = unavailableCanonicalOpenCodeSession("invalid");
        } else {
          this.canonicalOpenCodeScopeKey = mapping.scopeKey;
          pointer = activeCanonicalOpenCodeSession(mapping.scopeKey, mapping.sessionId);
        }
      }
      await this.atomicWrite(CANONICAL_OPEN_CODE_SESSION_FILE, pointer);
      this.canonicalOpenCodeReconciled = true;
      return clone(pointer);
    });
  }

  /** Persist the mapping first, then atomically publish/refresh the sticky pointer. */
  async setCanonicalOpenCodeSession(scopeKey: string, sessionId: string): Promise<boolean> {
    if (!isCanonicalOpenCodeScopeKey(scopeKey) || !isCanonicalOpenCodeSessionId(sessionId)) return false;
    return this.serialized(async () => {
      if (!this.canonicalOpenCodeReconciled) {
        throw new Error("Canonical OpenCode session must be reconciled before publication");
      }
      const key = `opencode:kant:${scopeKey}`;
      this.sessions = {
        version: 1,
        sessions: {
          ...this.sessions.sessions,
          [key]: { native_id: sessionId, initialized: true },
        },
      };
      // This fsync+rename completes before the pointer can name the session.
      await this.atomicWrite("sessions.json", this.sessions);

      if (this.canonicalOpenCodeScopeKey === undefined) {
        const mappings = this.canonicalOpenCodeMappings();
        if (mappings.length !== 1) {
          const reason = mappings.length > 1 ? "ambiguous" : "invalid";
          await this.atomicWrite(
            CANONICAL_OPEN_CODE_SESSION_FILE,
            unavailableCanonicalOpenCodeSession(reason),
          );
          return false;
        }
        const mapping = mappings[0]!;
        if (mapping.scopeKey !== scopeKey
          || !isCanonicalOpenCodeScopeKey(mapping.scopeKey)
          || !isCanonicalOpenCodeSessionId(mapping.sessionId)) {
          await this.atomicWrite(
            CANONICAL_OPEN_CODE_SESSION_FILE,
            unavailableCanonicalOpenCodeSession("invalid"),
          );
          return false;
        }
        this.canonicalOpenCodeScopeKey = scopeKey;
      }

      if (this.canonicalOpenCodeScopeKey !== scopeKey) return false;
      await this.atomicWrite(
        CANONICAL_OPEN_CODE_SESSION_FILE,
        activeCanonicalOpenCodeSession(scopeKey, sessionId),
      );
      return true;
    });
  }

  private canonicalOpenCodeMappings(): Array<{ scopeKey: string; sessionId: string }> {
    const prefix = "opencode:kant:";
    const mappings: Array<{ scopeKey: string; sessionId: string }> = [];
    for (const [key, record] of Object.entries(this.sessions.sessions)) {
      const candidate = record as unknown;
      if (!key.startsWith(prefix)
        || typeof candidate !== "object"
        || candidate === null
        || Array.isArray(candidate)) continue;
      const fields = candidate as Record<string, unknown>;
      if (fields.initialized !== true) continue;
      mappings.push({
        scopeKey: key.slice(prefix.length),
        sessionId: typeof fields.native_id === "string" ? fields.native_id : "",
      });
    }
    return mappings;
  }
}

function sameCorrelation(event: DeliveryEvent, correlation: EventCorrelation): boolean {
  return event.event_id === correlation.event_id
    && event.delivery_id === correlation.delivery_id
    && event.attempt === correlation.attempt
    && event.claim_token === correlation.claim_token;
}

function pidIsAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Cross-process guard for one long-lived consumer per stable alias. */
export class ConsumerLease {
  private constructor(
    private readonly path: string,
    private readonly handle: FileHandle,
  ) {}

  static async acquire(stateDirectory: string, alias: string, instanceId: string): Promise<ConsumerLease> {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    const path = join(stateDirectory, `.consumer-${alias}.lock`);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = await open(path, "wx", 0o600);
        await handle.writeFile(`${JSON.stringify({ pid: process.pid, instance_id: instanceId })}\n`, "utf8");
        await handle.sync();
        return new ConsumerLease(path, handle);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        let stale = false;
        try {
          const parsed = JSON.parse(await readFile(path, "utf8")) as { pid?: unknown };
          stale = typeof parsed.pid !== "number" || !pidIsAlive(parsed.pid);
        } catch {
          const age = await stat(path)
            .then((metadata) => Date.now() - metadata.mtimeMs)
            .catch(() => 0);
          stale = age > 30_000;
        }
        if (!stale) {
          throw new ConsumerLeaseError(`A consumer already owns stable alias '${alias}'`);
        }
        await unlink(path).catch(() => undefined);
      }
    }
    throw new ConsumerLeaseError(`Could not acquire consumer lease for '${alias}'`);
  }

  async release(): Promise<void> {
    await this.handle.close().catch(() => undefined);
    await unlink(this.path).catch(() => undefined);
  }
}
