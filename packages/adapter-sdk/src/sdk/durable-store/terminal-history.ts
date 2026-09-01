import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { mkdir, open, readdir, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { atomicWrite, prepareStateDirectory } from "./atomic-state.js";
import {
  TERMINAL_HISTORY_SEGMENT_RECORDS,
  type DirectoryFsync,
  type InboxRecord,
  type TerminalHistorySegment,
} from "./contracts.js";

const O_CLOEXEC = Number((fsConstants as unknown as Record<string, unknown>).O_CLOEXEC ?? 0);
const SEGMENT = /^([a-f0-9]{64})\.json$/u;
const UNCOMMITTED_SEGMENT = /^[a-f0-9]{64}\.json\.[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.atomic-tmp$/u;
const SOFT_SEGMENT_BYTES = 8 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 64 * 1024 * 1024;

async function prepareHistoryDirectory(
  directory: string,
  directoryFsync: DirectoryFsync,
): Promise<void> {
  let created = false;
  try {
    await mkdir(directory, { mode: 0o700 });
    created = true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  await prepareStateDirectory(directory);
  if (!created) return;
  const parent = await open(
    dirname(directory),
    fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
  );
  try {
    await directoryFsync(parent);
  } finally {
    await parent.close();
  }
}

function terminalRecord(value: unknown): value is InboxRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const previousClaims = record.previous_claim_tokens;
  const lifecycle = record.lifecycle_event_ids;
  const error = record.error;
  return typeof record.delivery_id === "string"
    && record.delivery_id.length > 0
    && typeof record.fingerprint === "string"
    && /^[a-f0-9]{64}$/u.test(record.fingerprint)
    && Number.isSafeInteger(record.epoch)
    && Number(record.epoch) > 0
    && Number.isSafeInteger(record.attempt)
    && Number(record.attempt) > 0
    && typeof record.claim_token === "string"
    && record.claim_token.length > 0
    && (previousClaims === undefined
      || (Array.isArray(previousClaims) && previousClaims.every((claim) => (
        typeof claim === "string" && claim.length > 0
      ))))
    && (record.state === "done" || record.state === "failed")
    && record.request === undefined
    && lifecycle !== null
    && typeof lifecycle === "object"
    && !Array.isArray(lifecycle)
    && typeof (lifecycle as Record<string, unknown>).terminal === "string"
    && (error === undefined
      || (error !== null
        && typeof error === "object"
        && !Array.isArray(error)
        && typeof (error as Record<string, unknown>).code === "string"
        && typeof (error as Record<string, unknown>).message === "string"
        && typeof (error as Record<string, unknown>).retryable === "boolean"))
    && typeof record.updated_at === "string"
    && Number.isFinite(Date.parse(record.updated_at));
}

function validatedSegment(value: unknown): TerminalHistorySegment {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Terminal history segment is not an object");
  }
  const segment = value as Record<string, unknown>;
  if (segment.version !== 1 || !Array.isArray(segment.records) || segment.records.length === 0
      || segment.records.length > TERMINAL_HISTORY_SEGMENT_RECORDS
      || !segment.records.every(terminalRecord)) {
    throw new Error("Terminal history segment failed validation");
  }
  return segment as unknown as TerminalHistorySegment;
}

function encodedSegment(records: readonly InboxRecord[]): {
  readonly digest: string;
  readonly segment: TerminalHistorySegment;
} {
  const segment: TerminalHistorySegment = { version: 1, records };
  const digest = createHash("sha256").update(JSON.stringify(segment)).digest("hex");
  return { digest, segment };
}

function recordDigest(record: InboxRecord): string {
  return createHash("sha256").update(JSON.stringify(record)).digest("hex");
}

async function readSecureSegment(path: string): Promise<TerminalHistorySegment> {
  const handle = await open(
    path,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK | O_CLOEXEC,
  );
  try {
    const metadata = await handle.stat();
    const euid = process.geteuid?.();
    if (euid === undefined || !metadata.isFile() || metadata.uid !== euid
        || (metadata.mode & 0o777) !== 0o600 || metadata.nlink !== 1
        || metadata.size < 1 || metadata.size > MAX_SEGMENT_BYTES) {
      throw new Error("Terminal history segment failed secure validation");
    }
    return validatedSegment(JSON.parse(await handle.readFile("utf8")) as unknown);
  } finally {
    await handle.close();
  }
}

function recordBytes(record: InboxRecord): number {
  return Buffer.byteLength(JSON.stringify(record), "utf8") + 2;
}

function recordBatches(records: readonly InboxRecord[]): InboxRecord[][] {
  const batches: InboxRecord[][] = [];
  let current: InboxRecord[] = [];
  let currentBytes = 0;
  for (const record of records) {
    const bytes = recordBytes(record);
    if (current.length > 0 && (current.length >= TERMINAL_HISTORY_SEGMENT_RECORDS
        || currentBytes + bytes > SOFT_SEGMENT_BYTES)) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(record);
    currentBytes += bytes;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

function ingestRecord(records: Map<string, InboxRecord>, record: InboxRecord): void {
  const existing = records.get(record.delivery_id);
  if (existing === undefined) {
    records.set(record.delivery_id, record);
    return;
  }
  if (existing.fingerprint !== record.fingerprint) {
    throw new Error(`Terminal history delivery_id collision for ${record.delivery_id}`);
  }
  if (existing.attempt === record.attempt) {
    if (!isDeepStrictEqual(existing, record)) {
      throw new Error(`Terminal history has conflicting records for ${record.delivery_id}`);
    }
    return;
  }
  const newer = existing.attempt > record.attempt ? existing : record;
  const older = newer === existing ? record : existing;
  const previousClaims = newer.previous_claim_tokens ?? [];
  if (!previousClaims.includes(older.claim_token)) {
    throw new Error(`Terminal history lost an earlier claim fence for ${record.delivery_id}`);
  }
  if (newer === record) records.set(record.delivery_id, record);
}

export class TerminalHistory {
  private readonly records = new Map<string, InboxRecord>();
  private readonly segments = new Set<string>();

  private constructor(
    private readonly directory: string,
    private readonly directoryFsync: DirectoryFsync,
  ) {}

  static async open(directory: string, directoryFsync: DirectoryFsync): Promise<TerminalHistory> {
    await prepareHistoryDirectory(directory, directoryFsync);
    const history = new TerminalHistory(directory, directoryFsync);
    const entries = await readdir(directory);
    let removedTemporary = false;
    for (const entry of entries) {
      if (UNCOMMITTED_SEGMENT.test(entry)) {
        await unlink(join(directory, entry));
        removedTemporary = true;
        continue;
      }
      if (entry.includes(".atomic-")) {
        throw new Error("Terminal history contains an ambiguous atomic artifact");
      }
      const matched = SEGMENT.exec(entry);
      if (matched?.[1] === undefined) {
        throw new Error("Terminal history contains an unsupported entry");
      }
      const segment = await readSecureSegment(join(directory, entry));
      const encoded = encodedSegment(segment.records);
      if (encoded.digest !== matched[1]) {
        throw new Error("Terminal history segment digest does not match its content");
      }
      history.segments.add(encoded.digest);
      for (const record of segment.records) ingestRecord(history.records, record);
    }
    if (removedTemporary) {
      const handle = await open(
        directory,
        fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW | O_CLOEXEC,
      );
      try {
        await directoryFsync(handle);
      } finally {
        await handle.close();
      }
    }
    return history;
  }

  get(deliveryId: string): InboxRecord | undefined {
    return this.records.get(deliveryId);
  }

  hasExact(deliveryId: string, digest: string): boolean {
    const record = this.records.get(deliveryId);
    return record !== undefined && recordDigest(record) === digest;
  }

  digest(record: InboxRecord): string {
    return recordDigest(record);
  }

  async archive(records: readonly InboxRecord[]): Promise<void> {
    if (records.length === 0) return;
    if (!records.every(terminalRecord)) {
      throw new Error("Only acknowledged terminal records without retained requests can be archived");
    }
    const encodedBatches = recordBatches(records).map(encodedSegment);
    for (const encoded of encodedBatches) {
      if (Buffer.byteLength(JSON.stringify(encoded.segment), "utf8") + 1 > MAX_SEGMENT_BYTES) {
        throw new RangeError("Terminal history segment exceeds the secure read limit");
      }
    }
    const projected = new Map(this.records);
    for (const record of records) ingestRecord(projected, record);
    for (const encoded of encodedBatches) {
      if (!this.segments.has(encoded.digest)) {
        await atomicWrite(
          join(this.directory, `${encoded.digest}.json`),
          encoded.segment,
          this.directoryFsync,
        );
        this.segments.add(encoded.digest);
      }
    }
    this.records.clear();
    for (const [deliveryId, record] of projected) this.records.set(deliveryId, record);
  }
}
